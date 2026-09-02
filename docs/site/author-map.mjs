import { buildAuthorNetworkFromAnalytics } from "./people-analytics.mjs";
import { researchConceptTags } from "./research-concepts.mjs";
import { colorForValue } from "./map-tooltip.js";
import { escapeHtml, plainMathTitle } from "./utils.js";

const authorMapState = {
  scope: "all",
  query: "",
  componentFloor: 0,
  islandLimit: 6,
  selectedId: "",
  hoverId: "",
  records: null,
  analysisArtifact: null,
  cache: new Map(),
  graph: null,
  graphTarget: null,
  renderToken: 0,
};

export function clearAuthorMapCache() {
  authorMapState.cache.clear();
}

export function focusAuthorMapTopic(topicLabel, scope = "") {
  authorMapState.query = String(topicLabel || "");
  if (["all", "main", "workshop"].includes(scope)) authorMapState.scope = scope;
  authorMapState.selectedId = "";
}

export function resetAuthorMapFocus() {
  authorMapState.scope = "all";
  authorMapState.query = "";
  authorMapState.selectedId = "";
}

function scopeRecords(records, scope) {
  if (scope === "workshop") return records.filter((record) => record.type === "workshop");
  if (scope === "main") return records.filter((record) => record.type === "paper" || record.type === "poster");
  return records;
}

function recordById(records) {
  return new Map(records.map((record) => [record.id, record]));
}

function searchText(node) {
  return [node.title, node.group, ...(node.topics || []).map((topic) => topic.label)].join(" ").toLocaleLowerCase();
}

function renderTopicLegend(nodes) {
  const counts = new Map();
  nodes.forEach((node) => counts.set(node.group, (counts.get(node.group) || 0) + 1));
  const topics = [...counts.entries()].sort((left, right) => (right[1] - left[1]) || left[0].localeCompare(right[0])).slice(0, 6);
  return `<div class="author-map-reading-key" aria-label="Author map topic colour key"><strong>Topic colours</strong><small>Primary reviewed Core concept; this is an authorship view, not corpus prevalence.</small>${topics.map(([topic, count]) => `<span><i style="--topic-color:${colorForValue(topic)}"></i>${escapeHtml(topic)} <em>${Number(count).toLocaleString()}</em></span>`).join("")}</div>`;
}

function linkEndpointId(endpoint) {
  return typeof endpoint === "object" ? endpoint?.id : endpoint;
}

export function filterAuthorGraph(network, query = "") {
  const normalizedQuery = String(query || "").trim().toLocaleLowerCase();
  if (!normalizedQuery) return network;
  const matching = network.nodes.filter((node) => searchText(node).includes(normalizedQuery));
  const visibleIds = new Set(matching.map((node) => node.id));
  matching.forEach((node) => (network.neighborsById.get(node.id) || []).forEach((neighbor) => visibleIds.add(neighbor.id)));
  const nodes = network.nodes.filter((node) => visibleIds.has(node.id));
  const links = network.links.filter((link) => (
    visibleIds.has(linkEndpointId(link.source)) && visibleIds.has(linkEndpointId(link.target))
  ));
  return {
    ...network,
    summary: {
      ...network.summary,
      authorCount: nodes.length,
      linkCount: links.length,
    },
    nodes,
    links,
  };
}

function filteredGraph(network) {
  return filterAuthorGraph(network, authorMapState.query);
}

function activeIslandFloor(network) {
  if (authorMapState.query) return 2;
  if (authorMapState.componentFloor) return authorMapState.componentFloor;
  return network.summary.authorCount <= 400 ? 3 : 8;
}

export function buildAuthorMapComponents(network) {
  const nodeById = new Map(network.nodes.map((node) => [node.id, node]));
  const neighbors = new Map(network.nodes.map((node) => [node.id, new Set()]));
  for (const link of network.links) {
    const source = linkEndpointId(link.source);
    const target = linkEndpointId(link.target);
    if (!nodeById.has(source) || !nodeById.has(target)) continue;
    neighbors.get(source).add(target);
    neighbors.get(target).add(source);
  }
  const visited = new Set();
  const components = [];
  for (const node of network.nodes) {
    if (visited.has(node.id)) continue;
    const stack = [node.id];
    const nodeIds = [];
    visited.add(node.id);
    while (stack.length) {
      const current = stack.pop();
      nodeIds.push(current);
      for (const neighborId of neighbors.get(current) || []) {
        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          stack.push(neighborId);
        }
      }
    }
    const idSet = new Set(nodeIds);
    const links = network.links.filter((link) => idSet.has(linkEndpointId(link.source)) && idSet.has(linkEndpointId(link.target)));
    components.push({
      id: nodeIds.slice().sort().join("|"),
      nodeIds,
      linkCount: links.length,
      workWeight: links.reduce((total, link) => total + Number(link.value || 0), 0),
    });
  }
  return components.sort((left, right) => (
    (right.nodeIds.length - left.nodeIds.length)
    || (right.workWeight - left.workWeight)
    || left.id.localeCompare(right.id)
  ));
}

export function selectAuthorMapIslands(network, minimumMembers = 8) {
  const components = buildAuthorMapComponents(network);
  const selectedComponents = components.filter((component) => component.nodeIds.length >= minimumMembers);
  const selectedIds = new Set(selectedComponents.flatMap((component) => component.nodeIds));
  const nodes = network.nodes.filter((node) => selectedIds.has(node.id));
  const links = network.links.filter((link) => selectedIds.has(linkEndpointId(link.source)) && selectedIds.has(linkEndpointId(link.target)));
  return {
    ...network,
    nodes,
    links,
    components: selectedComponents,
    summary: {
      ...network.summary,
      authorCount: nodes.length,
      linkCount: links.length,
      islandCount: selectedComponents.length,
      hiddenAuthorCount: network.nodes.length - nodes.length,
      minimumMembers,
    },
  };
}

function limitAuthorMapIslands(network, maximumIslands = 0) {
  const components = maximumIslands ? network.components.slice(0, maximumIslands) : network.components;
  const visibleIds = new Set(components.flatMap((component) => component.nodeIds));
  const nodes = network.nodes.filter((node) => visibleIds.has(node.id));
  const links = network.links.filter((link) => visibleIds.has(linkEndpointId(link.source)) && visibleIds.has(linkEndpointId(link.target)));
  return {
    ...network,
    nodes,
    links,
    components,
    summary: {
      ...network.summary,
      authorCount: nodes.length,
      linkCount: links.length,
      islandCount: components.length,
      availableIslandCount: network.components.length,
      mappedAuthorCount: network.summary.authorCount,
      hiddenAuthorCount: network.summary.hiddenAuthorCount + (network.nodes.length - nodes.length),
    },
  };
}

function stableOffset(value, seed) {
  let hash = seed;
  for (const character of String(value || "")) hash = ((hash << 5) - hash) + character.charCodeAt(0);
  return ((hash >>> 0) % 1000) / 1000;
}

function islandAnchor(index, count, width, height) {
  const columns = Math.max(1, Math.ceil(Math.sqrt(Math.max(1, count) * (width / Math.max(height, 1)))));
  const rows = Math.max(1, Math.ceil(count / columns));
  const column = index % columns;
  const row = Math.floor(index / columns);
  return {
    x: ((column + 0.5) / columns - 0.5) * width * 0.82,
    y: ((row + 0.5) / rows - 0.5) * height * 0.78,
    cellWidth: (width * 0.82) / columns,
    cellHeight: (height * 0.78) / rows,
  };
}

function applyIslandLayout(network, width, height) {
  const componentByNodeId = new Map();
  (network.components || []).forEach((component, index) => {
    const anchor = islandAnchor(index, network.components.length, width, height);
    component.nodeIds.forEach((id, memberIndex) => componentByNodeId.set(id, {
      ...anchor,
      size: component.nodeIds.length,
      id: component.id,
      linkCount: component.linkCount,
      label: network.components.length <= 6 && memberIndex === 0,
    }));
  });
  network.nodes.forEach((node) => {
    const component = componentByNodeId.get(node.id) || { x: 0, y: 0, size: 1, id: node.id, cellWidth: width, cellHeight: height };
    const naturalSpread = 30 + Math.sqrt(component.size) * 15;
    const boundedSpread = Math.min(component.cellWidth * 0.68, component.cellHeight * 0.68);
    const spread = Math.min(Math.max(42, boundedSpread), naturalSpread);
    node.islandId = component.id;
    node.islandX = component.x;
    node.islandY = component.y;
    node.islandSize = component.size;
    node.islandLinkCount = component.linkCount;
    node.islandLabel = component.label;
    node.islandLabelY = component.y - (component.cellHeight * 0.39);
    node.islandSpread = spread;
    node.x = component.x + (stableOffset(node.id, 17) - 0.5) * spread;
    node.y = component.y + (stableOffset(node.id, 43) - 0.5) * spread;
    node.vx = 0;
    node.vy = 0;
  });
}

function createIslandAnchorForce() {
  let nodes = [];
  const force = (alpha) => {
    for (const node of nodes) {
      node.vx += ((node.islandX || 0) - (node.x || 0)) * 0.16 * alpha;
      node.vy += ((node.islandY || 0) - (node.y || 0)) * 0.16 * alpha;
    }
  };
  force.initialize = (incomingNodes) => {
    nodes = incomingNodes || [];
  };
  return force;
}

function createIslandSeparationForce() {
  let islands = [];
  const force = (alpha) => {
    for (const nodes of islands) {
      for (let left = 0; left < nodes.length; left += 1) {
        for (let right = left + 1; right < nodes.length; right += 1) {
          const first = nodes[left];
          const second = nodes[right];
          const dx = (second.x || 0) - (first.x || 0);
          const dy = (second.y || 0) - (first.y || 0);
          const distance = Math.hypot(dx, dy) || 0.001;
          const minimum = 15 + Math.sqrt((first.paperCount || 1) + (second.paperCount || 1)) * 2.4;
          if (distance >= minimum) continue;
          const push = ((minimum - distance) / distance) * 0.09 * alpha;
          const shiftX = dx * push;
          const shiftY = dy * push;
          first.vx -= shiftX;
          first.vy -= shiftY;
          second.vx += shiftX;
          second.vy += shiftY;
        }
      }
    }
  };
  force.initialize = (nodes) => {
    const byIsland = new Map();
    for (const node of nodes || []) {
      const island = byIsland.get(node.islandId) || [];
      island.push(node);
      byIsland.set(node.islandId, island);
    }
    islands = [...byIsland.values()];
  };
  return force;
}

function selectedLink(link) {
  const source = linkEndpointId(link.source);
  const target = linkEndpointId(link.target);
  return source === authorMapState.selectedId || target === authorMapState.selectedId;
}

function nodeRadius(node, scale) {
  return Math.max(3.8 / Math.max(scale, 0.001), Math.min(11, 2.8 + Math.sqrt(node.paperCount || 1) * 1.7));
}

function drawAuthorNode(node, context, scale) {
  const radius = nodeRadius(node, scale);
  const selected = node.id === authorMapState.selectedId;
  const hovered = node.id === authorMapState.hoverId;
  const adjacent = selected && node.adjacent;
  if (selected || hovered) {
    context.save();
    context.beginPath();
    context.arc(node.x, node.y, radius + 5.5, 0, Math.PI * 2);
    context.fillStyle = selected ? "rgba(106,165,147,0.18)" : "rgba(255,255,255,0.78)";
    context.fill();
    context.restore();
  }
  context.beginPath();
  context.arc(node.x, node.y, radius, 0, Math.PI * 2);
  context.fillStyle = colorForValue(node.group);
  context.globalAlpha = selected || hovered ? 1 : adjacent ? 0.86 : 0.68;
  context.fill();
  context.globalAlpha = 1;
  if (selected || hovered) {
    context.lineWidth = selected ? 1.7 : 1.1;
    context.strokeStyle = selected ? "rgba(79,133,118,0.95)" : "rgba(255,255,255,0.94)";
    context.stroke();
  }
  if (!selected && !hovered) return;
  const maxLength = 34;
  const label = node.title.length > maxLength ? `${node.title.slice(0, maxLength - 1)}…` : node.title;
  const fontSize = Math.max(9, Math.min(13, 11 / Math.max(scale, 0.7)));
  context.font = `700 ${fontSize}px "Hanken Grotesk", system-ui, sans-serif`;
  context.textBaseline = "middle";
  context.textAlign = "left";
  const labelX = node.x + radius + 5;
  const width = context.measureText(label).width;
  context.fillStyle = "rgba(255,255,255,0.88)";
  context.fillRect(labelX - 3, node.y - fontSize * 0.72, width + 6, fontSize * 1.42);
  context.fillStyle = "rgba(37,40,43,0.92)";
  context.fillText(label, labelX, node.y);
}

function drawIslandLabel(node, context, scale) {
  if (!node.islandLabel || scale < 0.45) return;
  const fontSize = Math.max(8, Math.min(11, 9 / Math.max(scale, 0.7)));
  const label = `${Number(node.islandSize).toLocaleString()} authors · ${Number(node.islandLinkCount).toLocaleString()} links`;
  context.save();
  context.font = `800 ${fontSize}px "Hanken Grotesk", system-ui, sans-serif`;
  context.textAlign = "center";
  context.textBaseline = "bottom";
  context.fillStyle = "rgba(72, 78, 84, 0.78)";
  context.fillText(label, node.islandX, node.islandLabelY ?? (node.islandY - (node.islandSpread || 42)));
  context.restore();
}

function renderDetail(target, network, records, onOpenRecord) {
  const node = network.nodes.find((item) => item.id === authorMapState.selectedId);
  if (!node) {
    const noRecurringIsland = !network.nodes.length;
    target.innerHTML = `
      <div class="author-map-empty">
        <p class="eyebrow">Coauthorship network</p>
        <h3>${noRecurringIsland ? "No recurring island in this selection" : "Choose an author"}</h3>
        <p>${noRecurringIsland ? "The selected concept can still have resolved authors and exact works on Topics; this map only shows recurring coauthorship components." : "Nodes represent conservatively resolved authors with at least two unique accepted works. Links represent coauthored works."}</p>
      </div>
    `;
    return;
  }
  const nodeById = new Map(network.nodes.map((item) => [item.id, item]));
  const collaborators = (network.neighborsById.get(node.id) || [])
    .map((neighbor) => ({ ...neighbor, node: nodeById.get(neighbor.id) }))
    .filter((neighbor) => neighbor.node)
    .slice(0, 10);
  const recordsById = recordById(records);
  const papers = node.recordIds.map((id) => recordsById.get(id)).filter(Boolean).slice(0, 10);
  target.innerHTML = `
    <article class="author-map-detail-card">
      <p class="eyebrow">Resolved author</p>
      <h3>${escapeHtml(node.title)}</h3>
      <p class="author-map-detail-summary"><b>${Number(node.paperCount).toLocaleString()}</b> unique accepted works</p>
      <div class="author-map-topic-list">
        ${(node.topics || []).slice(0, 1).map((topic) => `<span><b>${escapeHtml(topic.label)}</b><em>${Number(topic.count).toLocaleString()}</em></span>`).join("") || "<small>No reviewed Core concept.</small>"}
      </div>
      <section>
        <h4>Frequent collaborators</h4>
        <div class="author-map-collaborators">
          ${collaborators.map((collaborator) => `
            <button type="button" data-author-id="${escapeHtml(collaborator.id)}">
              <span><i style="background:${escapeHtml(colorForValue(collaborator.node.group))}"></i>${escapeHtml(collaborator.node.title)}</span>
              <em>${Number(collaborator.workCount).toLocaleString()} works</em>
            </button>
          `).join("") || "<small>No mapped recurring collaborators.</small>"}
        </div>
      </section>
      <section>
        <h4>Accepted works</h4>
        <div class="author-map-paper-list">
          ${papers.map((record) => `
            <button type="button" data-record-id="${escapeHtml(record.id)}">
              <strong>${escapeHtml(plainMathTitle(record.title))}</strong>
              <small>${escapeHtml(researchConceptTags(record, "detail").join(" · ") || "No reviewed research concepts.")}</small>
            </button>
          `).join("") || "<small>No linked work in the loaded index.</small>"}
        </div>
      </section>
    </article>
  `;
  target.querySelectorAll("[data-author-id]").forEach((button) => button.addEventListener("click", () => selectAuthor(button.dataset.authorId, network, records, onOpenRecord)));
  target.querySelectorAll("[data-record-id]").forEach((button) => button.addEventListener("click", () => onOpenRecord(button.dataset.recordId)));
}

function selectAuthor(id, network, records, onOpenRecord) {
  authorMapState.selectedId = id;
  const selected = network.nodes.find((node) => node.id === id);
  network.nodes.forEach((node) => {
    node.adjacent = Boolean(selected && (network.neighborsById.get(selected.id) || []).some((neighbor) => neighbor.id === node.id));
  });
  authorMapState.graph?.refresh?.();
  renderDetail(document.querySelector("#authorMapDetail"), network, records, onOpenRecord);
  if (selected?.x !== undefined && selected?.y !== undefined) {
    authorMapState.graph?.centerAt?.(selected.x, selected.y, 360);
    authorMapState.graph?.zoom?.(2.6, 360);
  }
}

function mountGraph(target, network, records, onOpenRecord) {
  const canvas = target.querySelector("#authorMapCanvas");
  if (!canvas) return;
  if (typeof window.ForceGraph !== "function") {
    canvas.innerHTML = `<div class="empty-state"><strong>Author graph unavailable</strong><span>The graph library did not load.</span></div>`;
    return;
  }
  if (authorMapState.graphTarget !== canvas) {
    authorMapState.graph?.pauseAnimation?.();
    canvas.innerHTML = "";
    authorMapState.graphTarget = canvas;
    authorMapState.graph = window.ForceGraph()(canvas)
      .backgroundColor("rgba(0,0,0,0)")
      .nodeId("id")
      .nodeLabel("")
      .nodeRelSize(1)
      .nodeVal((node) => node.paperCount)
      .nodeCanvasObject((node, context, scale) => {
        drawIslandLabel(node, context, scale);
        drawAuthorNode(node, context, scale);
      })
      .nodePointerAreaPaint((node, color, context, scale) => {
        context.fillStyle = color;
        context.beginPath();
        context.arc(node.x, node.y, nodeRadius(node, scale) + 4, 0, Math.PI * 2);
        context.fill();
      })
      .linkWidth((link) => selectedLink(link) ? 1.65 : Math.min(1.2, 0.32 + Math.log2(Number(link.value || 1)) * 0.34))
      .linkColor((link) => selectedLink(link) ? "rgba(79,133,118,0.7)" : "rgba(113,119,125,0.26)")
      .linkDirectionalParticles((link) => selectedLink(link) ? 1 : 0)
      .linkDirectionalParticleWidth(0.75)
      .linkDirectionalParticleSpeed(0.004)
      .d3AlphaDecay(0.018)
      .d3VelocityDecay(0.32)
      .onNodeHover((node) => {
        authorMapState.hoverId = node?.id || "";
        canvas.style.cursor = node ? "pointer" : "default";
        authorMapState.graph?.refresh?.();
      })
      .onNodeClick((node) => selectAuthor(node.id, network, records, onOpenRecord));
    authorMapState.graph.d3Force("charge")?.strength(-24);
    authorMapState.graph.d3Force("link")?.distance(42);
    authorMapState.graph.d3Force("island-anchor", createIslandAnchorForce());
    authorMapState.graph.d3Force("island-separation", createIslandSeparationForce());
  }
  const width = canvas.clientWidth || 840;
  const height = canvas.clientHeight || 680;
  applyIslandLayout(network, width, height);
  authorMapState.graph.width(width).height(height).graphData({ nodes: network.nodes, links: network.links });
  authorMapState.graph.d3ReheatSimulation?.();
}

function renderAuthorMapStage(visible) {
  if (visible.nodes.length) return '<div id="authorMapCanvas" aria-label="Separated author coauthorship islands"></div>';
  return '<div class="author-map-graph-empty"><strong>No recurring coauthor island for this selection</strong><span>The selected concept has resolved authors, but none meet the recurring coauthorship threshold in this map. Their exact work authors remain listed on Topics.</span></div>';
}

function mountAuthorMap(target, network, records, onOpenRecord) {
  const filtered = filteredGraph(network);
  const minimumMembers = activeIslandFloor(filtered);
  const eligible = selectAuthorMapIslands(filtered, minimumMembers);
  const visible = limitAuthorMapIslands(eligible, authorMapState.query ? 0 : authorMapState.islandLimit);
  const mappedCandidateCount = Number(network.summary.authorCount || 0);
  const eligibleAuthorCount = Number(network.summary.eligibleAuthorCount || mappedCandidateCount);
  const cappedOutAuthorCount = Math.max(0, eligibleAuthorCount - mappedCandidateCount);
  const authorCap = Number(network.summary.authorCap || mappedCandidateCount);
  if (authorMapState.selectedId && !visible.nodes.some((node) => node.id === authorMapState.selectedId)) authorMapState.selectedId = "";
  target.innerHTML = `
    <section class="author-map-dashboard">
      <header class="author-map-head">
        <div>
          <p class="eyebrow">Authorship intelligence</p>
          <h2>Author map</h2>
        </div>
        <div class="author-map-controls">
          <label><span>Scope</span><select id="authorMapScope"><option value="all">All accepted works</option><option value="main">Main conference</option><option value="workshop">Workshops</option></select></label>
          <label><span>${authorMapState.query ? "Display (search context)" : "Display"}</span><select id="authorMapDensity"><option value="0">Adaptive islands</option><option value="8">Large islands (8+)</option><option value="5">Medium islands (5+)</option><option value="3">Small islands (3+)</option><option value="2">All linked authors (2+)</option></select></label>
          <label><span>Overview</span><select id="authorMapOverview"${authorMapState.query ? " disabled" : ""}><option value="6">Key 6 islands</option><option value="0">All eligible islands</option></select></label>
          <label><span>Find</span><input id="authorMapSearch" type="search" value="${escapeHtml(authorMapState.query)}" placeholder="Author or topic" autocomplete="off" /></label>
        </div>
      </header>
      <div class="author-map-body">
        <div class="author-map-stage">${renderAuthorMapStage(visible)}<p>${visible.nodes.length ? "Click an author to inspect their topics, works, and frequent collaborators. Use the overview control to reveal every eligible island." : "Try a broader topic or switch to all eligible islands."}</p></div>
        <aside id="authorMapDetail" class="author-map-detail" aria-label="Selected author"></aside>
      </div>
      <div class="author-map-method-note" role="note"><strong>Reading the graph</strong><span>Each visible island is an independent coauthorship component, deliberately anchored apart so groups do not overlap. This overview shows ${Number(visible.summary.islandCount).toLocaleString()} of ${Number(visible.summary.availableIslandCount || 0).toLocaleString()} eligible islands among the ${Number(mappedCandidateCount).toLocaleString()} mapped candidates. Node size = work count; colour = primary reviewed Core concept; link width = repeated coauthorship strength. ${Number(visible.summary.hiddenAuthorCount || 0).toLocaleString()} mapped authors are outside this view or the current ${Number(visible.summary.minimumMembers).toLocaleString()}-author island threshold. The graph intentionally caps candidates at ${Number(authorCap).toLocaleString()} of ${Number(eligibleAuthorCount).toLocaleString()} eligible recurring authors; ${Number(cappedOutAuthorCount).toLocaleString()} eligible authors are not included in its node or island counts. Node relationships represent recurring coauthorship, not a research-lab proxy. They are not verified institutional affiliations.${authorMapState.query ? ` Search currently shows ${Number(visible.nodes.length).toLocaleString()} topic matches plus their recurring mapped collaborators; adjacent nodes are exploration context, not additional topic matches. Same-name identities stay separate without email or shared-coauthor evidence.` : ""}</span></div>
      ${renderTopicLegend(visible.nodes)}
      <section class="author-map-insights" aria-label="Conference-wide author insights">
        <div class="author-map-insights-head"><p class="eyebrow">Conference overview</p><span>Computed from ${Number(network.summary.uniqueWorks).toLocaleString()} unique accepted works in this scope</span></div>
        <div class="author-map-insight-grid">
          ${network.insights.prolificAuthor ? `<button type="button" data-insight-author-id="${escapeHtml(network.insights.prolificAuthor.id)}"><em>Most prolific mapped author</em><strong>${escapeHtml(network.insights.prolificAuthor.name)}</strong><span>${Number(network.insights.prolificAuthor.workCount).toLocaleString()} works · ${escapeHtml(network.insights.prolificAuthor.topic)}</span></button>` : ""}
          ${network.insights.strongestPair ? `<article><em>Strongest recurring collaboration</em><strong>${escapeHtml(network.insights.strongestPair.source)} × ${escapeHtml(network.insights.strongestPair.target)}</strong><span>${Number(network.insights.strongestPair.workCount).toLocaleString()} shared accepted works</span></article>` : ""}
          ${network.insights.connector ? `<button type="button" data-insight-author-id="${escapeHtml(network.insights.connector.id)}"><em>Broadest mapped connector</em><strong>${escapeHtml(network.insights.connector.name)}</strong><span>${Number(network.insights.connector.collaboratorCount).toLocaleString()} direct mapped collaborators · ${Number(network.insights.connector.workCount).toLocaleString()} works</span></button>` : ""}
          <article><em>Leading mapped topic</em><strong>${escapeHtml(network.insights.leadingTopic.label)}</strong><span>Primary topic for ${Number(network.insights.leadingTopic.authorCount).toLocaleString()} mapped authors</span></article>
        </div>
      </section>
      <div class="selection-stat-grid author-map-stat-grid">
        <span><strong>${Number(visible.summary.authorCount).toLocaleString()}</strong><small>authors shown</small></span>
        <span><strong>${Number(visible.summary.islandCount).toLocaleString()} / ${Number(visible.summary.availableIslandCount || 0).toLocaleString()}</strong><small>shown / mapped islands</small></span>
        <span><strong>${Number(visible.summary.linkCount).toLocaleString()}</strong><small>coauthor links</small></span>
        <span><strong>${Number(visible.summary.hiddenAuthorCount || 0).toLocaleString()}</strong><small>outside this mapped view</small></span>
      </div>
    </section>
  `;
  target.querySelector("#authorMapScope").value = authorMapState.scope;
  target.querySelector("#authorMapDensity").value = String(authorMapState.componentFloor);
  target.querySelector("#authorMapOverview").value = String(authorMapState.query ? 0 : authorMapState.islandLimit);
  target.querySelector("#authorMapScope").addEventListener("change", (event) => {
    authorMapState.scope = event.target.value;
    authorMapState.selectedId = "";
    void renderAuthorMap(target, authorMapState.records, authorMapState.analysisArtifact, onOpenRecord);
  });
  target.querySelector("#authorMapDensity").addEventListener("change", (event) => {
    authorMapState.componentFloor = Number(event.target.value) || 0;
    authorMapState.selectedId = "";
    mountAuthorMap(target, network, records, onOpenRecord);
  });
  target.querySelector("#authorMapOverview").addEventListener("change", (event) => {
    authorMapState.islandLimit = Number(event.target.value) || 0;
    authorMapState.selectedId = "";
    mountAuthorMap(target, network, records, onOpenRecord);
  });
  target.querySelector("#authorMapSearch").addEventListener("input", (event) => {
    authorMapState.query = event.target.value;
    authorMapState.selectedId = "";
    mountAuthorMap(target, network, records, onOpenRecord);
    target.querySelector("#authorMapSearch")?.focus();
  });
  if (visible.nodes.length) mountGraph(target, visible, records, onOpenRecord);
  renderDetail(target.querySelector("#authorMapDetail"), visible, records, onOpenRecord);
  target.querySelectorAll("[data-insight-author-id]").forEach((button) => button.addEventListener("click", () => {
    const selected = network.nodes.find((node) => node.id === button.dataset.insightAuthorId);
    authorMapState.query = selected?.title || "";
    authorMapState.componentFloor = 2;
    authorMapState.islandLimit = 0;
    mountAuthorMap(target, network, records, onOpenRecord);
    const focused = limitAuthorMapIslands(selectAuthorMapIslands(filteredGraph(network), 2), 0);
    if (focused.nodes.some((node) => node.id === button.dataset.insightAuthorId)) {
      selectAuthor(button.dataset.insightAuthorId, focused, records, onOpenRecord);
    }
  }));
}

export async function renderAuthorMap(target, records, analysisArtifact, onOpenRecord) {
  if (!target || !records) return;
  if (authorMapState.records !== records || authorMapState.analysisArtifact !== analysisArtifact) {
    authorMapState.records = records;
    authorMapState.analysisArtifact = analysisArtifact;
    authorMapState.cache.clear();
  }
  const token = ++authorMapState.renderToken;
  let network = authorMapState.cache.get(authorMapState.scope);
  if (!network) {
    const analytics = analysisArtifact?.scopes?.[authorMapState.scope];
    if (!analytics) {
      target.innerHTML = `<div class="empty-state"><strong>Finalized author map pending</strong><span>This graph activates after the complete reviewed-concept artifact and its matching author/topic analysis artifact are published.</span></div>`;
      return;
    }
    network = buildAuthorNetworkFromAnalytics(analytics);
    authorMapState.cache.set(authorMapState.scope, network);
  }
  if (token !== authorMapState.renderToken || !target.isConnected) return;
  mountAuthorMap(target, network, scopeRecords(records, authorMapState.scope), onOpenRecord);
}

export function destroyAuthorMap() {
  authorMapState.graph?.pauseAnimation?.();
  authorMapState.graph = null;
  authorMapState.graphTarget = null;
}
