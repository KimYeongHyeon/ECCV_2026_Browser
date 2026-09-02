#!/usr/bin/env node

// PDF ingest: drop files into data/pdfs/ and the build picks them up.
//
// - The filename (minus .pdf) is matched to a record id; unmatched PDFs become
//   new metadata-only records so a folder of PDFs alone can bootstrap a corpus.
// - Extraction results are cached under .cache/atlas/pdf/<sha256>.json, so
//   re-running the build never re-parses an unchanged PDF (warm start).
// - Extracted abstracts and references fill gaps in the CSV/JSONL metadata.
// - Files are copied to docs/pdfs/ for serving; unchanged files are skipped.

import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { normalizeWhitespace } from "./text.mjs";
import { extractAbstract, extractPdfText, extractReferences, guessTitleFromText } from "./pdf.mjs";
import { sha256Hex } from "./text.mjs";

export async function ingestPdfs({ root, records, cacheDir, docsPdfDir }) {
  const pdfDir = path.join(root, "data", "pdfs");
  let files = [];
  try {
    files = (await readdir(pdfDir)).filter((name) => name.toLowerCase().endsWith(".pdf")).sort();
  } catch {
    files = [];
  }
  await mkdir(cacheDir, { recursive: true });
  const report = { found: files.length, extracted: 0, reused: 0, failed: 0, copied: 0, referencesTotal: 0 };
  const referencesByRecord = new Map();
  if (!files.length) return { records, report, referencesByRecord };

  const recordsById = new Map(records.map((record) => [record.id, record]));
  const usedPdfIds = new Set(records.map((record) => record.localPdfFile).filter(Boolean));
  const synthesized = [];

  for (const fileName of files) {
    const recordId = fileName.replace(/\.pdf$/iu, "");
    const filePath = path.join(pdfDir, fileName);
    const buffer = await readFile(filePath);
    const hash = sha256Hex(buffer);
    const cachePath = path.join(cacheDir, `${hash}.json`);
    let extraction;
    try {
      extraction = JSON.parse(await readFile(cachePath, "utf8"));
      report.reused += 1;
    } catch {
      try {
        const { infoTitle, fullText } = extractPdfText(buffer);
        extraction = {
          id: recordId,
          file: fileName,
          sha256: hash,
          title: normalizeWhitespace(infoTitle) || guessTitleFromText(fullText),
          abstract: extractAbstract(fullText),
          references: extractReferences(fullText),
          extractedAt: new Date().toISOString(),
          status: fullText.length > 400 ? "ok" : "sparse",
        };
        report.extracted += 1;
      } catch (error) {
        extraction = { id: recordId, file: fileName, sha256: hash, status: "failed", error: String(error.message || error), references: [] };
        report.failed += 1;
      }
      await writeFile(cachePath, `${JSON.stringify(extraction)}\n`, "utf8");
    }
    report.referencesTotal += (extraction.references || []).length;
    if ((extraction.references || []).length) referencesByRecord.set(recordId, extraction.references);

    let record = recordsById.get(recordId);
    if (!record && !usedPdfIds.has(recordId)) {
      record = {
        id: recordId,
        type: "paper",
        title: extraction.title || recordId,
        abstract: "",
        authors: [],
        authorAffiliations: [],
        searchAliases: [],
        group: "Main Conference",
        category: "Other",
        categoryTags: ["Other"],
        areaTags: [],
        domainTags: [],
        sourceType: "pdf_ingest",
        sourceUrl: "",
        sourceCheckedAt: new Date().toISOString(),
      };
      recordsById.set(recordId, record);
      synthesized.push(record);
    }
    if (record) {
      record.localPdfFile = fileName;
      record.localPdfHash = hash;
      if (!normalizeWhitespace(record.abstract) && extraction.abstract) {
        record.abstract = normalizeWhitespace(extraction.abstract);
        record.abstractSource = "pdf_extraction";
      }
      if ((!record.title || record.title === record.id) && extraction.title) {
        record.title = normalizeWhitespace(extraction.title);
      }
    }

    // Copy into docs/pdfs unless an identical copy is already there (warm start).
    const destination = path.join(docsPdfDir, fileName);
    try {
      const existing = await stat(destination);
      if (existing.size !== buffer.length) throw new Error("size mismatch");
    } catch {
      await mkdir(docsPdfDir, { recursive: true });
      await copyFile(filePath, destination);
      report.copied += 1;
    }
  }

  return { records: [...records, ...synthesized], report, referencesByRecord };
}
