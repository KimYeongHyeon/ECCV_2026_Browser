import { PAGE_SIZE } from "./config.js";
import { els } from "./dom.js";
import {
  MATCH_FIELD_LABEL,
  assetLabel,
  categoryTags,
  matchedField,
  presentationBadges,
  recordHaystack,
  resultDetails,
  statusLabel,
  typeLabel,
} from "./records.js";
import { researchConceptTags } from "./research-concepts.mjs";
import { matchesLandscapeCluster } from "./map-landscape.mjs";
import { state } from "./state.js";
import { containsNormalizedPhrase, escapeHtml, normalize, plainMathTitle, queueMathTypeset } from "./utils.js";
import { renderViewer, uniqueChipValues } from "./viewer.js";
import {
  mapColorValue,
  mapSemanticSearchIds,
} from "./map-core.js";
import { matchesMapCoreConcept } from "./research-concepts.mjs";
import { browseRecordColor } from "./map-tooltip.js";

let browseDeps = {};
let searchWorkerIndexed = false;

export function configureBrowse(deps) {
  browseDeps = deps;
}

export function displayRecords() {
  return (state.data?.records || []).filter((record) => record.type !== "poster");
}

function recordsForCurrentTab() {
  return state.tab === "map"
    ? displayRecords()
    : displayRecords().filter((record) => record.type === state.tab);
}

export function findDisplayRecord(id) {
  return displayRecords().find((record) => record.id === id);
}

function ensureSearchWorker() {
  if (state.searchWorker || typeof Worker !== "function") return state.searchWorker;
  try {
    state.searchWorker = new Worker(new URL("./search-worker.js", import.meta.url), { type: "module" });
    state.searchWorker.addEventListener("message", (event) => {
      if (event.data?.type === "ready") {
        searchWorkerIndexed = true;
        return;
      }
      const { requestId, query, ids } = event.data || {};
      if (requestId !== state.searchWorkerRequestId) return;
      state.searchWorkerQuery = query || "";
      state.searchWorkerIds = new Set(ids || []);
      state.searchWorkerPending = false;
      browseDeps.renderAfterWorkerSearch?.();
    });
  } catch {
    state.searchWorker = null;
  }
  return state.searchWorker;
}

export function refreshSearchWorkerIndex() {
  const worker = ensureSearchWorker();
  if (!worker) return;
  searchWorkerIndexed = false;
  const records = displayRecords().map((record) => ({
    id: record.id,
    title: record.title || "",
    haystack: recordHaystack(record),
  }));
  worker.postMessage({ type: "index", records });
}

export function queueWorkerSearch() {
  const query = normalize(state.query);
  state.searchWorkerQuery = "";
  state.searchWorkerIds = null;
  state.searchWorkerPending = false;
  if (!query) return;
  const worker = ensureSearchWorker();
  if (!worker) return;
  if (!searchWorkerIndexed) refreshSearchWorkerIndex();
  const requestId = state.searchWorkerRequestId + 1;
  state.searchWorkerRequestId = requestId;
  state.searchWorkerPending = true;
  const candidateIds = recordsForCurrentTab()
    .filter((record) => passesActiveFilters(record, true))
    .map((record) => record.id);
  worker.postMessage({ type: "search", requestId, query, candidateIds });
}

function passesActiveFilters(record, ignoreMapColorFilter) {
  if (state.category !== "all" && !categoryTags(record).includes(state.category)) return false;
  if (state.group !== "all" && record.group !== state.group) return false;
  if (state.presentation !== "all" && !(record.presentationLabels || []).includes(state.presentation)) return false;
  if (state.tab === "map" && !matchesMapCoreConcept(record, state.mapCoreConceptFilter)) return false;
  if (!ignoreMapColorFilter && state.tab === "map" && state.mapFilterValue && mapColorValue(record) !== state.mapFilterValue) return false;
  if (state.tab === "map" && !matchesLandscapeCluster(record, state.mapLandscapeFilterId)) return false;
  return true;
}

export function getFilteredRecords(options = {}) {
  const query = normalize(state.query);
  const ignoreMapFilter = Boolean(options.ignoreMapFilter);
  const filtered = recordsForCurrentTab().filter((record) => passesActiveFilters(record, ignoreMapFilter));
  if (!query) {
    state.mapSearchSeedIds = new Set();
    state.mapSearchSemanticIds = new Set();
    state.mapSearchKind = "";
    state.mapSearchTopScore = 0;
    state.mapSearchPending = false;
    state.mapSearchMessage = "";
    return filtered;
  }
  const semanticIds = mapSemanticSearchIds(query, filtered);
  if (semanticIds) return filtered.filter((record) => semanticIds.has(record.id));
  if (state.searchWorkerQuery === query && state.searchWorkerIds) {
    return filtered.filter((record) => state.searchWorkerIds.has(record.id));
  }
  return filtered.filter((record) => containsNormalizedPhrase(recordHaystack(record), query));
}

export function updateHeader() {
  const records = displayRecords();
  const papers = records.filter((record) => record.type === "paper");
  const workshops = records.filter((record) => record.type === "workshop");
  const areaGroups = new Set(records.map((record) => record.clusterLabel || record.clusterId).filter(Boolean)).size;
  const mapClusters = Math.max(
    0,
    ...(state.mapData?.embeddingClusterLevels || []).map((level) => (level.clusters || []).length),
  );
  els.headerStats.innerHTML = [
    ["records", papers.length + workshops.length],
    ["area groups", areaGroups],
    ["map clusters", mapClusters],
    ["workshops", workshops.length],
  ].filter(([, value]) => value > 0)
    .map(([label, value]) => `<span class="stat-pill"><strong>${value.toLocaleString()}</strong> ${label}</span>`)
    .join("");
}

function option(value, label) {
  return `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;
}

function updatePresentationOptions(recordsForTab) {
  if (!els.presentation) return;
  const labels = [...new Set(recordsForTab.flatMap((record) => record.presentationLabels || []))]
    .filter(Boolean)
    .sort((left, right) => {
      const priority = { Spotlight: 0, Oral: 1 };
      return (priority[left] ?? 10) - (priority[right] ?? 10) || left.localeCompare(right);
    });
  els.presentation.innerHTML = option("all", "All presentations") + labels.map((label) => option(label, label)).join("");
  if (state.presentation !== "all" && !labels.includes(state.presentation)) state.presentation = "all";
  els.presentation.value = state.presentation;
  renderPresentationPills(labels);
}

function renderPresentationPills(labels) {
  if (!els.presentationPills) return;
  const pills = [["all", "All"], ...labels.map((label) => [label, label])];
  els.presentationPills.innerHTML = pills.map(([value, label]) => `
    <button class="filter-pill${state.presentation === value ? " is-active" : ""}" type="button" data-presentation="${escapeHtml(value)}">${escapeHtml(label)}</button>
  `).join("");
  els.presentationPills.querySelectorAll("[data-presentation]").forEach((button) => {
    button.addEventListener("click", () => {
      state.presentation = button.dataset.presentation || "all";
      els.presentation.value = state.presentation;
      renderPresentationPills(labels);
      browseDeps.applyFilterChange?.();
    });
  });
}

function resultEvidenceBadges(record) {
  return uniqueChipValues([
    record.status === "accepted_public" ? "Accepted" : statusLabel(record.status),
    record.abstract ? "Abstract" : "",
    record.mapAvailable ? "Mapped" : "",
    record.hasPdf || record.pdfUrl ? "PDF link" : "",
  ]).slice(0, 4);
}

export function activeFilterSummary(baseLabel, extraParts = []) {
  const parts = [baseLabel, state.category === "all" ? "all fields" : state.category];
  if (state.group !== "all") parts.push(state.group);
  if (state.presentation !== "all") parts.push(state.presentation);
  if (state.query.trim()) {
    const query = state.query.trim();
    parts.push(`search: ${query.length > 32 ? query.slice(0, 31) + "..." : query}`);
  }
  return [...parts, ...extraParts.filter(Boolean)].join(" · ");
}

export function updateSelects() {
  const recordsForTab = recordsForCurrentTab();
  const categories = [...new Set(recordsForTab.flatMap((record) => categoryTags(record)))].sort();
  const groups = [...new Set(recordsForTab.map((record) => record.group))].sort();

  els.category.innerHTML = option("all", "All fields") + categories.map((name) => option(name, name)).join("");
  els.group.innerHTML = option("all", "All groups") + groups.map((name) => option(name, name)).join("");
  els.category.value = categories.includes(state.category) ? state.category : "all";
  els.group.value = groups.includes(state.group) ? state.group : "all";
  state.category = els.category.value;
  state.group = els.group.value;
  updatePresentationOptions(recordsForTab);
}

export function renderResults() {
  const filtered = getFilteredRecords();
  const query = normalize(state.query);
  els.resultCount.textContent = `${filtered.length.toLocaleString()} results`;
  els.activeSummary.textContent = activeFilterSummary(typeLabel(state.tab));

  const visible = filtered.slice(0, state.visibleCount);
  els.results.innerHTML = visible
    .map((record) => {
      const selected = record.id === state.selectedId ? " is-selected" : "";
      const featured = (record.presentationLabels || []).includes("Spotlight") ? " is-spotlight" : (record.presentationLabels || []).includes("Oral") ? " is-oral" : "";
      const details = resultDetails(record);
      const matched = matchedField(record, query);
      const areaLabel = (record.areaTags || categoryTags(record)).slice(0, 1)[0] || "Other";
      const coreConcepts = researchConceptTags(record, "browse");
      const assetBadges = uniqueChipValues([
        assetLabel(record),
        record.hasPoster ? "Poster" : "",
        record.hasSlide ? "Slides" : "",
      ]);
      const evidenceBadges = resultEvidenceBadges(record);
      return `
        <button class="result-item${selected}${featured}" type="button" data-id="${escapeHtml(record.id)}" style="--record-color:${escapeHtml(browseRecordColor(record))}">
          <span class="result-kicker">
            ${matched ? `<span class="badge match">${escapeHtml(MATCH_FIELD_LABEL[matched])} match</span>` : ""}
            ${presentationBadges(record)}
            <span class="area-label"><i></i>${escapeHtml(areaLabel)}</span>
          </span>
          <span class="result-title">${escapeHtml(plainMathTitle(record.title))}</span>
          <span class="result-authors">${escapeHtml(record.authors || "Authors unavailable")}</span>
          <span class="badges">
            ${record.group && record.group !== "Main Conference" ? `<span class="badge">${escapeHtml(record.group)}</span>` : ""}
            ${assetBadges.map((label) => `<span class="badge">${escapeHtml(label)}</span>`).join("")}
          </span>
          ${coreConcepts.length ? `<span class="badges research-concept-chips" aria-label="Research concepts">${coreConcepts.map((concept) => `<span class="badge">${escapeHtml(concept)}</span>`).join("")}</span>` : ""}
          <span class="result-evidence" aria-label="Record evidence">
            ${evidenceBadges.map((label) => `<span>${escapeHtml(label)}</span>`).join("")}
          </span>
          ${details ? `<span class="result-details">${escapeHtml(details)}</span>` : ""}
        </button>
      `;
    })
    .join("");

  if (filtered.length === 0) {
    const message = "Adjust the filters or search terms.";
    els.results.innerHTML = `<div class="empty-state"><strong>No records</strong><span>${escapeHtml(message)}</span></div>`;
  }

  els.results.querySelectorAll(".result-item").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedId = button.dataset.id;
      state.viewerMapRequested = true;
      state.viewerReferenceRequested = true;
      const selected = findDisplayRecord(state.selectedId);
      renderResults();
      renderViewer(selected);
      browseDeps.hydrateSelectedRecord?.(state.selectedId);
    });
  });

  queueMathTypeset(els.results);
}

export function ensureVisibleSelection() {
  if (state.tab === "map") return findDisplayRecord(state.selectedId);
  const filtered = getFilteredRecords();
  if (!filtered.some((record) => record.id === state.selectedId)) {
    state.selectedId = filtered[0]?.id || "";
  }
  return findDisplayRecord(state.selectedId);
}

export function resetResultWindow() {
  state.visibleCount = PAGE_SIZE;
}

export function loadMoreResultsIfNeeded() {
  const remaining = getFilteredRecords().length - state.visibleCount;
  if (remaining <= 0) return;
  state.visibleCount += PAGE_SIZE;
  renderResults();
}
