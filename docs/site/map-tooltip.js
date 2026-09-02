import {
  AREA_COLORS,
  AVAILABILITY_COLORS,
  DOMAIN_COLORS,
  QUALITY_COLORS,
} from "./graph-constants.js";
import {
  displayAvailabilityLabel,
  typeLabel,
} from "./records.js";
import { embeddingClusterColorLabel } from "./map-core.js";
import { state } from "./state.js";
import { escapeHtml, plainMathTitle } from "./utils.js";

function hashString(value) {
  let hash = 0;
  for (const char of String(value)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash;
}

function embeddingClusterColor(value) {
  const text = String(value || "");
  const match = text.match(/\bCluster\s+(\d+)/i) || text.match(/embedding-cluster-(\d+)/i);
  const index = match ? Math.max(0, Number(match[1]) - 1) : hashString(text);
  const hue = Math.round((index * 137.508) % 360);
  const saturation = [82, 68, 76, 88][index % 4];
  const lightness = [43, 55, 36, 62][Math.floor(index / 4) % 4];
  return `hsl(${hue} ${saturation}% ${lightness}%)`;
}

export function colorForValue(value) {
  const colorMode = ["quality", "availability"].includes(state.mapColor) ? "area-domain" : state.mapColor;
  if (colorMode === "embedding-cluster") return embeddingClusterColor(value);
  const palette = {
    "area-domain": AREA_COLORS,
    area: AREA_COLORS,
    domain: DOMAIN_COLORS,
    quality: QUALITY_COLORS,
    availability: AVAILABILITY_COLORS,
  }[colorMode];
  if (palette?.[value]) return palette[value];
  const hue = hashString(value) % 360;
  return `hsl(${hue} 72% 58%)`;
}

export function browseRecordColor(record) {
  const label = (record.areaTags || record.categoryTags || ["Other"])[0] || "Other";
  return AREA_COLORS[label] || colorForValue(label);
}

export function areaColorValue(record) {
  return (record?.areaTags || record?.categoryTags || ["Other"])[0] || "Other";
}

export function domainColorValue(record) {
  return (record?.domainTags || ["General"])[0] || "General";
}

export function domainRingColor(record) {
  return DOMAIN_COLORS[domainColorValue(record)] || colorForValue(domainColorValue(record));
}

function availabilityStatusKind(value) {
  const key = String(value || "").toLowerCase();
  if (key.includes("download")) return "ok";
  if (key.includes("block")) return "warn";
  if (key.includes("unavail") || key.includes("skip")) return "off";
  return "meta";
}

export function graphTooltipHTML(node) {
  const record = node?.record;
  const title = node?.title || (record ? plainMathTitle(record.title) : "");
  if (!record) return `<div class="gt-title">${escapeHtml(title)}</div>`;
  const area = areaColorValue(record);
  const domain = domainColorValue(record);
  const authors = record.authors
    ? (record.authors.length > 110 ? `${record.authors.slice(0, 107)}…` : record.authors)
    : "";
  const availability = displayAvailabilityLabel(record) || record.bestAssetKind || record.status || "";
  const parts = [`<div class="gt-title">${escapeHtml(title)}</div>`];
  if (authors) parts.push(`<div class="gt-authors">${escapeHtml(authors)}</div>`);
  parts.push(
    `<div class="gt-meta">`
    + `<span><i class="gt-dot" style="background:${escapeHtml(colorForValue(area))}"></i>Area: ${escapeHtml(area)}</span>`
    + `<span><i class="gt-dot" style="background:${escapeHtml(domainRingColor(record))}"></i>Domain: ${escapeHtml(domain)}</span>`
    + `</div>`,
  );
  const foot = [`<span class="gt-type">${escapeHtml(typeLabel(record.type))}</span>`];
  if (record.embeddingClusterId) foot.push(`<span class="gt-cluster">Cluster: ${escapeHtml(embeddingClusterColorLabel(record))}</span>`);
  if (record.clusterLabel) foot.push(`<span class="gt-cluster">${escapeHtml(record.clusterLabel)}</span>`);
  if (availability) {
    foot.push(`<span class="gt-status gt-status--${availabilityStatusKind(availability)}">${escapeHtml(String(availability))}</span>`);
  }
  parts.push(`<div class="gt-foot">${foot.join("")}</div>`);
  return parts.join("");
}
