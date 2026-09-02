import { containsNormalizedPhrase, escapeHtml, normalize, plainMathTitle } from "./utils.js";

export const MATCH_FIELD_ORDER = ["title", "authors", "abstract", "tags"];
export const MATCH_FIELD_LABEL = { title: "title", authors: "author", abstract: "abstract", tags: "tag" };

export function typeLabel(type) {
  return {
    paper: "Paper",
    poster: "Poster",
    workshop: "Workshop",
    map: "Map",
  }[type] || type;
}

export function categoryTags(record) {
  return Array.isArray(record.categoryTags) && record.categoryTags.length ? record.categoryTags : [record.category || "Other"];
}

export function paperPresentationKind(record) {
  if (record.type !== "paper") return record.presentationType || "";
  const labels = Array.isArray(record.presentationLabels) ? record.presentationLabels : [];
  if (labels.includes("Oral")) return "Oral";
  if (labels.includes("Spotlight")) return "Spotlight";
  return "";
}

export function paperPresentationMode(record) {
  if (record.type !== "paper") return "";
  const value = `${record.presentationType || ""} ${record.session || ""}`;
  return /poster/i.test(value) ? "Poster session" : "";
}

export function viewerKindLabel(record) {
  if (record.type === "paper") {
    return `${typeLabel(record.type)} · ${paperPresentationKind(record) || record.group || "Main Conference"}`;
  }
  return `${typeLabel(record.type)} · ${record.category}`;
}

export function assetLabel(record) {
  if (record.hasPdf) return "PDF";
  if (record.hasSlide) return "Slides";
  if (record.hasPoster) return "Poster";
  return "Metadata";
}

export function displayAvailabilityLabel(record) {
  if (record.type === "paper" && record.availabilityStatus === "blocked") return openReviewPdfUrl(record) ? "OpenReview PDF" : "PDF pending";
  return record.availabilityLabel || "Metadata only";
}

export function statusClass(record) {
  if (record.availabilityStatus === "downloaded") return "good";
  if (record.type === "paper" && record.availabilityStatus === "blocked") return "warn";
  if (record.availabilityStatus === "blocked") return "bad";
  if (record.availabilityStatus === "unavailable") return "warn";
  return "";
}

export function statusLabel(value) {
  const labels = {
    accepted_public: "Accepted public",
    metadata_only: "Metadata only",
    downloaded: "Downloaded",
    blocked: "Blocked",
    unavailable: "Unavailable",
    failed: "Failed",
    skipped: "Skipped",
  };
  return labels[value] || value;
}

export function presentationBadges(record) {
  const labels = Array.isArray(record.presentationLabels) ? record.presentationLabels : [];
  const badges = labels.map((label) => {
    const className = label.toLowerCase() === "spotlight" ? "spotlight" : label.toLowerCase() === "oral" ? "oral" : "";
    return { label, className };
  });
  const mode = paperPresentationMode(record);
  if (mode) badges.push({ label: mode, className: "poster-session" });
  return badges
    .map((badge) => `<span class="badge ${badge.className}">${escapeHtml(badge.label)}</span>`)
    .join("");
}

export function resultDetails(record) {
  return [record.session, record.roomName].filter(Boolean).join(" · ");
}

export function icmlPresentationId(record) {
  const values = [record.id, record.pageUrl].filter(Boolean);
  for (const value of values) {
    const match = String(value).match(/(?:icml:|\/poster\/)(\d+)/);
    if (match) return match[1];
  }
  return "";
}

export function openReviewForumId(record) {
  const values = [record.pageUrl, record.id, record.openreviewUrl, record.pdfUrl].filter(Boolean);
  for (const value of values) {
    const text = String(value);
    if (/openreview\.net\/group\?/i.test(text)) continue;
    const match = text.match(/(?:[?&]id=|openreview:)([^;&]+)/);
    if (match) return decodeURIComponent(match[1]);
  }
  return "";
}

export function openReviewPdfUrl(record) {
  if (record.pdfUrl) return record.pdfUrl;
  const id = openReviewForumId(record);
  return record.type === "paper" && id ? `https://openreview.net/pdf?id=${encodeURIComponent(id)}` : "";
}

export function enrichPaperPresentationRecords(records) {
  const posterById = new Map();
  const posterByTitle = new Map();
  for (const record of records) {
    if (record.type !== "poster") continue;
    const icmlId = icmlPresentationId(record);
    if (icmlId) posterById.set(icmlId, record);
    posterByTitle.set(normalize(plainMathTitle(record.title)), record);
  }
  return records.map((record) => {
    if (record.type !== "paper") return record;
    const icmlId = icmlPresentationId(record);
    const poster = posterById.get(icmlId) || posterByTitle.get(normalize(plainMathTitle(record.title)));
    if (!poster) return record;
    const enriched = { ...record };
    for (const key of ["localPosterPath", "localSlidePath", "projectPageUrl"]) {
      if (!enriched[key] && poster[key]) enriched[key] = poster[key];
    }
    if (!enriched.hasPoster && poster.hasPoster) enriched.hasPoster = true;
    if (!enriched.hasSlide && poster.hasSlide) enriched.hasSlide = true;
    if (!enriched.bestAsset && poster.bestAsset) {
      enriched.bestAsset = poster.bestAsset;
      enriched.bestAssetKind = poster.bestAssetKind;
    }
    return enriched;
  });
}

export function recordSearchParts(record) {
  if (record._hayParts === undefined) {
    record._hayParts = {
      title: normalize(`${record.title} ${plainMathTitle(record.title)}`),
      authors: normalize([
        record.authors || "",
        ...(record.authorAffiliations || []).flatMap((item) => [item.institution || "", item.countryCode || ""]),
      ].join(" ")),
      abstract: normalize(record.abstract || ""),
      tags: normalize(`${record.group || ""} ${record.decision || ""} ${record.presentationType || ""} ${(record.presentationLabels || []).join(" ")} ${record.session || ""} ${categoryTags(record).join(" ")} ${(record.areaTags || []).join(" ")} ${(record.domainTags || []).join(" ")} ${record.clusterLabel || ""} ${record.embeddingClusterLabel || ""} ${Object.values(record.embeddingClusterLevels || {}).map((cluster) => cluster.label).join(" ")} ${(record.embeddingClusterKeywords || []).join(" ")} ${(record.searchAliases || []).join(" ")}`),
    };
    const p = record._hayParts;
    record._haystack = `${p.title} ${p.abstract} ${p.authors} ${p.tags}`;
  }
  return record._hayParts;
}

export function recordHaystack(record) {
  recordSearchParts(record);
  return record._haystack;
}

export function matchedField(record, query) {
  if (!query) return "";
  const parts = recordSearchParts(record);
  for (const field of MATCH_FIELD_ORDER) {
    if (containsNormalizedPhrase(parts[field], query)) return field;
  }
  return "";
}
