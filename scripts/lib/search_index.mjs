#!/usr/bin/env node

// Build-time mirror of the site's hashed lexical vectorizer
// (docs/site/semantic-search.js). Documents are embedded with exactly the
// same tokenizer, weights, FNV-1a feature hashing, and Int8 quantization the
// browser uses, so map search works densely out of the box without any
// external model. Importing real SPECTER2 vectors via
// scripts/import_search_embeddings.mjs replaces this index and upgrades the
// query side automatically.

import { normalizeWhitespace } from "./text.mjs";

export const HASH_DIMENSION = 512;
export const VECTOR_SCALE = 127;

// Keep this list in sync with semantic-search.js.
const STOPWORDS = new Set([
  "about", "after", "again", "against", "also", "and", "are", "based",
  "been", "between", "both", "can", "from", "have", "into", "its", "more",
  "most", "not", "our", "over", "paper", "poster", "record", "results",
  "that", "the", "their", "this", "through", "toward", "towards", "using",
  "via", "with", "workshop",
]);

function hashToken(token) {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normalizeToken(token) {
  return token
    .replace(/^[-+]+|[-+]+$/g, "")
    .replace(/ies$/, "y")
    .replace(/(?:ing|ers|er|ed|s)$/u, "");
}

export function tokenize(text) {
  const raw = String(text || "").toLowerCase().match(/[a-z0-9][a-z0-9+\-]{1,}/g) || [];
  const tokens = raw
    .map(normalizeToken)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
  const expanded = [...tokens];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    expanded.push(`${tokens[index]}_${tokens[index + 1]}`);
  }
  return expanded;
}

function addWeightedToken(vector, token, count) {
  const hash = hashToken(token);
  const index = hash % HASH_DIMENSION;
  const sign = (hash & 0x10000) === 0 ? 1 : -1;
  const isBigram = token.includes("_");
  const longTokenBoost = token.length > 8 ? 0.25 : 0;
  const weight = (isBigram ? 0.58 : 1) * (1 + Math.log1p(count) + longTokenBoost);
  vector.set(index, (vector.get(index) || 0) + sign * weight);
}

export function vectorizeLexical(text) {
  const counts = new Map();
  for (const token of tokenize(text)) {
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  const vector = new Map();
  for (const [token, count] of counts) {
    addWeightedToken(vector, token, count);
  }
  const norm = Math.sqrt([...vector.values()].reduce((sum, value) => sum + value * value, 0)) || 1;
  for (const [index, value] of vector) {
    vector.set(index, value / norm);
  }
  return vector;
}

// Approximates the site's recordEmbeddingText: plain-math title, haystack
// parts, tags, and cluster labels. Field composition only needs to be
// sensible on the document side — queries embed the raw query string.
function mathStrippedTitle(value) {
  return normalizeWhitespace(String(value || "").replace(/[$^~\\]/gu, " "));
}

export function recordEmbeddingText(record) {
  const title = normalizeWhitespace(record.title);
  const parts = [
    title,
    mathStrippedTitle(title),
    normalizeWhitespace(record.abstract),
    normalizeWhitespace([
      record.group || "",
      record.category || "",
      ...(record.categoryTags || []),
      ...(record.areaTags || []),
      ...(record.domainTags || []),
      record.embeddingClusterLabel || "",
      ...(record.embeddingClusterKeywords || []),
      ...(record.searchAliases || []),
    ].join(" ")),
  ].filter(Boolean);
  return parts.join("\n");
}

function toBase64Int8(values) {
  const bytes = Buffer.alloc(values.length);
  for (let index = 0; index < values.length; index += 1) bytes[index] = values[index] & 0xff;
  return bytes.toString("base64");
}

export function quantizeVector(vector) {
  const dense = new Array(HASH_DIMENSION).fill(0);
  for (const [index, value] of vector) dense[index] = value;
  return toBase64Int8(dense.map((value) => Math.max(-1, Math.min(1, value)) * VECTOR_SCALE | 0));
}

export function buildSearchEmbeddings(records) {
  const rows = records.map((record) => ({
    id: record.id,
    vector: quantizeVector(vectorizeLexical(recordEmbeddingText(record))),
  }));
  return {
    generatedAt: "",
    embeddingSource: {
      method: "hash-lexical-deterministic",
      note: "In-browser hashed lexical index; zero downloads. Import SPECTER2 vectors to upgrade query semantics.",
    },
    model: { id: "hash-lexical-local", kind: "hash-lexical", scale: VECTOR_SCALE },
    records: rows,
  };
}
