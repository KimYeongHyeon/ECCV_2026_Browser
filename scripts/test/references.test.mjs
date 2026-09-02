import assert from "node:assert/strict";
import { test } from "node:test";

import { buildReferenceArtifacts } from "../lib/references.mjs";

const RECORDS = [
  { id: "rec-a", title: "Record A", category: "Vision", areaTags: ["Vision"], domainTags: [] },
  { id: "rec-b", title: "Record B", category: "Vision", areaTags: ["Vision"], domainTags: [] },
  { id: "rec-c", title: "Record C", category: "Systems", areaTags: ["Systems"], domainTags: [] },
];

// rec-a and rec-b share two normalized reference titles; rec-c cites nothing.
const REFERENCES_BY_RECORD = new Map([
  ["rec-a", [
    { title: "Attention Is All You Need", year: "2017" },
    { title: "Deep Residual Learning for Image Recognition", year: "2015" },
    { title: "Only A Cites This One", year: "2010" },
  ]],
  ["rec-b", [
    { title: "  attention   is ALL you NEED! ", year: "2017" },
    { title: "deep-residual learning for image recognition.", year: "2015" },
    { title: "Only B Cites That One", year: "2011" },
  ]],
  ["rec-c", []],
]);

let buildOutcome;
try {
  buildOutcome = { value: buildReferenceArtifacts({
    records: RECORDS,
    referencesByRecord: REFERENCES_BY_RECORD,
  }) };
} catch (error) {
  buildOutcome = { error };
}

function artifacts() {
  if (buildOutcome.error) {
    assert.fail(`buildReferenceArtifacts threw: ${buildOutcome.error.message}`);
  }
  return buildOutcome.value;
}

test("manifest counts only records that contribute references", () => {
  const { manifest, hasData } = artifacts();
  assert.equal(hasData, true);
  assert.equal(manifest.summary.recordsWithReferences, 2);
  assert.equal(manifest.summary.recordCount, RECORDS.length);
  assert.equal(manifest.summary.uniqueReferenceKeys, 4);
  assert.deepEqual(Object.keys(manifest.records).sort(), ["rec-a", "rec-b"]);
});

test("insights communities link the two records sharing references", () => {
  const { insights } = artifacts();
  assert.ok(insights.communities.length >= 1);
  const community = insights.communities[0];
  assert.ok(community.recordIds.includes("rec-a"), "community should contain rec-a");
  assert.ok(community.recordIds.includes("rec-b"), "community should contain rec-b");
  assert.ok(!community.recordIds.includes("rec-c"));
  assert.equal(community.maxSharedCount, 2);
  assert.ok(insights.summary.communityCount >= 1);
  assert.ok(insights.summary.edgeCount >= 1);
});

test("sharedFoundations rank the twice-cited references first", () => {
  const { insights } = artifacts();
  assert.ok(insights.sharedFoundations.length >= 2);
  assert.equal(insights.sharedFoundations[0].count, 2);
  assert.equal(insights.sharedFoundations[1].count, 2);
  const keys = insights.sharedFoundations.map((foundation) => foundation.key);
  assert.ok(keys.includes("attention is all you need"));
  assert.ok(keys.includes("deep residual learning for image recognition"));
  for (const foundation of insights.sharedFoundations) {
    assert.deepEqual([...foundation.citingRecordIds].sort(), ["rec-a", "rec-b"]);
  }
});

test("bridge pairs carry the shared reference count", () => {
  const { insights } = artifacts();
  const pair = insights.bridgePairs.find((candidate) => (
    (candidate.leftRecordId === "rec-a" && candidate.rightRecordId === "rec-b")
    || (candidate.leftRecordId === "rec-b" && candidate.rightRecordId === "rec-a")
  ));
  assert.ok(pair, "a bridge pair between rec-a and rec-b should exist");
  assert.equal(pair.sharedCount, 2);
  assert.equal(pair.sharedReferences.length, 2);
});

test("per-record shards are JSON-serializable with reference details", () => {
  const { shards } = artifacts();
  assert.ok(shards instanceof Map);
  assert.equal(shards.size, 2);
  for (const recordId of ["rec-a", "rec-b"]) {
    // safeFileId keeps [a-zA-Z0-9_-] as-is, so hyphens survive.
    const key = `site/data/references/records/${recordId}.json`;
    const shard = shards.get(key);
    assert.ok(shard, `expected a shard at ${key}`);
    assert.equal(shard.referenceCount, 3);
    assert.equal(shard.title, `Record ${recordId.slice(-1).toUpperCase()}`);
    assert.equal(shard.references.length, 3);
    for (const reference of shard.references) {
      assert.equal(typeof reference.title, "string");
      assert.ok(reference.title.length > 0);
      assert.equal(typeof reference.year, "string");
      assert.equal(typeof reference.source, "string");
      assert.match(reference.key, /^[a-z0-9 ]+$/u);
    }
    const roundTrip = JSON.parse(JSON.stringify(shard));
    assert.deepEqual(roundTrip, shard);
  }
  const shardA = shards.get("site/data/references/records/rec-a.json");
  const overlap = shardA.overlaps.find((candidate) => candidate.recordId === "rec-b");
  assert.ok(overlap, "rec-a should list rec-b as an overlap");
  assert.equal(overlap.sharedCount, 2);
  assert.ok(overlap.score > 0 && overlap.score <= 1);
  assert.equal(overlap.references.length, 2);
});

test("reference keys normalize away case and punctuation", () => {
  const { shards } = artifacts();
  const shardA = shards.get("site/data/references/records/rec-a.json");
  const shardB = shards.get("site/data/references/records/rec-b.json");
  const keysA = shardA.references.map((reference) => reference.key);
  const keysB = shardB.references.map((reference) => reference.key);
  assert.deepEqual(keysA.slice(0, 2).sort(), keysB.slice(0, 2).sort());
});
