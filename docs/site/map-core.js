import {
  CLUSTER_AREA_HINTS,
} from "./graph-constants.js";
import {
  assetLabel,
  categoryTags,
  recordHaystack,
} from "./records.js";
import { state } from "./state.js";
import { containsNormalizedPhrase, normalize, plainMathTitle } from "./utils.js";
import { semanticQuerySearch } from "./semantic-search.js";
import {
  projectedGraphPosition,
  seededGraphPosition,
  seededUnit,
} from "./map-layout.js";

let mapDeps = {};
let mapRecordLookupSource = null;
let mapRecordLookup = null;

export function configureMapCore(deps) {
  mapDeps = deps;
}

export function mapRecordById() {
  const records = state.mapData?.records || [];
  if (mapRecordLookupSource !== records) {
    mapRecordLookupSource = records;
    mapRecordLookup = new Map(records.map((record) => [record.id, record]));
  }
  return mapRecordLookup;
}

export function mapColorValue(record) {
  if (state.mapColor === "quality" || state.mapColor === "availability") {
    state.mapColor = "area-domain";
  }
  if (state.mapColor === "domain") return (record.domainTags || ["General"])[0] || "General";
  if (state.mapColor === "embedding-cluster") return embeddingClusterColorLabel(record);
  if (state.mapColor === "cluster") return clusterColorLabel(record);
  return (record.areaTags || record.categoryTags || ["Other"])[0] || "Other";
}

export function embeddingClusterLevelMeta(record) {
  return record?.embeddingClusterLevels?.[state.mapEmbeddingClusterLevel] || null;
}

export function embeddingClusterMeta(record) {
  const levelMeta = embeddingClusterLevelMeta(record);
  if (levelMeta) return levelMeta;
  const clusterId = record?.embeddingClusterId;
  if (!clusterId) return null;
  return (state.mapData?.embeddingClusters || []).find((cluster) => cluster.id === clusterId) || null;
}

export function embeddingClusterColorLabel(record) {
  const levelMeta = embeddingClusterLevelMeta(record);
  return levelMeta?.label || record?.embeddingClusterLabel || embeddingClusterMeta(record)?.label || record?.embeddingClusterId || "Embedding cluster";
}

export function embeddingClusterColorId(record) {
  const levelMeta = embeddingClusterLevelMeta(record);
  return levelMeta?.id || record?.embeddingClusterId || "";
}

export function embeddingClusterSize(record) {
  return Number(record?.embeddingClusterSize || embeddingClusterMeta(record)?.size || 0);
}

function clusterColorLabel(record) {
  const clusterId = record?.clusterId || "";
  return record?.clusterLabel || CLUSTER_AREA_HINTS[clusterId] || "Semantic area";
}

export function mapSemanticSearchIds(query, records, limit = 10) {
  state.mapSearchSeedIds = new Set();
  state.mapSearchSemanticIds = new Set();
  state.mapSearchKind = "";
  state.mapSearchTopScore = 0;
  if (state.tab !== "map" || !query || !state.mapData?.records?.length) return null;
  const recordById = new Map(records.map((record) => [record.id, record]));
  const mapById = mapRecordById();
  const search = semanticQuerySearch(query, records, { limit: 260 });
  const vectorMatches = search.matches || [];
  if (vectorMatches.length) {
    const ids = new Set(vectorMatches.map((item) => item.id));
    state.mapSearchSeedIds = ids;
    state.mapSearchSemanticIds = new Set();
    state.mapSearchKind = search.source || "query-vector";
    state.mapSearchTopScore = search.topScore || vectorMatches[0]?.score || 0;
    state.mapSearchPending = Boolean(search.pending);
    state.mapSearchMessage = search.message || "";
    return ids;
  }
  const seeds = records.filter((record) => containsNormalizedPhrase(recordHaystack(record), query));
  const seedIds = new Set(seeds.map((record) => record.id));
  const semanticIds = new Set();
  const ids = new Set(seedIds);
  for (const seed of seeds) {
    let added = 0;
    for (const neighbor of mapById.get(seed.id)?.nearestNeighbors || []) {
      if (added >= limit) break;
      const neighborRecord = recordById.get(neighbor.id);
      if (!neighborRecord || neighborRecord.id === seed.id) continue;
      ids.add(neighborRecord.id);
      if (!seedIds.has(neighborRecord.id)) semanticIds.add(neighborRecord.id);
      added += 1;
    }
  }
  state.mapSearchSeedIds = seedIds;
  state.mapSearchSemanticIds = semanticIds;
  state.mapSearchKind = "keyword-neighbor";
  state.mapSearchPending = false;
  state.mapSearchMessage = "";
  return ids;
}

export function mapSearchSummary(records, query) {
  if (state.tab !== "map" || !query) return "";
  const seedCount = records.filter((record) => state.mapSearchSeedIds.has(record.id)).length;
  const semanticCount = records.filter((record) => state.mapSearchSemanticIds.has(record.id)).length;
  if (state.mapSearchKind === "in-browser") {
    const score = state.mapSearchTopScore ? ` · top ${state.mapSearchTopScore.toFixed(2)}` : "";
    return `${seedCount.toLocaleString()} semantic matches · in-browser index${score}`;
  }
  if (state.mapSearchKind === "specter2-query") {
    const score = state.mapSearchTopScore ? ` · top ${state.mapSearchTopScore.toFixed(2)}` : "";
    return `${seedCount.toLocaleString()} SPECTER2 matches${score}`;
  }
  if (state.mapSearchKind === "specter2-loading") {
    const score = state.mapSearchTopScore ? ` · lexical top ${state.mapSearchTopScore.toFixed(2)}` : "";
    return `SPECTER2 warming · ${seedCount.toLocaleString()} lexical matches${score}`;
  }
  if (state.mapSearchKind === "query-vector") {
    const score = state.mapSearchTopScore ? ` · top ${state.mapSearchTopScore.toFixed(2)}` : "";
    return `${seedCount.toLocaleString()} query-vector matches${score}`;
  }
  if (!semanticCount) return `${seedCount.toLocaleString()} keyword matches`;
  return `${seedCount.toLocaleString()} keyword + ${semanticCount.toLocaleString()} semantic neighbors`;
}

export function selectedNeighborIds(mapById, selectedId = state.selectedId, limit = 12) {
  const selected = mapById.get(selectedId);
  if (!selected) return new Set();
  return new Set((selected.nearestNeighbors || []).slice(0, limit).map((item) => item.id));
}

export function nearestDisplayNeighbors(record, mapById = mapRecordById(), limit = 8) {
  const center = mapById.get(record?.id);
  if (!center) return [];
  const neighbors = [];
  for (const neighbor of center.nearestNeighbors || []) {
    const neighborRecord = mapDeps.findDisplayRecord?.(neighbor.id);
    if (!neighborRecord || neighborRecord.id === record.id) continue;
    neighbors.push({ score: neighbor.score, rank: neighbors.length + 1, record: neighborRecord });
    if (neighbors.length >= limit) break;
  }
  return neighbors;
}

export function sharedSemanticTags(record, neighborRecord) {
  const centerTags = new Set([...(record.areaTags || []), ...(record.domainTags || []), ...categoryTags(record)]);
  const neighborTags = [...new Set([...(neighborRecord.areaTags || []), ...(neighborRecord.domainTags || []), ...categoryTags(neighborRecord)])];
  return neighborTags.filter((tag) => centerTags.has(tag)).slice(0, 4);
}

export function explainSemanticRelation(record, neighborRecord, score = 0) {
  const tags = sharedSemanticTags(record, neighborRecord);
  const reasons = [];
  if (score) reasons.push(`${Number(score || 0).toFixed(2)} similarity`);
  if (tags.length) reasons.push(`shared ${tags.slice(0, 3).join(", ")}`);
  if (embeddingClusterColorId(record) && embeddingClusterColorId(record) === embeddingClusterColorId(neighborRecord)) reasons.push("same embedding cluster");
  if (record.clusterId && record.clusterId === neighborRecord.clusterId) reasons.push("same semantic area");
  if (record.group && record.group === neighborRecord.group) reasons.push("same group");
  if (neighborRecord.hasPdf || neighborRecord.hasPoster || neighborRecord.hasSlide) reasons.push(assetLabel(neighborRecord));
  reasons.push(`${neighborRecord.embeddingTextQuality || "title/topic"} embedding`);
  return reasons.slice(0, 5).join(" · ");
}

function focusedGraphIds(visibleIds, mapById, selectedId = state.selectedId) {
  if (!selectedId || !visibleIds.has(selectedId)) return visibleIds;
  const ids = new Set([selectedId]);
  const selected = mapById.get(selectedId);
  const firstHop = (selected?.nearestNeighbors || [])
    .filter((item) => visibleIds.has(item.id))
    .slice(0, 10);
  for (const neighbor of firstHop) ids.add(neighbor.id);
  for (const neighbor of firstHop) {
    const neighborMap = mapById.get(neighbor.id);
    for (const secondHop of (neighborMap?.nearestNeighbors || []).slice(0, 4)) {
      if (visibleIds.has(secondHop.id) && secondHop.id !== selectedId) ids.add(secondHop.id);
    }
  }
  return ids;
}

export function focusDepth(id, selectedNeighbors, mapById, selectedId = state.selectedId) {
  if (id === selectedId) return 0;
  if (selectedNeighbors.has(id)) return 1;
  const selected = mapById.get(selectedId);
  const firstHop = (selected?.nearestNeighbors || []).slice(0, 12).map((item) => item.id);
  return firstHop.some((neighborId) => (mapById.get(neighborId)?.nearestNeighbors || []).some((item) => item.id === id)) ? 2 : 3;
}

function graphNodeIds(visibleRecords, mapById) {
  const visibleIds = new Set(visibleRecords.map((record) => record.id));
  if (state.mapMode !== "focused") return visibleIds;
  return focusedGraphIds(visibleIds, mapById);
}

export function focusedLayoutContext(ids, mapById, selectedId = state.selectedId, firstHopLimit = 10) {
  const selected = mapById.get(selectedId);
  const firstHop = (selected?.nearestNeighbors || [])
    .filter((item) => ids.has(item.id))
    .slice(0, firstHopLimit);
  const firstHopIndex = new Map(firstHop.map((item, index) => [item.id, index]));
  const firstHopScore = new Map(firstHop.map((item) => [item.id, Number(item.score || 0)]));
  const angles = new Map();
  firstHop.forEach((item, index) => {
    const baseAngle = (-Math.PI / 2) + (index / Math.max(1, firstHop.length)) * Math.PI * 2;
    angles.set(item.id, baseAngle + (seededUnit(item.id, 9) - 0.5) * 0.24);
  });

  const secondAnchors = new Map();
  firstHop.forEach((item, firstIndex) => {
    const neighborMap = mapById.get(item.id);
    (neighborMap?.nearestNeighbors || []).slice(0, 5).forEach((secondHop, secondIndex) => {
      if (!ids.has(secondHop.id) || secondHop.id === selectedId || firstHopIndex.has(secondHop.id)) return;
      const score = Number(secondHop.score || 0);
      const previous = secondAnchors.get(secondHop.id);
      if (!previous || score > previous.score) {
        secondAnchors.set(secondHop.id, {
          anchorId: item.id,
          firstIndex,
          secondIndex,
          score,
        });
      }
    });
  });

  return { firstHopIndex, firstHopScore, angles, secondAnchors };
}

export function focusedGraphPosition(id, record, context, selectedId = state.selectedId) {
  if (id === selectedId) return { x: 0, y: 0 };
  if (context.firstHopIndex.has(id)) {
    const rank = context.firstHopIndex.get(id);
    const score = context.firstHopScore.get(id) || 0.5;
    const angle = context.angles.get(id) || seededUnit(id, 3) * Math.PI * 2;
    const radius = 126 + rank * 4 + (1 - Math.min(0.9, score)) * 38;
    return {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
    };
  }

  const secondAnchor = context.secondAnchors.get(id);
  if (secondAnchor) {
    const anchorAngle = context.angles.get(secondAnchor.anchorId) || 0;
    const anchorPosition = focusedGraphPosition(secondAnchor.anchorId, record, context, selectedId);
    const side = secondAnchor.secondIndex % 2 === 0 ? -1 : 1;
    const angle = anchorAngle + side * (0.62 + seededUnit(id, 4) * 0.34);
    const radius = 72 + seededUnit(id, 5) * 44;
    return {
      x: anchorPosition.x + Math.cos(angle) * radius,
      y: anchorPosition.y + Math.sin(angle) * radius,
    };
  }

  const fallback = seededGraphPosition(id, record);
  return { x: fallback.x * 0.36, y: fallback.y * 0.36 };
}

export function buildGraphData(visibleRecords, mapById) {
  const ids = graphNodeIds(visibleRecords, mapById);
  const recordsById = new Map(visibleRecords.map((record) => [record.id, record]));
  const selectedNeighbors = selectedNeighborIds(mapById);
  const focusContext = state.mapMode === "focused" ? focusedLayoutContext(ids, mapById) : null;
  const hasMapQuery = state.tab === "map" && Boolean(normalize(state.query));
  const nodes = [...ids].map((id) => {
    const record = recordsById.get(id);
    const clusterMeta = embeddingClusterMeta(record);
    const displayRecord = clusterMeta
      ? { ...record, embeddingClusterLabel: clusterMeta.label, embeddingClusterSize: clusterMeta.size }
      : record;
    const position = focusContext
      ? focusedGraphPosition(id, displayRecord, focusContext)
      : projectedGraphPosition(mapById.get(id), id, displayRecord);
    const depth = state.mapMode === "focused" ? focusDepth(id, selectedNeighbors, mapById) : 0;
    return {
      id,
      record: displayRecord,
      title: plainMathTitle(displayRecord?.title || ""),
      group: mapColorValue(displayRecord || {}),
      selected: id === state.selectedId,
      adjacent: selectedNeighbors.has(id),
      searchMatch: hasMapQuery && state.mapSearchSeedIds.has(id),
      semanticContext: hasMapQuery && state.mapSearchSemanticIds.has(id),
      depth,
      type: displayRecord?.type || "record",
      focusRank: focusContext?.firstHopIndex.get(id) ?? 99,
      seedX: position.x,
      seedY: position.y,
      x: position.x,
      y: position.y,
    };
  }).filter((node) => node.record);
  const links = [];
  const seen = new Set();
  const neighborLimit = state.mapMode === "focused" ? 6 : hasMapQuery ? 1 : 2;
  for (const node of nodes) {
    const map = mapById.get(node.id);
    for (const neighbor of (map?.nearestNeighbors || []).slice(0, neighborLimit)) {
      if (!ids.has(neighbor.id)) continue;
      const key = [node.id, neighbor.id].sort().join("::");
      if (seen.has(key) || node.id === neighbor.id) continue;
      seen.add(key);
      links.push({
        source: node.id,
        target: neighbor.id,
        value: Number(neighbor.score || 0),
        selected: node.id === state.selectedId || neighbor.id === state.selectedId,
        depth: node.id === state.selectedId || neighbor.id === state.selectedId ? 1 : 2,
      });
    }
  }
  return { nodes, links };
}
