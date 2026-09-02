#!/usr/bin/env node

// Study features: per-record reading trails, semantic compare candidates,
// per-cluster topic lenses, and corpus outliers for the map detail panel.

import { normalizeWhitespace } from "./text.mjs";

const STAGE_PATTERNS = {
  intro: /\b(survey|review|tutorial|overview|foundation|background|introduction)\b/iu,
  applied: /\b(appl(y|ies|ied|ication|ications)|deploy|real.world|production|practical|clinical|industr)\b/iu,
};

export function buildStudyFeatures({ records, vectors, knn, level, trendByCluster }) {
  const indexById = new Map(vectors.map((entry, index) => [entry.id, index]));
  const clusterByIndex = level.assignments;
  const centrality = vectors.map((_, index) => {
    const neighbors = knn[index].neighbors;
    if (!neighbors.length) return 0;
    return neighbors.reduce((sum, neighbor) => sum + neighbor.score, 0) / neighbors.length;
  });
  const recordsPayload = {};
  const outliers = [];
  vectors.forEach((entry, index) => {
    const record = records[index];
    const neighbors = knn[index].neighbors || [];
    const clusterId = clusterByIndex[index];
    const memberIndexes = vectors
      .map((_, other) => (clusterByIndex[other] === clusterId ? other : -1))
      .filter((other) => other >= 0 && other !== index);
    const trail = [];
    const used = new Set();
    const push = (otherIndex, stage, reason) => {
      if (otherIndex == null || otherIndex < 0 || used.has(otherIndex)) return;
      used.add(otherIndex);
      trail.push({ recordId: vectors[otherIndex].id, stage, reason });
    };
    const coreIndex = memberIndexes.slice().sort((left, right) => centrality[right] - centrality[left])[0];
    push(coreIndex, "core", "Most connected record in its semantic cluster.");
    const introIndex = memberIndexes
      .filter((other) => STAGE_PATTERNS.intro.test(records[other].abstract || records[other].title || ""))
      .sort((left, right) => centrality[right] - centrality[left])[0];
    if (introIndex != null) {
      push(introIndex, "intro", "Survey or review-style record in the same cluster.");
    }
    const appliedIndex = memberIndexes
      .filter((other) => STAGE_PATTERNS.applied.test(records[other].abstract || records[other].title || ""))
      .sort((left, right) => centrality[right] - centrality[left])[0];
    if (appliedIndex != null) {
      push(appliedIndex, "applied", "Application-oriented record in the same cluster.");
    }
    const broaderIndex = neighbors
      .map((neighbor) => indexById.get(neighbor.id) ?? -1)
      .find((otherIndex) => otherIndex >= 0 && clusterByIndex[otherIndex] !== clusterId);
    if (broaderIndex != null) {
      push(broaderIndex, "broader", "Nearest record from a different cluster.");
    }
    if (trail.length) recordsPayload[record.id] = { studyTrail: trail };
    if (neighbors.length) {
      recordsPayload[record.id] = {
        ...recordsPayload[record.id],
        compareCandidates: neighbors.slice(0, 5).map((neighbor) => ({ recordId: neighbor.id })),
      };
    } else {
      outliers.push({ recordId: record.id, reason: "No close semantic neighbors; mapped from metadata only." });
    }
  });
  const topics = {};
  for (const cluster of level.clusters) {
    const memberIndexes = vectors
      .map((_, index) => (clusterByIndex[index] === cluster.id ? index : -1))
      .filter((index) => index >= 0);
    if (!memberIndexes.length) continue;
    const memberRecords = memberIndexes.map((index) => records[index]).filter(Boolean);
    const dominantArea = topLabel(memberRecords, (record) => (record.areaTags || [])[0] || record.category || "Other");
    const dominantDomain = topLabel(memberRecords, (record) => (record.domainTags || [])[0] || "General");
    topics[cluster.id] = {
      dominantArea,
      dominantDomain,
      nearbyTrendId: trendByCluster.get(cluster.id) || "",
      representativeRecordIds: memberIndexes
        .slice()
        .sort((left, right) => centrality[right] - centrality[left])
        .slice(0, 3)
        .map((index) => vectors[index].id),
    };
  }
  return { records: recordsPayload, topics, outliers: outliers.slice(0, 10) };
}

function topLabel(records, pick) {
  const counts = new Map();
  for (const record of records) {
    const key = normalizeWhitespace(pick(record)) || "Other";
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let best = "Other";
  let bestCount = -1;
  for (const [label, count] of counts) {
    if (count > bestCount) {
      best = label;
      bestCount = count;
    }
  }
  return best;
}
