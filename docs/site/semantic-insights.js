import { state } from "./state.js";
import { escapeHtml, normalize, plainMathTitle } from "./utils.js";

const STOPWORDS = new Set([
  "about", "across", "after", "against", "also", "among", "based", "because", "between", "can", "data",
  "different", "during", "each", "from", "have", "into", "large", "learn", "learning", "method", "methods",
  "model", "models", "more", "most", "using", "with", "without", "paper", "present", "propose", "provide",
  "show", "such", "than", "that", "their", "these", "this", "through", "towards", "training", "which",
]);

function topCounts(records, readValues, limit = 3) {
  const counts = new Map();
  for (const record of records) {
    for (const value of readValues(record)) {
      if (!value) continue;
      counts.set(value, (counts.get(value) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
}

function topKeywords(records, limit = 6) {
  const counts = new Map();
  for (const record of records.slice(0, 160)) {
    const text = `${plainMathTitle(record.title || "")} ${(record.abstract || "").slice(0, 1200)}`.toLowerCase();
    for (const word of text.match(/[a-z][a-z0-9-]{2,}/g) || []) {
      const key = word.replace(/^-+|-+$/g, "");
      if (key.length < 4 || STOPWORDS.has(key) || normalize(key) === normalize(state.query)) continue;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word]) => word);
}

function searchModeLabel() {
  if (state.mapSearchKind === "in-browser") return "in-browser semantic";
  if (state.mapSearchKind === "specter2-query") return "SPECTER2 query";
  if (state.mapSearchKind === "specter2-loading") return "lexical match";
  if (state.mapSearchKind === "keyword-neighbor") return "keyword neighbors";
  return "query-vector";
}

function searchEvidenceText(records) {
  if (state.mapSearchKind === "in-browser") {
    return "Why highlighted: nearest records to the query under the precomputed in-browser embedding index.";
  }
  if (state.mapSearchKind === "specter2-query") {
    return "Why highlighted: nearest records to the embedded query, then filtered by the current map scope.";
  }
  if (state.mapSearchKind === "specter2-loading") {
    return "Why highlighted: title, abstract, tag, and cluster text matches while the SPECTER2 query model warms up.";
  }
  if (state.mapSearchKind === "keyword-neighbor") {
    return "Why highlighted: keyword matches plus their closest mapped neighbors.";
  }
  return `Why highlighted: ${records.length.toLocaleString()} records ranked by the active semantic map signal.`;
}

function topicLens(records) {
  const clusterCounts = topCounts(records, (record) => [record.embeddingClusterId].filter(Boolean), 1);
  const clusterId = clusterCounts[0]?.[0] || "";
  const topic = clusterId ? state.studyFeatures?.topics?.[clusterId] : null;
  const trend = (state.trendData?.trends || []).find((item) => item.id === topic?.nearbyTrendId || item.id === clusterId || item.clusterId === clusterId);
  const representatives = (topic?.representativeRecordIds || [])
    .map((id) => records.find((record) => record.id === id))
    .filter(Boolean)
    .slice(0, 3);
  return { topic, trend, representatives };
}

export function renderSemanticInsightPanel(records, query) {
  const host = document.querySelector("#mapCanvas")?.parentElement;
  if (!host) return;
  let panel = host.querySelector(".semantic-insight");
  if (!query || state.tab !== "map") {
    panel?.remove();
    return;
  }
  if (!panel) {
    panel = document.createElement("aside");
    panel.className = "semantic-insight";
    panel.setAttribute("aria-label", "Semantic search insight");
    host.appendChild(panel);
  }
  const areas = topCounts(records, (record) => record.areaTags || record.categoryTags || []);
  const domains = topCounts(records, (record) => record.domainTags || []);
  const keywords = topKeywords(records);
  const lens = topicLens(records);
  panel.innerHTML = `
    <div class="semantic-insight-head">
      <strong>Topic lens · ${records.length.toLocaleString()} highlighted</strong>
      <span>${escapeHtml(searchModeLabel())}</span>
    </div>
    <div class="semantic-insight-grid">
      <span><em>Area</em><b>${escapeHtml(lens.topic?.dominantArea || areas[0]?.[0] || "Mixed")}</b></span>
      <span><em>Domain</em><b>${escapeHtml(lens.topic?.dominantDomain || domains[0]?.[0] || "General")}</b></span>
      <span><em>Nearby trend</em><b>${escapeHtml(lens.trend?.name || lens.topic?.nearbyTrendId || "Mixed highlighted region")}</b></span>
      <span><em>Search mode</em><b>${escapeHtml(searchModeLabel())}</b></span>
    </div>
    <div class="semantic-insight-keywords">
      ${keywords.map((word) => `<b>${escapeHtml(word)}</b>`).join("") || "<b>title-only</b>"}
    </div>
    <p class="semantic-insight-evidence">${escapeHtml(searchEvidenceText(records))}</p>
    <p class="semantic-insight-scope">Highlighted records are the active search lens. The Trends panel summarizes the broader embedding cluster, so its record counts can be larger.</p>
    <div class="semantic-insight-keywords topic-lens-records">
      ${(lens.representatives.length ? lens.representatives : records.slice(0, 3)).map((record) => `<button type="button" data-record-id="${escapeHtml(record.id)}">${escapeHtml(plainMathTitle(record.title))}</button>`).join("")}
    </div>
  `;
}
