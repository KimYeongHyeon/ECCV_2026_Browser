#!/usr/bin/env node

// Tests for scripts/lib/pdf.mjs: the wasm-accelerated extractPdfText hot path
// (with pure-JS fallback) plus the pure-JS abstract/reference heuristics.

import test from "node:test";
import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";

import { extractAbstract, extractPdfText, extractReferences } from "../lib/pdf.mjs";

// Build a minimal single-object-ish PDF in memory: one Info-ish /Title object
// (outside any stream) and one FlateDecode content stream. The extractor does
// not validate xref tables, so no offsets are needed.
function buildFixturePdf() {
  const contentStream =
    "BT /F1 12 Tf 72 720 Td (Hello \\(Wasm\\) World) Tj 0 -20 Td (Second line) Tj ET";
  const compressed = deflateSync(Buffer.from(contentStream, "latin1"));
  return Buffer.concat([
    Buffer.from("%PDF-1.4\n", "latin1"),
    Buffer.from("1 0 obj\n<< /Title (Test Title) >>\nendobj\n", "latin1"),
    Buffer.from(
      `2 0 obj\n<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`,
      "latin1",
    ),
    compressed,
    Buffer.from("\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n", "latin1"),
  ]);
}

test("extractPdfText recovers text and info title from a fixture PDF", () => {
  const { infoTitle, fullText } = extractPdfText(buildFixturePdf());
  assert.equal(typeof fullText, "string");
  assert.ok(fullText.includes("Hello (Wasm) World"), `fullText: ${JSON.stringify(fullText)}`);
  assert.ok(fullText.includes("Second line"), `fullText: ${JSON.stringify(fullText)}`);
  assert.equal(infoTitle, "Test Title");
});

test("extractPdfText is deterministic across repeated calls", () => {
  const buffer = buildFixturePdf();
  const first = extractPdfText(buffer);
  const second = extractPdfText(buffer);
  assert.deepStrictEqual(first, second);
});

test("extractAbstract pulls the abstract paragraph from synthetic text", () => {
  const fullText = [
    "Deep Learning for Atlas Maps",
    "Grace Hopper and Alan Turing",
    "",
    "Abstract",
    "We present a thorough study of retrieval quality in very large digital libraries and",
    "describe a scalable pipeline that extracts clean text from research papers at conference",
    "scale with only modest compute resources.",
    "",
    "1 Introduction",
    "Researchers have long studied large collections of documents.",
  ].join("\n");
  const abstract = extractAbstract(fullText);
  assert.ok(abstract.length >= 80, `abstract too short: ${JSON.stringify(abstract)}`);
  assert.ok(abstract.includes("retrieval quality"), abstract);
  assert.ok(!abstract.includes("1 Introduction"), abstract);
});

test("extractReferences parses a synthetic References section", () => {
  const fullText = [
    "Some paper body text goes here and talks about prior work in the field at length.",
    "References",
    "[1] A. Lovelace, On the analytical engine and its application to general mechanical computation, 1996",
    "[2] G. Hopper, Compiling routines for the arithmetic behavior of stored program machines, 1952",
    "",
  ].join("\n");
  const references = extractReferences(fullText);
  assert.ok(references.length >= 2, `expected >= 2 references, got ${references.length}`);
  assert.equal(references[0].year, "1996");
  assert.equal(references[1].year, "1952");
  assert.ok(references[0].title.includes("analytical engine"), references[0].title);
  assert.ok(references.every((reference) => reference.key.length > 12));
});
