#!/usr/bin/env node

// ECCV 2026 accepted-papers collector.
//
// Parses the official ECVA "List of Accepted Papers" snapshot
// (data/snapshots/eccv2026_accepted_papers.html, fetched from
// https://eccv.ecva.net/Conferences/2026/AcceptedPapers) into normalized
// records. Idempotent: same snapshot in, same records out.
//
// Output: data/source/records.jsonl
// Each entry on the official page carries: virtual-site poster id, title,
// authors (⋅ separated), primary keywords (; separated), room, poster board
// number, presentation time, and poster session. Abstracts are not published
// on the page and are added later by enrich_arxiv.mjs.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SNAPSHOT = path.join(ROOT, "data", "snapshots", "eccv2026_accepted_papers.html");
const OUTPUT = path.join(ROOT, "data", "source", "records.jsonl");

function decodeEntities(value) {
  return value
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, "\"")
    .replace(/&#39;|&apos;/gu, "'")
    .replace(/&nbsp;/gu, " ")
    .replace(/&ndash;/gu, "–")
    .replace(/&mdash;/gu, "—")
    .replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number(code)));
}

function stripTags(value) {
  return decodeEntities(String(value || "").replace(/<[^>]+>/g, " ")).replace(/\s+/gu, " ").trim();
}

function parseRow(row) {
  const link = /<a href="\/virtual\/2026\/poster\/(\d+)">([\s\S]*?)<\/a>/u.exec(row);
  if (!link) return null;
  const id = `eccv-${link[1]}`;
  const title = stripTags(link[2]);
  const authorsBlock = /<div class="indented">\s*<i>([\s\S]*?)<\/i>/u.exec(row);
  const authors = authorsBlock
    ? stripTags(authorsBlock[1]).split(/\s*⋅\s*/u).map((name) => name.trim()).filter(Boolean)
    : [];
  const keywordsBlock = /<td class="elc-keywords">\s*([\s\S]*?)\s*<\/td>/u.exec(row);
  const keywords = keywordsBlock
    ? stripTags(keywordsBlock[1]).split(";").map((keyword) => keyword.trim()).filter(Boolean)
    : [];
  const where = {
    room: /In Room:\s*([^<]*?)</u.exec(row)?.[1]?.trim() || "",
    board: /Poster Location:\s*#\s*([\w-]+)/u.exec(row)?.[1]?.trim() || "",
    time: /at\s+([^<]*?)(?:<|\s{2})/u.exec(row)?.[1]?.trim() || "",
    session: /in\s+(Poster Session [\dA-Za-z ]+?)\.?\s*(?:<|$)/u.exec(row)?.[1]?.trim() || "",
  };
  return { id, title, authors, keywords, ...where };
}

async function main() {
  const snapshot = await readFile(SNAPSHOT, "utf8");
  const rows = snapshot.split(/<tr[^>]*>/u).map(parseRow).filter(Boolean);
  const sourceCheckedAt = new Date().toISOString();
  const seen = new Set();
  const records = [];
  for (const row of rows) {
    if (seen.has(row.id)) {
      process.stderr.write(`duplicate id ${row.id}\n`);
      continue;
    }
    seen.add(row.id);
    records.push({
      id: row.id,
      type: "paper",
      title: row.title,
      abstract: "",
      authors: row.authors,
      authorAffiliations: [],
      searchAliases: [],
      group: row.session || "Main Conference",
      category: row.keywords[0] || "Other",
      categoryTags: row.keywords.length ? row.keywords : ["Other"],
      areaTags: [],
      domainTags: [],
      sourceType: "ecva_accepted_list",
      sourceUrl: `https://eccv.ecva.net/virtual/2026/poster/${row.id.replace(/^eccv-/, "")}`,
      sourceCheckedAt,
      pageUrl: `https://eccv.ecva.net/virtual/2026/poster/${row.id.replace(/^eccv-/, "")}`,
      presentationType: "Poster",
      presentationLabels: ["Poster"],
      session: row.session,
      roomName: row.room,
      startTime: row.time,
      upstream: {
        posterBoard: row.board,
        officialList: "https://eccv.ecva.net/Conferences/2026/AcceptedPapers",
      },
    });
  }
  if (!records.length) throw new Error("No records parsed from the snapshot.");
  await mkdir(path.dirname(OUTPUT), { recursive: true });
  const lines = records.map((record) => JSON.stringify(record)).join("\n");
  await writeFile(OUTPUT, `${lines}\n`, "utf8");
  const withKeywords = records.filter((record) => record.categoryTags.length > 0).length;
  process.stdout.write(`Parsed ${records.length} accepted papers -> ${path.relative(ROOT, OUTPUT)}\n`);
  process.stdout.write(`  with keywords: ${withKeywords}, with authors: ${records.filter((record) => record.authors.length).length}\n`);
}

await main();
