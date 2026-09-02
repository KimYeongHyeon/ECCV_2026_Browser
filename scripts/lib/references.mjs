#!/usr/bin/env node

// Citation-overlap artifacts for the References view.
//
// Input is either the references extracted from dropped-in PDFs or an optional
// data/source/references.jsonl with rows of:
//   {"recordId": "...", "references": [{"title": "...", "year": "2024"}]}
// Reference keys are normalized titles, so overlap means "cites the same work".

import { normalizeWhitespace } from "./text.mjs";

function normalizeKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim().replace(/\s+/gu, " ").slice(0, 240);
}

function referenceKey(reference) {
  if (reference.key) return normalizeKey(reference.key);
  return normalizeKey(reference.title || reference.raw || "");
}

function safeFileId(recordId) {
  const safe = String(recordId).replace(/[^a-zA-Z0-9_-]+/gu, "_").slice(0, 120);
  return safe || "record";
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

export function buildReferenceArtifacts({ records, referencesByRecord }) {
  const recordsById = new Map(records.map((record) => [record.id, record]));
  const entries = [...referencesByRecord.entries()].filter(([recordId, references]) => (
    recordsById.has(recordId) && Array.isArray(references) && references.length
  ));
  const keyTitles = new Map();
  const citingByKey = new Map();
  for (const [recordId, references] of entries) {
    for (const reference of references) {
      const key = referenceKey(reference);
      if (!key) continue;
      if (!keyTitles.has(key)) keyTitles.set(key, normalizeWhitespace(reference.title || reference.raw || "").slice(0, 200));
      if (!citingByKey.has(key)) citingByKey.set(key, new Set());
      citingByKey.get(key).add(recordId);
    }
  }
  const recordReferenceCounts = new Map(entries.map(([recordId, references]) => [recordId, references.length]));
  const overlapPairs = new Map();
  for (const [key, citing] of citingByKey) {
    if (citing.size < 2) continue;
    const ids = [...citing];
    for (let left = 0; left < ids.length; left += 1) {
      for (let right = left + 1; right < ids.length; right += 1) {
        const pairKey = `${ids[left]}\u0000${ids[right]}`;
        const shared = overlapPairs.get(pairKey) || new Set();
        shared.add(key);
        overlapPairs.set(pairKey, shared);
      }
    }
  }
  const overlapsByRecord = new Map(entries.map(([recordId]) => [recordId, []]));
  const pairList = [];
  for (const [pairKey, shared] of overlapPairs) {
    const [leftId, rightId] = pairKey.split("\u0000");
    const score = Number((shared.size / Math.max(1, Math.min(recordReferenceCounts.get(leftId) || 1, recordReferenceCounts.get(rightId) || 1))).toFixed(4));
    pairList.push({ leftId, rightId, sharedCount: shared.size, score, sharedKeys: shared });
  }
  pairList.sort((left, right) => right.score - left.score || right.sharedCount - left.sharedCount);
  for (const pair of pairList) {
    overlapsByRecord.get(pair.leftId)?.push(pair);
    overlapsByRecord.get(pair.rightId)?.push(pair);
  }
  // Communities: connected components over the overlap graph.
  const parent = new Map(entries.map(([recordId]) => [recordId, recordId]));
  const find = (id) => {
    while (parent.get(id) !== id) {
      parent.set(id, parent.get(parent.get(id)));
      id = parent.get(id);
    }
    return id;
  };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent.set(leftRoot, rightRoot);
  };
  for (const pair of pairList) union(pair.leftId, pair.rightId);
  const communityMembers = new Map();
  for (const [recordId] of entries) {
    const root = find(recordId);
    if (!communityMembers.has(root)) communityMembers.set(root, []);
    communityMembers.get(root).push(recordId);
  }
  const communities = [...communityMembers.values()]
    .filter((members) => members.length >= 2)
    .sort((left, right) => right.length - left.length)
    .slice(0, 12)
    .map((members, index) => {
      const memberPairs = pairList.filter((pair) => members.includes(pair.leftId) && members.includes(pair.rightId));
      const memberRecords = members.map((id) => recordsById.get(id)).filter(Boolean);
      return {
        id: `community-${index + 1}`,
        label: topLabel(memberRecords, (record) => record.category || "Other"),
        recordIds: members,
        representativeRecordIds: members.slice(0, 3),
        edgeCount: memberPairs.length,
        maxSharedCount: memberPairs.reduce((max, pair) => Math.max(max, pair.sharedCount), 0),
        areaTags: [...new Set(memberRecords.flatMap((record) => record.areaTags || []))].slice(0, 6),
        domainTags: [...new Set(memberRecords.flatMap((record) => record.domainTags || []))].slice(0, 6),
      };
    });
  const bridgePairs = pairList.slice(0, 10).map((pair, index) => ({
    id: `bridge-${index + 1}`,
    leftRecordId: pair.leftId,
    rightRecordId: pair.rightId,
    sharedCount: pair.sharedCount,
    score: pair.score,
    sharedReferences: [...pair.sharedKeys].slice(0, 8).map((key) => ({ title: keyTitles.get(key) || key, key })),
  }));
  const sharedFoundations = [...citingByKey.entries()]
    .filter(([, citing]) => citing.size >= 2)
    .sort((left, right) => right[1].size - left[1].size)
    .slice(0, 20)
    .map(([key, citing]) => {
      const memberRecords = [...citing].map((id) => recordsById.get(id)).filter(Boolean);
      return {
        key,
        title: keyTitles.get(key) || key,
        count: citing.size,
        citingRecordIds: [...citing].slice(0, 40),
        areaTags: [...new Set(memberRecords.flatMap((record) => record.areaTags || []))].slice(0, 6),
        domainTags: [...new Set(memberRecords.flatMap((record) => record.domainTags || []))].slice(0, 6),
      };
    });
  const manifest = {
    generatedAt: "",
    source: { recordCount: entries.length, input: "pdf_and_jsonl" },
    limits: { maxReferencesPerRecord: 400, maxCommunities: 12, minSharedKeysForOverlap: 2 },
    summary: {
      recordCount: records.length,
      matchedRecords: entries.length,
      recordsWithReferences: entries.length,
      recordsWithOverlaps: overlapsByRecord.size ? [...overlapsByRecord.values()].filter((pairs) => pairs.length).length : 0,
      uniqueReferenceKeys: citingByKey.size,
      extractionErrors: 0,
    },
    records: Object.fromEntries(entries.map(([recordId]) => [
      recordId,
      {
        url: `site/data/references/records/${safeFileId(recordId)}.json`,
        referenceCount: recordReferenceCounts.get(recordId) || 0,
        overlapCount: (overlapsByRecord.get(recordId) || []).length,
      },
    ])),
    analysis: {
      referenceCounts: {
        byArea: countAreaReferences(entries, recordsById),
        byDomain: [],
      },
    },
    errors: [],
  };
  const insights = {
    generatedAt: "",
    sourceManifestGeneratedAt: "",
    summary: { edgeCount: pairList.length, communityCount: communities.length },
    recordIndex: Object.fromEntries(entries.map(([recordId]) => [recordId, true])),
    bridgePairs,
    communities,
    sharedFoundations,
  };
  const shards = new Map(entries.map(([recordId]) => [
    `site/data/references/records/${safeFileId(recordId)}.json`,
    {
      title: recordsById.get(recordId)?.title || recordId,
      referenceCount: recordReferenceCounts.get(recordId) || 0,
      references: (referencesByRecord.get(recordId) || []).slice(0, 400).map((reference) => ({
        title: normalizeWhitespace(reference.title || reference.raw || "").slice(0, 240),
        year: reference.year || "",
        source: reference.source || "",
        key: referenceKey(reference),
      })),
      overlaps: (overlapsByRecord.get(recordId) || []).slice(0, 20).map((pair) => ({
        recordId: pair.leftId === recordId ? pair.rightId : pair.leftId,
        sharedCount: pair.sharedCount,
        score: pair.score,
        references: [...pair.sharedKeys].slice(0, 8).map((key) => ({ title: keyTitles.get(key) || key, key })),
      })),
    },
  ]));
  return { manifest, insights, shards, hasData: entries.length > 0 };
}

function countAreaReferences(entries, recordsById) {
  const counts = new Map();
  for (const [recordId, references] of entries) {
    const record = recordsById.get(recordId);
    const label = (record?.areaTags || [])[0] || record?.category || "Other";
    counts.set(label, (counts.get(label) || 0) + references.length);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1]).map(([label, count]) => ({ label, count }));
}
