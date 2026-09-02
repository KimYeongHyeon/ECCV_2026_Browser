#!/usr/bin/env node

// First-pass research concept extraction.
//
// The ICML pipeline derives these artifacts from a human review workflow. The
// template generates an automatic first pass with identical coverage so the
// People/Topics views work out of the box; a reviewed artifact with the same
// schema can replace it at any time.

import { displayForms, normalizeWhitespace, tokenizeWithBigrams } from "./text.mjs";

function candidatePhrases(record) {
  const title = normalizeWhitespace(record.title);
  const abstract = normalizeWhitespace(record.abstract);
  const display = new Map([...displayForms(title), ...displayForms(abstract)]);
  const toPhrase = (token) => token
    .split("_")
    .map((part) => display.get(part) || part)
    .join(" ");
  const score = new Map();
  const add = (token, weight) => {
    const phrase = toPhrase(token);
    score.set(phrase, (score.get(phrase) || 0) + weight);
  };
  const seen = new Set();
  for (const token of tokenizeWithBigrams(title)) {
    seen.add(token);
    add(token, 2);
  }
  for (const token of tokenizeWithBigrams(abstract)) {
    add(token, seen.has(token) ? 1.4 : 0.6);
  }
  return score;
}

export function buildConceptArtifact(records) {
  const corpusScores = new Map();
  const perRecord = records.map((record) => candidatePhrases(record));
  for (const scores of perRecord) {
    for (const [token] of scores) corpusScores.set(token, (corpusScores.get(token) || 0) + 1);
  }
  const total = Math.max(records.length, 1);
  const conceptRecords = {};
  records.forEach((record, index) => {
    const ranked = [...perRecord[index].entries()]
      .filter(([phrase]) => corpusScores.get(phrase) <= total * 0.6)
      .map(([phrase, weight]) => ({ phrase, weight: weight * Math.log(1 + total / (corpusScores.get(phrase) || 1)) }))
      .sort((left, right) => right.weight - left.weight)
      .map(({ phrase }) => phrase);
    const core = ranked.slice(0, 3).map(normalizeWhitespace).filter(Boolean);
    const detail = ranked.slice(3, 9).map(normalizeWhitespace).filter(Boolean);
    if (!core.length) core.push(normalizeWhitespace(record.category) || "General");
    conceptRecords[record.id] = { core, detail };
  });
  return {
    schemaVersion: "conference-atlas-concepts/v1",
    fingerprints: { artifact: "" },
    records: conceptRecords,
    review: {},
    source: { recordCount: records.length, generator: "auto-first-pass/v1" },
    summary: {
      candidateRecordCount: records.length,
      publishedRecordCount: records.length,
      excludedRecordCount: 0,
      exclusionCounts: {},
    },
  };
}
