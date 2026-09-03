#!/usr/bin/env node

// Deterministic NMF topic modeling (zero dependencies).
//
// Documents are represented as title-weighted unigram count vectors over a
// pruned vocabulary, factorized as X ≈ W·H with multiplicative updates
// (Euclidean NMF). Fixed seeded initialization makes every run produce the
// same topics, so builds stay reproducible and cacheable.
//
// Output: K topics, each with a natural-language label from its top terms
// (via the corpus display-form map), a size (documents whose dominant topic
// it is), and per-document dominant topic + proportions.

import { displayForms, normalizeWhitespace, tokenize } from "./text.mjs";

const NMF_ITERATIONS = 30;
const EPSILON = 1e-10;

function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function topicCountFor(records) {
  return Math.max(12, Math.min(44, Math.round(records.length / 72)));
}

// Maps serialize poorly to JSON; the build caches the whole model between
// runs, so provide explicit (de)serializers.
export function serializeModel(model) {
  return {
    topics: model.topics,
    topicCount: model.topicCount,
    topicOf: Object.fromEntries(model.topicOf || []),
    proportions: Object.fromEntries(model.proportions || []),
  };
}

export function deserializeModel(payload) {
  if (!payload) return null;
  return {
    topics: payload.topics || [],
    topicCount: payload.topicCount || 0,
    topicOf: new Map(Object.entries(payload.topicOf || {})),
    proportions: new Map(Object.entries(payload.proportions || {})),
  };
}

// Unigram-only, df-pruned document vectors for topic modeling.
function cleanText(value) {
  return String(value || "")
    .replace(/&#x?[0-9a-f]+;|&[a-z]+;/giu, " ")
    .replace(/\\[a-z]+\b/giu, " ");
}

const LABEL_NOISE = new Set([
  "nevertheless", "susceptible", "knowing", "unleashing", "struggling",
  "focusing", "obscure", "translates", "raising", "think", "thoughts",
  "students", "teacher", "slow", "sign", "date", "know", "unlocking",
  "unleash", "diagnosing", "long-standing", "production", "presence",
]);

function buildTopicVectors(records, { minDfRatio = 0.003, maxDfRatio = 0.4, maxTerms = 6000 } = {}) {
  const documentFrequency = new Map();
  const docs = records.map((record) => {
    const title = normalizeWhitespace(record.title);
    const counts = new Map();
    const add = (text, weight) => {
      if (!text) return;
      for (const token of tokenize(text)) {
        counts.set(token, (counts.get(token) || 0) + weight);
      }
    };
    add(cleanText(title), 2.2);
    add(cleanText(record.abstract), 1);
    add((record.categoryTags || []).join(" "), 0.8);
    for (const token of counts.keys()) documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
    return { id: record.id, counts };
  });
  const n = Math.max(records.length, 1);
  const minDf = Math.max(2, Math.ceil(n * minDfRatio));
  const maxDf = Math.floor(n * maxDfRatio);
  // Cap the vocabulary: topic models work best on a few thousand salient
  // terms, and the NMF update cost scales linearly with it.
  const terms = [...documentFrequency.entries()]
    .filter(([token, df]) => df >= minDf && df <= maxDf)
    .sort((left, right) => right[1] - left[1])
    .slice(0, maxTerms)
    .map(([token]) => token);
  const termIndex = new Map(terms.map((token, index) => [token, index]));
  const rows = docs.map(({ id, counts }) => {
    const indexes = [];
    const values = [];
    for (const [token, count] of counts) {
      const index = termIndex.get(token);
      if (index === undefined) continue;
      const weight = (1 + Math.log(count)) * Math.log((n + 1) / (documentFrequency.get(token) + 1)) + 1;
      indexes.push(index);
      values.push(weight);
    }
    const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1;
    for (let index = 0; index < values.length; index += 1) values[index] /= norm;
    return { id, indexes, values };
  });
  return { rows, termIndex, display: buildDisplay(records) };
}

function buildDisplay(records) {
  const display = new Map();
  for (const record of records) {
    const text = cleanText(`${record.title || ""} ${record.abstract || ""} ${(record.categoryTags || []).join(" ")}`);
    for (const [normalized, original] of displayForms(text)) {
      if (!display.has(normalized)) display.set(normalized, original);
    }
  }
  return display;
}

export function modelTopics(records, { topics: requestedTopics, seed = 42, iterations = NMF_ITERATIONS, assignments = null } = {}) {
  const K = Math.max(requestedTopics || topicCountFor(records), assignments ? new Set(assignments.values()).size : 0, 2);
  const { rows, termIndex, display } = buildTopicVectors(records);
  const d = termIndex.size;
  const n = rows.length;
  if (!n || !d || K < 2) return { topics: [], topicOf: new Map(), proportions: new Map(), topicCount: K };

  const random = mulberry32(seed);
  const H = Array.from({ length: K }, () => Float64Array.from({ length: d }, () => 0.1 + random() * 0.4));
  // Seeding W from the k-means cluster assignments prevents the classic NMF
  // collapse where one background topic absorbs most of the corpus.
  const W = rows.map((row, i) => {
    const wRow = new Float64Array(K);
    const cluster = assignments?.get(row.id);
    if (cluster !== undefined && cluster < K) wRow[cluster] = 1;
    else wRow[random() * K | 0] = 1;
    for (let noise = 0; noise < 2; noise += 1) wRow[random() * K | 0] += 0.2 + random() * 0.3;
    return wRow;
  });

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    // H *= (Wᵀ X) / (Wᵀ W H)
    const numH = Array.from({ length: K }, () => new Float64Array(d));
    const WtW = Array.from({ length: K }, () => new Float64Array(K));
    for (let i = 0; i < n; i += 1) {
      const wRow = W[i];
      const { indexes, values } = rows[i];
      for (let a = 0; a < K; a += 1) {
        const wa = wRow[a];
        if (!wa) continue;
        const numRow = numH[a];
        for (let p = 0; p < indexes.length; p += 1) numRow[indexes[p]] += wa * values[p];
        for (let b = 0; b < K; b += 1) WtW[a][b] += wa * wRow[b];
      }
    }
    for (let a = 0; a < K; a += 1) {
      const hRow = H[a];
      const numRow = numH[a];
      for (let j = 0; j < d; j += 1) {
        let denom = 0;
        for (let b = 0; b < K; b += 1) denom += WtW[a][b] * H[b][j];
        hRow[j] = (hRow[j] * numRow[j]) / (denom + EPSILON);
      }
    }
    // W *= (X Hᵀ) / (W H Hᵀ)
    const HHt = Array.from({ length: K }, (_, a) => {
      const row = new Float64Array(K);
      for (let b = 0; b < K; b += 1) {
        let sum = 0;
        for (let j = 0; j < d; j += 1) sum += H[a][j] * H[b][j];
        row[b] = sum;
      }
      return row;
    });
    for (let i = 0; i < n; i += 1) {
      const wRow = W[i];
      const { indexes, values } = rows[i];
      const numW = new Float64Array(K);
      const denomW = new Float64Array(K);
      for (let p = 0; p < indexes.length; p += 1) {
        const j = indexes[p];
        const v = values[p];
        for (let a = 0; a < K; a += 1) numW[a] += v * H[a][j];
      }
      for (let a = 0; a < K; a += 1) {
        const hRow = H[a];
        for (let b = 0; b < K; b += 1) denomW[a] += hRow[b] * HHt[a][b];
      }
      for (let a = 0; a < K; a += 1) wRow[a] = (wRow[a] * numW[a]) / (denomW[a] + EPSILON);
    }
  }

  // L1-normalize each document's topic proportions; dominant topic = argmax.
  const topicOf = new Map();
  const proportions = new Map();
  for (let i = 0; i < n; i += 1) {
    const wRow = W[i];
    let sum = 0;
    for (let a = 0; a < K; a += 1) sum += wRow[a];
    if (!sum) {
      topicOf.set(rows[i].id, 0);
      proportions.set(rows[i].id, [1]);
      continue;
    }
    const props = Float64Array.from(wRow, (value) => value / sum);
    proportions.set(rows[i].id, [...props]);
    let best = 0;
    for (let a = 1; a < K; a += 1) if (props[a] > props[best]) best = a;
    topicOf.set(rows[i].id, best);
  }

  // Topic labels from top H terms (display forms), distinctiveness-boosted.
  const reverse = [...termIndex.entries()].map(([token, index]) => [index, token]);
  const topics = [];
  for (let a = 0; a < K; a += 1) {
    const hRow = H[a];
    let mass = 0;
    for (let j = 0; j < d; j += 1) mass += hRow[j];
    const ranked = reverse
      .map(([index, token]) => ({ token, weight: hRow[index] }))
      .sort((left, right) => right.weight - left.weight)
      .slice(0, 12)
      .map(({ token }) => display.get(token) || token);
    const seen = new Set();
    const topTerms = [];
    for (const term of ranked) {
      const word = term.toLowerCase();
      if (seen.has(word) || LABEL_NOISE.has(word)) continue;
      seen.add(word);
      topTerms.push(term);
    }
    let size = 0;
    for (const topic of topicOf.values()) if (topic === a) size += 1;
    if (!mass || size === 0) continue;
    topics.push({
      id: `topic-${a + 1}`,
      label: topTerms.slice(0, 3).map((word) => word[0].toUpperCase() + word.slice(1)).join(" "),
      topTerms: topTerms.slice(0, 6),
      size,
      mass: Number(mass.toFixed(3)),
    });
  }
  topics.sort((left, right) => right.size - left.size);
  topics.forEach((topic, index) => { topic.id = `topic-${index + 1}`; });
  return { topics, topicOf, proportions, topicCount: K };
}

// Returns "Primary Topic Name" plus an optional secondary topic when the
// paper draws substantially from two topics (cross-listing, like ECCV's own
// dual keywords).
export function topicLabelsFor(recordId, model) {
  if (!model || !model.topicOf) return [];
  const primary = model.topicOf.get(recordId);
  if (primary === undefined) return [];
  const labels = [model.topics.find((topic) => topic.id === `topic-${primary + 1}`)?.label].filter(Boolean);
  const props = model.proportions.get(recordId) || [];
  let secondary = -1;
  for (let a = 0; a < props.length; a += 1) {
    if (a === primary) continue;
    if (secondary < 0 || props[a] > props[secondary]) secondary = a;
  }
  if (secondary >= 0 && props[secondary] >= 0.28) {
    const label = model.topics.find((topic) => topic.id === `topic-${secondary + 1}`)?.label;
    if (label) labels.push(label);
  }
  return labels;
}
