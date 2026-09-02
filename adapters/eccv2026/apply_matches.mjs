#!/usr/bin/env node

// Applies arXiv matches (data/source/arxiv_matches.jsonl, produced by
// enrich_arxiv.mjs) to records.jsonl: fills abstracts and attaches
// upstream.arxiv provenance. Records without a match stay abstract-free with
// availability metadata — nothing is inferred or guessed.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RECORDS = path.join(ROOT, "data", "source", "records.jsonl");
const MATCHES = path.join(ROOT, "data", "source", "arxiv_matches.jsonl");

async function main() {
  const records = (await readFile(RECORDS, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const matchLines = (await readFile(MATCHES, "utf8")).trim().split("\n").filter(Boolean);
  const matches = new Map(matchLines.map((line) => {
    const match = JSON.parse(line);
    return [match.recordId, match];
  }));
  let applied = 0;
  const merged = records.map((record) => {
    const match = matches.get(record.id);
    if (!match) return record;
    applied += 1;
    return {
      ...record,
      abstract: match.abstract || record.abstract,
      pdfUrl: match.arxivId ? `https://arxiv.org/pdf/${match.arxivId}` : record.pdfUrl,
      upstream: {
        ...record.upstream,
        arxiv: {
          id: match.arxivId,
          absUrl: `https://arxiv.org/abs/${match.arxivId}`,
          pdfUrl: `https://arxiv.org/pdf/${match.arxivId}`,
          primaryCategory: match.primaryCategory || "",
          published: match.published || "",
          arxivTitle: match.arxivTitle || "",
        },
      },
    };
  });
  if (applied !== matches.size) {
    process.stderr.write(`warning: ${matches.size - applied} matches had no corresponding record\n`);
  }
  await writeFile(RECORDS, `${merged.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  process.stdout.write(`Applied ${applied}/${records.length} arXiv matches to ${path.relative(ROOT, RECORDS)}\n`);
}

await main();
