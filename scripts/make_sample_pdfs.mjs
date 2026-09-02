#!/usr/bin/env node

// Regenerates the two sample PDFs in data/pdfs/ (tiny synthetic papers with
// shared bibliographies) used by the template's example corpus. The PDFs are
// committed so a fresh template clone demonstrates PDF ingestion, abstract
// extraction, the built-in viewer, and the References view out of the box.

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function escapePdfString(value) {
  return value.replace(/\\/gu, "\\\\").replace(/\(/gu, "\\(").replace(/\)/gu, "\\)");
}

function buildPdf(title, lines) {
  let content = "BT /F1 11 Tf 72 720 Td 18 TL\n";
  for (const line of lines) content += `(${escapePdfString(line)}) Tj 0 -18 Td\n`;
  content += "ET";
  const compressed = deflateSync(Buffer.from(content, "latin1"));
  const objects = [];
  objects[1] = Buffer.from("1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n", "latin1");
  objects[2] = Buffer.from("2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n", "latin1");
  objects[3] = Buffer.from("3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> endobj\n", "latin1");
  objects[4] = Buffer.concat([
    Buffer.from(`4 0 obj << /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`, "latin1"),
    compressed,
    Buffer.from("\nendstream endobj\n", "latin1"),
  ]);
  objects[5] = Buffer.from("5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n", "latin1");
  objects[6] = Buffer.from(`6 0 obj << /Title (${escapePdfString(title)}) >> endobj\n`, "latin1");
  const offsets = [0];
  let total = 9; // "%PDF-1.4\n"
  for (let index = 1; index <= 6; index += 1) {
    offsets[index] = total;
    total += objects[index].length;
  }
  let trailer = `xref\n0 7\n0000000000 65535 f \n`;
  for (let index = 1; index <= 6; index += 1) trailer += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  trailer += `trailer << /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n${total}\n%%EOF\n`;
  return Buffer.concat([Buffer.from("%PDF-1.4\n", "latin1"), ...objects.slice(1), Buffer.from(trailer, "latin1")]);
}

const SHARED_REFERENCES = [
  "[1] Vaswani et al. Attention Is All You Need. NeurIPS 2017.",
  "[2] He et al. Deep Residual Learning for Image Recognition. CVPR 2015.",
];

const pdfs = {
  "demo-llm-1.pdf": buildPdf(
    "Sparse Attention Serving for Long-Context Language Models",
    [
      "Abstract",
      "We study efficient serving of long-context language models with sparse",
      "attention and a chunked KV-cache scheduler that keeps memory bounded.",
      "The scheduler preserves answer quality on long-document benchmarks.",
      "1 Introduction",
      "Serving long contexts is expensive in memory and compute.",
      "References",
      ...SHARED_REFERENCES,
      "[3] Chen et al. Chunked KV-Cache Scheduling for Long Contexts. MLSys 2024.",
    ],
  ),
  "demo-llm-2.pdf": buildPdf(
    "Quantized LoRA Fine-Tuning Under a Fixed Memory Budget",
    [
      "Abstract",
      "We fine-tune language models with 4-bit quantized LoRA adapters",
      "under a strict memory budget using a budget-aware rank scheduler.",
      "1 Introduction",
      "Adapters reduce memory but quantization adds representation error.",
      "References",
      ...SHARED_REFERENCES,
      "[3] Dettmers et al. QLoRA Efficient Finetuning of Quantized LLMs. NeurIPS 2023.",
    ],
  ),
};

const outputDir = path.join(ROOT, "data", "pdfs");
mkdirSync(outputDir, { recursive: true });
for (const [name, bytes] of Object.entries(pdfs)) {
  writeFileSync(path.join(outputDir, name), bytes);
  console.log(`wrote data/pdfs/${name} (${bytes.length} bytes)`);
}
