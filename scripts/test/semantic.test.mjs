import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildVectors,
  clusterLevels,
  nearestNeighbors,
  pickPrimaryLevel,
  project2D,
  semanticFingerprint,
} from "../lib/semantic.mjs";

// Two obviously separated topic groups with no shared content words.
const GROUP_A_TEXTS = [
  ["Attention Head Pruning in Neural Language Models", "We analyze how attention heads in transformer language models encode syntax across layers."],
  ["Sparse Attention for Long Context Language Models", "Sparse attention lets transformer language models read long contexts with fewer token comparisons."],
  ["Transformer Decoding Strategies for Language Models", "We compare decoding strategies for transformer language models and their effect on token fluency."],
  ["Multilingual Neural Language Model Transfer", "We transfer neural language model weights across languages while keeping attention layers stable."],
];
const GROUP_B_TEXTS = [
  ["Reinforcement Learning Policies for Robot Control", "We develop reinforcement control policies that let a robot arm grasp objects on a cluttered table."],
  ["Sample Efficient Robot Control with Reinforcement", "Reinforcement control of a quadruped robot needs few reward tweaks to walk over rough terrain."],
  ["Policy Distillation for Robotic Manipulation", "We distill a reinforcement policy into a small controller for robotic grasping and pushing."],
  ["Safe Reinforcement Control for Warehouse Robots", "Safety filters keep reinforcement control policies for warehouse robots within joint limits."],
];

function makeRecord(id, [title, abstract]) {
  return { id, title, abstract };
}

const records = [
  ...GROUP_A_TEXTS.map((texts, index) => makeRecord(`a${index + 1}`, texts)),
  ...GROUP_B_TEXTS.map((texts, index) => makeRecord(`b${index + 1}`, texts)),
];

function groupOf(id) {
  return id.startsWith("a") ? "A" : "B";
}

function cosineLength(vector) {
  let sum = 0;
  for (const value of vector.values()) sum += value * value;
  return Math.sqrt(sum);
}

test("buildVectors returns L2-normalized sparse vectors", () => {
  const { vectors, termIndex, documentFrequency } = buildVectors(records);
  assert.equal(vectors.length, records.length);
  assert.ok(termIndex instanceof Map);
  assert.ok(documentFrequency instanceof Map);
  for (const entry of vectors) {
    assert.ok(entry.vector instanceof Map);
    assert.ok(Math.abs(cosineLength(entry.vector) - 1) < 1e-9, `vector for ${entry.id} should be unit length`);
  }
});

test("nearestNeighbors rank same-group records first", () => {
  const { vectors } = buildVectors(records);
  const neighborsByRecord = nearestNeighbors(vectors, { limit: 4 });
  assert.equal(neighborsByRecord.length, records.length);
  for (const { id, neighbors } of neighborsByRecord) {
    assert.ok(neighbors.length > 0, `${id} should have at least one neighbor`);
    assert.equal(
      groupOf(neighbors[0].id),
      groupOf(id),
      `${id}'s top neighbor should come from the same topic group (got ${neighbors[0].id})`,
    );
    for (const neighbor of neighbors) {
      assert.ok(neighbor.score > 0);
      assert.notEqual(neighbor.id, id);
    }
  }
});

test("pickPrimaryLevel splits the two topic groups cleanly", () => {
  const { vectors, termIndex } = buildVectors(records);
  const levels = clusterLevels(vectors, termIndex);
  assert.ok(levels.length >= 1);
  for (const level of levels) {
    assert.equal(level.assignments.length, records.length, "assignments must be parallel to the records");
    const clusterIds = new Set(level.clusters.map((cluster) => cluster.id));
    for (const assignment of level.assignments) {
      assert.ok(clusterIds.has(assignment), `assignment "${assignment}" must exist in the level clusters`);
    }
  }
  const primary = pickPrimaryLevel(levels);
  assert.ok(primary, "a primary level should be selectable");
  assert.ok(primary.clusters.length >= 2, "the primary level should separate the corpus into multiple clusters");
  const groupsByCluster = new Map();
  for (const [index, assignment] of primary.assignments.entries()) {
    const groups = groupsByCluster.get(assignment) || new Set();
    groups.add(groupOf(records[index].id));
    groupsByCluster.set(assignment, groups);
  }
  for (const [clusterId, groups] of groupsByCluster) {
    assert.equal(
      groups.size,
      1,
      `cluster ${clusterId} should not mix topic groups (contains ${[...groups].join(" + ")})`,
    );
  }
  assert.equal(groupsByCluster.size, 2, "the two groups should land in two distinct clusters");
});

test("project2D is deterministic and stays within [-1, 1]", () => {
  const { vectors } = buildVectors(records);
  const first = project2D(vectors);
  const second = project2D(vectors);
  assert.equal(JSON.stringify(first), JSON.stringify(second), "projection should be deterministic");
  assert.equal(first.length, records.length);
  for (const point of first) {
    assert.ok(Math.abs(point.x) <= 1, `x for ${point.id} should be within [-1, 1]`);
    assert.ok(Math.abs(point.y) <= 1, `y for ${point.id} should be within [-1, 1]`);
  }
});

test("semanticFingerprint is stable and sensitive to input changes", () => {
  const fingerprint = semanticFingerprint({ records: 8, levels: [2, 4] });
  assert.equal(semanticFingerprint({ records: 8, levels: [2, 4] }), fingerprint);
  assert.notEqual(semanticFingerprint({ records: 9, levels: [2, 4] }), fingerprint);
  assert.notEqual(semanticFingerprint({ records: 8, levels: [2, 5] }), fingerprint);
});
