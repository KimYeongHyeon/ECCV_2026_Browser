#!/usr/bin/env node

// Import dense search embeddings into the artifact consumed by the site's
// semantic search decoder (atob -> Int8Array -> divide by scale).
//
//   node scripts/import_search_embeddings.mjs --input embeddings.json \
//     [--output docs/site/data/conference_search_embeddings.json] \
//     [--generated-at 2026-01-01T00:00:00.000Z]
//
// Input JSON shape:
//   {
//     "model": { "id": "sentence-transformers/...", "queryModelId": "...", "scale": 127 },
//     "embeddingSource": { ...optional provenance... },
//     "records": [{ "id": "record-id", "vector": [0.12, -0.83, ...] }, ...]
//   }
//
// Vectors are L2-normalized, clamped to [-1, 1], quantized to Int8 with a
// scale of 127, and written base64-encoded.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUTPUT = "docs/site/data/conference_search_embeddings.json";

function usage() {
  return `Usage: node scripts/import_search_embeddings.mjs --input PATH [options]

Quantize dense record embeddings into the site's Int8/base64 format.

Options:
  --input PATH            Input JSON with model + records (required)
  --output PATH           Output artifact (default: ${DEFAULT_OUTPUT})
  --generated-at ISO      Artifact timestamp (default: now)
  --help                  Show this help`;
}

function parseArguments(argv) {
  const options = { output: DEFAULT_OUTPUT };
  let hasInput = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { ...options, help: true };
    if (!["--input", "--output", "--generated-at"].includes(argument)) {
      throw new Error(`Unknown option: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
    if (argument === "--input") {
      options.input = value;
      hasInput = true;
    } else if (argument === "--output") {
      options.output = value;
    } else {
      if (Number.isNaN(Date.parse(value))) throw new Error(`--generated-at must be an ISO timestamp (got "${value}")`);
      options.generatedAt = value;
    }
    index += 1;
  }
  if (!hasInput) throw new Error("Missing required option: --input PATH");
  return options;
}

function absolute(relativeOrAbsolute) {
  return path.isAbsolute(relativeOrAbsolute) ? relativeOrAbsolute : path.join(ROOT, relativeOrAbsolute);
}

function normalizeToUnit(vector, recordId) {
  if (!vector.every((value) => typeof value === "number" && Number.isFinite(value))) {
    throw new Error(`record "${recordId}": vector must contain only finite numbers`);
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) return vector.map(() => 0);
  return vector.map((value) => value / norm);
}

function quantize(vector) {
  const quantized = vector.map((value) => {
    const clamped = Math.min(1, Math.max(-1, value));
    return Math.min(127, Math.max(-127, Math.round(clamped * 127)));
  });
  return Buffer.from(new Int8Array(quantized).buffer, 0, quantized.length).toString("base64");
}

function toArtifact(input, generatedAt) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("input must be a JSON object with model and records");
  }
  const model = input.model;
  if (!model || typeof model !== "object" || !String(model.id || "").trim()) {
    throw new Error("input.model.id is required (the embedding model identifier)");
  }
  if (!Array.isArray(input.records) || !input.records.length) {
    throw new Error("input.records must be a non-empty array of {id, vector}");
  }
  const seen = new Set();
  const vectors = input.records.map((record, index) => {
    if (!record || typeof record !== "object") {
      throw new Error(`records[${index}]: entry must be an object with id and vector`);
    }
    const id = String(record.id ?? "");
    if (!id.trim()) throw new Error(`records[${index}]: id must be a non-empty string`);
    if (seen.has(id)) throw new Error(`records[${index}]: duplicate id "${id}"`);
    seen.add(id);
    if (!Array.isArray(record.vector) || !record.vector.length) {
      throw new Error(`record "${id}": vector must be a non-empty array of numbers`);
    }
    return { id, raw: record.vector };
  });
  const vectorLength = vectors[0].raw.length;
  for (const { id, raw } of vectors) {
    if (raw.length !== vectorLength) {
      throw new Error(`record "${id}": vector length ${raw.length} does not match expected length ${vectorLength}`);
    }
  }
  return {
    generatedAt,
    embeddingSource: input.embeddingSource && typeof input.embeddingSource === "object" ? input.embeddingSource : {},
    model: {
      id: String(model.id),
      queryModelId: String(model.queryModelId || model.id),
      scale: 127,
    },
    records: vectors.map(({ id, raw }) => ({ id, vector: quantize(normalizeToUnit(raw, id)) })),
  };
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
  } else {
    const inputPath = absolute(options.input);
    const input = JSON.parse(await readFile(inputPath, "utf8"));
    const generatedAt = options.generatedAt || new Date().toISOString();
    const artifact = toArtifact(input, generatedAt);
    const outputPath = absolute(options.output);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    const vectorBytes = Buffer.from(artifact.records[0].vector, "base64").length;
    console.log(`Imported ${artifact.records.length} embedding vectors (model ${artifact.model.id}, ${vectorBytes} Int8 dims) into ${path.relative(ROOT, outputPath)}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("Run with --help for usage.");
  process.exitCode = 1;
}
