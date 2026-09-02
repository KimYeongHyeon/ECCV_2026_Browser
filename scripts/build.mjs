#!/usr/bin/env node

// Conference Atlas build.
//
// One command turns three inputs into the complete static artifact set:
//   1. config/conference.json   – conference identity
//   2. data/source/records.csv  – one row per paper/workshop (or records.jsonl)
//   3. data/pdfs/*.pdf          – optional PDFs named <recordId>.pdf
//
// The first build extracts text from every PDF and runs the semantic
// pipeline. Later builds warm-start: unchanged PDFs reuse their extraction
// cache, an unchanged corpus reuses semantic artifacts, and an unchanged
// input set keeps the previous generatedAt so published fingerprints stay
// stable.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { buildConceptArtifact } from "./lib/concepts.mjs";
import { parseCsv, recordsFromCsvRows } from "./lib/csv.mjs";
import { ingestPdfs } from "./lib/ingest.mjs";
import { buildReferenceArtifacts } from "./lib/references.mjs";
import { buildSearchEmbeddings } from "./lib/search_index.mjs";
import {
  CLUSTER_LEVELS,
  NEIGHBOR_COUNT,
  buildVectors,
  clusterLevels,
  corpusMeanVector,
  nearestNeighbors,
  pickPrimaryLevel,
  project2D,
  semanticFingerprint,
} from "./lib/semantic.mjs";
import { buildStudyFeatures } from "./lib/study.mjs";
import { documentText, sha256Fingerprint, stringArray } from "./lib/text.mjs";
import { buildTrends } from "./lib/trends.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEMANTIC_PIPELINE_VERSION = 2;
const EMAIL_PATTERN = /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/u;

function usage() {
  return `Usage: node scripts/build.mjs [options]

Options:
  --config PATH   Conference configuration (default: config/conference.json)
  --records PATH  Metadata CSV or JSONL (default: data/source/records.csv, then records.jsonl)
  --output PATH   Static artifact directory (default: docs/site/data)
  --force         Ignore warm-start caches and rebuild everything
  --help          Show this help`;
}

function parseArguments(argv) {
  const options = { config: "config/conference.json", records: "", output: "docs/site/data", force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { ...options, help: true };
    if (argument === "--force") {
      options.force = true;
      continue;
    }
    if (!["--config", "--records", "--output"].includes(argument)) {
      throw new Error(`Unknown option: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
    options[argument.slice(2)] = value;
    index += 1;
  }
  return options;
}

function absolute(relativeOrAbsolute) {
  return path.isAbsolute(relativeOrAbsolute) ? relativeOrAbsolute : path.join(ROOT, relativeOrAbsolute);
}

async function readIfExists(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function readJsonIfExists(filePath) {
  const text = await readIfExists(filePath);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseJsonLines(text, sourcePath) {
  return text.split(/\r?\n/u).flatMap((line, index) => {
    if (!line.trim()) return [];
    try {
      return [{ row: JSON.parse(line), line: index + 1 }];
    } catch (error) {
      throw new Error(`${sourcePath}:${index + 1}: invalid JSON (${error.message})`);
    }
  });
}

function validateRecord(record, label) {
  for (const key of ["id", "type", "title"]) {
    if (!String(record[key] || "").trim()) throw new Error(`records ${label}: missing ${key}`);
  }
  if (!["paper", "poster", "workshop"].includes(record.type)) {
    throw new Error(`records ${label}: type must be paper, poster, or workshop`);
  }
  if (!Array.isArray(record.authorAffiliations || [])) {
    throw new Error(`records ${label}: authorAffiliations must be an array`);
  }
  for (const affiliation of record.authorAffiliations || []) {
    if (!affiliation.author || !affiliation.institution || !affiliation.sourceUrl) {
      throw new Error(`records ${label}: affiliation requires author, institution, and sourceUrl`);
    }
  }
}

function normalizedRecord(source) {
  const authors = stringArray(source.authors);
  const categoryTags = stringArray(source.categoryTags || source.category || "Other");
  // Area/domain tags drive map colors and the legend; default them to the
  // category so the map stays meaningful without hand-tagged metadata.
  const areaTags = stringArray(source.areaTags).length ? stringArray(source.areaTags) : categoryTags.slice(0, 1);
  const domainTags = stringArray(source.domainTags);
  const bestAsset = source.localPdfPath || source.localSlidePath || source.localPosterPath || "";
  const bestAssetKind = source.localPdfPath ? "pdf" : source.localSlidePath ? "slide" : source.localPosterPath ? "poster" : "";
  return {
    id: String(source.id),
    type: source.type,
    title: String(source.title),
    abstract: String(source.abstract || ""),
    authors: authors.join(", "),
    authorAffiliations: source.authorAffiliations || [],
    searchAliases: stringArray(source.searchAliases),
    group: String(source.group || (source.type === "workshop" ? "Workshop" : "Main Conference")),
    category: categoryTags[0] || "Other",
    categoryTags,
    areaTags,
    domainTags,
    clusterId: source.clusterId ?? null,
    clusterLabel: String(source.clusterLabel || ""),
    embeddingClusterId: null,
    embeddingClusterLabel: "",
    embeddingClusterKeywords: [],
    mapAvailable: false,
    status: String(source.status || "metadata_only"),
    sourceType: String(source.sourceType || "template_example"),
    sourceUrl: String(source.sourceUrl || ""),
    sourceCheckedAt: String(source.sourceCheckedAt || "2026-01-01T00:00:00Z"),
    failureReason: String(source.failureReason || ""),
    availabilityStatus: String(source.availabilityStatus || (bestAsset ? "downloaded" : "metadata")),
    availabilityLabel: String(source.availabilityLabel || (bestAsset ? "Downloaded" : "Metadata only")),
    pageUrl: String(source.pageUrl || source.sourceUrl),
    doi: String(source.doi || ""),
    doiUrl: String(source.doiUrl || ""),
    openreviewUrl: String(source.openreviewUrl || ""),
    projectPageUrl: String(source.projectPageUrl || ""),
    pdfUrl: String(source.pdfUrl || ""),
    localPdfPath: String(source.localPdfPath || ""),
    localPosterPath: String(source.localPosterPath || ""),
    localSlidePath: String(source.localSlidePath || ""),
    localSupplementalPaths: stringArray(source.localSupplementalPaths),
    bestAsset,
    bestAssetKind,
    hasPdf: Boolean(source.localPdfPath),
    hasPoster: Boolean(source.localPosterPath),
    hasSlide: Boolean(source.localSlidePath),
    decision: String(source.decision || ""),
    presentationType: String(source.presentationType || ""),
    presentationLabels: stringArray(source.presentationLabels),
    session: String(source.session || ""),
    roomName: String(source.roomName || ""),
    startTime: String(source.startTime || ""),
    endTime: String(source.endTime || ""),
    upstream: source.upstream && typeof source.upstream === "object" ? source.upstream : {},
  };
}

async function loadRawRecords(explicitPath, sourceCheckedAt) {
  const candidates = explicitPath
    ? [absolute(explicitPath)]
    : [absolute("data/source/records.csv"), absolute("data/source/records.jsonl")];
  for (const candidate of candidates) {
    const text = await readIfExists(candidate);
    if (!text.trim()) continue;
    if (candidate.endsWith(".jsonl")) {
      const records = parseJsonLines(text, candidate).map(({ row, line }) => {
        validateRecord(row, `line ${line}`);
        return normalizedRecord(row);
      });
      return { records, text, path: candidate };
    }
    const records = recordsFromCsvRows(parseCsv(text), sourceCheckedAt).map((record) => {
      validateRecord(record, `csv row ${record.csvRow}`);
      return normalizedRecord(record);
    });
    return { records, text, path: candidate };
  }
  return { records: [], text: "", path: "" };
}

function corpusSummary(records, semanticStatus) {
  const typeCounts = {};
  const assetCounts = { pdf: 0, poster: 0, slide: 0 };
  const availabilityCounts = { downloaded: 0, blocked: 0, metadata: 0, unavailable: 0 };
  const categories = new Set();
  const groups = { paper: new Set(), poster: new Set(), workshop: new Set() };
  for (const record of records) {
    typeCounts[record.type] = (typeCounts[record.type] || 0) + 1;
    for (const category of record.categoryTags) categories.add(category);
    groups[record.type].add(record.group);
    if (record.hasPdf) assetCounts.pdf += 1;
    if (record.hasPoster) assetCounts.poster += 1;
    if (record.hasSlide) assetCounts.slide += 1;
    availabilityCounts[record.availabilityStatus] = (availabilityCounts[record.availabilityStatus] || 0) + 1;
  }
  return {
    total: records.length,
    typeCounts,
    assetCounts,
    availabilityCounts,
    categories: [...categories].sort(),
    groups: Object.fromEntries(Object.entries(groups).map(([key, values]) => [key, [...values].sort()])),
    embedding: semanticStatus,
  };
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(filePath, text, "utf8");
  return text;
}

function configModule(configuration) {
  return `// Generated by scripts/build.mjs – do not edit by hand.
export const DATA_MANIFEST_URL = "site/data/conference_index.manifest.json";
export const MAP_URL = "site/data/conference_map.json";
export const SEARCH_EMBEDDINGS_URL = "site/data/conference_search_embeddings.json";
export const TRENDS_URL = "site/data/conference_trends.json";
export const STUDY_FEATURES_URL = "site/data/conference_study_features.json";
export const RESEARCH_CONCEPTS_URL = "site/data/concepts/conference_concepts.json";
export const PEOPLE_TOPICS_URL = "site/data/analysis/conference_people_topics.json";
export const REFERENCES_MANIFEST_URL = "site/data/references/manifest.json";
export const REFERENCES_INSIGHTS_URL = "site/data/references/insights.json";
export const PAGE_SIZE = 80;
export const REPO_CDN_BASE = ${JSON.stringify(`https://cdn.jsdelivr.net/gh/${configuration.repository || ""}@main/`)};
export const LOCAL_ASSET_PREFIX = window.location.pathname.includes("/docs/") ? "../" : "";
export const SITE_ROOT_URL = new URL("../", import.meta.url).href;
export function assetUrl(path) {
  if (/^https?:\\/\\//i.test(path)) return path;
  return new URL(path, SITE_ROOT_URL).href;
}
export const MATHJAX_RETRY_LIMIT = 40;
export const PDFJS_MODULE_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/+esm";
export const PDFJS_WORKER_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";
export const TRANSFORMERS_JS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0";
`;
}

async function applyConfigure(configuration) {
  const indexPath = path.join(ROOT, "docs", "index.html");
  let html = await readFile(indexPath, "utf8");
  html = html
    .replace(/<html lang="[^"]+">/u, `<html lang="${configuration.locale}">`)
    .replace(/<title>[^<]+<\/title>/u, `<title>${configuration.atlas_title}</title>`)
    .replace(/<h1>[^<]+<\/h1>/u, `<h1>${configuration.atlas_title}</h1>`)
    .replace(/aria-label="[^"]* material browser"/u, `aria-label="${configuration.name} material browser"`);
  await writeFile(indexPath, html, "utf8");
}

async function runSemanticPipeline(records) {
  const { vectors, termIndex, corpusDisplay } = buildVectors(records);
  const knn = nearestNeighbors(vectors);
  const corpusMean = corpusMeanVector(vectors);
  const levels = clusterLevels(vectors, termIndex, corpusMean, corpusDisplay, knn);
  const primary = pickPrimaryLevel(levels) || levels[0];
  const positions = project2D(vectors);
  return {
    mapRecords: vectors.map((entry, index) => ({
      id: entry.id,
      x: positions[index].x,
      y: positions[index].y,
      nearestNeighbors: knn[index].neighbors,
    })),
    clusters: primary.clusters,
    primaryK: primary.k,
    levels: levels.map((level) => ({ k: level.k, assignments: level.assignments, clusters: level.clusters })),
  };
}

async function build(options) {
  const configuration = JSON.parse(await readFile(absolute(options.config), "utf8"));
  const cacheDir = path.join(ROOT, ".cache", "atlas");
  const output = absolute(options.output);
  const docsPdfDir = path.join(ROOT, "docs", "pdfs");
  await mkdir(cacheDir, { recursive: true });

  // ---- Load metadata, then ingest PDFs ----
  const sourceCheckedAt = "2026-01-01T00:00:00Z";
  let { records, text: recordsText, path: recordsPath } = await loadRawRecords(options.records, sourceCheckedAt);

  const ingest = await ingestPdfs({ root: ROOT, records, cacheDir: path.join(cacheDir, "pdf"), docsPdfDir });
  records = ingest.records;
  for (const record of records) {
    if (record.localPdfFile) {
      record.localPdfPath = `pdfs/${record.localPdfFile}`;
      record.hasPdf = true;
      record.bestAsset = record.localPdfPath;
      record.bestAssetKind = "pdf";
      record.availabilityStatus = record.availabilityStatus === "blocked" ? "blocked" : "downloaded";
      if (record.availabilityLabel === "Metadata only") record.availabilityLabel = "Downloaded";
      if (record.status === "metadata_only") record.status = "downloaded";
    }
  }
  if (!records.length && !ingest.report.found) {
    throw new Error("No records found. Add data/source/records.csv (or records.jsonl), or drop PDFs into data/pdfs/.");
  }

  const referencesByRecord = ingest.referencesByRecord;
  const referenceRowsText = await readIfExists(absolute("data/source/references.jsonl"));
  for (const { row, line } of parseJsonLines(referenceRowsText, "data/source/references.jsonl")) {
    if (!row.recordId || !Array.isArray(row.references)) {
      throw new Error(`data/source/references.jsonl line ${line}: needs recordId and references[]`);
    }
    referencesByRecord.set(String(row.recordId), row.references);
  }

  // ---- Warm-start bookkeeping ----
  const inputFingerprint = semanticFingerprint({
    version: SEMANTIC_PIPELINE_VERSION,
    config: configuration,
    records: recordsText,
    pdfs: records.filter((record) => record.localPdfHash).map((record) => [record.id, record.localPdfHash]).sort(),
    levels: CLUSTER_LEVELS,
    neighbors: NEIGHBOR_COUNT,
  });
  const state = (await readJsonIfExists(path.join(cacheDir, "state.json"))) || {};
  const warmInput = !options.force && state.inputFingerprint === inputFingerprint && state.generatedAt;
  const generatedAt = warmInput ? state.generatedAt : new Date().toISOString();

  // ---- Semantic pipeline (cached by corpus fingerprint) ----
  const semanticCacheKey = semanticFingerprint({
    version: SEMANTIC_PIPELINE_VERSION,
    docs: records.map((record) => [record.id, documentText(record)]),
  });
  const semanticCachePath = path.join(cacheDir, `semantic-${semanticCacheKey}.json`);
  let semantic = options.force ? null : await readJsonIfExists(semanticCachePath);
  const semanticWarm = Boolean(semantic);
  if (!semantic && records.length) {
    semantic = await runSemanticPipeline(records);
    await mkdir(path.dirname(semanticCachePath), { recursive: true });
    await writeFile(semanticCachePath, `${JSON.stringify(semantic)}\n`, "utf8");
  }
  if (semantic) {
    const primaryLevel = semantic.levels.find((level) => level.k === semantic.primaryK) || semantic.levels[0];
    const clusterById = new Map(semantic.clusters.map((cluster) => [cluster.id, cluster]));
    const indexById = new Map(records.map((record, index) => [record.id, index]));
    semantic.mapRecords.forEach((mapRecord, mapIndex) => {
      const record = records[indexById.get(mapRecord.id)];
      if (!record) return;
      const cluster = clusterById.get(primaryLevel.assignments[mapIndex]);
      record.mapAvailable = true;
      record.embeddingClusterId = cluster ? cluster.id : null;
      record.embeddingClusterLabel = cluster ? cluster.label : "";
      record.embeddingClusterKeywords = cluster ? cluster.topTerms.slice(0, 3) : [];
    });
  }

  // ---- Index / startup / shards ----
  const semanticStatus = {
    status: semantic ? "fresh" : "missing",
    recordCount: records.length,
    mapRecordCount: semantic ? semantic.mapRecords.length : 0,
    staleReasons: semantic ? [] : ["no_records"],
  };
  const index = {
    generatedAt,
    records,
    summary: corpusSummary(records, semanticStatus),
  };
  const indexText = `${JSON.stringify(index, null, 2)}\n`;
  const indexArtifactFingerprint = sha256Fingerprint(indexText);
  const shardNames = ["paper", "poster", "workshop"];
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, "conference_index.json"), indexText, "utf8");
  await writeJson(path.join(output, "conference_startup.json"), index);
  for (const type of shardNames) {
    await writeJson(path.join(output, "shards", `${type}.json`), {
      generatedAt,
      records: records.filter((record) => record.type === type),
    });
  }

  // ---- Concepts + people topics (People/Topics tabs) ----
  let peopleTopicsArtifactFingerprint = "";
  if (records.length) {
    const conceptArtifact = buildConceptArtifact(records);
    conceptArtifact.generatedAt = generatedAt;
    conceptArtifact.fingerprints = { artifact: sha256Fingerprint(JSON.stringify(conceptArtifact)) };
    await writeJson(path.join(output, "concepts", "conference_concepts.json"), conceptArtifact);

    const { buildPeopleTopicsArtifact } = await import(path.join(ROOT, "docs", "site", "people-artifact.mjs"));
    const peopleArtifact = buildPeopleTopicsArtifact(records, conceptArtifact, {
      indexVersion: generatedAt,
      indexArtifactFingerprint,
    });
    peopleArtifact.fingerprints = {
      artifact: sha256Fingerprint(JSON.stringify(peopleArtifact)),
      conceptArtifact: conceptArtifact.fingerprints.artifact,
    };
    if (EMAIL_PATTERN.test(JSON.stringify(peopleArtifact))) {
      throw new Error("Refusing to publish an analysis artifact containing email addresses.");
    }
    const peoplePath = path.join(output, "analysis", "conference_people_topics.json");
    const serialized = `${JSON.stringify(peopleArtifact, null, 2)}\n`;
    await mkdir(path.dirname(peoplePath), { recursive: true });
    await writeFile(peoplePath, serialized, "utf8");
    peopleTopicsArtifactFingerprint = sha256Fingerprint(serialized);
  } else {
    await writeJson(path.join(output, "concepts", "conference_concepts.json"), {
      schemaVersion: "conference-atlas-concepts/v1",
      fingerprints: { artifact: sha256Fingerprint("{}") },
      records: {},
      review: {},
      source: { recordCount: 0, generator: "auto-first-pass/v1" },
      summary: { candidateRecordCount: 0, publishedRecordCount: 0, excludedRecordCount: 0, exclusionCounts: {} },
    });
  }

  // ---- Map / trends / study features ----
  if (semantic) {
    await writeJson(path.join(output, "conference_map.json"), {
      generatedAt,
      embeddingSource: {
        method: "tfidf-deterministic",
        fingerprint: indexArtifactFingerprint,
        note: "Zero-dependency first pass. Import SPECTER2 vectors via scripts/import_search_embeddings.mjs for stronger query semantics.",
      },
      model: { id: "tfidf-local", kind: "tfidf", neighborCount: NEIGHBOR_COUNT },
      projection: { method: "pca-power-iteration", seed: 42 },
      records: semantic.mapRecords,
      clusters: semantic.clusters,
      embeddingClusters: semantic.clusters,
      embeddingClusterLevels: semantic.levels,
    });
    const vectorsForDownstream = semantic.mapRecords.map((mapRecord) => ({ id: mapRecord.id }));
    const knnForDownstream = semantic.mapRecords.map((mapRecord) => ({ id: mapRecord.id, neighbors: mapRecord.nearestNeighbors }));
    const primaryLevel = semantic.levels.find((level) => level.k === semantic.primaryK) || semantic.levels[0];
    const trends = buildTrends({ records, vectors: vectorsForDownstream, knn: knnForDownstream, level: primaryLevel });
    await writeJson(path.join(output, "conference_trends.json"), {
      generatedAt,
      source: { recordCount: records.length, method: "cluster-summary/v1" },
      trends: trends.trends,
    });
    const study = buildStudyFeatures({
      records,
      vectors: vectorsForDownstream,
      knn: knnForDownstream,
      level: primaryLevel,
      trendByCluster: trends.trendByCluster,
    });
    await writeJson(path.join(output, "conference_study_features.json"), {
      generatedAt,
      source: { recordCount: records.length, method: "study-heuristics/v1" },
      records: study.records,
      topics: study.topics,
      outliers: study.outliers,
    });
  } else {
    await writeJson(path.join(output, "conference_map.json"), { generatedAt, embeddingSource: {}, model: {}, projection: {}, records: [], clusters: [], embeddingClusters: [], embeddingClusterLevels: [] });
    await writeJson(path.join(output, "conference_trends.json"), { generatedAt, source: { recordCount: records.length }, trends: [] });
    await writeJson(path.join(output, "conference_study_features.json"), { generatedAt, source: { recordCount: records.length }, records: {}, topics: {}, outliers: [] });
  }

  // ---- Search embeddings: in-browser hashed lexical index (zero downloads).
  // Importing SPECTER2 vectors via scripts/import_search_embeddings.mjs
  // overwrites this file and upgrades the query side automatically.
  if (records.length) {
    const searchEmbeddings = buildSearchEmbeddings(records);
    searchEmbeddings.generatedAt = generatedAt;
    await writeJson(path.join(output, "conference_search_embeddings.json"), searchEmbeddings);
  } else {
    await writeJson(path.join(output, "conference_search_embeddings.json"), { generatedAt, embeddingSource: {}, model: {}, records: [] });
  }

  // ---- References (from PDF extraction and/or references.jsonl) ----
  const referenceArtifacts = buildReferenceArtifacts({ records, referencesByRecord });
  referenceArtifacts.manifest.generatedAt = generatedAt;
  await writeJson(path.join(output, "references", "manifest.json"), referenceArtifacts.manifest);
  referenceArtifacts.insights.generatedAt = generatedAt;
  referenceArtifacts.insights.sourceManifestGeneratedAt = generatedAt;
  await writeJson(path.join(output, "references", "insights.json"), referenceArtifacts.insights);
  for (const [shardPath, payload] of referenceArtifacts.shards) {
    const relative = path.relative("site/data/references", shardPath);
    await writeJson(path.join(output, "references", relative), payload);
  }

  // ---- Manifest (last: pins the fingerprints) ----
  await writeJson(path.join(output, "conference_index.manifest.json"), {
    generatedAt,
    indexArtifactFingerprint,
    peopleTopicsArtifactFingerprint,
    summary: index.summary,
    startupUrl: "site/data/conference_startup.json",
    shards: shardNames.map((type) => ({ type, url: `site/data/shards/${type}.json` })),
  });

  // ---- Site shell (title, config.js) ----
  await applyConfigure(configuration);
  await writeFile(path.join(ROOT, "docs", "site", "config.js"), configModule(configuration), "utf8");

  await writeFile(path.join(cacheDir, "state.json"), `${JSON.stringify({
    inputFingerprint,
    generatedAt,
    builtAt: new Date().toISOString(),
    recordCount: records.length,
    recordsSource: recordsPath,
  }, null, 2)}\n`, "utf8");

  return {
    records: records.length,
    output,
    warm: { input: Boolean(warmInput), semantic: semanticWarm },
    ingest: ingest.report,
    mapRecords: semantic ? semantic.mapRecords.length : 0,
    clusters: semantic ? semantic.clusters.length : 0,
    trendsCount: semantic ? 0 : 0,
  };
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
  } else {
    const result = await build(options);
    console.log(`Built ${result.records} records into ${path.relative(ROOT, result.output)}`);
    console.log(`  map: ${result.mapRecords} points in ${result.clusters} clusters`);
    console.log(`  pdfs: ${result.ingest.found} found, ${result.ingest.extracted} extracted, ${result.ingest.reused} warm, ${result.ingest.copied} copied`);
    if (result.ingest.failed) console.log(`  pdfs: ${result.ingest.failed} extraction failures (records still included)`);
    console.log(`  warm start: input=${result.warm.input ? "reused" : "changed"} semantic=${result.warm.semantic ? "reused" : "rebuilt"}`);
  }
} catch (error) {
  console.error(error.message);
  console.error("Run with --help for usage.");
  process.exitCode = 1;
}
