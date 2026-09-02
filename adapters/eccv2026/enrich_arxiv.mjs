#!/usr/bin/env node

// arXiv enrichment for the ECCV 2026 accepted list.
//
// Matches records against arXiv by exact normalized title (the template's
// cited-public-source policy: no fuzzy matching, no guessed metadata). For
// every match it fills the record abstract and attaches upstream.arxiv
// provenance (id, categories, published, arXiv title).
//
// Batches titles into OR queries against the arXiv API, caches every raw
// response under .cache/arxiv/<batch>.xml so re-runs are warm-started, and
// writes data/source/arxiv_matches.jsonl (recordId -> match) plus a summary.
// PDFs are downloaded separately by download_pdfs.mjs.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RECORDS = path.join(ROOT, "data", "source", "records.jsonl");
const MATCHES = path.join(ROOT, "data", "source", "arxiv_matches.jsonl");
const CACHE = path.join(ROOT, ".cache", "arxiv");

const BATCH_SIZE = 8;
const MAX_RESULTS = 40;
const REQUEST_DELAY_MS = 3200;
const USER_AGENT = "ECCV2026Atlas/0.1 (unofficial conference browser; contact: github.com/KimYeongHyeon)";

function normalizeTitle(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function queryTitle(value) {
  return String(value || "")
    .replace(/["""]/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 220);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseFeed(xml) {
  const entries = [];
  for (const chunk of xml.split("<entry>").slice(1)) {
    const pick = (tag) => {
      const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "u").exec(chunk);
      return match ? match[1].replace(/\s+/gu, " ").trim() : "";
    };
    const idMatch = /<id>http:\/\/arxiv\.org\/abs\/([^<]+)<\/id>/u.exec(chunk);
    const categories = [...chunk.matchAll(/<category[^>]*term="([^"]+)"/gu)].map((match) => match[1]);
    entries.push({
      arxivId: idMatch ? idMatch[1] : "",
      title: pick("title"),
      summary: pick("summary"),
      published: pick("published"),
      primaryCategory: /<arxiv:primary_category[^>]*term="([^"]+)"/u.exec(chunk)?.[1] || categories[0] || "",
      authors: [...chunk.matchAll(/<name>([\s\S]*?)<\/name>/gu)].map((match) => match[1].trim()),
    });
  }
  return entries;
}

async function fetchBatch(batchIndex, titles) {
  const cachePath = path.join(CACHE, `batch-${String(batchIndex).padStart(4, "0")}.xml`);
  try {
    const cached = await readFile(cachePath, "utf8");
    if (cached.includes("<entry>") || cached.includes("<!-- empty -->")) return cached;
  } catch {
    // Not cached yet.
  }
  const query = titles
    .map((title) => `ti:%22${encodeURIComponent(queryTitle(title))}%22`)
    .join("+OR+");
  const url = `https://export.arxiv.org/api/query?search_query=${query}&start=0&max_results=${MAX_RESULTS}`;
  let body = "";
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { "user-agent": USER_AGENT } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      body = await response.text();
      break;
    } catch (error) {
      if (attempt >= 4) throw error;
      process.stderr.write(`  retry batch ${batchIndex} after error: ${error.message}\n`);
      await sleep(REQUEST_DELAY_MS * attempt);
    }
  }
  const payload = body.includes("<entry>") ? body : "<!-- empty -->";
  await writeFile(cachePath, payload, "utf8");
  await sleep(REQUEST_DELAY_MS);
  return payload;
}

async function main() {
  const records = (await readFile(RECORDS, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  await mkdir(CACHE, { recursive: true });
  const cachedFiles = new Set(await readdir(CACHE));
  const batches = [];
  for (let index = 0; index < records.length; index += BATCH_SIZE) {
    batches.push(records.slice(index, index + BATCH_SIZE));
  }
  process.stdout.write(`${records.length} records in ${batches.length} batches (batch size ${BATCH_SIZE})\n`);
  const matches = new Map();
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    const cacheName = `batch-${String(index).padStart(4, "0")}.xml`;
    const wasCached = cachedFiles.has(cacheName);
    const xml = await fetchBatch(index, batch.map((record) => record.title));
    const entries = xml.includes("<entry>") ? parseFeed(xml) : [];
    const byTitle = new Map(entries.map((entry) => [normalizeTitle(entry.title), entry]));
    for (const record of batch) {
      const entry = byTitle.get(normalizeTitle(record.title));
      if (entry && entry.arxivId) {
        matches.set(record.id, {
          recordId: record.id,
          arxivId: entry.arxivId,
          primaryCategory: entry.primaryCategory,
          categories: categoriesOf(entry),
          published: entry.published,
          arxivTitle: entry.title,
          abstract: entry.summary,
          arxivAuthors: entry.authors,
        });
      }
    }
    if (index % 10 === 0 || index === batches.length - 1) {
      process.stdout.write(`  batch ${index + 1}/${batches.length} (${wasCached ? "warm" : "fetched"}): matched so far ${matches.size}\n`);
    }
  }
  const lines = [...matches.values()].map((match) => JSON.stringify(match)).join("\n");
  await writeFile(MATCHES, lines ? `${lines}\n` : "", "utf8");
  process.stdout.write(`Matched ${matches.size}/${records.length} records -> ${path.relative(ROOT, MATCHES)}\n`);
}

function categoriesOf(entry) {
  return entry.categories ? entry.categories.slice(0, 8) : [];
}

await main();
