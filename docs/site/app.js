import {
  MAP_URL,
  SEARCH_EMBEDDINGS_URL,
} from "./config.js";
import {
  loadIndexData,
  loadPeopleTopics,
  loadResearchConcepts,
  loadShardRecords,
  versionedUrl,
} from "./data-loader.js";
import { els } from "./dom.js";
import { enrichPaperPresentationRecords } from "./records.js";
import { attachResearchConcepts } from "./research-concepts.mjs";
import { clearMapCoreConceptFilter, createMapCoreConceptHandoff } from "./map-core-concept-filter.mjs";
import { state } from "./state.js";
import { escapeHtml, normalize, plainMathTitle } from "./utils.js";
import {
  configureViewer,
  renderViewer,
} from "./viewer.js";
import {
  activeFilterSummary,
  configureBrowse,
  displayRecords,
  ensureVisibleSelection,
  findDisplayRecord,
  getFilteredRecords,
  loadMoreResultsIfNeeded,
  renderResults,
  resetResultWindow,
  queueWorkerSearch,
  refreshSearchWorkerIndex,
  updateHeader,
  updateSelects,
} from "./browse.js";
import {
  buildGraphData,
  configureMapCore,
  mapRecordById,
  mapSearchSummary,
  mapSemanticSearchIds,
} from "./map-core.js";
import { installMapDebugProbe } from "./map-debug.js";
import {
  applyMapMotionSettings,
  configureMapEngine,
  destroyGraphEngine,
  fitForceGraph,
  reflowMap,
  renderForceGraph,
  zoomMap,
} from "./map-engine.js";
import {
  configureMapDetail,
  controlMiniGraph,
  destroyMiniGraph,
  mountMiniGraph,
  renderMapDetail,
  renderMiniMap,
  semanticNeighborhood,
} from "./map-detail.js";
import {
  clearMapSelection,
  configureMapInteractions,
  ensureMapSelectionBox,
  hideGraphTooltip,
  installMapPointerInteractions,
  showGraphTooltip,
} from "./map-interactions.js";
import { renderMapLegend } from "./map-legend.js";
import { renderSemanticInsightPanel } from "./semantic-insights.js";
import { loadSearchEmbeddings } from "./semantic-search.js";
import { loadStudyFeatures } from "./study-features.js";
import { loadTrends } from "./trends.js";
import {
  loadReferenceInsights,
  loadReferenceRecord,
  loadReferencesManifest,
} from "./references.js";
import { clearPeopleDashboardCache, renderPeopleDashboard } from "./people-dashboard.mjs";
import { clearAuthorMapCache, destroyAuthorMap, focusAuthorMapTopic, renderAuthorMap, resetAuthorMapFocus } from "./author-map.mjs";
import { renderTopicsDashboard } from "./topics-dashboard.mjs";

let fullRecordsPromise = null;
let mapDataPromise = null;
let studyFeaturesPromise = null;
let researchConceptsPromise = null;
let peopleTopicsPromise = null;
let searchEmbeddingsStarted = false;

configureMapCore({ findDisplayRecord });
configureMapEngine({
  ensureMapSelectionBox,
  hideGraphTooltip,
});
configureBrowse({
  applyFilterChange,
  hydrateSelectedRecord(recordId) {
    void hydrateFullRecordsInBackground().then(() => {
      if (state.selectedId !== recordId || state.tab === "map" || state.tab === "references") return;
      const selected = findDisplayRecord(recordId);
      if (!selected) return;
      renderResults();
      renderViewer(selected);
    });
  },
  renderAfterWorkerSearch() {
    if (state.tab === "map") renderMap();
    else renderResults();
  },
});
configureMapDetail({
  findDisplayRecord,
  hideGraphTooltip,
  renderAll,
  renderMap,
  renderResults,
  renderViewer,
  ensureStudyFeatures,
  showGraphTooltip,
});
configureMapInteractions({
  findDisplayRecord,
  renderViewer,
});

async function renderMap() {
  if (state.tab !== "map") return;
  const renderToken = ++state.mapRenderToken;
  if (!state.mapData?.records?.length) {
    els.mapCanvas.innerHTML = `<div class="empty-state"><strong>Loading map</strong><span>Reading the precomputed semantic graph.</span></div>`;
    await ensureMapData();
    if (renderToken !== state.mapRenderToken || state.tab !== "map") return;
  }
  if (!state.mapData?.records?.length) {
    state.mapGraph = null;
    els.mapCanvas.innerHTML = `<div class="empty-state"><strong>No map data</strong><span>The precomputed semantic graph could not be loaded.</span></div>`;
    renderMapDetail(null);
    return;
  }
  const mapById = mapRecordById();
  const legendRecords = getFilteredRecords({ ignoreMapFilter: true }).filter((record) => record.mapAvailable && mapById.has(record.id));
  const visibleRecords = getFilteredRecords().filter((record) => record.mapAvailable && mapById.has(record.id));
  renderMapLegend(legendRecords, () => {
    state.selectedId = "";
    clearMapSelection();
    resetResultWindow();
    renderMap();
    renderViewer(null);
  }, () => {
    renderMap();
  });
  els.resultCount.textContent = `${visibleRecords.length.toLocaleString()} mapped records`;
  const query = normalize(state.query);
  const clusterSummary = state.mapColor === "embedding-cluster"
    ? `${state.mapEmbeddingClusterLevel} clusters`
    : "";
  const colorSummary = {
    "area-domain": "area + domain",
    "embedding-cluster": "embedding cluster",
    cluster: "semantic area group",
    area: "research area",
    domain: "domain",
  }[state.mapColor] || state.mapColor;
  els.activeSummary.textContent = activeFilterSummary("Map", [
    state.mapMode,
    colorSummary,
    clusterSummary,
    state.mapCoreConceptFilter ? `Core: ${state.mapCoreConceptFilter}` : "",
    state.mapFilterValue,
    state.mapLandscapeFilterName,
    mapSearchSummary(visibleRecords, query),
  ]);
  renderSemanticInsightPanel(visibleRecords, query);
  if ((query || state.selectedId) && !state.studyFeaturesLoaded) {
    void ensureStudyFeatures().then(() => {
      if (renderToken === state.mapRenderToken && state.tab === "map") renderMap();
    });
  }
  if (!visibleRecords.length) {
    destroyGraphEngine();
    els.mapCanvas.innerHTML = `<div class="empty-state"><strong>No mapped records</strong><span>Adjust the filters.</span></div>`;
    renderMapDetail(null);
    return;
  }
  if (!visibleRecords.some((record) => record.id === state.selectedId)) {
    state.selectedId = "";
  }
  const graphData = buildGraphData(visibleRecords, mapById);
  let rendered = false;
  try {
    rendered = renderForceGraph(graphData);
  } catch {
    rendered = false;
  }
  if (!rendered) {
    destroyGraphEngine();
    els.mapCanvas.innerHTML = `<div class="empty-state"><strong>Graph library unavailable</strong><span>ForceGraph could not be loaded.</span></div>`;
    renderMapDetail(null);
    return;
  }
  const selected = findDisplayRecord(state.selectedId);
  if (!selected) await loadTrends();
  renderMapDetail(selected || null);
}

configureViewer({
  controlMiniGraph,
  destroyMiniGraph,
  ensureMapData,
  findDisplayRecord,
  hydrateSelectedRecord: hydrateFullRecordsInBackground,
  mountMiniGraph,
  renderMap,
  renderMiniMap,
  renderResults,
  semanticNeighborhood,
  ensureStudyFeatures,
  updateHeader,
});

function renderDataHealthNote() {
  if (!els.dataNote) return;
  const embedding = state.data?.summary?.embedding || {};
  const summary = state.data?.summary || {};
  const typeCounts = summary.typeCounts || {};
  const assetCounts = summary.assetCounts || {};
  const status = embedding.status || "missing";
  const source = state.dataManifest ? "sharded index" : "monolithic index";
  const generatedAt = state.data?.generatedAt
    ? new Date(state.data.generatedAt).toLocaleString().replace(/(AM|PM|오전|오후)\s+(?=\d)/u, "$1\u00a0")
    : "";
  const stale = status !== "fresh";
  const conceptsUnavailable = Boolean(state.researchConceptsError);
  els.dataNote.classList.add("is-visible");
  els.dataNote.classList.toggle("is-warning", stale || conceptsUnavailable);
  if (conceptsUnavailable) {
    els.dataNote.innerHTML = "<strong>Research concepts unavailable.</strong><span>The published reviewed-concepts artifact could not be loaded. Concept-specific cards, author topics, and map detail are withheld until a valid artifact is deployed.</span>";
    return;
  }
  const loadedText = `Loaded ${escapeHtml(source)}${generatedAt ? ` · ${escapeHtml(generatedAt)}` : ""}.`;
  const snapshot = [
    `${Number(typeCounts.paper || 0).toLocaleString()} papers`,
    `${Number(typeCounts.workshop || 0).toLocaleString()} workshops`,
    `${Number(assetCounts.pdf || 0).toLocaleString()} local PDFs`,
  ].filter((item) => !item.startsWith("0 ")).join(" · ");
  const messages = {
    fresh: ["Data snapshot.", `${loadedText}${snapshot ? ` ${snapshot}.` : ""} Semantic index fresh.`],
    legacy: ["Semantic metadata pending.", `${loadedText} Existing semantic vectors are available; the rebuild workflow will attach freshness metadata.`],
    stale: ["Semantic rebuild recommended.", `${loadedText} Dense vectors may be older than the current records, so search also uses lexical matching.`],
    missing: ["Semantic search limited.", `${loadedText} Dense vectors are not available yet, so map/search use lexical matching until the rebuild workflow runs.`],
  };
  const [title, body] = messages[status] || messages.missing;
  els.dataNote.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(body)}</span>`;
}

async function hydrateFullRecords() {
  if (!state.dataManifest || state.dataShardsLoaded) return;
  const records = await loadShardRecords(state.dataManifest);
  if (!records?.length) return;
  const selectedId = state.selectedId;
  const shouldRestoreMapViewer = state.tab === "map" && selectedId;
  const enrichedRecords = enrichPaperPresentationRecords(records);
  attachResearchConcepts(enrichedRecords, state.researchConcepts);
  if (state.mapData?.records?.length) enrichEmbeddingClusterRecords(enrichedRecords);
  state.data.records = enrichedRecords;
  state.dataShardsLoaded = true;
  refreshSearchWorkerIndex();
  queueWorkerSearch();
  updateHeader();
  renderAll();
  if (shouldRestoreMapViewer) {
    const selected = findDisplayRecord(selectedId);
    if (selected) renderViewer(selected);
  }
}

function hydrateFullRecordsInBackground() {
  if (fullRecordsPromise || state.dataShardsLoaded) return fullRecordsPromise;
  fullRecordsPromise = hydrateFullRecords().catch(() => null);
  return fullRecordsPromise;
}

function ensureResearchConcepts() {
  if (researchConceptsPromise) return researchConceptsPromise;
  researchConceptsPromise = loadResearchConcepts(state.dataManifest?.version).then((concepts) => {
    state.researchConcepts = concepts;
    state.researchConceptsLoaded = true;
    state.researchConceptsError = "";
    attachResearchConcepts(state.data?.records || [], concepts);
    clearPeopleDashboardCache();
    clearAuthorMapCache();
    renderDataHealthNote();
    renderAll();
    return concepts;
  }).catch((error) => {
    state.researchConcepts = new Map();
    state.researchConceptsLoaded = false;
    state.researchConceptsError = error instanceof Error ? error.message : "Research concepts artifact could not be loaded.";
    state.peopleTopics = null;
    state.peopleTopicsLoaded = false;
    state.peopleTopicsError = "People and topic analysis requires the finalized research concepts artifact.";
    attachResearchConcepts(state.data?.records || [], state.researchConcepts);
    clearPeopleDashboardCache();
    clearAuthorMapCache();
    renderDataHealthNote();
    renderAll();
    return state.researchConcepts;
  });
  return researchConceptsPromise;
}

function ensurePeopleTopics() {
  if (peopleTopicsPromise || !state.researchConceptsLoaded) return peopleTopicsPromise;
  peopleTopicsPromise = loadPeopleTopics(
    state.dataManifest?.version,
    state.researchConcepts.artifactFingerprint,
    state.dataManifest?.indexArtifactFingerprint,
    state.researchConcepts.artifactRecordCount,
    state.dataManifest?.peopleTopicsArtifactFingerprint,
  ).then((artifact) => {
    state.peopleTopics = artifact;
    state.peopleTopicsLoaded = true;
    state.peopleTopicsError = "";
    clearPeopleDashboardCache();
    clearAuthorMapCache();
    renderAll();
    return artifact;
  }).catch((error) => {
    state.peopleTopics = null;
    state.peopleTopicsLoaded = false;
    state.peopleTopicsError = error instanceof Error ? error.message : "People and topic analysis artifact could not be loaded.";
    renderAll();
    return null;
  });
  return peopleTopicsPromise;
}

function scheduleFullRecordsHydration() {
  window.setTimeout(() => {
    void hydrateFullRecordsInBackground();
  }, 300);
}

function scheduleMapDataPreload() {
  if (state.mapData?.records?.length) return;
  const preload = () => void ensureMapData();
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(preload, { timeout: 1800 });
  } else {
    window.setTimeout(preload, 900);
  }
}

function referenceStat(label, value) {
  return `<span><strong>${Number(value || 0).toLocaleString()}</strong><small>${escapeHtml(label)}</small></span>`;
}

function referencePercent(part, total) {
  const denominator = Number(total || 0);
  if (!denominator) return "0%";
  return `${Math.round((Number(part || 0) / denominator) * 100)}%`;
}

function hasMetricValue(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key) && value[key] !== null && value[key] !== undefined;
}

function metricNumber(value, key) {
  return Number(value?.[key] || 0);
}

function referenceCandidateCount(manifest) {
  const summary = manifest?.summary || {};
  const source = manifest?.source || {};
  const sourceCandidates = Number(source.matchedRecords || 0) + Number(source.unmatchedRecords || 0);
  const summaryCandidates = Number(summary.matchedRecords || 0) + Number(summary.unmatchedRecords || 0);
  if (hasMetricValue(source, "pdfRecords")) return metricNumber(source, "pdfRecords");
  if (hasMetricValue(summary, "pdfRecords")) return metricNumber(summary, "pdfRecords");
  if (hasMetricValue(source, "matchedRecords") || hasMetricValue(source, "unmatchedRecords")) return sourceCandidates;
  if (hasMetricValue(summary, "matchedRecords") || hasMetricValue(summary, "unmatchedRecords")) return summaryCandidates;
  if (hasMetricValue(summary, "recordCount")) return metricNumber(summary, "recordCount");
  return 0;
}

function referenceCoveredCount(manifest) {
  const summary = manifest?.summary || {};
  const source = manifest?.source || {};
  if (hasMetricValue(summary, "recordsWithReferences")) return metricNumber(summary, "recordsWithReferences");
  if (hasMetricValue(summary, "matchedRecords")) return metricNumber(summary, "matchedRecords");
  if (hasMetricValue(source, "matchedRecords")) return metricNumber(source, "matchedRecords");
  if (hasMetricValue(summary, "recordCount")) return metricNumber(summary, "recordCount");
  return 0;
}

function optionalSummaryNumber(manifest, key) {
  const summary = manifest?.summary || {};
  const source = manifest?.source || {};
  if (hasMetricValue(summary, key)) return metricNumber(summary, key);
  if (hasMetricValue(source, key)) return metricNumber(source, key);
  return null;
}

function optionalMetricLabel(value) {
  return value === null ? "unknown" : Number(value || 0).toLocaleString();
}

function referenceCountChips(items = []) {
  return items.slice(0, 10).map((item) => `
    <span class="reference-chip"><b>${escapeHtml(item.label || item.author || "")}</b>${Number(item.references || item.count || 0).toLocaleString()}</span>
  `).join("");
}

function referenceDisplayText(item = {}) {
  return plainMathTitle(item.title || item.raw || item.key || "").replace(/\s+/g, " ").trim();
}

function looksLikeCitationTitle(text) {
  const value = String(text || "").trim();
  if (value.length < 18) return false;
  if (/^(url\s+https?:|https?:|arxiv preprint|openreview\.net|association for computational linguistics)$/i.test(value)) return false;
  if (/^(and|[a-z]\.)\s+/i.test(value)) return false;
  if (/^[A-Za-z]{1,3},\s*[A-Z]\./.test(value)) return false;
  if (/[a-z]{3,}[A-Z]\.,/.test(value)) return false;
  if (/^(?:[A-Z][\w'’.-]+,\s*(?:[A-Z]\.|[A-Z][a-z]+|et al\.?)\s*){2,}$/u.test(value)) return false;
  if (/^[A-Z]\.,?\s+/.test(value) || /^[A-Z][\w'’.-]+,\s+[A-Z]\.?[, ]/.test(value)) return false;
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length < 3) return false;
  return /[a-z]{3,}/i.test(value);
}

function referenceCitationItems(items = [], limit = 12) {
  const seen = new Set();
  return items
    .map((item) => ({ ...item, displayText: referenceDisplayText(item) }))
    .filter((item) => {
      const key = item.displayText.toLowerCase();
      if (!looksLikeCitationTitle(item.displayText) || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

function referenceBadge(value) {
  return value ? `<b>${escapeHtml(String(value))}</b>` : "";
}

function referenceMiniTags(values = [], limit = 3) {
  return values.slice(0, limit).map((value) => `<i>${escapeHtml(value)}</i>`).join("");
}

function sharedReferenceLabels(references = [], limit = 4) {
  const seen = new Set();
  return references
    .map(referenceDisplayText)
    .filter((value) => {
      const key = value.toLowerCase();
      if (!value || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

function overlapStrength(sharedCount, score) {
  const shared = Number(sharedCount || 0);
  const ratio = Number(score || 0);
  if (shared >= 5 || ratio >= 0.12) return "strong";
  if (shared >= 3 || ratio >= 0.06) return "moderate";
  return "weak";
}

function renderReferenceGraph(payload = {}, record = null) {
  const overlaps = (payload.overlaps || []).slice(0, 10);
  if (!overlaps.length) {
    return `<div class="reference-overlap-graph is-empty">No shared-reference graph yet.</div>`;
  }
  const width = 760;
  const height = 260;
  const cx = width / 2;
  const cy = height / 2;
  const radius = 94;
  const maxShared = Math.max(1, ...overlaps.map((item) => Number(item.sharedCount || 0)));
  const centerRadius = Math.min(34, 15 + Math.sqrt(Number(payload.referenceCount || 0)));
  const nodes = overlaps.map((item, index) => {
    const angle = (-Math.PI / 2) + (index / overlaps.length) * Math.PI * 2;
    const shared = Number(item.sharedCount || 0);
    return {
      ...item,
      x: cx + Math.cos(angle) * radius,
      y: cy + Math.sin(angle) * radius,
      r: 8 + (shared / maxShared) * 12,
      title: plainMathTitle(findDisplayRecord(item.recordId)?.title || item.title || item.recordId),
    };
  });
  return `
    <div class="reference-overlap-graph" aria-label="Citation overlap graph">
      <svg viewBox="0 0 ${width} ${height}" role="img">
        <title>${escapeHtml(plainMathTitle(record?.title || payload.title || "Selected record"))} citation overlap graph</title>
        ${nodes.map((node) => `
          <line
            x1="${cx}"
            y1="${cy}"
            x2="${node.x.toFixed(1)}"
            y2="${node.y.toFixed(1)}"
            style="--w:${(1.2 + (Number(node.sharedCount || 0) / maxShared) * 4).toFixed(2)}"
          />
        `).join("")}
        <circle class="reference-node is-selected" cx="${cx}" cy="${cy}" r="${centerRadius}">
          <title>${escapeHtml(plainMathTitle(record?.title || payload.title || "Selected record"))} · ${Number(payload.referenceCount || 0).toLocaleString()} refs</title>
        </circle>
        ${nodes.map((node, index) => `
          <a href="#" data-id="${escapeHtml(node.recordId)}" aria-label="${escapeHtml(node.title)}">
            <circle class="reference-node" cx="${node.x.toFixed(1)}" cy="${node.y.toFixed(1)}" r="${node.r.toFixed(1)}">
              <title>${escapeHtml(node.title)} · ${Number(node.sharedCount || 0).toLocaleString()} shared refs</title>
            </circle>
            <text x="${node.x.toFixed(1)}" y="${(node.y + 4).toFixed(1)}">${index + 1}</text>
          </a>
        `).join("")}
      </svg>
      <small>Node size follows shared reference count. Edge width follows shared references with the selected paper.</small>
      <small>Shown overlap records are sorted by shared normalized references, then extracted-reference count.</small>
    </div>
  `;
}

function renderReferencesLoading() {
  els.referencesView.innerHTML = `<div class="empty-state"><strong>Loading references</strong><span>Reading the citation overlap index.</span></div>`;
}

function referenceRecordTitle(recordId) {
  return plainMathTitle(findDisplayRecord(recordId)?.title || recordId);
}

function renderReferenceCommunities(insights) {
  const communities = insights?.communities || [];
  return communities.map((community, index) => `
    <button class="reference-community-card" type="button" data-community-id="${escapeHtml(community.id)}">
      <span class="neighbor-rank">${index + 1}</span>
      <span>
        <strong>${escapeHtml(plainMathTitle(community.label || community.id))}</strong>
        <small>${Number((community.recordIds || []).length).toLocaleString()} papers · ${Number(community.edgeCount || 0).toLocaleString()} citation edges · max ${Number(community.maxSharedCount || 0).toLocaleString()} shared refs</small>
        <span class="reference-mini-tags">${referenceMiniTags([...(community.areaTags || []), ...(community.domainTags || [])], 5)}</span>
      </span>
    </button>
  `).join("") || "<small>No citation communities yet.</small>";
}

function renderReferenceBridgePairs(insights) {
  return (insights?.bridgePairs || []).slice(0, 8).map((bridge, index) => `
    <button class="reference-bridge-pair" type="button" data-bridge-id="${escapeHtml(bridge.id)}">
      <span class="neighbor-rank">${index + 1}</span>
      <span>
        <strong>${escapeHtml(referenceRecordTitle(bridge.leftRecordId))}</strong>
        <strong>${escapeHtml(referenceRecordTitle(bridge.rightRecordId))}</strong>
        <small>${Number(bridge.sharedCount || 0).toLocaleString()} shared references · ${Number(bridge.score || 0).toFixed(2)} overlap</small>
        <em class="reference-shared-refs">Shared: ${(bridge.sharedReferences || []).slice(0, 3).map((item) => escapeHtml(plainMathTitle(item.title || item.key || ""))).join(" · ")}</em>
      </span>
    </button>
  `).join("") || "<small>No citation bridge pairs yet.</small>";
}

function renderReferenceFoundations(insights) {
  return (insights?.sharedFoundations || []).slice(0, 12).map((foundation) => `
    <button class="reference-foundation-item" type="button" data-foundation-key="${escapeHtml(foundation.key)}">
      <span>
        <strong>${escapeHtml(plainMathTitle(foundation.title || foundation.key))}</strong>
        <small>${Number(foundation.count || 0).toLocaleString()} citing papers</small>
        <span class="reference-mini-tags">${referenceMiniTags([...(foundation.areaTags || []), ...(foundation.domainTags || [])], 4)}</span>
      </span>
    </button>
  `).join("") || "<small>No clean shared foundations yet.</small>";
}

function renderReferenceFocusList(title, note, recordIds = []) {
  return `
    <div class="reference-selected-head">
      <strong>${escapeHtml(title)}</strong>
      <span>${Number(recordIds.length || 0).toLocaleString()} papers</span>
    </div>
    <p class="reference-selected-note">${escapeHtml(note)}</p>
    <div class="reference-record-list compact">
      ${recordIds.map((recordId, index) => `
        <button class="reference-record-item" type="button" data-id="${escapeHtml(recordId)}">
          <span class="neighbor-rank">${index + 1}</span>
          <span>
            <strong>${escapeHtml(referenceRecordTitle(recordId))}</strong>
            <small>Open citation neighborhood</small>
          </span>
        </button>
      `).join("") || "<small>No papers in this citation slice.</small>"}
    </div>
  `;
}

function renderReferenceInsightFocus(kind, id, insights) {
  const target = els.referencesView.querySelector("#referenceInsightFocus");
  if (!target || !insights) return;
  if (kind === "community") {
    const community = (insights.communities || []).find((item) => item.id === id);
    if (!community) return;
    target.innerHTML = renderReferenceFocusList(
      `Citation community · ${plainMathTitle(community.label || community.id)}`,
      "These papers form a connected component through shared extracted references.",
      community.representativeRecordIds || community.recordIds || [],
    );
  } else if (kind === "bridge") {
    const bridge = (insights.bridgePairs || []).find((item) => item.id === id);
    if (!bridge) return;
    target.innerHTML = renderReferenceFocusList(
      "Strong citation bridge",
      `${Number(bridge.sharedCount || 0).toLocaleString()} shared references connect this pair.`,
      [bridge.leftRecordId, bridge.rightRecordId],
    );
  } else if (kind === "foundation") {
    const foundation = (insights.sharedFoundations || []).find((item) => item.key === id);
    if (!foundation) return;
    target.innerHTML = renderReferenceFocusList(
      `Shared foundation · ${plainMathTitle(foundation.title || foundation.key)}`,
      "These papers cite the same cleaned bibliography item.",
      foundation.citingRecordIds || [],
    );
  }
  target.querySelectorAll(".reference-record-item").forEach((button) => {
    button.addEventListener("click", () => {
      void renderReferenceSelection(button.dataset.id);
    });
  });
  target.scrollIntoView({ block: "nearest" });
}

async function renderReferences() {
  if (state.tab !== "references") return;
  if (!state.referencesManifestLoaded) renderReferencesLoading();
  const manifest = await loadReferencesManifest();
  const insights = await loadReferenceInsights();
  if (state.tab !== "references") return;
  if (!manifest) {
    els.referencesView.innerHTML = `<div class="empty-state"><strong>No reference index</strong><span>Run the reference builder.</span></div>`;
    return;
  }
  const summary = manifest.summary || {};
  const totalCandidates = referenceCandidateCount(manifest);
  const coveredReferences = referenceCoveredCount(manifest);
  const referenceCoverage = referencePercent(coveredReferences, totalCandidates);
  const withoutExtractedReferences = Math.max(0, totalCandidates - coveredReferences);
  const remoteAttempted = optionalSummaryNumber(manifest, "remotePdfAttemptedRecords");
  const blockedRemote = optionalSummaryNumber(manifest, "remotePdfBlockedRecords");
  const extractionErrors = Number(summary.extractionErrors || summary.errors || 0);
  const remoteHealthUnknown = remoteAttempted === null || blockedRemote === null;
  const sparseInsights = !insights || (Number((insights.communities || []).length) < 2 || Number((insights.bridgePairs || []).length) < 3);
  const records = Object.entries(manifest.records || {})
    .map(([id, entry]) => ({ id, ...entry, record: findDisplayRecord(id) }))
    .filter((item) => item.record)
    .sort((left, right) => (right.overlapCount - left.overlapCount) || (right.referenceCount - left.referenceCount))
    .slice(0, 16);
  els.resultCount.textContent = `${Number(summary.recordCount || 0).toLocaleString()} reference records`;
  els.activeSummary.textContent = activeFilterSummary("References", [
    `${Number(summary.recordsWithReferences || 0).toLocaleString()} reference sets`,
    `${Number(summary.recordsWithOverlaps || 0).toLocaleString()} overlap groups`,
  ]);
  els.referencesView.innerHTML = `
    <section class="reference-dashboard">
      <div class="reference-dashboard-head">
        <div>
          <p class="eyebrow">Bibliographic citations</p>
          <h2>Reference analysis</h2>
        </div>
      </div>
      <div class="selection-stat-grid reference-stat-grid">
        ${referenceStat("matched records", summary.matchedRecords || summary.pdfRecords)}
        ${referenceStat("reference sets", coveredReferences)}
        ${referenceStat("citation edges", insights?.summary?.edgeCount ?? summary.recordsWithOverlaps)}
        ${referenceStat("unique references", summary.uniqueReferenceKeys)}
      </div>
      <div class="reference-health-grid">
        <span><b>${escapeHtml(referenceCoverage)}</b><small>reference coverage for this run</small></span>
        <span><b>${coveredReferences.toLocaleString()} / ${totalCandidates.toLocaleString()}</b><small>with extracted refs / candidate PDFs</small></span>
        <span><b>${withoutExtractedReferences.toLocaleString()}</b><small>without extracted refs</small></span>
        <span><b>${escapeHtml(optionalMetricLabel(remoteAttempted))}</b><small>remote PDF attempts</small></span>
        <span><b>${extractionErrors.toLocaleString()}</b><small>extraction errors</small></span>
      </div>
      <p class="reference-health-note">${blockedRemote || extractionErrors ? "Blocked or failed PDFs are excluded from citation overlap; semantic map/search still uses title and abstract text." : remoteHealthUnknown ? "Remote PDF attempt counts are unavailable for this artifact; extraction errors are shown when reported." : "No blocking extraction errors in the current reference artifact."}</p>
      <div class="reference-coverage-explain">
        <span><b>What counts</b>Only records with extracted references can contribute citation-overlap edges.</span>
        <span><b>What does not count</b>Semantic map/search still works for records without extracted references.</span>
        <span><b>Coverage gap</b>${withoutExtractedReferences.toLocaleString()} candidate PDFs currently have no extracted bibliography.</span>
      </div>
      ${sparseInsights ? `
        <div class="reference-sparse-note">
          <strong>Citation coverage is still sparse.</strong>
          <span>References below use only the extracted-reference subset. Semantic map/search still covers the larger title and abstract corpus.</span>
        </div>
      ` : ""}
      <div class="reference-analysis-grid reference-analysis-grid-primary">
        <article class="reference-panel-block">
          <h3>Citation communities</h3>
          <p class="reference-list-note">Connected components from papers that share extracted references. Singleton records are counted in coverage, not shown as communities.</p>
          <div class="reference-community-list">
            ${renderReferenceCommunities(insights)}
          </div>
        </article>
        <article class="reference-panel-block">
          <h3>Strongest citation bridges</h3>
          <p class="reference-sort-note">Unique paper pairs sorted by shared references, then normalized overlap.</p>
          <div class="reference-bridge-list">
            ${renderReferenceBridgePairs(insights)}
          </div>
        </article>
      </div>
      <article class="reference-panel-block">
        <h3>Shared foundations</h3>
        <p class="reference-list-note">Cleaned citation titles are merged before counting; URL-only, generic, and author-only fragments are excluded in the build artifact.</p>
        <div class="reference-foundation-list">
          ${renderReferenceFoundations(insights)}
        </div>
      </article>
      <article class="reference-panel-block reference-insight-focus" id="referenceInsightFocus">
        <div class="reference-selected-head">
          <strong>Choose a community, bridge, or foundation</strong>
          <span>citation evidence</span>
        </div>
        <p class="reference-selected-note">Click an insight above to see its member papers without loading every reference shard.</p>
      </article>
      <article class="reference-panel-block">
        <h3>Reference concentration</h3>
        <div class="reference-concentration-grid">
          <div>
          <p class="reference-chip-label">Areas</p>
          <div class="reference-chip-list">${referenceCountChips(manifest.analysis?.referenceCounts?.byArea || [])}</div>
          </div>
          <div>
          <p class="reference-chip-label">Domains</p>
          <div class="reference-chip-list">${referenceCountChips(manifest.analysis?.referenceCounts?.byDomain || [])}</div>
          </div>
        </div>
      </article>
      <article class="reference-panel-block">
        <h3>Selected paper citation neighborhood</h3>
        <p class="reference-sort-note">Sorted by overlap count first, then extracted reference count.</p>
        <div class="reference-record-list">
          ${records.map((item, index) => `
            <button class="reference-record-item" type="button" data-id="${escapeHtml(item.id)}">
              <span class="neighbor-rank">${index + 1}</span>
              <span>
                <strong>${escapeHtml(plainMathTitle(item.record.title))}</strong>
                <small>${Number(item.referenceCount || 0).toLocaleString()} refs · ${Number(item.overlapCount || 0).toLocaleString()} overlapping records</small>
              </span>
            </button>
          `).join("") || "<small>No overlap records yet. More matched references will improve this view.</small>"}
        </div>
        <div class="reference-selected" id="referenceSelected"></div>
      </article>
    </section>
  `;
  els.referencesView.querySelectorAll(".reference-record-item").forEach((button) => {
    button.addEventListener("click", () => {
      void renderReferenceSelection(button.dataset.id);
    });
  });
  els.referencesView.querySelectorAll(".reference-community-card").forEach((button) => {
    button.addEventListener("click", () => renderReferenceInsightFocus("community", button.dataset.communityId, insights));
  });
  els.referencesView.querySelectorAll(".reference-bridge-pair").forEach((button) => {
    button.addEventListener("click", () => renderReferenceInsightFocus("bridge", button.dataset.bridgeId, insights));
  });
  els.referencesView.querySelectorAll(".reference-foundation-item").forEach((button) => {
    button.addEventListener("click", () => renderReferenceInsightFocus("foundation", button.dataset.foundationKey, insights));
  });
  if (records[0]) void renderReferenceSelection(records[0].id);
}

async function renderReferenceSelection(recordId) {
  const target = els.referencesView.querySelector("#referenceSelected");
  if (!target) return;
  const record = findDisplayRecord(recordId);
  target.dataset.recordId = recordId;
  target.innerHTML = `<div class="empty-state compact"><strong>Loading overlap</strong><span>Reading one record shard.</span></div>`;
  const payload = await loadReferenceRecord(recordId);
  if (state.tab !== "references" || !target.isConnected || target.dataset.recordId !== recordId) return;
  const references = referenceCitationItems(payload?.references || [], 5);
  const overlaps = (payload?.overlaps || []).slice(0, 10);
  target.innerHTML = `
    <div class="reference-selected-head">
      <strong>${escapeHtml(plainMathTitle(record?.title || payload?.title || recordId))}</strong>
      <span>${Number(payload?.referenceCount || 0).toLocaleString()} extracted refs · ${overlaps.length.toLocaleString()} shown overlaps</span>
    </div>
    ${renderReferenceGraph(payload || {}, record)}
    <p class="reference-selected-note">Overlap means shared normalized references for this selected record; it is citation evidence, separate from semantic-map similarity.</p>
    <p class="reference-list-note">Sample extracted reference titles from this record.</p>
    <div class="reference-sample-list reference-selected-samples">
      ${references.map((item) => `<span>${escapeHtml(item.displayText)}${referenceBadge(item.year || item.source || "")}</span>`).join("") || "<small>No clean citation sample in this shard yet.</small>"}
    </div>
    <div class="reference-overlap-list">
      ${overlaps.map((item, index) => {
        const overlapRecord = findDisplayRecord(item.recordId);
        const sharedRefs = sharedReferenceLabels(item.references || []);
        return `
          <button class="reference-overlap-item" type="button" data-id="${escapeHtml(item.recordId)}">
            <span class="neighbor-rank">${index + 1}</span>
            <span>
              <strong>${escapeHtml(plainMathTitle(overlapRecord?.title || item.title || item.recordId))}</strong>
              <small>${escapeHtml(overlapStrength(item.sharedCount, item.score))} link · ${Number(item.sharedCount || 0).toLocaleString()} shared references · ${Number(item.score || 0).toFixed(2)} overlap</small>
              ${sharedRefs.length ? `<em class="reference-shared-refs">Shared: ${sharedRefs.map(escapeHtml).join(" · ")}</em>` : ""}
            </span>
          </button>
        `;
      }).join("") || "<small>No strong overlap yet for this record.</small>"}
    </div>
  `;
  target.querySelectorAll(".reference-overlap-item").forEach((button) => {
    button.addEventListener("click", () => {
      const selectedRecord = findDisplayRecord(button.dataset.id);
      state.tab = selectedRecord?.type === "workshop" ? "workshop" : "paper";
      state.selectedId = button.dataset.id;
      state.viewerMapRequested = true;
      state.viewerReferenceRequested = true;
      renderAll();
    });
  });
  target.querySelectorAll(".reference-overlap-graph a").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      void renderReferenceSelection(link.dataset.id);
    });
  });
}

function openPeopleTopicOnMap(topicLabel) {
  const handoff = createMapCoreConceptHandoff(topicLabel);
  if (!handoff) return;
  Object.assign(state, handoff);
  if (els.search) els.search.value = "";
  if (els.mapSearch) els.mapSearch.value = "";
  renderAll();
}

function openTopicAuthorMap(topicLabel, scope) {
  focusAuthorMapTopic(topicLabel, scope);
  state.tab = "people";
  state.authorView = "map";
  state.selectedId = "";
  renderAll();
}

function updateMapCoreConceptFilterControl() {
  const coreConcept = state.mapCoreConceptFilter;
  if (!els.mapCoreConceptFilter || !els.mapCoreConceptFilterLabel) return;
  els.mapCoreConceptFilter.hidden = !coreConcept;
  els.mapCoreConceptFilterLabel.textContent = coreConcept;
}

function renderAll() {
  els.tabs.forEach((button) => {
    const count = button.dataset.tab === "references" || button.dataset.tab === "topics" || button.dataset.tab === "people"
      ? 1
      : button.dataset.tab === "map"
      ? displayRecords().filter((record) => record.mapAvailable && (!state.mapData?.records?.length || mapRecordById().has(record.id))).length
      : displayRecords().filter((record) => record.type === button.dataset.tab).length;
    button.hidden = count === 0;
    button.classList.toggle("is-active", button.dataset.tab === state.tab);
  });
  updateSelects();
  resetResultWindow();
  const isMap = state.tab === "map";
  const isTopics = state.tab === "topics";
  const isPeople = state.tab === "people";
  const isAuthorMap = isPeople && state.authorView === "map";
  const isReferences = state.tab === "references";
  if ((isTopics || isPeople) && state.researchConceptsLoaded && !state.peopleTopicsLoaded && !state.peopleTopicsError) {
    void ensurePeopleTopics();
  }
  if (isTopics && !state.dataShardsLoaded) void hydrateFullRecordsInBackground();
  document.body.classList.toggle("is-map-tab", isMap);
  document.body.classList.toggle("is-topics-tab", isTopics);
  document.body.classList.toggle("is-people-tab", isPeople);
  document.body.classList.toggle("is-author-map-tab", isAuthorMap);
  document.body.classList.toggle("is-references-tab", isReferences);
  els.results.hidden = isMap || isTopics || isPeople || isAuthorMap || isReferences;
  els.mapView.hidden = !isMap;
  els.topicsView.hidden = !isTopics;
  els.peopleView.hidden = !isPeople;
  els.peopleDashboardView.hidden = !isPeople || isAuthorMap;
  els.authorMapView.hidden = !isAuthorMap;
  els.authorViewTabs.forEach((button) => {
    const active = button.dataset.authorView === state.authorView;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });
  els.referencesView.hidden = !isReferences;
  updateMapCoreConceptFilterControl();
  const selected = isMap || isTopics || isPeople || isReferences ? null : ensureVisibleSelection();
  if (!isMap && state.mapGraph) {
    state.mapGraph.pauseAnimation?.();
  } else if (isMap && state.mapGraph && state.mapLive) {
    state.mapGraph.resumeAnimation?.();
  }
  renderResults();
  renderMap();
  if (!isAuthorMap) destroyAuthorMap();
  if (isTopics) {
    if (!state.dataShardsLoaded) {
      els.topicsView.innerHTML = `<div class="empty-state"><strong>Loading complete topic corpus</strong><span>Reading the remaining indexed works before showing topic counts.</span></div>`;
    } else {
      void renderTopicsDashboard(els.topicsView, state.data?.records || [], state.peopleTopics, (recordId) => {
        const record = findDisplayRecord(recordId);
        if (!record) return;
        state.tab = record.type === "workshop" ? "workshop" : "paper";
        state.selectedId = record.id;
        state.viewerMapRequested = true;
        state.viewerReferenceRequested = true;
        renderAll();
      }, openPeopleTopicOnMap, openTopicAuthorMap);
    }
  }
  if (isPeople) {
    if (!isAuthorMap) void renderPeopleDashboard(els.peopleDashboardView, state.data?.records || [], state.peopleTopics, (recordId) => {
      const record = findDisplayRecord(recordId);
      if (!record) return;
      state.tab = record.type === "workshop" ? "workshop" : "paper";
      state.selectedId = record.id;
      state.viewerMapRequested = true;
      state.viewerReferenceRequested = true;
      renderAll();
    }, openPeopleTopicOnMap);
  }
  if (isAuthorMap) {
    void renderAuthorMap(els.authorMapView, state.data?.records || [], state.peopleTopics, (recordId) => {
      const record = findDisplayRecord(recordId);
      if (!record) return;
      state.tab = record.type === "workshop" ? "workshop" : "paper";
      state.selectedId = record.id;
      state.viewerMapRequested = true;
      state.viewerReferenceRequested = true;
      renderAll();
    });
  }
  void renderReferences();
  renderViewer(selected);
}

function applyFilterChange({ clearQuery = false } = {}) {
  if (clearQuery) {
    state.query = "";
    els.search.value = "";
    if (els.mapSearch) els.mapSearch.value = "";
  } else if (els.mapSearch && els.mapSearch.value !== state.query) {
    els.mapSearch.value = state.query;
  }
  queueWorkerSearch();
  if (state.query) void hydrateFullRecordsInBackground();
  if (state.tab === "map" && state.query) loadSearchEmbeddingsInBackground();
  state.mapFilterValue = "";
  clearMapSelection();
  resetResultWindow();
  const selected = ensureVisibleSelection();
  renderResults();
  renderMap();
  renderViewer(state.tab === "map" ? null : selected);
}

function rerenderActiveMapQuery() {
  if (state.tab !== "map") return;
  if (!normalize(state.query)) return;
  // Re-run the full filtered pipeline (getFilteredRecords → map semantic
  // search) so a search index that finished loading after the first
  // keystroke upgrades the running query from lexical to dense matches.
  renderResults();
  renderMap();
}

function openTrendRepresentative(recordId) {
  const record = findDisplayRecord(recordId);
  if (!record) return;
  state.tab = record.type === "workshop" ? "workshop" : "paper";
  state.selectedId = record.id;
  state.viewerMapRequested = true;
  state.viewerReferenceRequested = true;
  state.query = "";
  els.search.value = "";
  if (els.mapSearch) els.mapSearch.value = "";
  state.category = "all";
  state.group = "all";
  state.presentation = "all";
  if (els.presentation) els.presentation.value = "all";
  clearMapSelection();
  renderAll();
}

function loadSearchEmbeddingsInBackground() {
  if (searchEmbeddingsStarted) return;
  searchEmbeddingsStarted = true;
  void loadSearchEmbeddings(versionedUrl(SEARCH_EMBEDDINGS_URL, state.dataManifest?.version))
    .finally(rerenderActiveMapQuery);
}

function ensureStudyFeatures() {
  if (state.studyFeaturesLoaded) return Promise.resolve(state.studyFeatures);
  if (!studyFeaturesPromise) {
    studyFeaturesPromise = loadStudyFeatures().catch(() => null);
  }
  return studyFeaturesPromise;
}

function updateClusterLevelVisibility() {
  if (els.mapClusterLevelSetting) {
    els.mapClusterLevelSetting.hidden = state.mapColor !== "embedding-cluster";
  }
}

async function ensureMapData() {
  if (state.mapData?.records?.length) return state.mapData;
  if (!mapDataPromise) {
    const mapUrl = versionedUrl(MAP_URL, state.dataManifest?.version);
    mapDataPromise = fetch(mapUrl, { cache: "reload" })
      .then((response) => {
        if (!response.ok) throw new Error(`Failed to load ${mapUrl} (${response.status})`);
        return response.json();
      })
      .then((payload) => {
        state.mapData = payload;
        enrichEmbeddingClusterRecords(state.data?.records || []);
        refreshSearchWorkerIndex();
        queueWorkerSearch();
        updateHeader();
        return payload;
      })
      .catch(() => {
        state.mapData = null;
        return null;
      });
  }
  return mapDataPromise;
}

function enrichEmbeddingClusterRecords(records) {
  const clusters = new Map((state.mapData?.embeddingClusters || []).map((cluster) => [cluster.id, cluster]));
  const levelLookups = new Map();
  for (const level of state.mapData?.embeddingClusterLevels || []) {
    const key = String(level.k || "");
    levelLookups.set(key, {
      assignments: level.assignments || [],
      clusters: level.clusters || [],
    });
  }
  const missing = [];
  const mapRecordIndexes = new Map((state.mapData?.records || []).map((record, index) => [record.id, index]));
  for (const record of records || []) {
    if (!record.embeddingClusterId) continue;
    const cluster = clusters.get(record.embeddingClusterId);
    if (!cluster?.label || !Array.isArray(cluster.topTerms)) {
      missing.push(`${record.id}:${record.embeddingClusterId}`);
      continue;
    }
    record.embeddingClusterLabel = cluster.label || "";
    record.embeddingClusterKeywords = cluster.topTerms || [];
    const mapIndex = mapRecordIndexes.get(record.id);
    record.embeddingClusterLevels = {};
    for (const [key, level] of levelLookups.entries()) {
      const clusterIndex = level.assignments[mapIndex];
      const levelCluster = Number.isInteger(clusterIndex) ? level.clusters[clusterIndex] : null;
      if (levelCluster?.label && Array.isArray(levelCluster.topTerms)) {
        record.embeddingClusterLevels[key] = {
          id: levelCluster.id,
          label: levelCluster.label,
          size: levelCluster.size,
          topTerms: levelCluster.topTerms,
          method: levelCluster.method,
        };
      }
    }
    delete record._hayParts;
    delete record._haystack;
    delete record._queryVector;
  }
  if (missing.length) {
    throw new Error(`Missing embedding cluster metadata for ${missing.length} records (${missing.slice(0, 5).join(", ")})`);
  }
}

async function init() {
  installMapDebugProbe();
  els.results.innerHTML = `<div class="empty-state"><strong>Loading index</strong><span>Reading the local Conference corpus manifest.</span></div>`;
  const loaded = await loadIndexData();
  state.data = loaded.data;
  state.dataManifest = loaded.manifest;
  state.data.records = enrichPaperPresentationRecords(state.data.records || []);
  attachResearchConcepts(state.data.records, state.researchConcepts);
  renderDataHealthNote();
  refreshSearchWorkerIndex();
  updateHeader();
  updateClusterLevelVisibility();
  renderAll();
  void ensureResearchConcepts();
  scheduleMapDataPreload();
  scheduleFullRecordsHydration();
  els.mapDetail.addEventListener("click", (event) => {
    const landscapeButton = event.target.closest("[data-landscape-cluster-id]");
    if (landscapeButton) {
      state.mapLandscapeFilterId = landscapeButton.dataset.landscapeClusterId || "";
      state.mapLandscapeFilterName = landscapeButton.dataset.landscapeName || "Semantic concentration";
      state.selectedId = "";
      clearMapSelection();
      resetResultWindow();
      renderMap();
      return;
    }
    if (event.target.closest("[data-clear-landscape]")) {
      state.mapLandscapeFilterId = "";
      state.mapLandscapeFilterName = "";
      state.selectedId = "";
      clearMapSelection();
      resetResultWindow();
      renderMap();
      return;
    }
    const button = event.target.closest(".trend-card-main[data-record-id], .trend-representatives [data-record-id]");
    if (!button) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openTrendRepresentative(button.dataset.recordId);
  }, true);
  els.mapView.addEventListener("click", (event) => {
    const button = event.target.closest(".topic-lens-records [data-record-id]");
    if (!button) return;
    openTrendRepresentative(button.dataset.recordId);
  });
  window.addEventListener("conference-semantic-search-ready", (event) => {
    if (state.tab !== "map") return;
    if (normalize(state.query) !== event.detail?.query) return;
    rerenderActiveMapQuery();
  });
  els.tabs.forEach((button) => {
    button.addEventListener("click", () => {
      const nextTab = button.dataset.tab;
      const tabChanged = nextTab !== state.tab;
      state.tab = nextTab;
      if (tabChanged) {
        state.query = "";
        els.search.value = "";
        if (els.mapSearch) els.mapSearch.value = "";
        state.mapCoreConceptFilter = "";
        state.mapLandscapeFilterId = "";
        state.mapLandscapeFilterName = "";
      }
      state.category = "all";
      state.group = "all";
      state.presentation = "all";
      state.mapFilterValue = "";
      if (nextTab === "map") {
        state.selectedId = "";
        loadSearchEmbeddingsInBackground();
      }
      if (nextTab === "references" || nextTab === "topics" || nextTab === "people") {
        state.selectedId = "";
      }
      if (nextTab === "people" && tabChanged) {
        state.authorView = "directory";
        resetAuthorMapFocus();
      }
      clearMapSelection();
      if (els.presentation) els.presentation.value = "all";
      resetResultWindow();
      renderAll();
      window.scrollTo(0, 0);
    });
    if (button.dataset.tab === "map") {
      button.addEventListener("pointerenter", scheduleMapDataPreload);
      button.addEventListener("focus", scheduleMapDataPreload);
    }
  });
  els.authorViewTabs.forEach((button) => {
    button.addEventListener("click", () => {
      if (state.tab !== "people" || state.authorView === button.dataset.authorView) return;
      state.authorView = button.dataset.authorView || "directory";
      state.selectedId = "";
      renderAll();
      window.scrollTo(0, 0);
    });
  });

  els.search.addEventListener("input", (event) => {
    state.query = event.target.value;
    if (els.mapSearch && els.mapSearch.value !== state.query) els.mapSearch.value = state.query;
    applyFilterChange();
  });
  els.mapSearch?.addEventListener("input", (event) => {
    state.query = event.target.value;
    if (els.search.value !== state.query) els.search.value = state.query;
    applyFilterChange();
  });
  els.category.addEventListener("change", (event) => {
    state.category = event.target.value;
    applyFilterChange();
  });
  els.group.addEventListener("change", (event) => {
    state.group = event.target.value;
    applyFilterChange();
  });
  els.presentation?.addEventListener("change", (event) => {
    state.presentation = event.target.value;
    applyFilterChange();
  });
  els.mapColor.addEventListener("change", (event) => {
    state.mapColor = ["quality", "availability"].includes(event.target.value) ? "area-domain" : event.target.value;
    els.mapColor.value = state.mapColor;
    state.mapFilterValue = "";
    state.mapLegendExpanded = false;
    updateClusterLevelVisibility();
    clearMapSelection();
    renderMap();
  });
  els.mapClusterLevel?.addEventListener("change", (event) => {
    state.mapEmbeddingClusterLevel = event.target.value;
    state.mapFilterValue = "";
    state.mapLegendExpanded = false;
    clearMapSelection();
    renderMap();
  });
  els.mapMode.addEventListener("change", (event) => {
    state.mapMode = event.target.value;
    clearMapSelection();
    renderMap();
  });
  els.clearMapCoreConceptFilter?.addEventListener("click", () => {
    clearMapCoreConceptFilter(state);
    state.selectedId = "";
    clearMapSelection();
    resetResultWindow();
    updateMapCoreConceptFilterControl();
    renderMap();
  });
  els.mapLive?.addEventListener("click", () => {
    state.mapLive = !state.mapLive;
    applyMapMotionSettings();
    if (state.mapLive) reflowMap();
  });
  els.mapReflow?.addEventListener("click", () => reflowMap());
  els.mapFit?.addEventListener("click", () => reflowMap({ fit: true }));
  els.mapZoomOut?.addEventListener("click", () => zoomMap(0.78));
  els.mapZoomIn?.addEventListener("click", () => zoomMap(1.28));
  els.results.addEventListener("scroll", () => {
    const distanceFromBottom = els.results.scrollHeight - els.results.scrollTop - els.results.clientHeight;
    if (distanceFromBottom < 320) {
      loadMoreResultsIfNeeded();
    }
  });
  window.addEventListener("resize", () => {
    if (state.tab === "map" && state.mapGraph) {
      state.mapGraph
        .width(els.mapCanvas.clientWidth || 840)
        .height(els.mapCanvas.clientHeight || 640);
      fitForceGraph(state.mapGraph, state.mapGraphData, { duration: 180 });
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (!state.mapGraph) return;
    if (document.hidden || state.tab !== "map") {
      state.mapGraph.pauseAnimation?.();
    } else if (state.mapLive) {
      state.mapGraph.resumeAnimation?.();
    }
  });
  installMapPointerInteractions();
}

init().catch((error) => {
  els.results.innerHTML = `<div class="empty-state"><strong>Could not load data</strong><span>${escapeHtml(error.message)}</span></div>`;
});
