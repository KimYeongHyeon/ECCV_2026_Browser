#!/usr/bin/env node

// Zero-dependency contract checker for the built Conference Atlas artifacts.
//
// Run after `npm run build`:
//   node scripts/verify.mjs [--output docs/site/data]
//
// Every *.json under the output directory must parse, and the artifacts must
// satisfy the cross-file contract: fingerprints match file bytes, shard/map/
// trends/study ids resolve against the index, clustering levels line up, the
// people artifact is email-free, and search embeddings decode as Int8 vectors.

import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHARD_TYPES = ["paper", "poster", "workshop"];
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const EMAIL_PATTERN = /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/u;
const FORBIDDEN_KEY_NAMES = new Set(["email", "authoremails"]);
const SITE_DATA_URL_PREFIX = "site/data/";

function usage() {
  return `Usage: node scripts/verify.mjs [options]

Validate the Conference Atlas build artifacts (JSON contract, fingerprints,
id references, clustering levels, privacy, embeddings).

Options:
  --output PATH  Built artifact directory (default: docs/site/data)
  --help         Show this help`;
}

function parseArguments(argv) {
  const options = { output: "docs/site/data" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { ...options, help: true };
    if (argument !== "--output") throw new Error(`Unknown option: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
    options.output = value;
    index += 1;
  }
  return options;
}

function toPosix(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function displayPath(absolutePath) {
  const relative = path.relative(ROOT, absolutePath);
  return relative && !relative.startsWith("..") ? toPosix(relative) : absolutePath;
}

class Verifier {
  constructor(outputDir) {
    this.outputDir = outputDir;
    this.failures = [];
    this.checks = 0;
    this.files = 0;
    this.parsed = new Map(); // posix rel path -> parsed JSON value
  }

  fail(relPath, message) {
    this.failures.push(`${relPath}: ${message}`);
  }

  check(condition, relPath, message) {
    this.checks += 1;
    if (!condition) this.fail(relPath, message);
    return Boolean(condition);
  }

  equals(actual, expected, relPath, message) {
    this.checks += 1;
    if (actual !== expected) this.fail(relPath, `${message} (expected ${expected}, got ${actual})`);
    return actual === expected;
  }
}

async function findJsonFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const found = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...await findJsonFiles(entryPath));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) {
      found.push(entryPath);
    }
  }
  return found;
}

function fingerprintOfBytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectEmailIssues(value, jsonPath, issues) {
  if (typeof value === "string") {
    if (EMAIL_PATTERN.test(value)) issues.push(`${jsonPath} contains an email-like string`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectEmailIssues(entry, `${jsonPath}[${index}]`, issues));
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      const keyPath = jsonPath ? `${jsonPath}.${key}` : key;
      if (FORBIDDEN_KEY_NAMES.has(key.toLowerCase())) issues.push(`${keyPath} uses forbidden key "${key}"`);
      collectEmailIssues(entry, keyPath, issues);
    }
  }
}

function decodeBase64ToInt8(value) {
  const bytes = Buffer.from(value, "base64");
  if (Buffer.from(value, "base64").toString("base64").replace(/=+$/u, "") !== value.replace(/=+$/u, "")) {
    return { ok: false, vector: null, error: "vector is not valid base64" };
  }
  return { ok: true, vector: new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), error: "" };
}

async function loadOutputTree(verify, absoluteOutput) {
  let outputStat;
  try {
    outputStat = await stat(absoluteOutput);
  } catch {
    verify.fail(displayPath(absoluteOutput), "output directory does not exist (run npm run build first)");
    return false;
  }
  if (!verify.check(outputStat.isDirectory(), displayPath(absoluteOutput), "output path is not a directory")) {
    return false;
  }
  const jsonFiles = await findJsonFiles(absoluteOutput);
  verify.files = jsonFiles.length;
  if (!verify.check(jsonFiles.length > 0, displayPath(absoluteOutput), "no JSON artifacts found")) return false;
  for (const filePath of jsonFiles) {
    const relPath = toPosix(path.relative(absoluteOutput, filePath));
    verify.checks += 1;
    try {
      const bytes = await readFile(filePath);
      const text = bytes.toString("utf8");
      verify.parsed.set(relPath, { value: JSON.parse(text), bytes });
    } catch (error) {
      verify.fail(relPath, `invalid JSON (${error.message})`);
    }
  }
  return true;
}

function artifact(verify, relPath) {
  const entry = verify.parsed.get(relPath);
  if (!entry) {
    verify.fail(relPath, "required artifact is missing");
    return null;
  }
  return entry;
}

function recordIds(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((record) => (isPlainObject(record) ? record.id : null))
    .filter((id) => typeof id === "string" && id.length > 0);
}

function verifyIndex(verify) {
  const entry = artifact(verify, "conference_index.json");
  if (!entry) return null;
  const index = entry.value;
  const valid = verify.check(isPlainObject(index) && Array.isArray(index.records), "conference_index.json", "records must be an array");
  if (!valid) return null;
  const ids = index.records.map((record) => (isPlainObject(record) ? record.id : null));
  verify.check(ids.every((id) => typeof id === "string" && id.length > 0), "conference_index.json", "every record must have a non-empty string id");
  const duplicates = ids.filter((id, position) => ids.indexOf(id) !== position);
  verify.check(duplicates.length === 0, "conference_index.json", duplicates.length ? `duplicate record ids: ${[...new Set(duplicates)].slice(0, 5).join(", ")}` : "");
  return new Set(ids.filter(Boolean));
}

function verifyManifest(verify, indexIds) {
  const entry = artifact(verify, "conference_index.manifest.json");
  if (!entry) return;
  const manifest = entry.value;
  if (!verify.check(isPlainObject(manifest), "conference_index.manifest.json", "manifest must be a JSON object")) return;
  verify.check(isPlainObject(manifest.summary), "conference_index.manifest.json", "manifest.summary must be an object");

  const indexEntry = verify.parsed.get("conference_index.json");
  if (indexEntry) {
    const expected = fingerprintOfBytes(indexEntry.bytes);
    const actual = manifest.indexArtifactFingerprint;
    const shaped = typeof actual === "string" && FINGERPRINT_PATTERN.test(actual);
    verify.check(shaped, "conference_index.manifest.json", "indexArtifactFingerprint must match sha256:<64 hex chars>");
    if (shaped) {
      verify.equals(actual, expected, "conference_index.manifest.json", "indexArtifactFingerprint must equal the sha256 of conference_index.json bytes");
    }
  }

  const peopleFingerprint = manifest.peopleTopicsArtifactFingerprint;
  if (typeof peopleFingerprint === "string" && peopleFingerprint.length > 0) {
    const shaped = verify.check(FINGERPRINT_PATTERN.test(peopleFingerprint), "conference_index.manifest.json", "peopleTopicsArtifactFingerprint must match sha256:<64 hex chars>");
    const peopleEntry = verify.parsed.get(path.join("analysis", "conference_people_topics.json"));
    if (verify.check(Boolean(peopleEntry), "conference_index.manifest.json", "peopleTopicsArtifactFingerprint is set but analysis/conference_people_topics.json is missing") && peopleEntry && shaped) {
      verify.equals(peopleFingerprint, fingerprintOfBytes(peopleEntry.bytes), "conference_index.manifest.json", "peopleTopicsArtifactFingerprint must equal the sha256 of analysis/conference_people_topics.json bytes");
    }
  }

  const startupUrl = manifest.startupUrl;
  if (verify.check(typeof startupUrl === "string" && startupUrl.length > 0, "conference_index.manifest.json", "startupUrl must be a non-empty string")) {
    verify.check(Boolean(artifactForUrl(verify, startupUrl)), "conference_index.manifest.json", `startupUrl "${startupUrl}" does not resolve to an artifact`);
  }

  const shards = manifest.shards;
  if (!verify.check(Array.isArray(shards), "conference_index.manifest.json", "shards must be an array")) return;
  const seenTypes = new Set();
  for (const [position, shard] of shards.entries()) {
    const label = `conference_index.manifest.json shards[${position}]`;
    if (!verify.check(isPlainObject(shard), label, "shard entry must be an object")) continue;
    verify.check(SHARD_TYPES.includes(shard.type), label, `unknown shard type "${shard.type}"`);
    verify.check(!seenTypes.has(shard.type), label, `duplicate shard type "${shard.type}"`);
    seenTypes.add(shard.type);
    if (typeof shard.url !== "string" || shard.url.length === 0) {
      verify.fail(label, `shard url must be a non-empty string`);
      continue;
    }
    const shardEntry = artifactForUrl(verify, shard.url);
    if (!shardEntry) {
      verify.fail(label, `shard url "${shard.url}" does not resolve to an artifact`);
      continue;
    }
    const shardRecords = shardEntry.value?.records;
    if (!verify.check(Array.isArray(shardRecords), urlToRelPath(shard.url), "shard records must be an array")) continue;
    const unknown = recordIds(shardRecords).filter((id) => !indexIds.has(id));
    verify.check(unknown.length === 0, urlToRelPath(shard.url), unknown.length ? `record ids missing from conference_index.json: ${unknown.slice(0, 5).join(", ")}` : "");
  }
  for (const type of SHARD_TYPES) {
    verify.check(seenTypes.has(type), "conference_index.manifest.json", `missing shard for type "${type}"`);
  }
}

// Manifest urls are site-root relative ("site/data/..."), i.e. relative to the
// artifact directory itself once the "site/data/" prefix is stripped.
function urlToRelPath(url) {
  const relative = url.startsWith(SITE_DATA_URL_PREFIX) ? url.slice(SITE_DATA_URL_PREFIX.length) : url;
  return toPosix(path.normalize(relative));
}

function artifactForUrl(verify, url) {
  return verify.parsed.get(urlToRelPath(url)) || null;
}

function verifyStartup(verify, indexIds) {
  const manifest = verify.parsed.get("conference_index.manifest.json")?.value;
  const url = typeof manifest?.startupUrl === "string" && manifest.startupUrl ? manifest.startupUrl : "site/data/conference_startup.json";
  const entry = artifactForUrl(verify, url);
  if (!entry) return;
  const relPath = urlToRelPath(url);
  const records = entry.value?.records;
  if (!verify.check(Array.isArray(records), relPath, "startup records must be an array")) return;
  const unknown = recordIds(records).filter((id) => !indexIds.has(id));
  verify.check(unknown.length === 0, relPath, unknown.length ? `record ids missing from conference_index.json: ${unknown.slice(0, 5).join(", ")}` : "");
}

function verifyMap(verify, indexIds) {
  const entry = artifact(verify, "conference_map.json");
  if (!entry) return;
  const map = entry.value;
  if (!verify.check(isPlainObject(map), "conference_map.json", "map must be a JSON object")) return;
  const records = map.records;
  if (!verify.check(Array.isArray(records), "conference_map.json", "map records must be an array")) return;
  const mapIds = [];
  for (const [position, record] of records.entries()) {
    const label = `conference_map.json records[${position}]`;
    if (!verify.check(isPlainObject(record), label, "map record must be an object")) continue;
    verify.check(typeof record.id === "string" && record.id.length > 0, label, "map record id must be a non-empty string");
    if (typeof record.id === "string") mapIds.push(record.id);
    verify.check(Number.isFinite(record.x), label, `x must be a finite number (got ${JSON.stringify(record.x)})`);
    verify.check(Number.isFinite(record.y), label, `y must be a finite number (got ${JSON.stringify(record.y)})`);
    if (Array.isArray(record.nearestNeighbors)) {
      for (const [neighborPosition, neighbor] of record.nearestNeighbors.entries()) {
        const neighborLabel = `${label}.nearestNeighbors[${neighborPosition}]`;
        if (!verify.check(isPlainObject(neighbor), neighborLabel, "neighbor must be an object")) continue;
        verify.check(indexIds.has(neighbor.id), neighborLabel, `neighbor id "${neighbor.id}" is not present in conference_index.json`);
        verify.check(Number.isFinite(neighbor.score), neighborLabel, `score must be a finite number (got ${JSON.stringify(neighbor.score)})`);
      }
    }
  }
  const duplicates = mapIds.filter((id, position) => mapIds.indexOf(id) !== position);
  verify.check(duplicates.length === 0, "conference_map.json", duplicates.length ? `duplicate map record ids: ${[...new Set(duplicates)].slice(0, 5).join(", ")}` : "");
  const unknownIds = [...new Set(mapIds)].filter((id) => !indexIds.has(id));
  verify.check(unknownIds.length === 0, "conference_map.json", unknownIds.length ? `map record ids missing from conference_index.json: ${unknownIds.slice(0, 5).join(", ")}` : "");

  const clusterIdSets = [
    ["embeddingClusters", new Set((Array.isArray(map.embeddingClusters) ? map.embeddingClusters : []).map((cluster) => cluster?.id).filter(Boolean))],
    ["clusters", new Set((Array.isArray(map.clusters) ? map.clusters : []).map((cluster) => cluster?.id).filter(Boolean))],
  ];
  const levels = map.embeddingClusterLevels;
  if (!verify.check(levels === undefined || Array.isArray(levels), "conference_map.json", "embeddingClusterLevels must be an array")) return;
  for (const levelsEntry of Array.isArray(levels) ? levels.entries() : []) {
    const [position, level] = levelsEntry;
    const label = `conference_map.json embeddingClusterLevels[${position}]`;
    if (!verify.check(isPlainObject(level), label, "level must be an object")) continue;
    verify.check(Number.isInteger(level.k) && level.k >= 2, label, `k must be an integer >= 2 (got ${JSON.stringify(level.k)})`);
    if (!verify.check(Array.isArray(level.assignments), label, "assignments must be an array")) continue;
    verify.equals(level.assignments.length, records.length, label, "assignments length must equal map records length");
    const clusterIds = new Set((Array.isArray(level.clusters) ? level.clusters : []).map((cluster) => cluster?.id).filter(Boolean));
    const unknownAssignments = [...new Set(level.assignments.filter((assignment) => !clusterIds.has(assignment)))];
    verify.check(clusterIds.size > 0 || level.assignments.length === 0, label, "clusters must be non-empty when assignments exist");
    verify.check(unknownAssignments.length === 0, label, unknownAssignments.length ? `assignments reference unknown cluster ids: ${unknownAssignments.slice(0, 5).join(", ")}` : "");
  }
  verify.mapEmbeddingClusterIds = clusterIdSets[0][1];
  verify.mapClusterIds = clusterIdSets[1][1];
}

function verifyTrends(verify, indexIds) {
  const entry = artifact(verify, "conference_trends.json");
  if (!entry) return;
  const trends = entry.value?.trends;
  if (!verify.check(Array.isArray(trends), "conference_trends.json", "trends must be an array")) return;
  const seen = new Set();
  for (const [position, trend] of trends.entries()) {
    const label = `conference_trends.json trends[${position}]`;
    if (!verify.check(isPlainObject(trend), label, "trend must be an object")) continue;
    verify.check(typeof trend.id === "string" && trend.id.length > 0, label, "trend id must be a non-empty string");
    if (typeof trend.id === "string" && trend.id.length > 0) {
      verify.check(!seen.has(trend.id), label, `duplicate trend id "${trend.id}"`);
      seen.add(trend.id);
    }
    for (const field of ["representativeRecordIds", "firstReadRecordIds"]) {
      if (!Array.isArray(trend[field])) {
        verify.fail(label, `${field} must be an array`);
        continue;
      }
      const unknown = trend[field].filter((id) => !indexIds.has(id));
      verify.check(unknown.length === 0, label, unknown.length ? `${field} references ids missing from conference_index.json: ${unknown.slice(0, 5).join(", ")}` : "");
    }
  }
}

function verifyStudyFeatures(verify, indexIds) {
  const entry = artifact(verify, "conference_study_features.json");
  if (!entry) return;
  const features = entry.value;
  if (!verify.check(isPlainObject(features), "conference_study_features.json", "study features must be a JSON object")) return;
  const embeddingClusterIds = verify.mapEmbeddingClusterIds || new Set();
  const fallbackClusterIds = verify.mapClusterIds || new Set();
  const clusterIds = new Set([...embeddingClusterIds, ...fallbackClusterIds]);
  const topics = features.topics;
  if (verify.check(topics === undefined || isPlainObject(topics), "conference_study_features.json", "topics must be an object") && isPlainObject(topics)) {
    const unknown = Object.keys(topics).filter((clusterId) => !clusterIds.has(clusterId));
    verify.check(unknown.length === 0, "conference_study_features.json", unknown.length ? `topics reference cluster ids missing from conference_map.json: ${unknown.slice(0, 5).join(", ")}` : "");
  }
  const perRecord = features.records;
  if (verify.check(perRecord === undefined || isPlainObject(perRecord), "conference_study_features.json", "records must be an object") && isPlainObject(perRecord)) {
    const unknown = Object.keys(perRecord).filter((id) => !indexIds.has(id));
    verify.check(unknown.length === 0, "conference_study_features.json", unknown.length ? `record keys missing from conference_index.json: ${unknown.slice(0, 5).join(", ")}` : "");
  }
  if (Array.isArray(features.outliers)) {
    const unknown = features.outliers
      .map((outlier) => (isPlainObject(outlier) ? outlier.recordId : null))
      .filter((id) => typeof id === "string")
      .filter((id) => !indexIds.has(id));
    verify.check(unknown.length === 0, "conference_study_features.json", unknown.length ? `outlier record ids missing from conference_index.json: ${unknown.slice(0, 5).join(", ")}` : "");
  }
}

function verifyConcepts(verify) {
  const entry = artifact(verify, path.join("concepts", "conference_concepts.json"));
  if (!entry) return;
  const concepts = entry.value;
  if (!verify.check(isPlainObject(concepts), "concepts/conference_concepts.json", "concepts must be a JSON object")) return;
  const records = concepts.records;
  if (!verify.check(isPlainObject(records), "concepts/conference_concepts.json", "records must be an object")) return;
  verify.check(isPlainObject(concepts.summary), "concepts/conference_concepts.json", "summary must be an object");
  if (isPlainObject(concepts.summary)) {
    verify.equals(concepts.summary.publishedRecordCount, Object.keys(records).length, "concepts/conference_concepts.json", "summary.publishedRecordCount must equal the number of record keys");
  }
  const artifactFingerprint = concepts.fingerprints?.artifact;
  verify.check(typeof artifactFingerprint === "string" && FINGERPRINT_PATTERN.test(artifactFingerprint), "concepts/conference_concepts.json", `fingerprints.artifact must match sha256:<64 hex chars> (got ${JSON.stringify(artifactFingerprint)})`);
}

function verifyPeopleTopics(verify, manifest) {
  const entry = verify.parsed.get(path.join("analysis", "conference_people_topics.json"));
  if (!entry) return;
  const relPath = "analysis/conference_people_topics.json";
  const issues = [];
  collectEmailIssues(entry.value, "", issues);
  verify.check(issues.length === 0, relPath, issues.length ? issues.slice(0, 5).join("; ") : "");
  const peopleFingerprint = manifest?.peopleTopicsArtifactFingerprint;
  if (typeof peopleFingerprint === "string" && peopleFingerprint.length > 0) {
    verify.equals(peopleFingerprint, fingerprintOfBytes(entry.bytes), relPath, "sha256 of this file must equal manifest.peopleTopicsArtifactFingerprint");
  }
}

function verifySearchEmbeddings(verify, indexIds) {
  const entry = artifact(verify, "conference_search_embeddings.json");
  if (!entry) return;
  const embeddings = entry.value;
  if (!verify.check(isPlainObject(embeddings), "conference_search_embeddings.json", "search embeddings must be a JSON object")) return;
  const records = embeddings.records;
  if (!verify.check(Array.isArray(records), "conference_search_embeddings.json", "records must be an array")) return;
  if (!records.length) return;
  let expectedLength = null;
  for (const [position, record] of records.entries()) {
    const label = `conference_search_embeddings.json records[${position}]`;
    if (!verify.check(isPlainObject(record), label, "embedding record must be an object")) continue;
    verify.check(typeof record.id === "string" && record.id.length > 0, label, "embedding record id must be a non-empty string");
    if (typeof record.id === "string" && record.id.length > 0) {
      verify.check(indexIds.has(record.id), label, `embedding id "${record.id}" is not present in conference_index.json`);
    }
    const vector = record.vector;
    if (!verify.check(typeof vector === "string" && vector.length > 0, label, "vector must be a non-empty base64 string")) continue;
    const decoded = decodeBase64ToInt8(vector);
    if (!verify.check(decoded.ok, label, decoded.error)) continue;
    verify.check(decoded.vector.length > 0, label, "decoded vector must not be empty");
    if (expectedLength === null) expectedLength = decoded.vector.length;
    verify.equals(decoded.vector.length, expectedLength, label, "decoded Int8 vector length must be consistent across records");
  }
}

async function verify(options) {
  const absoluteOutput = path.isAbsolute(options.output) ? options.output : path.join(ROOT, options.output);
  const verify = new Verifier(absoluteOutput);
  const loaded = await loadOutputTree(verify, absoluteOutput);
  if (loaded) {
    const indexIds = verifyIndex(verify);
    if (indexIds) {
      const manifest = verify.parsed.get("conference_index.manifest.json")?.value || null;
      verifyManifest(verify, indexIds);
      verifyStartup(verify, indexIds);
      verifyMap(verify, indexIds);
      verifyTrends(verify, indexIds);
      verifyStudyFeatures(verify, indexIds);
      verifyConcepts(verify);
      verifyPeopleTopics(verify, manifest);
      verifySearchEmbeddings(verify, indexIds);
    }
  }
  return verify;
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
  } else {
    const result = await verify(options);
    for (const [index, failure] of result.failures.entries()) {
      console.error(`${index + 1}. ${failure}`);
    }
    if (result.failures.length) {
      console.error(`verify: FAILED (${result.files} files, ${result.checks} checks, ${result.failures.length} failures)`);
      process.exitCode = 1;
    } else {
      console.log(`verify: OK (${result.files} files, ${result.checks} checks)`);
    }
  }
} catch (error) {
  console.error(error.message);
  console.error("Run with --help for usage.");
  process.exitCode = 1;
}
