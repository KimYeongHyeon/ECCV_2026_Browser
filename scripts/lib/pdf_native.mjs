#!/usr/bin/env node

// Native (Rust -> WebAssembly) hot path for PDF text extraction.
//
// Loads `scripts/vendor/pdf_extract.wasm` (built from `rust/pdf-extract/`)
// lazily and instantiates it synchronously. The wasm module exposes a flat C
// ABI: alloc/extract/result_ptr/result_len/dealloc plus `memory`.
//
// If the wasm artifact is missing or cannot be instantiated, `nativeAvailable`
// is false and the extract functions throw a clear error; callers
// (scripts/lib/pdf.mjs) catch that and fall back to the pure-JS implementation.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const wasmPath = join(dirname(fileURLToPath(import.meta.url)), "..", "vendor", "pdf_extract.wasm");

export const nativeAvailable = existsSync(wasmPath);

let instance = null;
let instanceError = null;

function getInstance() {
  if (instance) return instance;
  if (instanceError) throw instanceError;
  try {
    const bytes = readFileSync(wasmPath);
    instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {});
  } catch (error) {
    instanceError = new Error(
      `pdf_extract.wasm could not be loaded from ${wasmPath}: ${error?.message || error}`,
    );
    throw instanceError;
  }
  return instance;
}

// Write bytes into wasm memory via alloc, run extract, read the JSON result
// from result_ptr/result_len, then free the input buffer via dealloc.
function extractSync(buffer) {
  const wasm = getInstance();
  const { alloc, extract, result_ptr, result_len, dealloc, memory } = wasm.exports;
  const pointer = alloc(buffer.length);
  try {
    new Uint8Array(memory.buffer, pointer, buffer.length).set(buffer);
    const code = extract(buffer.length);
    if (code !== 0) {
      throw new Error(`wasm pdf extraction failed with code ${code}`);
    }
    // `extract` may have grown memory, so read `memory.buffer` fresh here.
    const output = new Uint8Array(memory.buffer, result_ptr(), result_len());
    const parsed = JSON.parse(new TextDecoder().decode(output.slice()));
    return {
      infoTitle: typeof parsed.info_title === "string" ? parsed.info_title : "",
      fullText: typeof parsed.full_text === "string" ? parsed.full_text : "",
    };
  } finally {
    try {
      dealloc(pointer, buffer.length);
    } catch {
      // Never let cleanup mask the extraction result.
    }
  }
}

export function extractPdfTextNativeSync(buffer) {
  return extractSync(buffer);
}

export async function extractPdfTextNative(buffer) {
  return extractSync(buffer);
}
