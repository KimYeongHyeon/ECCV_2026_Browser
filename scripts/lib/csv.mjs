#!/usr/bin/env node

import { normalizeWhitespace, stringArray } from "./text.mjs";

export const CSV_COLUMNS = [
  "id", "title", "abstract", "authors", "type", "group", "category",
  "keywords", "pdf_file", "page_url", "doi", "session", "room", "start_time",
  "end_time", "presentation_type", "decision", "search_aliases",
];

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === "\"") {
        if (text[index + 1] === "\"") {
          field += "\"";
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === "\"") {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      field = "";
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  row.push(field);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

export function parseCsv(text) {
  const rows = parseCsvRows(String(text || ""));
  if (!rows.length) return [];
  const header = rows[0].map((name) => name.trim().toLowerCase());
  return rows.slice(1).map((row) => {
    const record = {};
    header.forEach((name, index) => {
      record[name] = row[index] ?? "";
    });
    return record;
  });
}

function slugify(value, fallbackPrefix) {
  const slug = String(value || "").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
  return slug || `${fallbackPrefix}-${Math.abs([...value].reduce((hash, char) => (hash * 31 + char.codePointAt(0)) | 0, 7))}`;
}

export function recordsFromCsvRows(rows, sourceCheckedAt) {
  return rows.map((row, index) => {
    const title = normalizeWhitespace(row.title);
    const pdfFile = normalizeWhitespace(row.pdf_file);
    const authors = row.authors ? row.authors.split(";").map((value) => normalizeWhitespace(value)).filter(Boolean) : [];
    const id = normalizeWhitespace(row.id) || (pdfFile ? pdfFile.replace(/\.pdf$/iu, "") : slugify(title, "record"));
    const keywords = row.keywords ? row.keywords.split(";").map((value) => normalizeWhitespace(value)).filter(Boolean) : [];
    const category = normalizeWhitespace(row.category) || keywords[0] || "Other";
    return {
      id,
      type: normalizeWhitespace(row.type) || "paper",
      title: title || id,
      abstract: normalizeWhitespace(row.abstract),
      authors,
      authorAffiliations: [],
      searchAliases: row.search_aliases ? row.search_aliases.split(";").map((value) => normalizeWhitespace(value)).filter(Boolean) : [],
      group: normalizeWhitespace(row.group) || (id.toLowerCase().includes("workshop") ? "Workshop" : "Main Conference"),
      category,
      categoryTags: stringArray(category),
      areaTags: [],
      domainTags: [],
      sourceType: "csv_input",
      sourceUrl: normalizeWhitespace(row.page_url) || "",
      sourceCheckedAt,
      presentationType: normalizeWhitespace(row.presentation_type) || "",
      presentationLabels: normalizeWhitespace(row.presentation_type) ? [normalizeWhitespace(row.presentation_type)] : [],
      session: normalizeWhitespace(row.session) || "",
      roomName: normalizeWhitespace(row.room) || "",
      startTime: normalizeWhitespace(row.start_time) || "",
      endTime: normalizeWhitespace(row.end_time) || "",
      decision: normalizeWhitespace(row.decision) || "",
      doi: normalizeWhitespace(row.doi) || "",
      doiUrl: normalizeWhitespace(row.doi) ? `https://doi.org/${normalizeWhitespace(row.doi)}` : "",
      pdfFile,
      csvRow: index + 2,
    };
  });
}
