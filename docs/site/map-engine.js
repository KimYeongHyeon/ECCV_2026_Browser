import { els } from "./dom.js";
import { state } from "./state.js";
import {
  colorForValue,
  domainColorValue,
  domainRingColor,
} from "./map-tooltip.js";

let engineDeps = {};

export function configureMapEngine(deps) {
  engineDeps = deps;
}

export function drawForceGraphNode(node, ctx, globalScale, options = {}) {
  const safeScale = Math.max(globalScale || 1, 0.001);
  const mode = options.mode || state.mapMode;
  const selectedId = options.selectedId || state.selectedId;
  const hoverId = options.hoverId ?? state.mapHoverId;
  const color = colorForValue(node.group);
  const isSelected = node.id === selectedId || node.selected;
  const isHover = node.id === hoverId;
  const isAdjacent = node.adjacent;
  const isSearchMatch = node.searchMatch;
  const isSemanticContext = node.semanticContext;
  const isEmphasized = isSelected || isHover || isAdjacent || isSearchMatch;
  const radiusScale = options.radiusScale || 1;
  let radius = isSelected ? 8.2 : isHover ? 6.6 : isSearchMatch ? 5.8 : isAdjacent ? 4.8 : node.depth === 2 ? 3.8 : 3.45;
  radius *= radiusScale;
  const minScreenRadius = options.minScreenRadius ?? (state.mapColor === "area-domain" ? 4.6 : 3.2);
  radius = Math.max(radius, minScreenRadius / safeScale);
  const domainShape = options.domainShape || domainShapeValue(node.record);
  const useDomainShape = (options.showDomainShape ?? state.mapColor === "area-domain") && node.record;
  if (isSearchMatch) {
    ctx.save();
    ctx.lineWidth = Math.max(1.4 / safeScale, 1.2);
    ctx.strokeStyle = "rgba(194,151,63,0.64)";
    ctx.beginPath();
    ctx.arc(node.x, node.y, radius + 7.2, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.restore();
  }
  if (isSelected || isHover || isSearchMatch) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(node.x, node.y, radius + (isSelected ? 9.5 : isSearchMatch ? 7 : 5.6), 0, 2 * Math.PI);
    ctx.fillStyle = isSelected ? "rgba(106,165,147,0.13)" : isSearchMatch ? "rgba(230,200,120,0.24)" : "rgba(255,255,255,0.58)";
    ctx.shadowBlur = isSelected ? 16 : isSearchMatch ? 15 : 11;
    ctx.shadowColor = isSelected ? "rgba(106,165,147,0.22)" : isSearchMatch ? "rgba(194,151,63,0.28)" : "rgba(106,165,147,0.12)";
    ctx.fill();
    ctx.restore();
  }
  drawNodeShape(ctx, node.x, node.y, radius, useDomainShape ? domainShape : "circle");
  ctx.fillStyle = isSearchMatch ? "#e9b949" : color;
  const queryDimmed = state.tab === "map" && Boolean(state.query) && !isSearchMatch && !isSemanticContext && !isSelected && !isHover;
  ctx.globalAlpha = isSearchMatch ? 1 : isEmphasized ? 0.94 : isSemanticContext ? 0.62 : queryDimmed ? 0.24 : mode === "focused" ? 0.72 : 0.66;
  ctx.fill();
  ctx.globalAlpha = 1;
  const showDomainRing = (options.showDomainRing ?? state.mapColor === "area-domain")
    && node.record
    && (
      isSelected
      || isHover
      || isSearchMatch
      || isSemanticContext
      || (mode === "focused" && (isAdjacent || node.depth <= 1))
    );
  if (showDomainRing && !useDomainShape) {
    ctx.save();
    ctx.globalAlpha = isSelected ? 0.86 : isHover ? 0.78 : isSearchMatch ? 0.7 : isSemanticContext ? 0.48 : 0.38;
    ctx.lineWidth = isSelected ? 2.1 : isHover ? 1.65 : isSearchMatch ? 1.4 : mode === "focused" ? 0.9 : 0.65;
    ctx.strokeStyle = domainRingColor(node.record);
    ctx.beginPath();
    ctx.arc(node.x, node.y, radius + (isSelected ? 2.2 : 1.15), 0, 2 * Math.PI);
    ctx.stroke();
    ctx.restore();
  }
  if (useDomainShape) {
    ctx.save();
    ctx.globalAlpha = isSelected ? 0.95 : isHover ? 0.88 : isSearchMatch ? 0.84 : isSemanticContext ? 0.66 : mode === "focused" ? 0.62 : 0.56;
    ctx.lineWidth = Math.max(0.8 / safeScale, isSelected || isHover ? 1.3 : 0.92);
    ctx.strokeStyle = domainRingColor(node.record);
    drawNodeShape(ctx, node.x, node.y, radius + (isSelected ? 2 : 1.1), domainShape);
    ctx.stroke();
    ctx.restore();
  }
  if (isSearchMatch) {
    ctx.lineWidth = isSelected ? 2.2 : 1.4;
    ctx.strokeStyle = "rgba(178,125,22,0.95)";
    ctx.beginPath();
    ctx.arc(node.x, node.y, radius + (isSelected ? 4.4 : 3.4), 0, 2 * Math.PI);
    ctx.stroke();
  }
  if (isEmphasized) {
    ctx.lineWidth = isSelected ? 1.35 : 0.65;
    ctx.strokeStyle = isSelected ? "rgba(79,133,118,0.9)" : "rgba(255,255,255,0.72)";
    drawNodeShape(ctx, node.x, node.y, radius, useDomainShape ? domainShape : "circle");
    ctx.stroke();
  }
  const shouldLabel = (isHover && options.showCanvasHoverLabel)
    || (isSelected && mode === "focused" && !options.hideSelectedLabel)
    || (mode === "focused" && node.depth === 1 && node.focusRank < (options.neighborLabelCount ?? 1) && globalScale > (options.labelScaleThreshold ?? 1.05));
  if (!shouldLabel) return;
  const maxLabelLength = options.maxLabelLength || (mode === "focused" ? 24 : 46);
  const label = node.title.length > maxLabelLength ? `${node.title.slice(0, maxLabelLength - 3)}...` : node.title;
  const fontSize = Math.min(options.maxFontSize || 12, Math.max(options.minFontSize || 8.5, (options.baseFontSize || 10.5) / safeScale));
  ctx.font = `650 ${fontSize}px "Hanken Grotesk", system-ui, sans-serif`;
  const labelOnLeft = mode === "focused" && node.x > 0;
  ctx.textAlign = labelOnLeft ? "right" : "left";
  ctx.textBaseline = "middle";
  const textX = labelOnLeft ? node.x - radius - 5 : node.x + radius + 5;
  const textY = node.y;
  const metrics = ctx.measureText(label);
  ctx.fillStyle = "rgba(255,255,255,0.86)";
  const boxX = labelOnLeft ? textX - metrics.width - 3 : textX - 3;
  ctx.fillRect(boxX, textY - fontSize * 0.7, metrics.width + 6, fontSize * 1.35);
  ctx.fillStyle = "rgba(37,40,43,0.82)";
  ctx.fillText(label, textX, textY);
}

const DOMAIN_SHAPES = ["circle", "square", "diamond", "triangle", "hexagon"];

export function domainShapeValue(record) {
  const domain = domainColorValue(record);
  let hash = 0;
  for (const char of String(domain || "General")) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return DOMAIN_SHAPES[hash % DOMAIN_SHAPES.length];
}

function drawNodeShape(ctx, x, y, radius, shape = "circle") {
  ctx.beginPath();
  if (shape === "circle") {
    ctx.arc(x, y, radius, 0, 2 * Math.PI);
    return;
  }
  if (shape === "square") {
    ctx.rect(x - radius, y - radius, radius * 2, radius * 2);
    return;
  }
  if (shape === "diamond") {
    ctx.moveTo(x, y - radius * 1.22);
    ctx.lineTo(x + radius * 1.22, y);
    ctx.lineTo(x, y + radius * 1.22);
    ctx.lineTo(x - radius * 1.22, y);
    ctx.closePath();
    return;
  }
  if (shape === "triangle") {
    ctx.moveTo(x, y - radius * 1.22);
    ctx.lineTo(x + radius * 1.1, y + radius * 0.78);
    ctx.lineTo(x - radius * 1.1, y + radius * 0.78);
    ctx.closePath();
    return;
  }
  if (shape === "cross") {
    const arm = radius * 0.48;
    ctx.rect(x - arm, y - radius, arm * 2, radius * 2);
    ctx.rect(x - radius, y - arm, radius * 2, arm * 2);
    return;
  }
  const points = shape === "star" ? 10 : shape === "pentagon" ? 5 : 6;
  for (let i = 0; i < points; i += 1) {
    const starScale = shape === "star" && i % 2 ? 0.58 : 1;
    const angle = -Math.PI / 2 + (i / points) * Math.PI * 2;
    const px = x + Math.cos(angle) * radius * 1.14 * starScale;
    const py = y + Math.sin(angle) * radius * 1.14 * starScale;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function linkTouchesSearch(link) {
  const source = typeof link.source === "object" ? link.source : null;
  const target = typeof link.target === "object" ? link.target : null;
  return Boolean(source?.searchMatch || target?.searchMatch || source?.semanticContext || target?.semanticContext);
}

function ensureForceGraph() {
  if (state.mapGraph || typeof window.ForceGraph !== "function") return state.mapGraph;
  els.mapCanvas.innerHTML = "";
  state.mapGraph = window.ForceGraph()(els.mapCanvas)
    .backgroundColor("rgba(0,0,0,0)")
    .nodeId("id")
    .nodeLabel("")
    .nodeVal((node) => node.selected ? 5.2 : node.depth === 1 ? 3.4 : node.depth === 2 ? 2.25 : node.type === "workshop" ? 1.9 : 1.6)
    .nodePointerAreaPaint((node, color, ctx, globalScale) => {
      const base = node.selected ? 13 : node.depth === 1 ? 10 : 8;
      const minScreenRadius = (node.selected ? 11 : 9) / Math.max(globalScale || 1, 0.0001);
      const radius = Math.max(base, minScreenRadius);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI);
      ctx.fill();
    })
    .enableZoomInteraction(false)
    .enablePanInteraction(false)
    .enableNodeDrag(false)
    .linkCurvature(0.045)
    .linkWidth((link) => {
      if (link.selected) return 1.36;
      if (linkTouchesSearch(link)) return 0.92;
      return Math.max(0.58, Number(link.value || 0) * (state.mapMode === "focused" ? 0.86 : 0.76));
    })
    .linkColor((link) => {
      if (link.selected) return "rgba(61,112,98,0.76)";
      if (linkTouchesSearch(link)) return "rgba(61,82,103,0.58)";
      return state.mapMode === "focused" ? "rgba(75,91,108,0.42)" : "rgba(75,91,108,0.48)";
    })
    .linkDirectionalParticles((link) => link.selected && state.mapLive ? 1 : 0)
    .linkDirectionalParticleWidth(0.8)
    .linkDirectionalParticleSpeed(0.0032)
    .d3AlphaMin(0.00035)
    .d3AlphaDecay(0.006)
    .d3VelocityDecay(0.28)
    .nodeCanvasObject((node, ctx, globalScale) => {
      drawForceGraphNode(node, ctx, globalScale);
    });
  applyMapMotionSettings(state.mapGraph);
  return state.mapGraph;
}

function updateMapControlState() {
  if (!els.mapLive) return;
  els.mapLive.classList.toggle("is-active", state.mapLive);
  els.mapLive.setAttribute("aria-pressed", String(state.mapLive));
  els.mapLive.textContent = state.mapLive ? "Live: On" : "Live: Off";
}

export function destroyGraphEngine(except = "") {
  engineDeps.hideGraphTooltip?.(els.mapCanvas);
  if (except !== "force" && state.mapGraph) {
    state.mapGraph.pauseAnimation?.();
    state.mapGraph = null;
    state.mapGraphData = null;
  }
  if (except !== "force") {
    els.mapCanvas.innerHTML = "";
  }
}

function graphDataBounds(graphData) {
  const allNodes = graphData?.nodes || [];
  const focusedNodes = state.mapMode === "focused"
    ? allNodes.filter((node) => node.depth <= 1)
    : allNodes;
  const nodes = focusedNodes.length ? focusedNodes : allNodes;
  if (!nodes.length) return null;
  return nodes.reduce((bounds, node) => ({
    minX: Math.min(bounds.minX, Number(node.x) || 0),
    maxX: Math.max(bounds.maxX, Number(node.x) || 0),
    minY: Math.min(bounds.minY, Number(node.y) || 0),
    maxY: Math.max(bounds.maxY, Number(node.y) || 0),
  }), {
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
  });
}

function defaultMapFitPadding(height) {
  if (state.mapMode === "focused") return 96;
  return Math.min(280, Math.max(210, height * 0.26));
}

export function fitForceGraph(graph = state.mapGraph, graphData = state.mapGraphData, options = {}) {
  if (!graph || !graphData?.nodes?.length) return;
  const bounds = graphDataBounds(graphData);
  if (!bounds) return;
  const width = els.mapCanvas.clientWidth || 840;
  const height = els.mapCanvas.clientHeight || 640;
  const padding = options.padding ?? defaultMapFitPadding(height);
  const duration = options.duration ?? 420;
  const nodeMargin = state.mapMode === "focused" ? 28 : 68;
  const spanX = Math.max(80, bounds.maxX - bounds.minX + nodeMargin * 2);
  const spanY = Math.max(80, bounds.maxY - bounds.minY + nodeMargin * 2);
  const availableWidth = Math.max(80, width - padding * 2);
  const availableHeight = Math.max(80, height - padding * 2);
  const fitScale = Math.min(
    availableWidth / spanX,
    availableHeight / spanY,
  );
  const minZoom = state.mapMode === "focused" ? 0.14 : 0.07;
  const zoom = Math.max(minZoom, Math.min(state.mapMode === "focused" ? 2.8 : 1.12, fitScale));
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  graph.centerAt?.(centerX, centerY, duration);
  graph.zoom?.(zoom, duration);
}

function createAnchorForce(strength) {
  let nodes = [];
  const force = (alpha) => {
    for (const node of nodes) {
      const targetX = Number(node.seedX) || 0;
      const targetY = Number(node.seedY) || 0;
      node.vx += (targetX - node.x) * strength * alpha;
      node.vy += (targetY - node.y) * strength * alpha;
    }
  };
  force.initialize = (nextNodes) => {
    nodes = nextNodes || [];
  };
  return force;
}

export function applyForceAnchors(graph, strength) {
  if (!graph) return;
  graph.d3Force("anchor", createAnchorForce(strength));
}

export function applyMapMotionSettings(graph = state.mapGraph) {
  if (!graph) return;
  const alphaTarget = state.mapLive
    ? state.mapMode === "focused" ? 0.01 : 0.004
    : 0;
  graph
    .autoPauseRedraw(!state.mapLive)
    .cooldownTicks(state.mapLive ? Infinity : 260)
    .cooldownTime(state.mapLive ? Infinity : 18000);
  if (typeof graph.d3AlphaTarget === "function") {
    graph.d3AlphaTarget(alphaTarget);
  }
  updateMapControlState();
}

export function reflowMap(options = {}) {
  const graph = state.mapGraph;
  if (!graph) return;
  applyMapMotionSettings(graph);
  graph.resumeAnimation?.();
  graph.d3ReheatSimulation?.();
  if (options.fit) {
    const scheduledAt = performance.now();
    window.setTimeout(() => {
      if (state.tab === "map" && state.mapGraph === graph && state.mapLastUserInteraction <= scheduledAt) {
        fitForceGraph(graph, state.mapGraphData, { duration: 420, padding: options.padding });
      }
    }, options.delay || 120);
  }
}

export function zoomMap(multiplier) {
  const graph = state.mapGraph;
  if (!graph) return;
  const currentZoom = typeof graph.zoom === "function" ? graph.zoom() : 1;
  graph.zoom(Math.max(0.08, Math.min(18, currentZoom * multiplier)), 220);
  graph.resumeAnimation?.();
}

function normalizedGraphPositionFn(nodes) {
  const xs = nodes.map((n) => n.x).sort((a, b) => a - b);
  const ys = nodes.map((n) => n.y).sort((a, b) => a - b);
  const pct = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0);
  const x1 = pct(xs, 0.02), x2 = pct(xs, 0.98);
  const y1 = pct(ys, 0.02), y2 = pct(ys, 0.98);
  const spanX = (x2 - x1) || 1, spanY = (y2 - y1) || 1;
  const SPAN = 1120, CLAMP = SPAN * 0.66;
  return (node) => ({
    x: Math.max(-CLAMP, Math.min(CLAMP, ((node.x - x1) / spanX - 0.5) * SPAN)),
    y: Math.max(-CLAMP, Math.min(CLAMP, ((node.y - y1) / spanY - 0.5) * SPAN)),
  });
}

export function renderForceGraph(graphData) {
  destroyGraphEngine("force");
  const graph = ensureForceGraph();
  if (!graph) return false;
  engineDeps.ensureMapSelectionBox?.();
  if (state.mapMode !== "focused") {
    const seedPos = normalizedGraphPositionFn(graphData.nodes);
    for (const node of graphData.nodes) {
      const p = seedPos(node);
      node.x = p.x; node.y = p.y;
      node.seedX = p.x; node.seedY = p.y;
      delete node.fx; delete node.fy;
    }
  } else {
    for (const node of graphData.nodes) { delete node.fx; delete node.fy; }
  }
  state.mapGraphData = graphData;
  graph
    .width(els.mapCanvas.clientWidth || 840)
    .height(els.mapCanvas.clientHeight || 640)
    .graphData(graphData);
  applyMapMotionSettings(graph);
  if (state.mapMode === "focused") {
    graph.d3Force("charge")?.strength((node) => node.selected ? -132 : node.depth === 1 ? -86 : node.depth === 2 ? -44 : -30);
    graph.d3Force("link")?.distance((link) => link.selected ? 72 : 86)?.strength?.(0.34);
    applyForceAnchors(graph, 0.018);
    fitForceGraph(graph, graphData, { duration: 360, padding: 98 });
    const scheduledAt = performance.now();
    window.setTimeout(() => {
      if (state.tab === "map" && state.mapMode === "focused" && state.mapGraph === graph && state.mapLastUserInteraction <= scheduledAt) {
        fitForceGraph(graph, graphData, { duration: 560, padding: 96 });
      }
    }, 350);
  } else {
    graph.d3Force("charge")?.strength((node) => node.searchMatch ? -58 : node.depth === 1 ? -46 : -34);
    graph.d3Force("link")?.distance((link) => 46 + (1 - Math.min(1, Number(link.value) || 0)) * 56)?.strength?.(0.13);
    applyForceAnchors(graph, 0.024);
    const firstFitScheduledAt = performance.now();
    window.setTimeout(() => {
      if (state.tab === "map" && state.mapMode === "global" && state.mapGraph === graph && state.mapLastUserInteraction <= firstFitScheduledAt) {
        fitForceGraph(graph, graphData, { duration: 520 });
      }
    }, 220);
    const secondFitScheduledAt = performance.now();
    window.setTimeout(() => {
      if (state.tab === "map" && state.mapMode === "global" && state.mapGraph === graph && state.mapLastUserInteraction <= secondFitScheduledAt) {
        fitForceGraph(graph, graphData, { duration: 520 });
      }
    }, 850);
    const finalFitScheduledAt = performance.now();
    window.setTimeout(() => {
      if (state.tab === "map" && state.mapMode === "global" && state.mapGraph === graph && state.mapLastUserInteraction <= finalFitScheduledAt) {
        fitForceGraph(graph, graphData, { duration: 560 });
      }
    }, 1700);
  }
  reflowMap();
  return true;
}
