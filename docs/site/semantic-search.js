import { SEARCH_EMBEDDINGS_URL, TRANSFORMERS_JS_URL } from "./config.js";
import { categoryTags, recordSearchParts } from "./records.js";
import { plainMathTitle } from "./utils.js";

const HASH_DIMENSION = 512;
const DEFAULT_LIMIT = 260;
const MIN_LEXICAL_SCORE = 0.045;
const MIN_DENSE_SCORE = 0.12;

const STOPWORDS = new Set([
  "about", "after", "again", "against", "also", "and", "are", "based",
  "been", "between", "both", "can", "from", "have", "into", "its", "more",
  "most", "not", "our", "over", "paper", "poster", "record", "results",
  "that", "the", "their", "this", "through", "toward", "towards", "using",
  "via", "with", "workshop",
]);

let denseIndex = null;
let denseIndexPromise = null;
let denseIndexLoading = false;
let denseIndexError = "";
let extractorPromise = null;
const queryVectorCache = new Map();
const pendingQueries = new Set();

function hashToken(token) {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normalizeToken(token) {
  return token
    .replace(/^[-+]+|[-+]+$/g, "")
    .replace(/ies$/, "y")
    .replace(/(?:ing|ers|er|ed|s)$/u, "");
}

function tokenize(text) {
  const raw = String(text || "").toLowerCase().match(/[a-z0-9][a-z0-9+\-]{1,}/g) || [];
  const tokens = raw
    .map(normalizeToken)
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
  const expanded = [...tokens];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    expanded.push(`${tokens[index]}_${tokens[index + 1]}`);
  }
  return expanded;
}

function addWeightedToken(vector, token, count) {
  const hash = hashToken(token);
  const index = hash % HASH_DIMENSION;
  const sign = (hash & 0x10000) === 0 ? 1 : -1;
  const isBigram = token.includes("_");
  const longTokenBoost = token.length > 8 ? 0.25 : 0;
  const weight = (isBigram ? 0.58 : 1) * (1 + Math.log1p(count) + longTokenBoost);
  vector.set(index, (vector.get(index) || 0) + sign * weight);
}

function vectorizeLexical(text) {
  const counts = new Map();
  for (const token of tokenize(text)) {
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  const vector = new Map();
  for (const [token, count] of counts) {
    addWeightedToken(vector, token, count);
  }
  const norm = Math.sqrt([...vector.values()].reduce((sum, value) => sum + value * value, 0)) || 1;
  for (const [index, value] of vector) {
    vector.set(index, value / norm);
  }
  return vector;
}

function recordEmbeddingText(record) {
  const parts = recordSearchParts(record);
  return [
    plainMathTitle(record.title || ""),
    parts.title,
    parts.abstract,
    parts.tags,
    (record.areaTags || []).join(" "),
    (record.domainTags || []).join(" "),
    categoryTags(record).join(" "),
    record.clusterLabel || "",
  ].filter(Boolean).join("\n");
}

function recordLexicalVector(record) {
  if (!record._queryVector) {
    record._queryVector = vectorizeLexical(recordEmbeddingText(record));
  }
  return record._queryVector;
}

function sparseDot(left, right) {
  let score = 0;
  const [small, large] = left.size < right.size ? [left, right] : [right, left];
  for (const [index, value] of small) {
    score += value * (large.get(index) || 0);
  }
  return score;
}

function lexicalSearch(query, records, limit) {
  const queryVector = vectorizeLexical(query);
  if (!queryVector.size) return [];
  return records
    .map((record) => ({ id: record.id, record, score: sparseDot(queryVector, recordLexicalVector(record)) }))
    .filter((item) => item.score >= MIN_LEXICAL_SCORE)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

function decodeInt8Base64(value) {
  const binary = globalThis.atob(value);
  const vector = new Int8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    vector[index] = binary.charCodeAt(index) << 24 >> 24;
  }
  return vector;
}

function normalizeDenseVector(values) {
  const vector = Float32Array.from(values, (value) => Number(value) || 0);
  const norm = Math.hypot(...vector) || 1;
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] /= norm;
  }
  return vector;
}

function denseDot(queryVector, docVector, scale) {
  const length = Math.min(queryVector.length, docVector.length);
  let score = 0;
  for (let index = 0; index < length; index += 1) {
    score += queryVector[index] * (docVector[index] / scale);
  }
  return score;
}

function scoreDense(queryVector, records, limit) {
  if (!denseIndex) return [];
  return records
    .map((record) => {
      const docVector = denseIndex.byId.get(record.id);
      if (!docVector) return null;
      return { id: record.id, record, score: denseDot(queryVector, docVector, denseIndex.scale) };
    })
    .filter((item) => item && item.score >= MIN_DENSE_SCORE)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

function tensorToVector(output) {
  if (output?.data) return normalizeDenseVector(output.data);
  if (typeof output?.tolist === "function") {
    const list = output.tolist();
    return normalizeDenseVector(Array.isArray(list?.[0]) ? list[0] : list);
  }
  return normalizeDenseVector(output || []);
}

async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = import(TRANSFORMERS_JS_URL)
      .then(({ pipeline }) => pipeline("feature-extraction", denseIndex?.model?.queryModelId || denseIndex?.model?.id, {
        dtype: "q8",
      }));
  }
  return extractorPromise;
}

// The build ships a zero-download "hash-lexical" index whose document vectors
// come from the same vectorizeLexical() used for lexical fallback. Queries
// embed locally with the identical function — no model download — while
// imported SPECTER2 indexes keep using the transformers.js path.
function usesInBrowserIndex() {
  return denseIndex?.model?.kind === "hash-lexical";
}

function computeQueryVectorSync(query) {
  const vector = vectorizeLexical(query);
  const dense = new Float32Array(HASH_DIMENSION);
  for (const [index, value] of vector) dense[index] = value;
  const norm = Math.hypot(...dense) || 1;
  for (let index = 0; index < dense.length; index += 1) dense[index] /= norm;
  return dense;
}

async function computeQueryVector(query, cacheKey) {
  if (usesInBrowserIndex()) {
    const vector = computeQueryVectorSync(query);
    queryVectorCache.set(cacheKey, vector);
    return vector;
  }
  const extractor = await getExtractor();
  const output = await extractor(query, { pooling: "mean", normalize: true });
  const vector = tensorToVector(output);
  queryVectorCache.set(cacheKey, vector);
  return vector;
}

function notifySearchReady(cacheKey) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent("conference-semantic-search-ready", { detail: { query: cacheKey } }));
}

function ensureDenseQuery(query, cacheKey) {
  if (!denseIndex || queryVectorCache.has(cacheKey) || pendingQueries.has(cacheKey)) return;
  if (usesInBrowserIndex()) {
    queryVectorCache.set(cacheKey, computeQueryVectorSync(query));
    notifySearchReady(cacheKey);
    return;
  }
  pendingQueries.add(cacheKey);
  computeQueryVector(query, cacheKey)
    .then(() => notifySearchReady(cacheKey))
    .catch((error) => {
      denseIndex.error = error?.message || "SPECTER2 query model failed to load.";
    })
    .finally(() => {
      pendingQueries.delete(cacheKey);
    });
}

export async function loadSearchEmbeddings(url = SEARCH_EMBEDDINGS_URL) {
  if (denseIndexPromise) return denseIndexPromise;
  denseIndexLoading = true;
  denseIndexError = "";
  denseIndexPromise = fetch(url)
    .then((response) => {
      if (response.ok) return response.json();
      denseIndexError = `SPECTER2 embeddings failed to load (${response.status}).`;
      return null;
    })
    .then((payload) => {
      if (!payload?.records?.length) return null;
      const byId = new Map();
      for (const record of payload.records) {
        if (record.id && record.vector) byId.set(record.id, decodeInt8Base64(record.vector));
      }
      denseIndex = {
        model: payload.model || {},
        embeddingSource: payload.embeddingSource || {},
        byId,
        scale: Number(payload.model?.scale || 127),
      };
      return denseIndex;
    })
    .catch((error) => {
      denseIndex = null;
      denseIndexError = error?.message || "SPECTER2 embeddings failed to load.";
      return null;
    })
    .finally(() => {
      denseIndexLoading = false;
    });
  return denseIndexPromise;
}

export function semanticQuerySearch(query, records, options = {}) {
  const limit = options.limit || DEFAULT_LIMIT;
  const cacheKey = String(query || "").trim().toLowerCase();
  const lexicalMatches = lexicalSearch(query, records, limit);
  if (!cacheKey) {
    return { matches: lexicalMatches, source: "query-vector", pending: false, topScore: lexicalMatches[0]?.score || 0 };
  }
  if (!denseIndex?.byId?.size) {
    return {
      matches: lexicalMatches,
      source: denseIndexLoading ? "specter2-loading" : "query-vector",
      pending: denseIndexLoading,
      message: denseIndexError,
      topScore: lexicalMatches[0]?.score || 0,
    };
  }
  if (usesInBrowserIndex()) {
    const cachedVector = queryVectorCache.get(cacheKey) || computeQueryVectorSync(query);
    queryVectorCache.set(cacheKey, cachedVector);
    const matches = scoreDense(cachedVector, records, limit);
    return {
      matches: matches.length ? matches : lexicalMatches,
      source: "in-browser",
      pending: false,
      topScore: (matches[0] || lexicalMatches[0])?.score || 0,
    };
  }
  const cachedVector = queryVectorCache.get(cacheKey);
  if (cachedVector) {
    const matches = scoreDense(cachedVector, records, limit);
    if (matches.length) {
      return { matches, source: "specter2-query", pending: false, topScore: matches[0]?.score || 0 };
    }
  }
  ensureDenseQuery(query, cacheKey);
  return {
    matches: lexicalMatches,
    source: denseIndex.error ? "query-vector" : "specter2-loading",
    pending: !denseIndex.error,
    message: denseIndex.error || "",
    topScore: lexicalMatches[0]?.score || 0,
  };
}
