import { els } from "./dom.js";
import { typeLabel } from "./records.js";
import { state } from "./state.js";
import { recordStudy, unusualDirectionForRecord } from "./study-features.js";
import { researchConceptTags } from "./research-concepts.mjs";
import { renderStudyPanel, renderUnusualDirections } from "./study-ui.js";
import { escapeHtml, plainMathTitle } from "./utils.js";
import { colorForValue } from "./map-tooltip.js";
import {
  explainSemanticRelation,
  focusDepth,
  focusedGraphPosition,
  focusedLayoutContext,
  mapColorValue,
  mapRecordById,
  embeddingClusterColorLabel,
  embeddingClusterSize,
  nearestDisplayNeighbors,
  selectedNeighborIds,
  sharedSemanticTags,
} from "./map-core.js";
import {
  applyForceAnchors,
  drawForceGraphNode,
} from "./map-engine.js";

let detailDeps = {};

export function configureMapDetail(deps) {
  detailDeps = deps;
}

function countLabelsHtml(items = []) {
  return items.slice(0, 3).map((item) => `<span>${escapeHtml(item.label)} <b>${Number(item.count || 0).toLocaleString()}</b></span>`).join("");
}

function trendCountGroup(label, items = []) {
  const html = countLabelsHtml(items);
  return html ? `<div class="trend-count-group"><em>${escapeHtml(label)}</em>${html}</div>` : "";
}

function trendEvidenceBasis(trend, firstReads) {
  const parts = [
    `${Number(trend.size || 0).toLocaleString()} mapped records`,
    `${(trend.keywords || []).length.toLocaleString()} keywords`,
    `${firstReads.length.toLocaleString()} first reads`,
    `${(trend.representativeSentences || []).length.toLocaleString()} representative sentences`,
  ];
  return `Basis: ${parts.join(" · ")}`;
}

function selectedMiniLabels(record) {
  const labels = [
    ...(record.areaTags || []).slice(0, 2).map((label) => ({ kind: "Area", label })),
    ...(record.domainTags || []).slice(0, 2).map((label) => ({ kind: "Domain", label })),
  ];
  const clusterLabel = embeddingClusterColorLabel(record);
  if (record.embeddingClusterId && clusterLabel) labels.push({ kind: "Cluster", label: clusterLabel });
  if (!labels.length) labels.push({ kind: "Type", label: typeLabel(record.type) });
  return labels;
}

function renderMiniSelectedLabels(record) {
  return selectedMiniLabels(record)
    .map((item) => `
      <span data-node-label="${escapeHtml(item.kind)}">
        <i style="background:${colorForValue(item.label)}"></i>
        <em>${escapeHtml(item.kind)}</em>
        ${escapeHtml(item.label)}
      </span>
    `)
    .join("");
}

function renderTrendCards() {
  const trends = (state.trendData?.trends || []).slice(0, 10);
  if (!trends.length) {
    return `<div class="empty-state compact"><strong>Select a paper from the map</strong><span>Hover to preview, click to inspect metadata and similar records.</span></div>`;
  }
  return `
    <section class="trend-panel">
      ${state.mapLandscapeFilterId ? `
        <div class="landscape-filter-state" role="status">
          <span>Landscape: <b>${escapeHtml(state.mapLandscapeFilterName)}</b></span>
          <button type="button" data-clear-landscape>Clear landscape</button>
        </div>
      ` : ""}
      <div class="trend-panel-head">
        <p class="eyebrow">Conference corpus research landscape</p>
        <h3>Semantic concentrations</h3>
        <p class="trend-basis-note">Single-conference snapshot from title+abstract embedding clusters. Sizes describe coverage in this corpus, not temporal growth, momentum, or official conference areas.</p>
      </div>
      <div class="trend-list">
        ${trends.map((trend, index) => {
          const firstReads = [...new Set([...(trend.firstReadRecordIds || []), ...(trend.representativeRecordIds || [])])]
            .map((recordId) => detailDeps.findDisplayRecord?.(recordId))
            .filter(Boolean)
            .slice(0, 3);
          return `
          <article class="trend-card" data-trend-id="${escapeHtml(trend.id)}">
            <button class="trend-card-main" type="button" data-record-id="${escapeHtml((trend.representativeRecordIds || [])[0] || "")}">
              <span class="neighbor-rank">${index + 1}</span>
              <span>
                <strong>${escapeHtml(trend.name || trend.clusterLabel || "Semantic trend")}</strong>
                <em>${Number(trend.size || 0).toLocaleString()} records · ${escapeHtml(trend.clusterLabel || "embedding cluster")}</em>
              </span>
            </button>
            <p>${escapeHtml(trend.summary || "")}</p>
            <div class="trend-keywords">
              ${(trend.keywords || []).slice(0, 5).map((keyword) => `<span>${escapeHtml(keyword)}</span>`).join("")}
            </div>
            <p class="trend-evidence-basis">${escapeHtml(trendEvidenceBasis(trend, firstReads))}</p>
            ${(trend.representativeSentences || []).slice(0, 1).map((sentence) => `<blockquote>${escapeHtml(sentence)}</blockquote>`).join("")}
            <div class="trend-counts">${trendCountGroup("Areas", trend.areaCounts)}${trendCountGroup("Domains", trend.domainCounts)}</div>
            <div class="trend-study-section">
              <span><em>Core question</em>${escapeHtml(trend.coreQuestion || "What should I read first in this embedding cluster?")}</span>
              <span><em>Method</em>${escapeHtml(trend.representativeMethodology || "Embedding-neighborhood analysis")}</span>
              <span><em>Branches</em>${(trend.subBranches || trend.keywords || []).slice(0, 4).map((label) => `<b>${escapeHtml(label)}</b>`).join("")}</span>
            </div>
            <button class="trend-explore-cluster" type="button"
              data-landscape-cluster-id="${escapeHtml(trend.clusterId || "")}"
              data-landscape-name="${escapeHtml(trend.name || trend.clusterLabel || "Semantic concentration")}">
              Explore this cluster <span>${Number(trend.size || 0).toLocaleString()} mapped records</span>
            </button>
            <div class="trend-representatives">
              <strong>First reads</strong>
              ${firstReads.map((record) => `<button type="button" data-record-id="${escapeHtml(record.id)}">${escapeHtml(plainMathTitle(record.title))}</button>`).join("")}
            </div>
          </article>
        `;
        }).join("")}
      </div>
      ${renderUnusualDirections(state.studyFeatures, detailDeps.findDisplayRecord)}
    </section>
  `;
}

function openMapRecord(recordId) {
  const record = detailDeps.findDisplayRecord?.(recordId);
  if (!record) return;
  state.selectedId = record.id;
  detailDeps.renderMap?.();
  renderMapDetail(record);
  detailDeps.renderViewer?.(record);
}

export function renderMapDetail(record) {
  if (!record) {
    els.mapDetail.innerHTML = renderTrendCards();
    els.mapDetail.querySelectorAll("[data-record-id], [data-study-id]").forEach((button) => {
      button.addEventListener("click", () => openMapRecord(button.dataset.recordId || button.dataset.studyId));
    });
    return;
  }
  if (!state.studyFeaturesLoaded && detailDeps.ensureStudyFeatures) {
    void detailDeps.ensureStudyFeatures().then(() => {
      if (state.selectedId === record.id && state.tab === "map") renderMapDetail(record);
    });
  }
  const mapById = mapRecordById();
  const neighbors = nearestDisplayNeighbors(record, mapById, 8);
  const displayScore = (score) => Number(Number(score || 0).toFixed(2));
  const neighborScores = neighbors.map((item) => displayScore(item.score));
  const neighborMin = neighborScores.length ? Math.min(...neighborScores) : 0;
  const neighborRange = (neighborScores.length ? Math.max(...neighborScores) : 1) - neighborMin || 1;
  const topScore = neighborScores.length ? Math.max(...neighborScores) : 0;
  const areaLabel = (record.areaTags || record.categoryTags || ["Other"]).slice(0, 2).join(", ") || "Other";
  const domainLabel = (record.domainTags || ["General"]).slice(0, 2).join(", ") || "General";
  const clusterLabel = embeddingClusterColorLabel(record);
  const clusterSize = embeddingClusterSize(record);
  const unusual = unusualDirectionForRecord(record.id);
  const detailConcepts = researchConceptTags(record, "detail");
  const neighborStrength = (score) => Math.max(0.08, Math.min(1, (displayScore(score) - neighborMin) / neighborRange));
  const similarityBand = topScore >= 0.9 ? "tight local neighborhood" : topScore >= 0.75 ? "clear related neighborhood" : "broad topical neighborhood";
  els.mapDetail.innerHTML = `
    <div class="map-detail-card">
      <p class="eyebrow">${escapeHtml(typeLabel(record.type))} · ${escapeHtml(record.clusterLabel || "Mapped record")}</p>
      <h3>${escapeHtml(plainMathTitle(record.title))}</h3>
      ${record.authors ? `<p class="result-authors">${escapeHtml(record.authors)}</p>` : ""}
      <div class="badges">
        ${(record.areaTags || []).slice(0, 3).map((tag) => `<span class="badge">${escapeHtml(tag)}</span>`).join("")}
        ${(record.domainTags || []).slice(0, 2).map((tag) => `<span class="badge">${escapeHtml(tag)}</span>`).join("")}
        ${record.embeddingClusterId ? `<span class="badge">Cluster: ${escapeHtml(clusterLabel)}</span>` : ""}
        ${unusual ? `<span class="badge">Unusual direction</span>` : ""}
        <span class="badge">${escapeHtml(record.embeddingTextQuality || "unavailable")}</span>
      </div>
      <div class="selection-stat-grid">
        <span><strong>${neighbors.length.toLocaleString()}</strong>neighbors</span>
        <span><strong>${Number(topScore || 0).toFixed(2)}</strong>top similarity</span>
        <span><strong>${escapeHtml(domainLabel)}</strong>domain</span>
      </div>
      <div class="selection-stat-block">
        <strong>Area / domain</strong>
        <span><em>${escapeHtml(areaLabel)}</em><b>${escapeHtml(domainLabel)}</b></span>
      </div>
      <div class="selection-stat-block">
        <strong>Embedding cluster</strong>
        <span><em>${escapeHtml(clusterLabel)}</em><b>${clusterSize ? clusterSize.toLocaleString() : "HDBSCAN"}</b></span>
      </div>
      ${detailConcepts.length ? `<section class="map-research-concepts"><h4>Research concepts</h4><div class="badges">${detailConcepts.map((concept) => `<span class="badge">${escapeHtml(concept)}</span>`).join("")}</div></section>` : ""}
      <p class="map-neighborhood-note">Neighborhood evidence: nearest records are ranked from the precomputed title+abstract embedding graph; bars are normalized within this selected record.</p>
      <p class="map-selected-basis">Selected basis: ${escapeHtml(record.embeddingTextQuality || "title/topic")} · ${escapeHtml(record.sourceType || "collected metadata")}</p>
      <p class="map-similarity-scale">Similarity scale: ${escapeHtml(similarityBand)} · top score ${Number(topScore || 0).toFixed(2)} · compare bars only within this selected record.</p>
      <button class="action primary map-open-record" type="button">Open in viewer</button>
      <div class="neighbor-list">
        ${neighbors.map((item) => {
          const strength = neighborStrength(item.score);
          const tags = sharedSemanticTags(record, item.record);
          const reason = explainSemanticRelation(record, item.record, item.score);
          return `<button type="button" class="neighbor-item semantic-neighbor" data-id="${escapeHtml(item.record.id)}"><span class="neighbor-rank">${item.rank}</span><span class="neighbor-main"><strong>${escapeHtml(plainMathTitle(item.record.title))}</strong><span>${displayScore(item.score).toFixed(2)} similarity${tags.length ? ` · shared ${tags.map(escapeHtml).join(", ")}` : ""}</span><small class="why-line">${escapeHtml(reason)}</small><i class="neighbor-score-bar\"><b style=\"width:${Math.round(strength * 100)}%\"></b></i></span></button>`;
        }).join("") || "<small>No mapped neighbors found for this record.</small>"}
      </div>
      ${renderStudyPanel(record, recordStudy(record.id), detailDeps.findDisplayRecord)}
    </div>
  `;
  els.mapDetail.querySelector(".map-open-record")?.addEventListener("click", () => {
    state.tab = record.type;
    state.category = "all";
    state.group = "all";
    state.presentation = "all";
    if (els.presentation) els.presentation.value = "all";
    detailDeps.renderAll?.();
    state.selectedId = record.id;
    detailDeps.renderResults?.();
    detailDeps.renderViewer?.(record);
  });
  els.mapDetail.querySelectorAll(".neighbor-item").forEach((button) => {
    button.addEventListener("click", () => {
      openMapRecord(button.dataset.id);
    });
  });
  els.mapDetail.querySelectorAll("[data-study-id]").forEach((button) => {
    button.addEventListener("click", () => openMapRecord(button.dataset.studyId));
  });
  els.mapDetail.querySelectorAll(".compare-candidate").forEach((button) => {
    button.addEventListener("click", () => {
      state.studyCompareSourceId = record.id;
      state.studyCompareTargetId = button.dataset.compareId || "";
      renderMapDetail(record);
    });
  });
}

export function semanticNeighborhood(record, depth = state.miniGraphDepth || "first") {
  if (!record?.mapAvailable || !state.mapData?.records?.length) return "";
  const mapById = mapRecordById();
  const center = mapById.get(record.id);
  if (!center) return null;
  const firstHopLimit = depth === "deep" ? 10 : 8;
  const neighbors = nearestDisplayNeighbors(record, mapById, firstHopLimit)
    .filter((item) => mapById.has(item.record.id));
  if (!neighbors.length) return null;
  const ids = new Set([record.id, ...neighbors.map((item) => item.record.id)]);
  if (depth === "deep") {
    for (const item of neighbors.slice(0, 8)) {
      for (const secondHop of (mapById.get(item.record.id)?.nearestNeighbors || []).slice(0, 3)) {
        if (ids.size >= 24) break;
        const secondRecord = detailDeps.findDisplayRecord?.(secondHop.id);
        if (!secondRecord || secondRecord.id === record.id) continue;
        ids.add(secondRecord.id);
      }
    }
  }
  const context = focusedLayoutContext(ids, mapById, record.id, firstHopLimit);
  const selectedNeighbors = selectedNeighborIds(mapById, record.id, firstHopLimit);
  const recordsById = new Map([record, ...neighbors.map((item) => item.record)].map((item) => [item.id, item]));
  for (const id of ids) {
    if (!recordsById.has(id)) {
      const item = detailDeps.findDisplayRecord?.(id);
      if (item) recordsById.set(id, item);
    }
  }
  const nodes = [...ids].map((id) => {
    const item = recordsById.get(id);
    const position = focusedGraphPosition(id, item, context, record.id);
    return {
      id,
      record: item,
      title: plainMathTitle(item?.title || ""),
      group: mapColorValue(item || {}),
      selected: id === record.id,
      adjacent: selectedNeighbors.has(id),
      depth: focusDepth(id, selectedNeighbors, mapById, record.id),
      type: item?.type || "record",
      focusRank: context.firstHopIndex.get(id) ?? 99,
      seedX: position.x,
      seedY: position.y,
      x: position.x,
      y: position.y,
    };
  }).filter((node) => node.record);
  const links = [];
  const seen = new Set();
  for (const node of nodes) {
    const map = mapById.get(node.id);
    const linkLimit = depth === "deep" ? 6 : 5;
    for (const neighbor of (map?.nearestNeighbors || []).slice(0, linkLimit)) {
      if (!ids.has(neighbor.id)) continue;
      const key = [node.id, neighbor.id].sort().join("::");
      if (seen.has(key) || node.id === neighbor.id) continue;
      seen.add(key);
      links.push({
        source: node.id,
        target: neighbor.id,
        value: Number(neighbor.score || 0),
        selected: node.id === record.id || neighbor.id === record.id,
        depth: node.id === record.id || neighbor.id === record.id ? 1 : 2,
      });
    }
  }
  const displayScore = (score) => Number(Number(score || 0).toFixed(2));
  const scores = neighbors.map((item) => displayScore(item.score));
  const minScore = Math.min(...scores);
  const maxScore = Math.max(...scores);
  const scoreRange = Math.max(0.001, maxScore - minScore);
  const similarityPercent = (score) => Math.max(0.08, Math.min(1, (displayScore(score) - minScore) / scoreRange));
  const sharedTags = (neighborRecord) => sharedSemanticTags(record, neighborRecord);
  return { neighbors, maxScore, similarityPercent, sharedTags, depth, graphData: { nodes, links } };
}

export function destroyMiniGraph() {
  state.miniGraph?.pauseAnimation?.();
  state.miniGraph = null;
  detailDeps.hideGraphTooltip?.(els.viewerFrame.querySelector(".mini-graph"));
}

function fitGraphToElement(graph, graphData, element, options = {}) {
  if (!graph || !graphData?.nodes?.length || !element) return;
  const graphBox = graph.getGraphBbox?.();
  const bounds = graphBox ? {
    minX: Number(graphBox.x?.[0]) || 0,
    maxX: Number(graphBox.x?.[1]) || 0,
    minY: Number(graphBox.y?.[0]) || 0,
    maxY: Number(graphBox.y?.[1]) || 0,
  } : graphData.nodes.reduce((box, node) => ({
    minX: Math.min(box.minX, Number(node.x) || 0),
    maxX: Math.max(box.maxX, Number(node.x) || 0),
    minY: Math.min(box.minY, Number(node.y) || 0),
    maxY: Math.max(box.maxY, Number(node.y) || 0),
  }), {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
  });
  const width = element.clientWidth || 720;
  const height = element.clientHeight || 240;
  const padding = options.padding ?? 30;
  const spanX = Math.max(34, bounds.maxX - bounds.minX);
  const spanY = Math.max(34, bounds.maxY - bounds.minY);
  const fitScale = Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanY);
  const zoom = Math.max(options.minZoom ?? 0.72, Math.min(options.maxZoom ?? 4.8, fitScale));
  graph.centerAt?.((bounds.minX + bounds.maxX) / 2, (bounds.minY + bounds.maxY) / 2, options.duration ?? 260);
  graph.zoom?.(zoom, options.duration ?? 260);
}

export function controlMiniGraph(action, record) {
  const container = els.viewerFrame.querySelector(".mini-graph");
  if (action === "depth") {
    state.miniGraphDepth = state.miniGraphDepth === "deep" ? "first" : "deep";
    detailDeps.renderViewer?.(record);
    return;
  }
  if (!state.miniGraph || !container) return;
  if (action === "fit") {
    fitGraphToElement(state.miniGraph, state.miniGraph.graphData?.(), container, { padding: 44, minZoom: 0.72, maxZoom: 5.2 });
    return;
  }
  const currentZoom = Number(state.miniGraph.zoom?.() || 1);
  const factor = action === "zoom-in" ? 1.25 : action === "zoom-out" ? 0.8 : 1;
  state.miniGraph.zoom?.(Math.max(0.45, Math.min(6, currentZoom * factor)), 180);
}

function miniGraphPoint(event, container) {
  const rect = container.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function nearestMiniNodeAtScreen(point, maxDist = 28) {
  const graph = state.miniGraph;
  const nodes = graph?.graphData?.()?.nodes || [];
  if (!graph || typeof graph.graph2ScreenCoords !== "function" || !nodes.length) return null;
  let best = null;
  let bestDistSq = maxDist * maxDist;
  for (const node of nodes) {
    const screen = graph.graph2ScreenCoords(Number(node.x) || 0, Number(node.y) || 0);
    const dx = (Number(screen.x) || 0) - point.x;
    const dy = (Number(screen.y) || 0) - point.y;
    const distSq = dx * dx + dy * dy;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      best = node;
    }
  }
  return best;
}

export function mountMiniGraph(graphData, selectedId) {
  destroyMiniGraph();
  const container = els.viewerFrame.querySelector(".mini-graph");
  if (!container || typeof window.ForceGraph !== "function") return;
  let miniHoverId = "";
  const showMiniHover = (node) => {
    miniHoverId = node?.id || "";
    container.style.cursor = node ? "pointer" : "";
    if (node && typeof state.miniGraph?.graph2ScreenCoords === "function") {
      detailDeps.showGraphTooltip?.(container, node, state.miniGraph.graph2ScreenCoords(node.x || 0, node.y || 0));
    } else {
      detailDeps.hideGraphTooltip?.(container, 90);
    }
    state.miniGraph?.refresh?.();
  };
  state.miniGraph = window.ForceGraph()(container)
    .backgroundColor("rgba(0,0,0,0)")
    .nodeId("id")
    .nodeLabel("")
    .nodeVal((node) => node.selected ? 8 : node.depth === 1 ? 5.2 : 3.4)
    .nodePointerAreaPaint((node, color, ctx) => {
      const radius = node.selected ? 18 : 14;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI);
      ctx.fill();
    })
    .enableZoomInteraction(true)
    .enablePanInteraction(true)
    .enableNodeDrag(false)
    .linkCurvature(0.06)
    .linkWidth((link) => link.selected ? 2.2 : Math.max(0.5, Number(link.value || 0) * 1.8))
    .linkColor((link) => link.selected ? "rgba(106,165,147,0.62)" : "rgba(111,125,140,0.36)")
    .linkDirectionalParticles(0)
    .d3AlphaMin(0.001)
    .d3AlphaDecay(0.018)
    .d3VelocityDecay(0.42)
    .nodeCanvasObject((node, ctx, globalScale) => {
      drawForceGraphNode(node, ctx, globalScale, {
        mode: "focused",
        selectedId,
        hoverId: miniHoverId,
        hideSelectedLabel: true,
        neighborLabelCount: 0,
        labelScaleThreshold: 0.35,
        maxLabelLength: 42,
        baseFontSize: 10,
        maxFontSize: 12,
        showDomainRing: true,
        radiusScale: 2.45,
        minScreenRadius: node.selected ? 12 : 8.5,
      });
    })
    .onNodeHover((node) => {
      showMiniHover(node);
    })
    .onNodeClick((node) => {
      if (!node?.record) return;
      state.selectedId = node.id;
      detailDeps.renderResults?.();
      detailDeps.renderMap?.();
      detailDeps.renderViewer?.(node.record);
    })
    .width(container.clientWidth || 720)
    .height(container.clientHeight || 240)
    .graphData(graphData);
  state.miniGraph.d3Force("charge")?.strength((node) => node.selected ? -154 : -68);
  state.miniGraph.d3Force("link")?.distance((link) => link.selected ? 76 : 86);
  applyForceAnchors(state.miniGraph, 0.035);
  state.miniGraph.cooldownTime?.(3200);
  state.miniGraph.resumeAnimation?.();
  const mountedGraph = state.miniGraph;
  const fitMiniGraph = (duration = 220) => {
    if (state.miniGraph !== mountedGraph || !container.isConnected) return;
    fitGraphToElement(mountedGraph, mountedGraph.graphData?.() || graphData, container, { padding: 64, minZoom: 0.72, maxZoom: 4.4, duration });
  };
  requestAnimationFrame(() => fitMiniGraph(0));
  window.setTimeout(() => fitMiniGraph(180), 180);
  window.setTimeout(() => fitMiniGraph(220), 900);
  window.setTimeout(() => fitMiniGraph(220), 1800);
  container.addEventListener("pointermove", (event) => {
    const node = nearestMiniNodeAtScreen(miniGraphPoint(event, container));
    if ((node?.id || "") !== miniHoverId) showMiniHover(node);
  }, { passive: true });
  container.addEventListener("pointerleave", () => showMiniHover(null));
}

export function renderMiniMap(record) {
  const depth = state.miniGraphDepth || "first";
  const neighborhood = semanticNeighborhood(record, depth);
  if (!neighborhood) return "";
  const { neighbors, maxScore, similarityPercent, sharedTags } = neighborhood;
  const deep = depth === "deep";
  return `
    <section class="mini-map-panel" data-mini-graph-record="${escapeHtml(record.id)}">
      <div class="mini-map-heading">
        <h3>Semantic neighborhood</h3>
        <span>${deep ? "deeper neighborhood" : "first-hop view"} · ${neighbors.length} nearest mapped records</span>
      </div>
      <div class="mini-graph-toolbar" aria-label="Semantic neighborhood controls">
        <button class="mini-graph-control" type="button" data-mini-action="zoom-out" title="Zoom out">-</button>
        <button class="mini-graph-control" type="button" data-mini-action="zoom-in" title="Zoom in">+</button>
        <button class="mini-graph-control" type="button" data-mini-action="fit" title="Fit neighborhood graph">Fit</button>
        <button class="mini-graph-control depth-toggle${deep ? " is-active" : ""}" type="button" data-mini-action="depth" aria-pressed="${deep}" title="Toggle first-hop and deeper semantic neighborhood">${deep ? "Depth: Deeper" : "Depth: 1-hop"}</button>
      </div>
      <div class="mini-graph" aria-label="Semantic neighborhood graph using the same ForceGraph renderer as the main map">
        <div class="mini-graph-caption">
          <strong>${Number(maxScore || 0).toFixed(2)}</strong>
          <span>top similarity</span>
        </div>
      </div>
      <div class="mini-selected-title">${escapeHtml(plainMathTitle(record.title))}</div>
      <div class="mini-tag-summary">
        ${renderMiniSelectedLabels(record)}
      </div>
      <div class="neighbor-list">
        ${neighbors.map((item) => {
          const strength = similarityPercent(item.score);
          const tags = sharedTags(item.record).slice(0, 3);
          return `
            <button type="button" class="neighbor-item semantic-neighbor" data-id="${escapeHtml(item.record.id)}">
              <span class="neighbor-rank">${item.rank}</span>
              <span class="neighbor-main">
                <strong>${escapeHtml(plainMathTitle(item.record.title))}</strong>
                <span>${Number(item.score || 0).toFixed(2)} similarity${tags.length ? ` · shared ${tags.map(escapeHtml).join(", ")}` : ""}</span>
                <i class="neighbor-score-bar"><b style="width:${Math.round(strength * 100)}%"></b></i>
              </span>
            </button>
          `;
        }).join("")}
      </div>
    </section>
  `;
}
