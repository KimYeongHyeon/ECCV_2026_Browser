#!/usr/bin/env node

// Best-effort, dependency-free PDF text extraction.
//
// The goal is not a full PDF parser. It recovers enough text for the atlas
// pipeline: a title fallback, an abstract paragraph, and reference entries.
// PDFs that use exotic encodings may extract poorly; callers must treat every
// result as optional and report extraction failures instead of crashing.

import { inflateSync, inflateRawSync } from "node:zlib";

import { extractPdfTextNativeSync, nativeAvailable } from "./pdf_native.mjs";

function decodePdfString(raw) {
  let text = "";
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === "\\") {
      const next = raw[index + 1];
      if (next === undefined) break;
      if (next >= "0" && next <= "7") {
        let octal = "";
        let cursor = index + 1;
        while (cursor < raw.length && octal.length < 3 && raw[cursor] >= "0" && raw[cursor] <= "7") {
          octal += raw[cursor];
          cursor += 1;
        }
        text += String.fromCharCode(parseInt(octal, 8));
        index = cursor - 1;
        continue;
      }
      const escapes = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };
      text += escapes[next] ?? next;
      index += 1;
      continue;
    }
    text += char;
  }
  return text;
}

function decodeUtf16(value) {
  const bytes = [];
  for (let index = 0; index < value.length; index += 1) bytes.push(value.charCodeAt(index) & 0xff);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    let text = "";
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      text += String.fromCharCode((bytes[index] << 8) | bytes[index + 1]);
    }
    return text;
  }
  return null;
}

function inflateStreams(buffer) {
  const chunks = [];
  const latin = buffer.toString("latin1");
  const streamPattern = /stream\r?\n?/gu;
  let match;
  while ((match = streamPattern.exec(latin)) !== null) {
    const start = match.index + match[0].length;
    const end = latin.indexOf("endstream", start);
    if (end < 0) break;
    streamPattern.lastIndex = end;
    const slice = buffer.subarray(start, end);
    const candidates = [inflateSync, inflateRawSync];
    let text = null;
    for (const inflate of candidates) {
      try {
        text = inflate(slice).toString("latin1");
        break;
      } catch {
        text = null;
      }
    }
    if (text) chunks.push(text);
  }
  return chunks;
}

function decodeContentStreams(content) {
  const parts = [];
  const operatorPattern = /\((?:[^()\\]|\\[\s\S])*\)|<[0-9A-Fa-f\s]+>|\bT[jJ]\b|\bTd\b|\bTD\b|\bT\*|\bET\b/gu;
  let pendingHex = null;
  let match;
  while ((match = operatorPattern.exec(content)) !== null) {
    const token = match[0];
    if (token.startsWith("(")) {
      const inner = token.slice(1, -1);
      pendingHex = null;
      parts.push(decodePdfString(inner));
    } else if (token.startsWith("<")) {
      const hex = token.slice(1, -1).replace(/\s+/gu, "");
      if (hex.length % 4 === 0 && /^(00|01|fe|ff)/iu.test(hex)) {
        let text = "";
        for (let index = 0; index < hex.length; index += 4) {
          const code = parseInt(hex.slice(index, index + 4), 16);
          if (code >= 32 || code === 10 || code === 13) text += String.fromCharCode(code);
        }
        pendingHex = text;
      } else {
        let text = "";
        for (let index = 0; index < hex.length; index += 2) {
          const code = parseInt(hex.slice(index, index + 2), 16);
          if (code >= 32 && code < 127) text += String.fromCharCode(code);
        }
        pendingHex = text;
      }
    } else if (token === "Tj" || token === "TJ") {
      if (pendingHex) {
        parts.push(pendingHex);
        pendingHex = null;
      }
    } else if (pendingHex) {
      parts.push(pendingHex);
      pendingHex = null;
    } else if (token === "Td" || token === "TD" || token === "T*" || token === "ET") {
      parts.push("\n");
    }
  }
  return parts.join("");
}

function extractInfoField(latin, field) {
  const direct = new RegExp(`/${field}\\s*\\(((?:[^()\\\\]|\\\\[\\s\\S])*)\\)`, "u").exec(latin);
  if (direct) {
    const decoded = decodePdfString(direct[1]);
    return decodeUtf16(decoded) ?? decoded;
  }
  const hex = new RegExp(`/${field}\\s*<([0-9A-Fa-f\\s]+)>`, "u").exec(latin);
  if (hex) {
    const bytes = (hex[1].replace(/\s+/gu, "").match(/.{2}/gu) || []).map((pair) => parseInt(pair, 16));
    let text = "";
    for (let index = 0; index < bytes.length; index += 1) {
      if (bytes[index] >= 32 && bytes[index] < 127) text += String.fromCharCode(bytes[index]);
    }
    return text.trim();
  }
  return "";
}

// Pure-JS implementation (kept as the fallback when the wasm module is
// missing or fails).
function extractPdfTextJs(buffer) {
  const latin = buffer.toString("latin1");
  const infoTitle = extractInfoField(latin, "Title");
  const streams = inflateStreams(buffer);
  const pageTexts = streams.map(decodeContentStreams);
  const fullText = pageTexts
    .join("\n")
    .replace(/[ \t]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return { infoTitle, fullText };
}

// Native (wasm) first; any failure falls back to the pure-JS implementation.
// Kept synchronous: callers destructure the result directly (see ingest.mjs).
export function extractPdfText(buffer) {
  if (nativeAvailable) {
    try {
      return extractPdfTextNativeSync(buffer);
    } catch {
      // Fall through to the pure-JS implementation below.
    }
  }
  return extractPdfTextJs(buffer);
}

export function guessTitleFromText(fullText) {
  const lines = String(fullText || "").split("\n").map((line) => line.trim()).filter(Boolean);
  for (const line of lines.slice(0, 15)) {
    if (/^\d+$/.test(line)) continue;
    if (line.length < 12 || line.length > 220) continue;
    if (/^(abstract|introduction|keywords?|proceedings|copyright|doi|https?:)/iu.test(line)) continue;
    if (/[a-z]{3}/u.test(line) && /[A-Z]/u.test(line)) return line;
  }
  return "";
}

export function extractAbstract(fullText) {
  const text = String(fullText || "");
  const match = /abstract\b[:.\s-]*([\s\S]{80,2200}?)(?=\n\s*(?:1\s+introduction|1\.?\s|introduction|keywords?|categories|ccs concepts|acm reference|permission to make)\b|[.\n]*\n\s*\n\s*[A-Z0-9])/giu.exec(text);
  if (!match) return "";
  const sentences = match[1].replace(/\s+/gu, " ").trim();
  return sentences.length >= 80 ? sentences : "";
}

function normalizeReferenceKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim().replace(/\s+/gu, " ");
}

export function extractReferences(fullText) {
  const text = String(fullText || "");
  const anchor = /\n\s*(references|bibliography)\s*\n/giu.exec(text);
  if (!anchor) return [];
  const section = text.slice(anchor.index + anchor[0].length, anchor.index + anchor[0].length + 30000);
  const cleaned = section.replace(/\n\s*references\s*\n/giu, "\n");
  const entries = cleaned
    .split(/\n(?=\[\d{1,3}\]\s|\d{1,3}\.\s(?=[A-Z"“]))/gu)
    .map((entry) => entry.replace(/\s+/gu, " ").trim())
    .filter((entry) => entry.length > 40 && entry.length < 1200 && /[a-z]{3}/u.test(entry));
  return entries.slice(0, 400).map((raw) => {
    const titleMatch = /^(?:\[\d{1,3}\]|\d{1,3}\.)\s*"?([^.""]{10,240})[.""]?/u.exec(raw);
    const yearMatch = /(?:\b|\()((?:19|20)\d{2})(?:\b|\))/u.exec(raw);
    return {
      title: (titleMatch ? titleMatch[1] : raw.slice(0, 160)).trim(),
      year: yearMatch ? yearMatch[1] : "",
      key: normalizeReferenceKey(raw).slice(0, 240),
      raw: raw.slice(0, 600),
    };
  }).filter((reference) => reference.key.length > 12);
}
