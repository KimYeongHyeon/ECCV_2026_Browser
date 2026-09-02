import { buildPeopleAnalytics } from "./people-analytics.mjs";
import {
  attachResearchConcepts,
  parseConceptArtifact,
  researchConceptTags,
} from "./research-concepts.mjs";

export const PEOPLE_TOPICS_SCHEMA_VERSION = "conference-atlas-people-topics/v1";

function assertCompleteConceptArtifact(payload) {
  const summary = payload?.summary;
  const candidateCount = summary?.candidateRecordCount;
  const publishedCount = summary?.publishedRecordCount;
  const excludedCount = summary?.excludedRecordCount;
  const records = payload?.records;
  if (
    payload?.schemaVersion !== "conference-atlas-concepts/v1"
    || !Number.isInteger(candidateCount)
    || candidateCount <= 0
    || publishedCount !== candidateCount
    || excludedCount !== 0
    || Object.keys(summary?.exclusionCounts || {}).length
    || !records
    || typeof records !== "object"
    || Array.isArray(records)
    || Object.keys(records).length !== candidateCount
    || parseConceptArtifact(payload).size !== candidateCount
  ) {
    throw new Error("A finalized artifact with complete concept coverage is required.");
  }
}

function recordsForScope(records, scope) {
  if (scope === "main") return records.filter((record) => record.type === "paper" || record.type === "poster");
  if (scope === "workshop") return records.filter((record) => record.type === "workshop");
  return records;
}

function normalizedWorkKey(record) {
  return String(record.title || "")
    .toLocaleLowerCase()
    .replace(/\\[a-z]+\b/giu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim() || String(record.id || "");
}

function uniqueWorks(records) {
  const works = new Map();
  for (const record of records) {
    if (!record?.title) continue;
    const key = normalizedWorkKey(record);
    const previous = works.get(key);
    if (!previous || (previous.type === "poster" && record.type !== "poster")) works.set(key, record);
  }
  return [...works.values()];
}

function topicTrends(records) {
  const works = uniqueWorks(records);
  const counts = new Map();
  for (const record of works) {
    const label = researchConceptTags(record, "core")[0];
    if (label) counts.set(label, (counts.get(label) || 0) + 1);
  }
  const denominator = Math.max(1, works.length);
  const topics = [...counts.entries()]
    .map(([label, workCount]) => ({
      label,
      workCount,
      workShare: Number((workCount / denominator).toFixed(6)),
    }))
    .sort((left, right) => (right.workCount - left.workCount) || left.label.localeCompare(right.label));
  return {
    claimScope: "single-year-corpus-prevalence",
    workCount: works.length,
    topicBearingWorkCount: [...counts.values()].reduce((total, count) => total + count, 0),
    note: `Conference corpus is a single-year corpus. Shares use ${works.length.toLocaleString()} unique works; counts describe prevalence, not temporal growth.`,
    topics,
  };
}

function artifactAuthor(author) {
  return {
    identityId: author.identityId,
    name: author.name,
    aliases: author.aliases,
    identityEvidence: author.email
      ? "email"
      : author.paperCount > 1
        ? "normalized-name+shared-coauthor-context"
        : "single-record-name",
    paperCount: author.paperCount,
    topics: author.topics,
    recordIds: author.recordIds,
  };
}

function scopeArtifact(records) {
  const analytics = buildPeopleAnalytics(records);
  return {
    summary: analytics.summary,
    identityResolution: {
      method: "email-then-normalized-name-with-shared-coauthor-context",
      emailAddressesPublished: false,
    },
    authors: analytics.authors.map(artifactAuthor),
    coauthorLinks: analytics.coauthorLinks,
    groups: analytics.groups.map((group) => ({
      ...group,
      provenance: {
        kind: "coauthor-community-proxy",
        rule: "connected authors with a pair appearing on at least two unique works",
        verifiedAffiliation: false,
      },
    })),
    topicTrends: topicTrends(records),
  };
}

export function buildPeopleTopicsArtifact(
  records,
  conceptArtifact,
  { indexVersion = "", indexArtifactFingerprint = "" } = {},
) {
  assertCompleteConceptArtifact(conceptArtifact);
  const concepts = parseConceptArtifact(conceptArtifact);
  const enriched = attachResearchConcepts(
    (records || []).map((record) => ({ ...record })),
    concepts,
  );
  return {
    schemaVersion: PEOPLE_TOPICS_SCHEMA_VERSION,
    source: {
      conceptArtifactFingerprint: conceptArtifact.fingerprints?.artifact || "",
      conceptRecordCount: conceptArtifact.summary.publishedRecordCount,
      corpusYear: 2026,
      indexVersion,
      indexArtifactFingerprint,
    },
    scopes: Object.fromEntries(["all", "main", "workshop"].map((scope) => [
      scope,
      scopeArtifact(recordsForScope(enriched, scope)),
    ])),
  };
}

function validScope(scope) {
  return Boolean(
    scope
    && typeof scope === "object"
    && scope.summary
    && Array.isArray(scope.authors)
    && Array.isArray(scope.coauthorLinks)
    && Array.isArray(scope.groups)
    && scope.identityResolution?.emailAddressesPublished === false
    && scope.authors.every((author) => author && typeof author === "object" && !("email" in author))
    && scope.topicTrends?.claimScope === "single-year-corpus-prevalence"
    && Array.isArray(scope.topicTrends.topics)
  );
}

function containsPrivateEmail(value) {
  if (Array.isArray(value)) return value.some(containsPrivateEmail);
  if (value && typeof value === "object") {
    return Object.entries(value).some(([key, nested]) => (
      key === "email" || key === "authorEmails" || containsPrivateEmail(nested)
    ));
  }
  return typeof value === "string" && /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/u.test(value);
}

export function parsePeopleTopicsArtifact(
  payload,
  expectedConceptFingerprint = "",
  expectedIndexVersion = "",
  expectedIndexFingerprint = "",
  expectedConceptRecordCount = 0,
) {
  const conceptFingerprint = payload?.source?.conceptArtifactFingerprint;
  if (
    payload?.schemaVersion !== PEOPLE_TOPICS_SCHEMA_VERSION
    || !payload.source
    || !Number.isInteger(payload.source.conceptRecordCount)
    || payload.source.conceptRecordCount <= 0
    || !/^sha256:[0-9a-f]{64}$/u.test(conceptFingerprint || "")
    || !expectedConceptFingerprint
    || conceptFingerprint !== expectedConceptFingerprint
    || !payload.source.indexVersion
    || !expectedIndexVersion
    || payload.source.indexVersion !== expectedIndexVersion
    || !/^sha256:[0-9a-f]{64}$/u.test(payload.source.indexArtifactFingerprint || "")
    || !expectedIndexFingerprint
    || payload.source.indexArtifactFingerprint !== expectedIndexFingerprint
    || !Number.isInteger(expectedConceptRecordCount)
    || expectedConceptRecordCount <= 0
    || payload.source.conceptRecordCount !== expectedConceptRecordCount
    || !/^sha256:[0-9a-f]{64}$/u.test(payload.fingerprints?.artifact || "")
    || !/^sha256:[0-9a-f]{64}$/u.test(payload.fingerprints?.conceptArtifact || "")
    || containsPrivateEmail(payload)
    || !validScope(payload.scopes?.all)
    || !validScope(payload.scopes?.main)
    || !validScope(payload.scopes?.workshop)
  ) {
    throw new Error("Invalid people and topic analysis artifact.");
  }
  return payload;
}
