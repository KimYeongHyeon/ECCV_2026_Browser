import { els } from "./dom.js";
import { state } from "./state.js";
import { escapeHtml } from "./utils.js";
import { colorForValue } from "./map-tooltip.js";
import { mapColorValue } from "./map-core.js";
import { domainShapeValue } from "./map-engine.js";

function domainShapeLegendItems(records) {
  const counts = new Map();
  for (const record of records) {
    const domain = (record.domainTags || ["General"])[0] || "General";
    counts.set(domain, (counts.get(domain) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 8)
    .map(([domain, count]) => ({
      count,
      domain,
      shape: domainShapeValue({ domainTags: [domain] }),
    }));
}

const DEFAULT_LEGEND_LIMIT = 12;

export function renderMapLegend(visibleRecords, onFilterChange, onLegendToggle) {
  if (!els.mapLegend) return;
  if (state.mapColor === "quality" || state.mapColor === "availability") {
    state.mapColor = "area-domain";
    if (els.mapColor) els.mapColor.value = state.mapColor;
  }
  const counts = new Map();
  for (const record of visibleRecords) {
    const value = mapColorValue(record);
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  const sortedItems = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const canExpand = state.mapColor === "embedding-cluster" && sortedItems.length > DEFAULT_LEGEND_LIMIT;
  const items = canExpand && state.mapLegendExpanded
    ? sortedItems
    : sortedItems.slice(0, DEFAULT_LEGEND_LIMIT);
  const hiddenCount = Math.max(0, sortedItems.length - items.length);
  const domainShapeItems = domainShapeLegendItems(visibleRecords);
  const allCount = visibleRecords.length;
  els.mapLegend.innerHTML = `
    ${state.mapColor === "area-domain" ? `
      <div class="legend-note">
        <span>Fill = research area. Shape = domain below. Ring = domain accent. Click an area to filter.</span>
        <span class="legend-shape-row" aria-label="Domain shape map">
          ${domainShapeItems.map((item) => `
            <span title="${escapeHtml(`${item.domain}: ${item.count.toLocaleString()} records`)}">
              <i class="legend-shape legend-shape-${escapeHtml(item.shape)}"></i>
              <em>${escapeHtml(item.domain)}</em>
              <strong>${item.count.toLocaleString()}</strong>
            </span>
          `).join("")}
        </span>
        <b>Each shape marks the domain tag shown next to it.</b>
      </div>
    ` : ""}
    <button class="legend-item legend-all${state.mapFilterValue ? "" : " is-active"}" type="button" data-value="" title="Show all color groups">
      <span class="legend-swatch legend-swatch-all"></span>
      <span>All</span>
      <strong>${allCount.toLocaleString()}</strong>
    </button>
  ` + items.map(([value, count]) => `
    <button class="legend-item${state.mapFilterValue === value ? " is-active" : ""}" type="button" data-value="${escapeHtml(value)}" title="${escapeHtml(state.mapColor === "area-domain" ? `Filter area: ${value}` : state.mapColor === "embedding-cluster" ? `Filter embedding cluster: ${value}` : value)}">
      <span class="legend-swatch" style="background:${colorForValue(value)}"></span>
      <span>${escapeHtml(value)}</span>
      <strong>${count.toLocaleString()}</strong>
    </button>
  `).join("") + (canExpand ? `
    <button class="legend-more" type="button">
      <span>${state.mapLegendExpanded ? "Show less" : `Show more (${hiddenCount.toLocaleString()})`}</span>
    </button>
  ` : "");
  els.mapLegend.querySelectorAll(".legend-item").forEach((button) => {
    button.addEventListener("click", () => {
      const value = button.dataset.value || "";
      state.mapFilterValue = state.mapFilterValue === value ? "" : value || "";
      onFilterChange?.();
    });
  });
  els.mapLegend.querySelector(".legend-more")?.addEventListener("click", () => {
    state.mapLegendExpanded = !state.mapLegendExpanded;
    onLegendToggle?.();
  });
}
