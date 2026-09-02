#!/usr/bin/env node

// Deterministic, dependency-free semantic pipeline.
//
// Documents are embedded as TF-IDF sparse vectors over title + abstract text,
// related records are connected with cosine kNN, clusters are produced with
// seeded k-means at several granularities, and x/y positions come from a
// two-component power-iteration PCA. Everything is deterministic: the same
// input always produces the same artifacts.

import { displayForms, documentText, sha256Hex, titleCaseLabel, tokenizeWithBigrams } from "./text.mjs";

export const NEIGHBOR_COUNT = 12;
export const CLUSTER_LEVELS = [5, 10, 15, 20, 25, 30];
const KMEANS_ITERATIONS = 30;
// Titles describe a paper far more densely than abstracts; category-style
// tags are only context. Applied as per-occurrence multipliers before tf-idf.
const FIELD_WEIGHTS = { title: 2.2, abstract: 1, tags: 0.8 };

function fieldCounts(record) {
  const title = String(record.title || "").replace(/\s+/gu, " ").trim();
  const fields = [
    { text: title, weight: FIELD_WEIGHTS.title },
    { text: record.abstract || "", weight: FIELD_WEIGHTS.abstract },
    {
      text: [...(record.categoryTags || []), ...(record.areaTags || []), ...(record.domainTags || [])].join(" "),
      weight: FIELD_WEIGHTS.tags,
    },
  ];
  const counts = new Map();
  for (const { text, weight } of fields) {
    if (!text) continue;
    for (const token of tokenizeWithBigrams(text)) {
      counts.set(token, (counts.get(token) || 0) + weight);
    }
  }
  return counts;
}

export function buildVectors(records) {
  const documentFrequency = new Map();
  const corpusDisplay = new Map();
  const tokenized = records.map((record) => {
    // Display forms must cover every field that contributes tokens (title,
    // abstract, AND tags) so cluster labels never show stemmed fragments.
    const displaySource = [
      record.title || "",
      record.abstract || "",
      ...(record.categoryTags || []),
      ...(record.areaTags || []),
      ...(record.domainTags || []),
    ].join(" ");
    for (const [normalized, original] of displayForms(displaySource)) {
      if (!corpusDisplay.has(normalized)) corpusDisplay.set(normalized, original);
    }
    const counts = fieldCounts(record);
    for (const token of counts.keys()) documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
    return { id: record.id, counts };
  });
  const total = Math.max(records.length, 1);
  const termIndex = new Map();
  for (const [token, count] of documentFrequency) {
    if (count < 2 && records.length > 8) continue;
    termIndex.set(token, termIndex.size);
  }
  const vectors = tokenized.map(({ id, counts }) => {
    const vector = new Map();
    let norm = 0;
    for (const [token, count] of counts) {
      const index = termIndex.get(token);
      if (index === undefined) continue;
      const idf = Math.log((total + 1) / (documentFrequency.get(token) + 1)) + 1;
      const weight = (1 + Math.log(count)) * idf;
      vector.set(index, weight);
      norm += weight * weight;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [index, weight] of vector) vector.set(index, weight / norm);
    return { id, vector };
  });
  return { vectors, termIndex, documentFrequency, corpusDisplay };
}

function dot(left, right) {
  const [small, large] = left.size < right.size ? [left, right] : [right, left];
  let score = 0;
  for (const [index, value] of small) {
    const other = large.get(index);
    if (other !== undefined) score += value * other;
  }
  return score;
}

export function nearestNeighbors(vectors, { limit = NEIGHBOR_COUNT } = {}) {
  return vectors.map((entry, index) => {
    const scored = [];
    for (let other = 0; other < vectors.length; other += 1) {
      if (other === index) continue;
      const score = dot(entry.vector, vectors[other].vector);
      if (score > 0.02) scored.push({ id: vectors[other].id, score: Number(score.toFixed(4)) });
    }
    scored.sort((left, right) => right.score - left.score);
    return { id: entry.id, neighbors: scored.slice(0, limit) };
  });
}

function meanVector(vectors) {
  const mean = new Map();
  if (!vectors.length) return mean;
  for (const { vector } of vectors) {
    for (const [index, value] of vector) mean.set(index, (mean.get(index) || 0) + value);
  }
  for (const [index, value] of mean) mean.set(index, value / vectors.length);
  return mean;
}

export function corpusMeanVector(vectors) {
  return meanVector(vectors);
}

function centroidTopTerms(vectors, termIndex, corpusMean, corpusDisplay, limit = 5) {
  const mean = meanVector(vectors);
  const terms = [];
  for (const [index, weight] of mean) {
    const baseline = corpusMean?.get(index) || 0;
    terms.push({ index, score: weight - baseline * 0.6 });
  }
  terms.sort((left, right) => right.score - left.score);
  const reverse = new Map([...termIndex.entries()].map(([token, index]) => [index, token]));
  return terms.slice(0, limit).map(({ index }) => {
    const token = reverse.get(index) || "";
    if (token.includes("_")) {
      return token.split("_").map((part) => corpusDisplay?.get(part) || part).join(" ");
    }
    return corpusDisplay?.get(token) || token;
  }).filter(Boolean);
}

function kmeans(vectors, k) {
  k = Math.max(1, Math.min(k, vectors.length));
  const distanceTo = (vector, centroid) => 1 - dot(vector, centroid);
  const seeds = [];
  const globalMean = meanVector(vectors);
  seeds.push(vectors.reduce((best, entry, index) => (
    distanceTo(entry.vector, globalMean) > distanceTo(vectors[best].vector, globalMean) ? index : best
  ), 0));
  while (seeds.length < k) {
    const minDistances = vectors.map(({ vector }, index) => {
      if (seeds.includes(index)) return -1;
      let closest = Infinity;
      for (const seed of seeds) closest = Math.min(closest, distanceTo(vector, vectors[seed].vector));
      return closest;
    });
    const nextSeed = minDistances.reduce((best, value, index) => (value > minDistances[best] ? index : best), 0);
    if (minDistances[nextSeed] <= 0) break;
    seeds.push(nextSeed);
  }
  const effectiveK = seeds.length;
  let assignments = new Array(vectors.length).fill(0);
  let centroids = seeds.map((seed) => vectors[seed].vector);
  for (let iteration = 0; iteration < KMEANS_ITERATIONS; iteration += 1) {
    let changed = false;
    assignments = vectors.map(({ vector }, index) => {
      let best = 0;
      let bestScore = -Infinity;
      centroids.forEach((centroid, cluster) => {
        const score = dot(vector, centroid);
        if (score > bestScore) {
          bestScore = score;
          best = cluster;
        }
      });
      if (assignments[index] !== best) changed = true;
      return best;
    });
    centroids = Array.from({ length: effectiveK }, (_, cluster) => {
      const members = vectors.filter((_, index) => assignments[index] === cluster);
      return members.length ? meanVector(members) : vectors[seeds[cluster] % vectors.length].vector;
    });
    if (!changed && iteration > 0) break;
  }
  return assignments;
}

// One sweep of kNN majority voting: a record joins the cluster most of its
// semantic neighbors belong to (self vote 1.0, each neighbor 0.5). This snaps
// k-means boundaries to the actual neighborhood graph.
export function smoothAssignments(assignments, vectors, knn) {
  const indexById = new Map(vectors.map((entry, index) => [entry.id, index]));
  const next = assignments.slice();
  vectors.forEach((_, index) => {
    const votes = new Map();
    votes.set(assignments[index], (votes.get(assignments[index]) || 0) + 1);
    for (const neighbor of knn[index].neighbors || []) {
      const neighborIndex = indexById.get(neighbor.id);
      if (neighborIndex === undefined) continue;
      votes.set(assignments[neighborIndex], (votes.get(assignments[neighborIndex]) || 0) + 0.5);
    }
    let best = assignments[index];
    let bestVotes = -1;
    for (const [cluster, count] of votes) {
      if (count > bestVotes) {
        best = cluster;
        bestVotes = count;
      }
    }
    next[index] = best;
  });
  return next;
}

function labelClusters(vectors, assignments, termIndex, corpusMean, corpusDisplay) {
  const labels = new Map();
  const clusters = [];
  const clusterIndexes = [...new Set(assignments)].sort((left, right) => left - right);
  for (const cluster of clusterIndexes) {
    const members = vectors.filter((_, index) => assignments[index] === cluster);
    if (!members.length) continue;
    const topTerms = centroidTopTerms(members, termIndex, corpusMean, corpusDisplay);
    const id = `c${clusters.length + 1}`;
    labels.set(cluster, id);
    clusters.push({
      id,
      label: dedupeLabel(topTerms, `Cluster ${clusters.length + 1}`),
      topTerms,
      size: members.length,
      method: "kmeans-tfidf",
    });
  }
  return { assignments: assignments.map((cluster) => labels.get(cluster)), clusters };
}

export function clusterLevels(vectors, termIndex, corpusMean, corpusDisplay, knn, levels = CLUSTER_LEVELS) {
  const usable = levels.filter((k) => k >= 2 && k <= Math.max(2, Math.floor(vectors.length / 2)));
  const candidateLevels = (usable.length ? usable : [2]).slice(0, 6);
  return candidateLevels.map((k) => {
    const raw = kmeans(vectors, k);
    const smoothed = knn ? smoothAssignments(raw, vectors, knn) : raw;
    const { assignments, clusters } = labelClusters(vectors, smoothed, termIndex, corpusMean, corpusDisplay);
    return { k, assignments, clusters };
  });
}

export function pickPrimaryLevel(levels) {
  if (!levels.length) return null;
  for (const level of levels) {
    if (level.clusters.every((cluster) => cluster.size >= 3)) return level;
  }
  const balanced = [...levels].reverse().find((level) => level.clusters.every((cluster) => cluster.size >= 2));
  return balanced || levels[0];
}

function dedupeLabel(topTerms, fallback) {
  const seen = new Set();
  const words = [];
  for (const term of topTerms) {
    for (const word of term.split(/\s+/u)) {
      if (!word || seen.has(word.toLowerCase())) continue;
      seen.add(word.toLowerCase());
      words.push(word);
    }
    if (words.length >= 3) break;
  }
  return titleCaseLabel(words.join(" ")) || fallback;
}

export function project2D(vectors) {
  const n = vectors.length;
  if (n < 3) {
    return vectors.map((entry, index) => ({ id: entry.id, x: index * 0.5 - 0.25, y: index % 2 === 0 ? 0.25 : -0.25 }));
  }
  const mean = meanVector(vectors);
  const applyXv = (v) => {
    const rows = vectors.map(({ vector }) => {
      let value = 0;
      for (const [index, weight] of vector) value += weight * (v.get(index) || 0);
      return value;
    });
    const rowMean = rows.reduce((sum, value) => sum + value, 0) / n;
    return rows.map((value) => value - rowMean);
  };
  const applyXtR = (rows) => {
    const result = new Map();
    vectors.forEach(({ vector }, index) => {
      const scale = rows[index];
      if (!scale) return;
      for (const [dim, weight] of vector) result.set(dim, (result.get(dim) || 0) + weight * scale);
    });
    return result;
  };
  const powerIteration = (initial) => {
    let vector = initial;
    for (let iteration = 0; iteration < 60; iteration += 1) {
      const next = applyXtR(applyXv(vector));
      let norm = 0;
      for (const value of next.values()) norm += value * value;
      norm = Math.sqrt(norm);
      if (!norm) return vector;
      for (const [index, value] of next) vector.set(index, value / norm);
    }
    return vector;
  };
  const normalize = (vector) => {
    let norm = Math.sqrt([...vector.values()].reduce((sum, value) => sum + value * value, 0)) || 1;
    for (const [index, value] of vector) vector.set(index, value / norm);
    return vector;
  };
  const orthogonalize = (vector, against) => {
    let projection = 0;
    for (const [index, value] of against) projection += value * (vector.get(index) || 0);
    for (const [index, value] of against) vector.set(index, (vector.get(index) || 0) - projection * value);
    return vector;
  };
  const dims = new Set();
  for (const { vector } of vectors) for (const index of vector.keys()) dims.add(index);
  const seed = 1 / Math.sqrt(dims.size || 1);
  const first = normalize(powerIteration(new Map([...dims].map((dim) => [dim, seed]))));
  let second = new Map(first);
  const firstDim = [...dims][0];
  second.set(firstDim, (second.get(firstDim) || 0) + 0.5);
  second = normalize(new Map(second));
  second = normalize(orthogonalize(second, first));
  second = normalize(orthogonalize(powerIteration(second), first));
  const project = (component) => {
    const rows = applyXv(component);
    const max = Math.max(...rows.map(Math.abs)) || 1;
    return rows.map((value) => Number((value / max).toFixed(4)));
  };
  const x = project(first);
  const y = project(second);
  return vectors.map((entry, index) => ({ id: entry.id, x: x[index], y: y[index] }));
}

export function semanticFingerprint(inputs) {
  return sha256Hex(JSON.stringify(inputs));
}
