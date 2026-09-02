//! Rust -> WebAssembly hot path for PDF text extraction.
//!
//! This is a flattened, byte-faithful port of the extraction core of
//! `scripts/lib/pdf.mjs` (NOT the abstract/reference heuristics, which stay in
//! JS). It finds `stream...endstream` sections, inflates them (zlib, then raw
//! deflate) with `miniz_oxide`, decodes PDF content-stream text operators
//! (literal strings with escapes incl. octal, hex strings incl. UTF-16BE, and
//! the Tj/TJ/Td/TD/T*/ET operators), and scans the raw bytes for a document
//! Info `/Title (...)` or `/Title <hex>` value.
//!
//! The result is returned as JSON `{"info_title":"...","full_text":"..."}` via
//! a wasm-side output buffer, with this flat C ABI (no wasm-bindgen):
//!
//! - `alloc(len) -> *mut u8`     JS writes the PDF bytes here
//! - `extract(len) -> i32`       0 = ok, 3 = bad length, 2 = panicked, 1 = misc
//! - `result_ptr() -> *const u8` JSON bytes (UTF-8)
//! - `result_len() -> usize`
//! - `dealloc(ptr, len)`         frees a pointer previously returned by `alloc`
//!
//! Panics never unwind across the ABI: `extract` wraps the work in
//! `catch_unwind` and reports an error code instead.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr;

use miniz_oxide::inflate::{decompress_to_vec, decompress_to_vec_zlib};

// ---------------------------------------------------------------------------
// Error codes returned by `extract`.
// ---------------------------------------------------------------------------

const ERR_PANIC: i32 = 2;
const ERR_BAD_LENGTH: i32 = 3;

// ---------------------------------------------------------------------------
// Global buffers. wasm32-unknown-unknown is single threaded, so plain statics
// are fine; they are accessed through raw pointers to avoid static-mut-ref
// borrow shenanigans.
// ---------------------------------------------------------------------------

static mut INPUT: *mut Vec<u8> = ptr::null_mut();
static mut OUTPUT: *mut Vec<u8> = ptr::null_mut();

unsafe fn input_slot() -> &'static mut Vec<u8> {
    if INPUT.is_null() {
        INPUT = Box::into_raw(Box::new(Vec::new()));
    }
    &mut *INPUT
}

unsafe fn output_slot() -> &'static mut Vec<u8> {
    if OUTPUT.is_null() {
        OUTPUT = Box::into_raw(Box::new(Vec::new()));
    }
    &mut *OUTPUT
}

/// Hand the JS side a zeroed buffer of `len` bytes to write the PDF into.
#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let buffer = vec![0u8; len];
    let pointer = buffer.as_ptr() as *mut u8;
    unsafe {
        *input_slot() = buffer;
    }
    pointer
}

/// Run the extraction over the first `len` bytes of the `alloc`-ed buffer.
/// Returns 0 on success; the JSON result is available via `result_ptr` /
/// `result_len`. Never unwinds across the ABI.
#[no_mangle]
pub extern "C" fn extract(len: usize) -> i32 {
    let outcome = catch_unwind(AssertUnwindSafe(|| -> i32 {
        let slice: Option<&[u8]> = unsafe {
            if INPUT.is_null() {
                None
            } else {
                (*INPUT).get(..len)
            }
        };
        let slice = match slice {
            Some(slice) if slice.len() == len => slice,
            _ => return ERR_BAD_LENGTH,
        };
        match run_extract(slice) {
            Ok(json) => {
                unsafe {
                    *output_slot() = json;
                }
                0
            }
            Err(code) => code,
        }
    }));
    match outcome {
        Ok(code) => code,
        Err(_) => ERR_PANIC,
    }
}

/// Pointer to the wasm-side JSON result produced by the last `extract`.
#[no_mangle]
pub extern "C" fn result_ptr() -> *const u8 {
    unsafe { output_slot().as_ptr() }
}

/// Length in bytes of the wasm-side JSON result.
#[no_mangle]
pub extern "C" fn result_len() -> usize {
    unsafe { output_slot().len() }
}

/// Free a buffer previously returned by `alloc`. Safe to call with the null
/// pointer or zero length (no-ops).
#[no_mangle]
pub extern "C" fn dealloc(pointer: *mut u8, len: usize) {
    if pointer.is_null() || len == 0 {
        return;
    }
    unsafe {
        // If the caller is freeing the current input buffer, relinquish our
        // copy of that ownership first so we never double free.
        let owns_input = !INPUT.is_null()
            && (*INPUT).as_ptr() == pointer
            && (*INPUT).len() == len
            && (*INPUT).capacity() == len;
        if owns_input {
            let old = std::mem::replace(input_slot(), Vec::new());
            std::mem::forget(old);
        }
        drop(Vec::from_raw_parts(pointer, len, len));
    }
}

// ---------------------------------------------------------------------------
// Extraction pipeline (port of extractPdfText in scripts/lib/pdf.mjs).
// ---------------------------------------------------------------------------

fn run_extract(data: &[u8]) -> Result<Vec<u8>, i32> {
    let info_title = extract_info_field(data);
    let streams = inflate_streams(data);
    let mut joined: Vec<u16> = Vec::new();
    for (index, stream) in streams.iter().enumerate() {
        if index > 0 {
            joined.push(u16::from(b'\n'));
        }
        joined.extend_from_slice(&decode_content_stream(stream));
    }
    let full_text = collapse_whitespace(&joined);
    Ok(build_json(&info_title, &full_text))
}

// ---------------------------------------------------------------------------
// Small byte helpers mirroring the JS regex character classes.
// ---------------------------------------------------------------------------

fn find_from(haystack: &[u8], from: usize, needle: &[u8]) -> Option<usize> {
    if from >= haystack.len() {
        return None;
    }
    haystack[from..]
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|position| position + from)
}

/// JS `\s` restricted to latin1 (single-byte) code points.
fn is_js_ws_byte(byte: u8) -> bool {
    matches!(byte, 0x09..=0x0d | 0x20 | 0xa0)
}

fn is_hex_byte(byte: u8) -> bool {
    matches!(byte, b'0'..=b'9' | b'a'..=b'f' | b'A'..=b'F')
}

/// JS `\w` = `[A-Za-z0-9_]` (used for regex word boundaries).
fn is_word_byte(byte: u8) -> bool {
    matches!(byte, b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'_')
}

fn hex_val(byte: u8) -> Option<u16> {
    match byte {
        b'0'..=b'9' => Some(u16::from(byte - b'0')),
        b'a'..=b'f' => Some(u16::from(byte - b'a' + 10)),
        b'A'..=b'F' => Some(u16::from(byte - b'A' + 10)),
        _ => None,
    }
}

/// Boundary before position `pos` (as in `\b` before the operator token).
fn word_boundary_before(content: &[u8], pos: usize) -> bool {
    pos == 0 || !is_word_byte(content[pos - 1])
}

/// Boundary at position `pos` (as in `\b` after the operator token).
fn word_boundary_after(content: &[u8], pos: usize) -> bool {
    pos >= content.len() || !is_word_byte(content[pos])
}

// ---------------------------------------------------------------------------
// inflateStreams: find "stream ... endstream", try zlib then raw deflate.
// ---------------------------------------------------------------------------

fn inflate_streams(data: &[u8]) -> Vec<Vec<u8>> {
    let mut chunks: Vec<Vec<u8>> = Vec::new();
    // The JS regex `/stream\r?\n?/g` sets lastIndex to the "endstream" offset
    // after each hit, which lands the next search on the "stream" inside
    // "endstream" itself; `last = end` replicates that exactly.
    let mut last = 0usize;
    while let Some(at) = find_from(data, last, b"stream") {
        let mut start = at + b"stream".len();
        // Consume the optional `\r?\n?` after the keyword.
        if data.get(start) == Some(&b'\r') {
            start += 1;
            if data.get(start) == Some(&b'\n') {
                start += 1;
            }
        } else if data.get(start) == Some(&b'\n') {
            start += 1;
        }
        let end = match find_from(data, start, b"endstream") {
            Some(end) => end,
            None => break,
        };
        let slice = &data[start..end];
        // JS: first successful inflate wins (zlib, then raw); an inflate that
        // succeeds but yields nothing is dropped (falsy string in JS).
        let inflated = decompress_to_vec_zlib(slice).ok().or_else(|| decompress_to_vec(slice).ok());
        if let Some(text) = inflated {
            if !text.is_empty() {
                chunks.push(text);
            }
        }
        last = end;
    }
    chunks
}

// ---------------------------------------------------------------------------
// decodeContentStreams: PDF content-stream text operators.
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum OperatorKind {
    /// Tj / TJ (show text).
    Show,
    /// Td / TD / T* / ET (line-break-ish operators).
    Newline,
}

/// Scan a PDF literal string starting at `content[open] == b'('`.
/// Mirrors `\((?:[^()\\]|\\[\s\S])*\)`: an unescaped nested `(` aborts the
/// match (the JS regex then retries from a later position), and a trailing
/// backslash with no following char also fails.
fn scan_literal(content: &[u8], open: usize) -> Option<(&[u8], usize)> {
    let mut cursor = open + 1;
    while cursor < content.len() {
        let byte = content[cursor];
        if byte == b'\\' {
            if cursor + 1 >= content.len() {
                return None;
            }
            cursor += 2;
        } else if byte == b'(' {
            return None;
        } else if byte == b')' {
            return Some((&content[open + 1..cursor], cursor + 1));
        } else {
            cursor += 1;
        }
    }
    None
}

/// Scan a hex string starting at `content[open] == b'<'`. Mirrors
/// `<[0-9A-Fa-f\s]+>`: at least one hex/whitespace char, closed by `>`.
fn scan_hex(content: &[u8], open: usize) -> Option<(&[u8], usize)> {
    let mut cursor = open + 1;
    while cursor < content.len() && (is_hex_byte(content[cursor]) || is_js_ws_byte(content[cursor])) {
        cursor += 1;
    }
    if cursor > open + 1 && cursor < content.len() && content[cursor] == b'>' {
        Some((&content[open + 1..cursor], cursor + 1))
    } else {
        None
    }
}

/// Try to match one of the operator alternatives at `pos`:
/// `\bT[jJ]\b`, `\bTd\b`, `\bTD\b`, `\bT\*`, `\bET\b`.
/// `T*` counts as a line break regardless of what follows; the original JS
/// regex (`\bT\*\b`) silently dropped end-of-line `T*` operators, which lost
/// line breaks in real PDFs, so both implementations now treat every `T*` as
/// a line-break operator.
fn try_operator(content: &[u8], pos: usize) -> Option<(OperatorKind, usize)> {
    if !word_boundary_before(content, pos) {
        return None;
    }
    match content[pos] {
        b'T' => match content.get(pos + 1) {
            Some(b'j' | b'J') if word_boundary_after(content, pos + 2) => Some((OperatorKind::Show, pos + 2)),
            Some(b'd' | b'D') if word_boundary_after(content, pos + 2) => Some((OperatorKind::Newline, pos + 2)),
            Some(b'*') => Some((OperatorKind::Newline, pos + 2)),
            _ => None,
        },
        b'E' => {
            if content.get(pos + 1) == Some(&b'T') && word_boundary_after(content, pos + 2) {
                Some((OperatorKind::Newline, pos + 2))
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Port of decodePdfString: literal-string escapes, including up to three
/// octal digits. Operates on latin1 bytes; output values are UTF-16 code
/// units (JS keeps `String.fromCharCode(parseInt(octal, 8))`, which can reach
/// 511).
fn decode_pdf_string(raw: &[u8]) -> Vec<u16> {
    let mut text: Vec<u16> = Vec::with_capacity(raw.len());
    let mut index = 0usize;
    while index < raw.len() {
        let byte = raw[index];
        if byte == b'\\' {
            let next = match raw.get(index + 1) {
                Some(next) => *next,
                // JS: `if (next === undefined) break;`
                None => break,
            };
            if (b'0'..=b'7').contains(&next) {
                let mut octal: u32 = 0;
                let mut digits = 0usize;
                let mut cursor = index + 1;
                while cursor < raw.len() && digits < 3 && (b'0'..=b'7').contains(&raw[cursor]) {
                    octal = octal * 8 + u32::from(raw[cursor] - b'0');
                    digits += 1;
                    cursor += 1;
                }
                text.push(octal as u16);
                index = cursor;
                continue;
            }
            let mapped = match next {
                b'n' => 0x0au16,
                b'r' => 0x0du16,
                b't' => 0x09u16,
                b'b' => 0x08u16,
                b'f' => 0x0cu16,
                other => u16::from(other),
            };
            text.push(mapped);
            index += 2;
            continue;
        }
        text.push(u16::from(byte));
        index += 1;
    }
    text
}

/// Port of the hex-string branch of decodeContentStreams: UTF-16BE when the
/// length is a multiple of 4 and the first byte pair is 00/01/fe/ff
/// (case-insensitive), latin1 otherwise.
fn decode_hex_string(raw: &[u8]) -> Vec<u16> {
    let hex: Vec<u8> = raw
        .iter()
        .copied()
        .filter(|byte| !is_js_ws_byte(*byte))
        .collect();
    let utf16_prefix = hex.len() >= 4
        && hex.len() % 4 == 0
        && ((hex[0] == b'0' && (hex[1] == b'0' || hex[1] == b'1'))
            || ((hex[0] == b'f' || hex[0] == b'F') && matches!(hex[1], b'e' | b'E' | b'f' | b'F')));
    if utf16_prefix {
        let mut text: Vec<u16> = Vec::with_capacity(hex.len() / 4);
        let mut index = 0usize;
        while index + 3 < hex.len() {
            // Hex digits are pre-validated by the filter above, so the lookups
            // below cannot fail; fall back to 0 defensively.
            let code = (hex_val(hex[index]).unwrap_or(0) << 12)
                | (hex_val(hex[index + 1]).unwrap_or(0) << 8)
                | (hex_val(hex[index + 2]).unwrap_or(0) << 4)
                | hex_val(hex[index + 3]).unwrap_or(0);
            // JS keeps code units >= 32 plus \n and \r.
            if code >= 32 || code == 10 || code == 13 {
                text.push(code);
            }
            index += 4;
        }
        return text;
    }
    // Latin1 branch. JS `parseInt(slice, 16)` also accepts a single trailing
    // hex digit, so a 1-byte tail is parsed as one digit.
    let mut text: Vec<u16> = Vec::with_capacity(hex.len() / 2);
    let mut index = 0usize;
    while index < hex.len() {
        let high = hex_val(hex[index]);
        let low = hex_val(*hex.get(index + 1).unwrap_or(&0));
        let code = match (high, low) {
            (Some(high), Some(low)) => (high << 4) | low,
            (Some(high), None) => high,
            (None, _) => {
                index += 2;
                continue;
            }
        };
        // JS keeps 32 <= code < 127.
        if (32..127).contains(&code) {
            text.push(code);
        }
        index += 2;
    }
    text
}

/// Port of decodeContentStreams. `pending` mirrors the JS `pendingHex`
/// variable, including its truthiness quirk (an empty string is falsy, so a
/// hex string that decodes to nothing is never flushed).
fn decode_content_stream(content: &[u8]) -> Vec<u16> {
    let mut parts: Vec<Vec<u16>> = Vec::new();
    let mut pending: Option<Vec<u16>> = None;
    let mut pos = 0usize;
    while pos < content.len() {
        match content[pos] {
            b'(' => {
                if let Some((inner, end)) = scan_literal(content, pos) {
                    pending = None;
                    parts.push(decode_pdf_string(inner));
                    pos = end;
                    continue;
                }
                pos += 1;
            }
            b'<' => {
                if let Some((inner, end)) = scan_hex(content, pos) {
                    pending = Some(decode_hex_string(inner));
                    pos = end;
                    continue;
                }
                pos += 1;
            }
            _ => {
                if let Some((kind, end)) = try_operator(content, pos) {
                    let truthy = pending.as_ref().is_some_and(|text| !text.is_empty());
                    if truthy {
                        parts.push(pending.take().expect("pending checked non-empty"));
                    } else if kind == OperatorKind::Newline {
                        parts.push(vec![u16::from(b'\n')]);
                    }
                    pos = end;
                } else {
                    pos += 1;
                }
            }
        }
    }
    let mut joined: Vec<u16> = Vec::new();
    for part in parts {
        joined.extend_from_slice(&part);
    }
    joined
}

// ---------------------------------------------------------------------------
// extractInfoField for /Title.
// ---------------------------------------------------------------------------

/// Port of decodeUtf16: low bytes of the decoded code units; if they start
/// with a UTF-16BE BOM, re-decode the remainder big-endian.
fn decode_utf16be_from_bom(decoded: &[u16]) -> Option<Vec<u16>> {
    let bytes: Vec<u8> = decoded.iter().map(|unit| (*unit & 0xff) as u8).collect();
    if bytes.len() < 2 || bytes[0] != 0xfe || bytes[1] != 0xff {
        return None;
    }
    let mut text: Vec<u16> = Vec::new();
    let mut index = 2usize;
    while index + 1 < bytes.len() {
        text.push((u16::from(bytes[index]) << 8) | u16::from(bytes[index + 1]));
        index += 2;
    }
    Some(text)
}

/// Port of the hex branch of extractInfoField: strip whitespace, decode byte
/// pairs, keep 32 <= byte < 127, trim.
fn decode_hex_info_title(raw: &[u8]) -> Vec<u16> {
    let hex: Vec<u8> = raw
        .iter()
        .copied()
        .filter(|byte| !is_js_ws_byte(*byte))
        .collect();
    let mut text: Vec<u16> = Vec::new();
    let mut index = 0usize;
    while index < hex.len() {
        let high = hex_val(hex[index]);
        let low = hex_val(*hex.get(index + 1).unwrap_or(&0));
        let code = match (high, low) {
            (Some(high), Some(low)) => (high << 4) | low,
            (Some(high), None) => high,
            (None, _) => {
                index += 2;
                continue;
            }
        };
        if (32..127).contains(&code) {
            text.push(code);
        }
        index += 2;
    }
    trim_u16(text)
}

/// Port of extractInfoField(latin, "Title"). JS first scans the whole
/// document for `/Title\s*(literal)`; only if no direct match exists does it
/// scan for `/Title\s*<hex>`. Two passes replicate that ordering.
fn extract_info_field(data: &[u8]) -> Vec<u16> {
    let keyword = b"/Title";
    let mut search = 0usize;
    while let Some(at) = find_from(data, search, keyword) {
        let mut cursor = at + keyword.len();
        while cursor < data.len() && is_js_ws_byte(data[cursor]) {
            cursor += 1;
        }
        if cursor < data.len() && data[cursor] == b'(' {
            if let Some((inner, _)) = scan_literal(data, cursor) {
                let decoded = decode_pdf_string(inner);
                return decode_utf16be_from_bom(&decoded).unwrap_or(decoded);
            }
        }
        search = at + 1;
    }
    let mut search = 0usize;
    while let Some(at) = find_from(data, search, keyword) {
        let mut cursor = at + keyword.len();
        while cursor < data.len() && is_js_ws_byte(data[cursor]) {
            cursor += 1;
        }
        if cursor < data.len() && data[cursor] == b'<' {
            if let Some((inner, _)) = scan_hex(data, cursor) {
                return decode_hex_info_title(inner);
            }
        }
        search = at + 1;
    }
    Vec::new()
}

// ---------------------------------------------------------------------------
// Post-processing: `[ \t]+ -> " "`, `\n{3,} -> "\n\n"`, trim().
// ---------------------------------------------------------------------------

fn is_js_ws_unit(unit: u16) -> bool {
    matches!(
        unit,
        0x09 | 0x0a | 0x0b | 0x0c | 0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f
            | 0x205f | 0x3000 | 0xfeff
    )
}

fn trim_u16(mut text: Vec<u16>) -> Vec<u16> {
    let start = match text.iter().position(|unit| !is_js_ws_unit(*unit)) {
        Some(start) => start,
        None => return Vec::new(),
    };
    let end = text.iter().rposition(|unit| !is_js_ws_unit(*unit)).expect("non-empty after start");
    text.drain(..start);
    text.truncate(end - start + 1);
    text
}

fn collapse_whitespace(input: &[u16]) -> Vec<u16> {
    // replace(/[ \t]+/gu, " ")
    let mut step1: Vec<u16> = Vec::with_capacity(input.len());
    let mut index = 0usize;
    while index < input.len() {
        let unit = input[index];
        if unit == 0x20 || unit == 0x09 {
            step1.push(0x20);
            while index < input.len() && (input[index] == 0x20 || input[index] == 0x09) {
                index += 1;
            }
        } else {
            step1.push(unit);
            index += 1;
        }
    }
    // replace(/\n{3,}/gu, "\n\n")
    let mut step2: Vec<u16> = Vec::with_capacity(step1.len());
    let mut index = 0usize;
    while index < step1.len() {
        if step1[index] == 0x0a {
            let mut run = 0usize;
            while index + run < step1.len() && step1[index + run] == 0x0a {
                run += 1;
            }
            let keep = if run >= 3 { 2 } else { run };
            step2.extend(std::iter::repeat(0x0au16).take(keep));
            index += run;
        } else {
            step2.push(step1[index]);
            index += 1;
        }
    }
    trim_u16(step2)
}

// ---------------------------------------------------------------------------
// JSON serialization (no serde): correct escaping incl. \uXXXX for controls.
// ---------------------------------------------------------------------------

fn push_utf8(unit: u16, next: Option<u16>, out: &mut Vec<u8>) -> usize {
    // Combine a surrogate pair; replace lone surrogates (JSON.parse of a lone
    // surrogate escape is an edge case we accept losing).
    if (0xd800..0xdc00).contains(&unit) {
        if let Some(high_low) = next {
            if (0xdc00..0xe000).contains(&high_low) {
                let code_point = 0x1_0000u32
                    + ((u32::from(unit) - 0xd800) << 10)
                    + (u32::from(high_low) - 0xdc00);
                push_char(char::from_u32(code_point).unwrap_or('\u{fffd}'), out);
                return 2;
            }
        }
        push_char('\u{fffd}', out);
        return 1;
    }
    if (0xdc00..0xe000).contains(&unit) {
        push_char('\u{fffd}', out);
        return 1;
    }
    push_char(char::from_u32(u32::from(unit)).expect("BMP scalar"), out);
    1
}

fn push_char(ch: char, out: &mut Vec<u8>) {
    let mut buffer = [0u8; 4];
    out.extend_from_slice(ch.encode_utf8(&mut buffer).as_bytes());
}

fn json_escape_string(units: &[u16], out: &mut Vec<u8>) {
    out.push(b'"');
    let mut index = 0usize;
    while index < units.len() {
        let unit = units[index];
        match unit {
            0x22 => out.extend_from_slice(b"\\\""),
            0x5c => out.extend_from_slice(b"\\\\"),
            0x08 => out.extend_from_slice(b"\\b"),
            0x09 => out.extend_from_slice(b"\\t"),
            0x0a => out.extend_from_slice(b"\\n"),
            0x0c => out.extend_from_slice(b"\\f"),
            0x0d => out.extend_from_slice(b"\\r"),
            unit if unit < 0x20 => {
                out.extend_from_slice(format!("\\u{:04x}", unit).as_bytes());
            }
            _ => {
                index += push_utf8(unit, units.get(index + 1).copied(), out);
                continue;
            }
        }
        index += 1;
    }
    out.push(b'"');
}

fn build_json(info_title: &[u16], full_text: &[u16]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(b"{\"info_title\":");
    json_escape_string(info_title, &mut out);
    out.extend_from_slice(b",\"full_text\":");
    json_escape_string(full_text, &mut out);
    out.push(b'}');
    out
}

// ---------------------------------------------------------------------------
// Pure-Rust unit tests (host target): cargo test
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn lossy(units: &[u16]) -> String {
        String::from_utf16_lossy(units)
    }

    #[test]
    fn literal_escapes_and_octal() {
        assert_eq!(lossy(&decode_pdf_string(b"Hello \\(Wasm\\) World")), "Hello (Wasm) World");
        assert_eq!(lossy(&decode_pdf_string(b"a\\101\\102c")), "aABc");
        assert_eq!(lossy(&decode_pdf_string(b"n\\nr\\rt\\tb\\bf\\f")), "n\nr\rt\tb\x08f\x0c");
        assert_eq!(lossy(&decode_pdf_string(b"back\\slash")), "backslash");
        // Trailing lone backslash: JS `break`s and drops it.
        assert_eq!(lossy(&decode_pdf_string(b"end\\")), "end");
    }

    #[test]
    fn hex_utf16be_with_bom() {
        // <FEFF00410042> -> U+FEFF (kept: 0xFEFF >= 32, like the JS port) + "AB"
        assert_eq!(lossy(&decode_hex_string(b"FEFF00410042")), "\u{feff}AB");
        // Whitespace inside hex strings is ignored.
        assert_eq!(lossy(&decode_hex_string(b"FE FF 00 41")), "\u{feff}A");
        // Two-digit latin1 branch keeps 32..127 only.
        assert_eq!(lossy(&decode_hex_string(b"48656C6C6F")), "Hello");
        // Codes below 32 are dropped in the UTF-16 branch except \n and \r.
        assert_eq!(lossy(&decode_hex_string(b"000A00090042")), "\nB");
    }

    #[test]
    fn content_stream_operators() {
        let stream = b"BT /F1 12 Tf 72 720 Td (Hello \\(Wasm\\) World) Tj 0 -20 Td (Second line) Tj ET";
        assert_eq!(
            lossy(&decode_content_stream(stream)),
            "\nHello (Wasm) World\nSecond line\n"
        );
        // `T*` always counts as a line break now (see try_operator docs).
        assert_eq!(lossy(&decode_content_stream(b"(a) T* (b)")), "a\nb");
        assert_eq!(lossy(&decode_content_stream(b"(a) T*x (b)")), "a\nb");
    }

    #[test]
    fn info_title_literal_utf16_and_hex() {
        assert_eq!(
            lossy(&extract_info_field(b"<< /Title (Test Title) >>")),
            "Test Title"
        );
        // UTF-16BE with BOM in a literal string.
        let mut with_bom = b"<< /Title (".to_vec();
        with_bom.extend_from_slice(&[0xfe, 0xff, 0x00, 0x41, 0x00, 0x42]);
        with_bom.extend_from_slice(b") >>");
        assert_eq!(lossy(&extract_info_field(&with_bom)), "AB");
        // Hex form.
        assert_eq!(
            lossy(&extract_info_field(b"/Title <4869 20 21>")),
            "Hi !"
        );
        assert_eq!(lossy(&extract_info_field(b"<< /Author (x) >>")), "");
    }

    #[test]
    fn json_escaping() {
        let units: Vec<u16> = "a\"b\\c\u{1}\u{9}".encode_utf16().collect();
        let mut out = Vec::new();
        json_escape_string(&units, &mut out);
        let json = String::from_utf8(out).unwrap();
        assert_eq!(json, "\"a\\\"b\\\\c\\u0001\\t\"");
        assert_eq!(serde_parse(&json), "a\"b\\c\u{1}\u{9}");
    }

    // Minimal stand-in for JSON.parse in tests (host only).
    fn serde_parse(json: &str) -> String {
        let inner = json.trim_matches('"');
        let mut result = String::new();
        let mut chars = inner.chars();
        while let Some(ch) = chars.next() {
            if ch != '\\' {
                result.push(ch);
                continue;
            }
            match chars.next() {
                Some('u') => {
                    let hex: String = chars.by_ref().take(4).collect();
                    result.push(char::from_u32(u32::from_str_radix(&hex, 16).unwrap()).unwrap());
                }
                Some('n') => result.push('\n'),
                Some('t') => result.push('\t'),
                Some('r') => result.push('\r'),
                Some('b') => result.push('\u{8}'),
                Some('f') => result.push('\u{c}'),
                Some(other) => result.push(other),
                None => break,
            }
        }
        result
    }

    #[test]
    fn end_to_end_fixture() {
        let content = b"BT /F1 12 Tf 72 720 Td (Hello \\(Wasm\\) World) Tj 0 -20 Td (Second line) Tj ET";
        let inflated = miniz_oxide::deflate::compress_to_vec_zlib(content, 6);
        let mut pdf = Vec::new();
        pdf.extend_from_slice(b"%PDF-1.4\n1 0 obj\n<< /Title (Test Title) >>\nendobj\n2 0 obj\n<< /Filter /FlateDecode >>\nstream\n");
        pdf.extend_from_slice(&inflated);
        pdf.extend_from_slice(b"\nendstream\nendobj\n%%EOF\n");
        let json = run_extract(&pdf).unwrap();
        let parsed = String::from_utf8(json).unwrap();
        assert!(parsed.contains("Hello (Wasm) World"), "{parsed}");
        assert!(parsed.contains("Second line"), "{parsed}");
        assert!(parsed.contains("Test Title"), "{parsed}");
    }
}
