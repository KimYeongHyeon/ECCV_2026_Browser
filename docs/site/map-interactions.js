import { els } from "./dom.js";
import { typeLabel } from "./records.js";
import { state } from "./state.js";
import { escapeHtml, plainMathTitle } from "./utils.js";
import {
  countLabels,
  normalizedBox,
} from "./map-layout.js";
import { graphTooltipHTML } from "./map-tooltip.js";
import {
  mapRecordById,
  selectedNeighborIds,
} from "./map-core.js";
import {
  fitForceGraph,
  zoomMap,
} from "./map-engine.js";
import { renderMapDetail } from "./map-detail.js";

let interactionDeps = {};
const SELECTION_SAMPLE_PAGE_SIZE = 3;

export function configureMapInteractions(deps) {
  interactionDeps = deps;
}

function mapCanvasPoint(event) {
  const rect = els.mapCanvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function mapCanvasCenter() {
  return {
    x: (els.mapCanvas.clientWidth || 840) / 2,
    y: (els.mapCanvas.clientHeight || 640) / 2,
  };
}

function markMapUserInteraction() {
  state.mapLastUserInteraction = performance.now();
}

function forceGraphZoomAt(point, multiplier, duration = 180) {
  const graph = state.mapGraph;
  if (!graph || typeof graph.screen2GraphCoords !== "function") return;
  const width = els.mapCanvas.clientWidth || 840;
  const height = els.mapCanvas.clientHeight || 640;
  const currentZoom = typeof graph.zoom === "function" ? graph.zoom() : 1;
  const nextZoom = Math.max(0.08, Math.min(18, currentZoom * multiplier));
  const graphPoint = graph.screen2GraphCoords(point.x, point.y);
  const centerX = graphPoint.x - (point.x - width / 2) / nextZoom;
  const centerY = graphPoint.y - (point.y - height / 2) / nextZoom;
  if (duration > 0) {
    graph.centerAt?.(centerX, centerY, duration);
    graph.zoom?.(nextZoom, duration);
  } else {
    graph.centerAt?.(centerX, centerY);
    graph.zoom?.(nextZoom);
  }
  graph.resumeAnimation?.();
}

function forceGraphZoomToBox(start, end) {
  const graph = state.mapGraph;
  if (!graph || typeof graph.screen2GraphCoords !== "function") return;
  const width = els.mapCanvas.clientWidth || 840;
  const height = els.mapCanvas.clientHeight || 640;
  const left = Math.min(start.x, end.x);
  const right = Math.max(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const bottom = Math.max(start.y, end.y);
  const boxWidth = Math.max(8, right - left);
  const boxHeight = Math.max(8, bottom - top);
  const topLeft = graph.screen2GraphCoords(left, top);
  const bottomRight = graph.screen2GraphCoords(right, bottom);
  const spanX = Math.max(8, Math.abs(bottomRight.x - topLeft.x));
  const spanY = Math.max(8, Math.abs(bottomRight.y - topLeft.y));
  const nextZoom = Math.max(0.08, Math.min(18, Math.min(width / spanX, height / spanY) * 0.88));
  const center = graph.screen2GraphCoords(left + boxWidth / 2, top + boxHeight / 2);
  graph.centerAt?.(center.x, center.y, 240);
  graph.zoom?.(nextZoom, 240);
  graph.resumeAnimation?.();
}

function pointInActiveSelection(point) {
  if (!state.mapSelection.active || !state.mapSelection.start || !state.mapSelection.end) return false;
  const box = normalizedBox(state.mapSelection.start, state.mapSelection.end);
  return point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom;
}

function mapNodesInBox(start, end) {
  const graph = state.mapGraph;
  if (!graph || typeof graph.graph2ScreenCoords !== "function") return [];
  const box = normalizedBox(start, end);
  return (state.mapGraphData?.nodes || []).filter((node) => {
    const point = graph.graph2ScreenCoords(node.x || 0, node.y || 0);
    return point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom;
  });
}

function nearestNodeAtScreen(point, maxDist = 24) {
  const graph = state.mapGraph;
  const nodes = state.mapGraphData?.nodes;
  if (!graph || typeof graph.graph2ScreenCoords !== "function" || !nodes?.length) return null;
  let best = null;
  let bestDistSq = maxDist * maxDist;
  for (const node of nodes) {
    const screen = graph.graph2ScreenCoords(Number(node.x) || 0, Number(node.y) || 0);
    const sx = Number(screen.x) || 0;
    const sy = Number(screen.y) || 0;
    const dx = sx - point.x;
    const dy = sy - point.y;
    const distSq = dx * dx + dy * dy;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      best = node;
    }
  }
  return best;
}

function renderMapSelectionSummary(nodes) {
  const records = nodes.map((node) => node.record).filter(Boolean);
  const areas = countLabels(records.map((record) => record.areaTags || []));
  const embeddingClusters = countLabels(records.map((record) => [record.embeddingClusterLabel || record.embeddingClusterId || "Unclustered"]));
  const groups = countLabels(records.map((record) => [record.group || record.clusterLabel || "Other"]));
  const types = countLabels(records.map((record) => [typeLabel(record.type)]));
  const samplePageCount = Math.max(1, Math.ceil(records.length / SELECTION_SAMPLE_PAGE_SIZE));
  let samplePage = 0;
  const sampleRecordsHtml = () => {
    const offset = samplePage * SELECTION_SAMPLE_PAGE_SIZE;
    const sample = records.slice(offset, offset + SELECTION_SAMPLE_PAGE_SIZE);
    return sample.map((record) => `<button type="button" class="neighbor-item" data-id="${escapeHtml(record.id)}"><strong>${escapeHtml(plainMathTitle(record.title))}</strong><span>${escapeHtml(record.group || typeLabel(record.type))}</span></button>`).join("") || "<small>No records inside the box</small>";
  };
  const wireSampleRecordButtons = () => {
    els.mapDetail.querySelectorAll(".selection-sample-list .neighbor-item").forEach((button) => {
      button.addEventListener("click", () => {
        const selected = interactionDeps.findDisplayRecord?.(button.dataset.id);
        if (!selected) return;
        state.selectedId = selected.id;
        refreshForceSelectionState();
        renderMapDetail(selected);
        interactionDeps.renderViewer?.(selected);
      });
    });
  };
  const renderSamplePage = () => {
    const sampleList = els.mapDetail.querySelector(".selection-sample-list");
    if (!sampleList) return;
    sampleList.innerHTML = sampleRecordsHtml();
    const pageLabel = els.mapDetail.querySelector(".selection-sample-page");
    if (pageLabel) pageLabel.textContent = `${samplePage + 1}/${samplePageCount}`;
    const prev = els.mapDetail.querySelector(".selection-sample-prev");
    const next = els.mapDetail.querySelector(".selection-sample-next");
    if (prev) prev.disabled = samplePage <= 0;
    if (next) next.disabled = samplePage >= samplePageCount - 1;
    wireSampleRecordButtons();
  };
  els.mapDetail.innerHTML = `
    <div class="map-detail-card">
      <p class="eyebrow">BOX SELECTION</p>
      <h3>${nodes.length.toLocaleString()} mapped records</h3>
      <button class="action primary map-zoom-selection" type="button">Zoom to selection</button>
      <div class="selection-stat-grid">
        ${types.slice(0, 3).map(([label, count]) => `<span><strong>${count.toLocaleString()}</strong>${escapeHtml(label)}</span>`).join("")}
      </div>
      <div class="selection-stat-block">
        <strong>Top areas</strong>
        ${areas.slice(0, 6).map(([label, count]) => `<span><em>${escapeHtml(label)}</em><b>${count.toLocaleString()}</b></span>`).join("") || "<small>No area tags</small>"}
      </div>
      <div class="selection-stat-block selection-stat-block-clusters">
        <strong>Top embedding clusters</strong>
        ${embeddingClusters.slice(0, 5).map(([label, count]) => `<span class="selection-stat-row"><em class="selection-stat-label">${escapeHtml(label)}</em><b class="selection-stat-count">${count.toLocaleString()}</b></span>`).join("") || "<small>No embedding clusters</small>"}
      </div>
      <div class="selection-stat-block selection-stat-block-groups">
        <strong>Top groups</strong>
        ${groups.slice(0, 5).map(([label, count]) => `<span class="selection-stat-row"><em class="selection-stat-label">${escapeHtml(label)}</em><b class="selection-stat-count">${count.toLocaleString()}</b></span>`).join("") || "<small>No groups</small>"}
      </div>
      <div class="selection-stat-block selection-sample-block">
        <div class="selection-block-head">
          <strong>Sample records</strong>
          ${records.length > SELECTION_SAMPLE_PAGE_SIZE ? `
            <span class="selection-sample-controls">
              <button type="button" class="selection-sample-prev" aria-label="Previous sample records">&lt;</button>
              <em class="selection-sample-page">1/${samplePageCount}</em>
              <button type="button" class="selection-sample-next" aria-label="Next sample records">&gt;</button>
            </span>
          ` : ""}
        </div>
        <div class="selection-sample-list">
          ${sampleRecordsHtml()}
        </div>
      </div>
    </div>
  `;
  els.mapDetail.querySelector(".map-zoom-selection")?.addEventListener("click", () => zoomToMapSelection());
  els.mapDetail.querySelector(".selection-sample-prev")?.addEventListener("click", () => {
    samplePage = Math.max(0, samplePage - 1);
    renderSamplePage();
  });
  els.mapDetail.querySelector(".selection-sample-next")?.addEventListener("click", () => {
    samplePage = Math.min(samplePageCount - 1, samplePage + 1);
    renderSamplePage();
  });
  renderSamplePage();
}

function setMapSelection(start, end) {
  const nodes = mapNodesInBox(start, end);
  state.mapSelection = {
    active: true,
    start,
    end,
    nodeIds: nodes.map((node) => node.id),
  };
  updateMapSelectionBox(start, end);
  renderMapSelectionSummary(nodes);
}

export function clearMapSelection() {
  state.mapSelection = { active: false, start: null, end: null, nodeIds: [] };
  hideMapSelectionBox();
}

function zoomToMapSelection() {
  if (!state.mapSelection.active || !state.mapSelection.start || !state.mapSelection.end) return false;
  forceGraphZoomToBox(state.mapSelection.start, state.mapSelection.end);
  clearMapSelection();
  return true;
}

export function ensureMapSelectionBox() {
  let box = els.mapCanvas.querySelector(".map-selection-box");
  if (!box) {
    box = document.createElement("div");
    box.className = "map-selection-box";
    els.mapCanvas.appendChild(box);
  }
  return box;
}

function updateMapSelectionBox(start, current) {
  const box = ensureMapSelectionBox();
  const left = Math.min(start.x, current.x);
  const top = Math.min(start.y, current.y);
  const width = Math.abs(current.x - start.x);
  const height = Math.abs(current.y - start.y);
  box.style.transform = `translate(${left}px, ${top}px)`;
  box.style.width = `${width}px`;
  box.style.height = `${height}px`;
  box.hidden = false;
}

function hideMapSelectionBox() {
  const box = els.mapCanvas.querySelector(".map-selection-box");
  if (box) box.hidden = true;
}

function ensureGraphTooltip(container) {
  let tooltip = container.querySelector(":scope > .graph-node-tooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.className = "graph-node-tooltip";
    tooltip.hidden = true;
    container.appendChild(tooltip);
  }
  return tooltip;
}

export function showGraphTooltip(container, node, point) {
  if (!container || !node?.title || !point) return;
  const tooltip = ensureGraphTooltip(container);
  if (tooltip._hideTimer) {
    window.clearTimeout(tooltip._hideTimer);
    tooltip._hideTimer = null;
  }
  const rect = container.getBoundingClientRect();
  tooltip.innerHTML = graphTooltipHTML(node);
  tooltip.style.transform = "none";
  tooltip.hidden = false;
  const pad = 8;
  const gap = 12;
  const width = tooltip.offsetWidth;
  const height = tooltip.offsetHeight;
  const anchorX = rect.left + point.x;
  const anchorY = rect.top + point.y;
  let left = anchorX - width / 2;
  left = Math.max(rect.left + pad, Math.min(left, rect.right - width - pad));
  let top = anchorY - height - gap;
  if (top < rect.top + pad) top = anchorY + gap + 4;
  top = Math.max(rect.top + pad, Math.min(top, rect.bottom - height - pad));
  tooltip.style.left = `${Math.round(left)}px`;
  tooltip.style.top = `${Math.round(top)}px`;
}

export function hideGraphTooltip(container, delay = 0) {
  const tooltip = container?.querySelector(":scope > .graph-node-tooltip");
  if (!tooltip) return;
  if (tooltip._hideTimer) window.clearTimeout(tooltip._hideTimer);
  if (delay > 0) {
    tooltip._hideTimer = window.setTimeout(() => {
      tooltip.hidden = true;
      tooltip._hideTimer = null;
    }, delay);
  } else {
    tooltip.hidden = true;
    tooltip._hideTimer = null;
  }
}

function graphClickSuppressed() {
  return performance.now() < state.mapInteraction.suppressClickUntil;
}

function selectMapNode(node) {
  if (!node?.record) return;
  state.selectedId = node.id;
  refreshForceSelectionState();
  renderMapDetail(node.record);
  interactionDeps.renderViewer?.(node.record);
}

function refreshForceSelectionState() {
  if (!state.mapGraphData?.nodes?.length) return;
  const mapById = mapRecordById();
  const selectedNeighbors = selectedNeighborIds(mapById);
  for (const node of state.mapGraphData.nodes) {
    node.selected = node.id === state.selectedId;
    node.adjacent = selectedNeighbors.has(node.id);
  }
  for (const link of state.mapGraphData.links || []) {
    const source = typeof link.source === "object" ? link.source.id : link.source;
    const target = typeof link.target === "object" ? link.target.id : link.target;
    link.selected = source === state.selectedId || target === state.selectedId;
  }
  state.mapGraph?.refresh?.();
}

function isTextEntryTarget(target) {
  return ["INPUT", "SELECT", "TEXTAREA"].includes(target?.tagName) || target?.isContentEditable;
}

export function installMapPointerInteractions() {
  document.addEventListener("keydown", (event) => {
    if (event.code !== "Space" || isTextEntryTarget(event.target)) return;
    if (state.tab !== "map") return;
    event.preventDefault();
    state.mapInteraction.spaceDown = true;
    els.mapCanvas.classList.add("is-space-ready");
  });

  document.addEventListener("keyup", (event) => {
    if (event.code !== "Space") return;
    if (state.tab === "map" && !isTextEntryTarget(event.target)) {
      event.preventDefault();
    }
    state.mapInteraction.spaceDown = false;
    els.mapCanvas.classList.remove("is-space-ready", "is-panning");
  });

  els.mapCanvas.addEventListener("pointerdown", (event) => {
    if (state.tab === "map" && event.button === 1 && state.mapGraph) {
      event.preventDefault();
      fitForceGraph(state.mapGraph, state.mapGraphData, { duration: 280, padding: state.mapMode === "focused" ? 84 : 160 });
      state.mapGraph.resumeAnimation?.();
      return;
    }
    if (state.tab !== "map" || event.button !== 0 || !state.mapGraph) return;
    const point = mapCanvasPoint(event);
    const interaction = state.mapInteraction;
    interaction.pointerId = event.pointerId;
    interaction.mode = interaction.spaceDown ? "pan" : pointInActiveSelection(point) ? "selection-click" : "box";
    interaction.moved = false;
    interaction.start = point;
    interaction.last = point;
    interaction.center = typeof state.mapGraph.screen2GraphCoords === "function"
      ? state.mapGraph.screen2GraphCoords(mapCanvasCenter().x, mapCanvasCenter().y)
      : { x: 0, y: 0 };
    els.mapCanvas.setPointerCapture?.(event.pointerId);
    if (interaction.mode === "pan") {
      els.mapCanvas.classList.add("is-panning");
      clearMapSelection();
    } else if (interaction.mode === "box") {
      updateMapSelectionBox(point, point);
    }
    event.preventDefault();
  });

  els.mapCanvas.addEventListener("pointermove", (event) => {
    const interaction = state.mapInteraction;
    if (interaction.pointerId !== event.pointerId || !interaction.mode || !state.mapGraph) return;
    const point = mapCanvasPoint(event);
    const dx = point.x - interaction.start.x;
    const dy = point.y - interaction.start.y;
    if (Math.hypot(dx, dy) > 4) interaction.moved = true;
    if (interaction.mode === "pan") {
      const zoom = typeof state.mapGraph.zoom === "function" ? state.mapGraph.zoom() : 1;
      state.mapGraph.centerAt?.(
        interaction.center.x - dx / zoom,
        interaction.center.y - dy / zoom,
        0,
      );
    } else if (interaction.mode === "box") {
      updateMapSelectionBox(interaction.start, point);
    }
    interaction.last = point;
    event.preventDefault();
  });

  let hoverFrame = 0;
  els.mapCanvas.addEventListener("pointermove", (event) => {
    if (state.tab !== "map" || !state.mapGraph) return;
    const interaction = state.mapInteraction;
    if (interaction.mode === "box" || interaction.mode === "pan" || interaction.spaceDown) {
      hideGraphTooltip(els.mapCanvas, 0);
      return;
    }
    const point = mapCanvasPoint(event);
    if (hoverFrame) return;
    hoverFrame = window.requestAnimationFrame(() => {
      hoverFrame = 0;
      if (state.mapInteraction.mode) return;
      const node = nearestNodeAtScreen(point, 24);
      const id = node?.id || "";
      if (id !== state.mapHoverId) {
        state.mapHoverId = id;
        state.mapGraph?.refresh?.();
      }
      els.mapCanvas.style.cursor = node ? "pointer" : "crosshair";
      if (node && typeof state.mapGraph?.graph2ScreenCoords === "function") {
        showGraphTooltip(els.mapCanvas, node, state.mapGraph.graph2ScreenCoords(node.x || 0, node.y || 0));
      } else {
        hideGraphTooltip(els.mapCanvas, 80);
      }
    });
  }, { passive: true });

  els.mapCanvas.addEventListener("pointerleave", () => {
    if (state.mapHoverId) {
      state.mapHoverId = "";
      state.mapGraph?.refresh?.();
    }
    hideGraphTooltip(els.mapCanvas, 0);
  });

  els.mapCanvas.addEventListener("pointerup", (event) => {
    const interaction = state.mapInteraction;
    if (interaction.pointerId !== event.pointerId || !interaction.mode) return;
    els.mapCanvas.releasePointerCapture?.(event.pointerId);
    els.mapCanvas.classList.remove("is-panning");
    const mode = interaction.mode;
    const moved = interaction.moved;
    const start = interaction.start;
    const end = mapCanvasPoint(event);
    interaction.pointerId = null;
    interaction.mode = "";
    if (mode === "selection-click" && !moved) {
      interaction.suppressClickUntil = performance.now() + 300;
      zoomToMapSelection();
      event.preventDefault();
      return;
    }
    if (mode === "box") {
      hideMapSelectionBox();
      const dragDistance = Math.hypot(end.x - start.x, end.y - start.y);
      if (dragDistance > 10) {
        interaction.suppressClickUntil = performance.now() + 300;
        setMapSelection(start, end);
      } else {
        const hadSelection = state.mapSelection.active;
        if (hadSelection) clearMapSelection();
        const node = nearestNodeAtScreen(end, 24);
        if (node?.record) {
          selectMapNode(node);
        } else if (hadSelection) {
          const selected = interactionDeps.findDisplayRecord?.(state.selectedId);
          renderMapDetail(selected || null);
        }
      }
    }
    event.preventDefault();
  });

  els.mapCanvas.addEventListener("pointercancel", () => {
    state.mapInteraction.pointerId = null;
    state.mapInteraction.mode = "";
    els.mapCanvas.classList.remove("is-panning");
    clearMapSelection();
  });

  els.mapCanvas.addEventListener("wheel", (event) => {
    if (state.tab !== "map" || !state.mapGraph) return;
    event.preventDefault();
    markMapUserInteraction();
    zoomMap(event.deltaY > 0 ? 0.86 : 1.16);
  }, { passive: false });

  els.mapCanvas.addEventListener("auxclick", (event) => {
    if (state.tab !== "map" || event.button !== 1 || !state.mapGraph) return;
    event.preventDefault();
    fitForceGraph(state.mapGraph, state.mapGraphData, { duration: 280, padding: state.mapMode === "focused" ? 84 : 160 });
    state.mapGraph.resumeAnimation?.();
  });
}
