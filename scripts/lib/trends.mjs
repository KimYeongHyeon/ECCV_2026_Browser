#!/usr/bin/env node

// Emerging-trend cards for the map detail panel, one per primary cluster.

import { splitSentences } from "./text.mjs";

// records, vectors, knn share the same order. level.assignments[i] is the
// cluster id of vectors[i].
export function buildTrends({ records, vectors, knn, level }) {
  const memberIndexesByCluster = new Map();
  vectors.forEach((_, index) => {
    const clusterId = level.assignments[index];
    if (!memberIndexesByCluster.has(clusterId)) memberIndexesByCluster.set(clusterId, []);
    memberIndexesByCluster.get(clusterId).push(index);
  });
  const trends = [];
  level.clusters.forEach((cluster) => {
    const memberIndexes = memberIndexesByCluster.get(cluster.id) || [];
    if (memberIndexes.length < 2) return;
    const memberRecords = memberIndexes.map((index) => records[index]).filter(Boolean);
    const recordIds = memberIndexes.map((index) => vectors[index].id);
    const sentences = representativeSentences(memberRecords, cluster.topTerms);
    const centrality = new Map(memberIndexes.map((index) => [
      vectors[index].id,
      (knn[index].neighbors || []).reduce((sum, neighbor) => sum + neighbor.score, 0),
    ]));
    const rankedIds = recordIds.slice().sort((left, right) => (centrality.get(right) || 0) - (centrality.get(left) || 0));
    trends.push({
      id: `trend-${trends.length + 1}`,
      name: cluster.label,
      clusterLabel: cluster.label,
      clusterId: cluster.id,
      size: memberIndexes.length,
      summary: sentences[0] || buildSummary(memberRecords, cluster.topTerms),
      keywords: cluster.topTerms,
      coreQuestion: `What should I read first to understand ${cluster.label.toLowerCase()} in this corpus?`,
      representativeMethodology: "Embedding-neighborhood cluster summary",
      subBranches: cluster.topTerms,
      representativeRecordIds: rankedIds.slice(0, 5),
      firstReadRecordIds: rankedIds.slice(0, Math.min(3, rankedIds.length)),
      representativeSentences: sentences.slice(0, 3),
      areaCounts: countBy(memberRecords, (record) => (record.areaTags || [])[0] || record.category || "Other"),
      domainCounts: countBy(memberRecords, (record) => (record.domainTags || [])[0] || "General"),
    });
  });
  return { trends, trendByCluster: new Map(trends.map((trend) => [trend.clusterId, trend.id])) };
}

function representativeSentences(memberList, keywords) {
  const wanted = keywords.map((term) => term.toLowerCase());
  const scored = [];
  for (const record of memberList) {
    for (const sentence of splitSentences(record.abstract)) {
      const lower = sentence.toLowerCase();
      const hits = wanted.filter((term) => lower.includes(term)).length;
      if (hits > 0) scored.push({ sentence, hits });
    }
  }
  scored.sort((left, right) => right.hits - left.hits);
  const seen = new Set();
  const output = [];
  for (const { sentence } of scored) {
    const key = sentence.slice(0, 60).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(sentence);
    if (output.length >= 3) break;
  }
  return output;
}

function countBy(records, pick) {
  const counts = new Map();
  for (const record of records) {
    const key = pick(record);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 6)
    .map(([label, count]) => ({ label, count }));
}

function buildSummary(memberList, keywords) {
  const wanted = keywords.map((term) => term.toLowerCase());
  const sentences = [];
  for (const record of memberList) {
    for (const sentence of splitSentences(record.abstract)) {
      const lower = sentence.toLowerCase();
      if (wanted.some((term) => lower.includes(term))) sentences.push(sentence);
    }
  }
  if (sentences.length) return sentences.slice(0, 2).join(" ");
  const titles = memberList.slice(0, 3).map((record) => `“${record.title}”`);
  return `Groups ${memberList.length} records around ${keywords.slice(0, 3).join(", ")}, including ${titles.join(", ")}.`;
}
