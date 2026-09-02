#!/usr/bin/env node

import { createHash } from "node:crypto";

const STOPWORDS = new Set([
  "about", "after", "again", "against", "all", "also", "and", "any", "are", "based",
  "been", "before", "between", "both", "can", "down", "during", "each", "either",
  "for", "from", "has", "have", "how", "into", "its", "least", "less", "many",
  "may", "more", "most", "much", "neither", "new", "novel", "not", "our", "over",
  "others", "paper", "per", "poster", "record", "results", "same", "several",
  "that", "the", "their", "this", "three", "through", "top", "toward", "towards",
  "two", "under", "up", "using", "various", "via", "well", "what", "when",
  "where", "which", "while", "whose", "with", "within", "without", "workshop",
  "across", "between", "show", "shown", "propose", "proposed", "propose",
  "approach", "method", "methods", "present", "presented", "however", "further",
  "among", "other", "such", "than", "then", "abstract", "keywords",
]);

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Fingerprint(value) {
  return `sha256:${sha256Hex(value)}`;
}

export function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

export function normalizeToken(token) {
  return token
    .replace(/^[-+]+|[-+]+$/g, "")
    .replace(/ies$/, "y")
    .replace(/(?:ing|ers|er|ed|s)$/u, "");
}

export function tokenize(text) {
  const raw = String(text || "").toLowerCase().match(/[a-z0-9][a-z0-9+\-]{1,}/g) || [];
  return raw
    .map(normalizeToken)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

// Map each normalized token back to a representative original word so cluster
// labels and concept phrases read naturally ("decoding" instead of "decod").
export function displayForms(text) {
  const raw = String(text || "").toLowerCase().match(/[a-z0-9][a-z0-9+\-]{1,}/g) || [];
  const display = new Map();
  for (const word of raw) {
    const normalized = normalizeToken(word);
    if (normalized.length > 2 && !STOPWORDS.has(normalized) && !display.has(normalized)) {
      display.set(normalized, word);
    }
  }
  return display;
}

export function tokenizeWithBigrams(text) {
  const tokens = tokenize(text);
  const expanded = [...tokens];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    expanded.push(`${tokens[index]}_${tokens[index + 1]}`);
  }
  return expanded;
}

export function documentText(record) {
  const parts = [];
  const title = normalizeWhitespace(record.title);
  const abstract = normalizeWhitespace(record.abstract);
  if (title) parts.push(`Title: ${title}`);
  if (abstract) parts.push(`Abstract: ${abstract}`);
  const tags = [
    ...stringArray(record.categoryTags),
    ...stringArray(record.areaTags),
    ...stringArray(record.domainTags),
  ];
  if (!abstract && tags.length) parts.push(`Context: ${tags.join(" ")}`);
  return parts.join("\n");
}

export function stringArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  return value ? [String(value)] : [];
}

export function splitSentences(text) {
  return String(text || "")
    .replace(/\s+/gu, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/u)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 30 && sentence.length < 600);
}

export function titleCaseLabel(value) {
  return String(value || "")
    .split(/[\s_]+/u)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}
