import { researchConceptTags } from "./research-concepts.mjs";

const GENERIC_TERMS = new Set([
  "approach", "data", "framework", "learning", "method", "methods", "model", "models", "performance", "problem", "quality", "reasoning", "training",
]);

function legacyTopicTags(record, depth) {
  const limit = depth === "detail" ? 3 : 1;
  const tags = (Array.isArray(record?.embeddingClusterKeywords) ? record.embeddingClusterKeywords : [])
    .map((value) => String(value || "").trim())
    .filter((value) => value && !GENERIC_TERMS.has(value.toLocaleLowerCase()));
  const unique = [...new Set(tags)];
  if (unique.length) return unique.slice(0, limit);
  const fallback = record?.embeddingClusterLabel || record?.clusterLabel;
  return (fallback ? [fallback] : record?.areaTags || []).filter(Boolean).slice(0, limit);
}

export function coreTopicTags(record, depth = "core") {
  if (!Object.hasOwn(record || {}, "researchConcepts")) return legacyTopicTags(record, depth);
  return researchConceptTags(record, depth === "detail" ? "detail" : "core");
}
