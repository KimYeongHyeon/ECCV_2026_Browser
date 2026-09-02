import assert from "node:assert/strict";
import { test } from "node:test";

import { parseCsv, recordsFromCsvRows } from "../lib/csv.mjs";

test("parseCsv handles quoted fields with commas, newlines, and escaped quotes", () => {
  const rows = parseCsv([
    "id,title,abstract",
    '"a-1","Hello, world","Line one\nLine two"',
    '"a-2","He said ""ok"" twice","plain"',
  ].join("\n"));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { id: "a-1", title: "Hello, world", abstract: "Line one\nLine two" });
  assert.equal(rows[1].title, 'He said "ok" twice');
  assert.equal(rows[1].abstract, "plain");
});

test("parseCsv handles CRLF line endings and trailing newlines", () => {
  const rows = parseCsv("name,size\r\nalpha,1\r\nbeta,2\r\n");
  assert.equal(rows.length, 2);
  assert.deepEqual(rows, [
    { name: "alpha", size: "1" },
    { name: "beta", size: "2" },
  ]);
});

test("parseCsv trims and lowercases the header, pads short rows", () => {
  const rows = parseCsv('Id, Title\n"r-1","One"');
  assert.deepEqual(rows, [{ id: "r-1", title: "One" }]);
});

function recordsFromCsv(csvText) {
  return recordsFromCsvRows(parseCsv(csvText));
}

test("recordsFromCsvRows splits authors on semicolons and trims whitespace", () => {
  const [record] = recordsFromCsv([
    "id,title,authors",
    '"a-1","Author Lists","A; B;  C "',
  ].join("\n"));
  assert.deepEqual(record.authors, ["A", "B", "C"]);
});

test("recordsFromCsvRows defaults type to paper and generates slug ids", () => {
  const records = recordsFromCsv([
    "id,title,authors,type,pdf_file",
    ',"Two Authors: A Study","A; B",,',
    '"c-3","Third Paper","C",poster,',
  ].join("\n"));
  assert.equal(records.length, 2);
  assert.equal(records[0].id, "two-authors-a-study");
  assert.equal(records[0].type, "paper");
  assert.equal(records[0].title, "Two Authors: A Study");
  assert.equal(records[1].id, "c-3");
  assert.equal(records[1].type, "poster");
});

test("recordsFromCsvRows prefers the pdf file name for generated ids", () => {
  const [record] = recordsFromCsv([
    "id,title,authors,pdf_file",
    ',"A Paper About Things","A","2301.00001-some-paper.pdf"',
  ].join("\n"));
  assert.equal(record.id, "2301.00001-some-paper");
  assert.equal(record.pdfFile, "2301.00001-some-paper.pdf");
});

test("recordsFromCsvRows falls back to a hashed record id for empty titles", () => {
  // The authors cell keeps the row from being dropped as fully empty.
  const [record] = recordsFromCsv([
    "id,title,authors",
    ',"","A"',
  ].join("\n"));
  assert.match(record.id, /^record-/u);
  assert.equal(record.title, record.id);
  assert.deepEqual(record.authors, ["A"]);
});

test("recordsFromCsvRows derives category from keywords and builds the doi url", () => {
  const [record] = recordsFromCsv([
    "id,title,keywords,search_aliases,category,doi",
    '"k-1","Keyed","robots; vision","keyed; k one",,"10.1234/abc"',
  ].join("\n"));
  assert.deepEqual(record.searchAliases, ["keyed", "k one"]);
  assert.equal(record.category, "robots");
  assert.deepEqual(record.categoryTags, ["robots"]);
  assert.equal(record.doiUrl, "https://doi.org/10.1234/abc");
});
