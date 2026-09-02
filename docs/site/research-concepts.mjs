const BROAD_CONCEPTS = new Set([
  "ai",
  "artificial intelligence",
  "computer vision",
  "data science",
  "deep learning",
  "generative ai",
  "large language models",
  "machine learning",
  "natural language processing",
  "optimization",
  "reinforcement learning",
  "statistics",
  "theory",
]);

const EMPTY_CONCEPTS = Object.freeze({ core: [], detail: [] });

function normalizeConcept(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

function conceptKey(value) {
  return normalizeConcept(value).toLocaleLowerCase();
}

function concreteConcepts(values, limit, excluded = new Set()) {
  const seen = new Set(excluded);
  const concepts = [];
  for (const rawValue of Array.isArray(values) ? values : []) {
    const value = normalizeConcept(rawValue);
    const key = conceptKey(value);
    if (!value || BROAD_CONCEPTS.has(key) || seen.has(key)) continue;
    seen.add(key);
    concepts.push(value);
    if (concepts.length === limit) break;
  }
  return concepts;
}

function reviewerArtifactRecords(payload) {
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.records)) return payload.records;
  if (Array.isArray(payload.concepts)) return payload.concepts;
  return [];
}

export function parseConceptArtifact(payload) {
  const conceptsByRecordId = new Map();
  const compactRecords = payload?.records;
  if (compactRecords && typeof compactRecords === "object" && !Array.isArray(compactRecords)) {
    for (const [recordId, entry] of Object.entries(compactRecords)) {
      if (!entry || typeof entry !== "object") continue;
      const core = concreteConcepts(entry.core, 3);
      if (!core.length) continue;
      const detail = concreteConcepts(entry.detail, 6, new Set(core.map(conceptKey)));
      conceptsByRecordId.set(recordId, { core, detail });
    }
    return conceptsByRecordId;
  }
  for (const entry of reviewerArtifactRecords(payload)) {
    if (!entry || typeof entry !== "object" || entry.review_status !== "accepted") continue;
    const recordId = normalizeConcept(entry.record_id || entry.id);
    if (!recordId) continue;
    const core = concreteConcepts(entry.core_concepts, 3);
    if (!core.length) continue;
    const detail = concreteConcepts(entry.detail_concepts, 6, new Set(core.map(conceptKey)));
    conceptsByRecordId.set(recordId, { core, detail });
  }
  return conceptsByRecordId;
}

export function conceptsForRecord(conceptsByRecordId, recordId) {
  if (!(conceptsByRecordId instanceof Map)) return EMPTY_CONCEPTS;
  return conceptsByRecordId.get(String(recordId || "")) || EMPTY_CONCEPTS;
}

export function attachResearchConcepts(records, conceptsByRecordId) {
  for (const record of records || []) {
    record.researchConcepts = conceptsForRecord(conceptsByRecordId, record.id);
  }
  return records;
}

export function researchConceptTags(record, depth = "core") {
  const concepts = record?.researchConcepts || EMPTY_CONCEPTS;
  if (depth === "detail") return (Array.isArray(concepts.detail) ? concepts.detail : []).slice(0, 6);
  const limit = depth === "browse" ? 3 : 1;
  return (Array.isArray(concepts.core) ? concepts.core : []).slice(0, limit);
}

export function matchesMapCoreConcept(record, coreConceptFilter = "") {
  if (!coreConceptFilter) return true;
  return Array.isArray(record?.researchConcepts?.core) && record.researchConcepts.core.includes(coreConceptFilter);
}
