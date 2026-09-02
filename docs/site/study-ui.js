import { mapRecordById } from "./map-core.js";
import { state } from "./state.js";
import { escapeHtml, plainMathTitle } from "./utils.js";

const STAGE_LABELS = {
  intro: "Intro",
  core: "Core",
  applied: "Applied",
  broader: "Broader",
};
const STUDY_TRAIL_HELP = "Staged recommended papers: intro, core, applied, and broader reading steps with a short reason for each.";
const SEMANTIC_COMPARE_HELP = "Compare this paper with suggested neighbors to see common topics, differences, and bridge papers.";

function renderStudyDisclosure(className, title, help, body, initiallyOpen = false) {
  return `
    <details class="${className} selection-stat-block study-disclosure"${initiallyOpen ? " open" : ""}>
      <summary class="selection-block-head study-disclosure-head">
        <strong>${escapeHtml(title)}</strong>
        <span class="selection-sample-controls">
          <span class="study-help" title="${escapeHtml(help)}" aria-label="${escapeHtml(help)}" tabindex="0">?</span>
          <span class="study-disclosure-toggle" aria-hidden="true"></span>
        </span>
      </summary>
      <div class="study-disclosure-body">${body}</div>
    </details>
  `;
}

function tagList(record) {
  return [...new Set([...(record?.areaTags || []), ...(record?.domainTags || [])])];
}

function sharedTags(left, right) {
  const leftTags = new Set(tagList(left));
  return tagList(right).filter((tag) => leftTags.has(tag)).slice(0, 4);
}

function differentTags(left, right) {
  const leftTags = new Set(tagList(left));
  return tagList(right).filter((tag) => !leftTags.has(tag)).slice(0, 4);
}

function bridgeRecords(left, right, findRecord) {
  const mapById = mapRecordById();
  const leftNeighbors = mapById.get(left.id)?.nearestNeighbors || [];
  const rightNeighborIds = new Set((mapById.get(right.id)?.nearestNeighbors || []).map((item) => item.id));
  const shared = leftNeighbors
    .filter((item) => rightNeighborIds.has(item.id))
    .map((item) => findRecord(item.id))
    .filter(Boolean);
  if (shared.length) return shared.slice(0, 4);
  const nearest = leftNeighbors.concat(mapById.get(right.id)?.nearestNeighbors || [])
    .map((item) => findRecord(item.id))
    .filter((record, index, records) => record && record.id !== left.id && record.id !== right.id && records.findIndex((candidate) => candidate.id === record.id) === index)
    .slice(0, 4);
  if (nearest.length) return nearest;
  return (state.studyFeatures?.records?.[left.id]?.studyTrail || [])
    .map((item) => findRecord(item.recordId))
    .filter((record) => record && record.id !== left.id && record.id !== right.id)
    .slice(0, 4);
}

function stageSummary(trail) {
  const counts = new Map();
  for (const item of trail) {
    const label = STAGE_LABELS[item.stage] || item.stage || "Step";
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()].map(([label, count]) => ({ label, count }));
}

export function renderStudyTrail(record, study, findRecord) {
  const trail = (study?.studyTrail || []).map((item) => ({ ...item, record: findRecord(item.recordId) })).filter((item) => item.record);
  if (!trail.length) return "";
  const stages = stageSummary(trail);
  const areas = new Set(trail.flatMap((item) => item.record.areaTags || []));
  const domains = new Set(trail.flatMap((item) => item.record.domainTags || []));
  return renderStudyDisclosure("study-trail", "Study Trail", STUDY_TRAIL_HELP, `
      <div class="study-trail-summary">
        ${stages.map((item) => `<span><b>${escapeHtml(item.label)}</b>${Number(item.count).toLocaleString()}</span>`).join("")}
        <span><b>Areas</b>${Number(areas.size).toLocaleString()}</span>
        <span><b>Domains</b>${Number(domains.size).toLocaleString()}</span>
      </div>
      <p class="study-guidance">Reading order: start broad, read the core neighbor, then branch into applied and broader papers. Each step is chosen from embedding proximity plus area/domain diversity.</p>
      <div class="study-trail-list">
        ${trail.map((item, index) => `
          <button type="button" class="neighbor-item study-trail-item" data-study-id="${escapeHtml(item.record.id)}">
            <span class="neighbor-rank">${index + 1}</span>
            <span class="neighbor-main">
              <em>${escapeHtml(STAGE_LABELS[item.stage] || item.stage)}</em>
              <strong>${escapeHtml(plainMathTitle(item.record.title))}</strong>
              <small class="why-line">${escapeHtml(item.reason || "related reading step")}</small>
            </span>
          </button>
        `).join("")}
      </div>
  `);
}

export function renderSemanticCompare(record, study, findRecord) {
  const candidates = (study?.compareCandidates || []).map((item) => ({ ...item, record: findRecord(item.recordId) })).filter((item) => item.record);
  if (!candidates.length) return "";
  const targetId = state.studyCompareSourceId === record.id ? state.studyCompareTargetId : "";
  const target = findRecord(targetId);
  return renderStudyDisclosure("semantic-compare", "Semantic Compare", SEMANTIC_COMPARE_HELP, `
      <div class="trend-representatives semantic-compare-controls">
        ${candidates.slice(0, 3).map((item) => `
          <button type="button" class="compare-candidate" data-compare-id="${escapeHtml(item.record.id)}">
            ${escapeHtml(plainMathTitle(item.record.title))}
          </button>
        `).join("")}
      </div>
      ${target ? renderCompareResult(record, target, findRecord) : "<small>Pick a candidate for common topic, differences, and bridging papers.</small>"}
  `, Boolean(target));
}

function renderCompareResult(record, target, findRecord) {
  const common = sharedTags(record, target);
  const differences = differentTags(record, target);
  const bridges = bridgeRecords(record, target, findRecord);
  return `
    <div class="semantic-compare-result">
      <div class="semantic-compare-metrics">
        <span><b>${common.length}</b><small>shared tags</small></span>
        <span><b>${differences.length}</b><small>different tags</small></span>
        <span><b>${bridges.length}</b><small>bridge papers</small></span>
      </div>
      <span><em>Common topic</em><b>${escapeHtml(common.join(", ") || record.embeddingClusterLabel || record.clusterLabel || "nearby embedding region")}</b></span>
      <span><em>Differences</em><b>${escapeHtml(differences.join(", ") || "different emphasis inside the same area")}</b></span>
      <div class="semantic-bridge-list">
        <em>Bridging papers</em>
        ${bridges.map((bridge) => `<button type="button" class="semantic-bridge" data-study-id="${escapeHtml(bridge.id)}">${escapeHtml(plainMathTitle(bridge.title))}</button>`).join("") || "<small>No bridge paper found in the current neighbor lists.</small>"}
        <small>Bridge papers are picked from shared nearest-neighbor paths, then fallback study-trail neighbors.</small>
      </div>
    </div>
  `;
}

export function renderStudyPanel(record, study, findRecord) {
  if (!study) return "";
  return `${renderStudyTrail(record, study, findRecord)}${renderSemanticCompare(record, study, findRecord)}`;
}

export function renderUnusualDirections(studyFeatures, findRecord, limit = 4) {
  const items = (studyFeatures?.outliers || []).map((item) => ({ ...item, record: findRecord(item.recordId) })).filter((item) => item.record).slice(0, limit);
  if (!items.length) return "";
  return `
    <section class="unusual-directions selection-stat-block">
      <strong>Unusual directions</strong>
      ${items.map((item) => `
        <button type="button" class="neighbor-item study-trail-item" data-study-id="${escapeHtml(item.record.id)}">
          <span class="neighbor-main">
            <strong>${escapeHtml(plainMathTitle(item.record.title))}</strong>
            <small class="why-line">${escapeHtml(item.reason || "far from its cluster center")}</small>
          </span>
        </button>
      `).join("")}
    </section>
  `;
}
