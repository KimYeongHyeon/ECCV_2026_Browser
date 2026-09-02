#!/usr/bin/env node

// Downloads arXiv PDFs for matched ECCV 2026 records into the template's
// data/pdfs/ convention (data/pdfs/<recordId>.pdf, where recordId matches
// data/source/records.jsonl). Resumable: an existing non-empty file of the
// right size is skipped, failures are retried on the next run, and every
// attempt is logged to data/source/pdf_download_log.jsonl.

import { mkdir, readFile, stat, writeFile, appendFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RECORDS = path.join(ROOT, "data", "source", "records.jsonl");
const MATCHES = path.join(ROOT, "data", "source", "arxiv_matches.jsonl");
const PDF_DIR = path.join(ROOT, "data", "pdfs");
const LOG = path.join(ROOT, "data", "source", "pdf_download_log.jsonl");

const DELAY_MS = 1800;
const JITTER_MS = 700;
const USER_AGENT = "ECCV2026Atlas/0.1 (unofficial conference browser; contact: github.com/KimYeongHyeon)";
const MAX_RETRIES = 3;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sizeOf(filePath) {
  try {
    return (await stat(filePath)).size;
  } catch {
    return 0;
  }
}

async function downloadPdf(arxivId, destination) {
  const url = `https://arxiv.org/pdf/${arxivId}`;
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "application/pdf" },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 2000 || !buffer.subarray(0, 5).toString("latin1").startsWith("%PDF-")) {
    throw new Error(`Not a PDF (${buffer.length} bytes) for ${url}`);
  }
  await writeFile(destination, buffer);
  return buffer.length;
}

async function main() {
  const [recordLines, matchLines] = await Promise.all([
    readFile(RECORDS, "utf8"),
    readFile(MATCHES, "utf8").catch(() => ""),
  ]);
  const records = recordLines.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const known = new Set(records.map((record) => record.id));
  const matches = matchLines.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const queue = matches.filter((match) => known.has(match.recordId));
  await mkdir(PDF_DIR, { recursive: true });
  await appendFile(LOG, "").catch(() => {});
  process.stdout.write(`${queue.length} matched records to check (PDF dir: ${path.relative(ROOT, PDF_DIR)})\n`);

  let downloaded = 0;
  let skipped = 0;
  let failed = 0;
  for (let index = 0; index < queue.length; index += 1) {
    const match = queue[index];
    const destination = path.join(PDF_DIR, `${match.recordId}.pdf`);
    const existing = await sizeOf(destination);
    if (existing > 2000) {
      skipped += 1;
      continue;
    }
    let ok = false;
    let error = "";
    for (let attempt = 1; attempt <= MAX_RETRIES && !ok; attempt += 1) {
      try {
        const bytes = await downloadPdf(match.arxivId, destination);
        ok = true;
        downloaded += 1;
        await appendFile(LOG, `${JSON.stringify({ recordId: match.recordId, arxivId: match.arxivId, status: "downloaded", bytes, at: new Date().toISOString() })}\n`);
      } catch (reason) {
        error = String(reason.message || reason);
        if (/HTTP 40[34]/.test(error)) break; // do not retry hard failures
        await sleep(DELAY_MS * attempt);
      }
    }
    if (!ok) {
      failed += 1;
      await appendFile(LOG, `${JSON.stringify({ recordId: match.recordId, arxivId: match.arxivId, status: "failed", error, at: new Date().toISOString() })}\n`);
    }
    if ((index + 1) % 25 === 0) {
      process.stdout.write(`  ${index + 1}/${queue.length}: downloaded ${downloaded}, skipped ${skipped}, failed ${failed}\n`);
    }
    await sleep(DELAY_MS + Math.random() * JITTER_MS);
  }
  process.stdout.write(`Done: downloaded ${downloaded}, already present ${skipped}, failed ${failed} (of ${queue.length})\n`);
  process.stdout.write(`Failures are retried on the next run; see ${path.relative(ROOT, LOG)}\n`);
}

await main();
