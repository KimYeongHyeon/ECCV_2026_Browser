import { AREA_LAYOUT_ANCHORS, CLUSTER_AREA_HINTS } from "./graph-constants.js";

export function scaleMapValue(value, min, max) {
  return max === min ? 50 : 5 + ((value - min) / (max - min)) * 90;
}

export function stableHash(value) {
  let hash = 2166136261;
  for (const char of String(value || "")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function seededUnit(id, salt = 0) {
  return ((stableHash(`${id}:${salt}`) % 10000) / 10000);
}

export function clusterAnchor(record) {
  const primaryArea = (record?.areaTags || []).find((tag) => tag !== "Other");
  const clusterHint = CLUSTER_AREA_HINTS[record?.clusterId] || record?.clusterLabel;
  const value = primaryArea || (AREA_LAYOUT_ANCHORS[clusterHint] ? clusterHint : "Other");
  return AREA_LAYOUT_ANCHORS[value] || AREA_LAYOUT_ANCHORS.Other;
}

export function seededGraphPosition(id, record) {
  const anchor = clusterAnchor(record);
  const angle = seededUnit(id, 1) * Math.PI * 2;
  const radius = Math.sqrt(seededUnit(id, 2)) * (record?.type === "workshop" ? 88 : 126);
  return {
    x: anchor.x + Math.cos(angle) * radius,
    y: anchor.y + Math.sin(angle) * radius,
  };
}

export function projectedGraphPosition(mapPoint, id, record) {
  const hasProjection = Number.isFinite(mapPoint?.x)
    && Number.isFinite(mapPoint?.y)
    && (Math.abs(mapPoint.x) > 1e-9 || Math.abs(mapPoint.y) > 1e-9);
  if (!hasProjection) return seededGraphPosition(id, record);
  return {
    x: mapPoint.x * 1500,
    y: -mapPoint.y * 1500,
  };
}

export function normalizedBox(start, end) {
  return {
    left: Math.min(start.x, end.x),
    right: Math.max(start.x, end.x),
    top: Math.min(start.y, end.y),
    bottom: Math.max(start.y, end.y),
  };
}

export function countLabels(values) {
  const counts = new Map();
  for (const value of values.flat().filter(Boolean)) {
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1]);
}
