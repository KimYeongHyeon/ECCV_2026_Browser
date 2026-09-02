import { escapeHtml, plainMathTitle } from "./utils.js";

const TOPIC_CARD_LIMIT = 12;
const TOPIC_SEARCH_LIMIT = 36;
const TOPIC_WORK_LIMIT = 10;
const TOPIC_AUTHOR_LIMIT = 8;

const dashboardState = {
  scope: "all",
  query: "",
  selectedTopic: "",
};

function scopeRecords(records, scope) {
  if (scope === "main") return records.filter((record) => record.type === "paper" || record.type === "poster");
  if (scope === "workshop") return records.filter((record) => record.type === "workshop");
  return records;
}

function normalizedWorkKey(record) {
  return String(record?.title || "")
    .toLocaleLowerCase()
    .replace(/\\[a-z]+\b/giu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim() || String(record?.id || "");
}

function uniqueWorks(records) {
  const byWork = new Map();
  for (const record of records) {
    const key = normalizedWorkKey(record);
    const current = byWork.get(key);
    if (!current || (current.type === "poster" && record.type !== "poster")) byWork.set(key, record);
  }
  return [...byWork.values()];
}

function topicLabels(record) {
  return [...new Set(Array.isArray(record?.researchConcepts?.core) ? record.researchConcepts.core : [])];
}

function conceptSearchTokens(value) {
  return String(value || "").toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
}

export function matchesConceptSearch(label, query) {
  const queryTokens = conceptSearchTokens(query);
  if (!queryTokens.length) return true;
  const labelTokens = conceptSearchTokens(label);
  return queryTokens.every((token) => labelTokens.some((labelToken) => labelToken.startsWith(token)));
}

export function buildReviewedTopicIndex(records, scope = "all") {
  const works = uniqueWorks(scopeRecords(records || [], scope));
  const recordsByTopic = new Map();
  for (const record of works) {
    for (const label of topicLabels(record)) {
      const existing = recordsByTopic.get(label) || [];
      existing.push(record);
      recordsByTopic.set(label, existing);
    }
  }
  const topics = [...recordsByTopic.entries()]
    .map(([label, topicRecords]) => ({ label, records: topicRecords, workCount: topicRecords.length }))
    .sort((left, right) => (right.workCount - left.workCount) || left.label.localeCompare(right.label));
  return { topics, workCount: works.length };
}

function matchingAuthors(analysisArtifact, scope, recordIds) {
  const authors = analysisArtifact?.scopes?.[scope]?.authors || [];
  return authors
    .map((author) => ({
      ...author,
      matchingWorkCount: (author.recordIds || []).filter((recordId) => recordIds.has(recordId)).length,
    }))
    .filter((author) => author.matchingWorkCount > 0)
    .sort((left, right) => (
      (right.matchingWorkCount - left.matchingWorkCount)
      || (right.paperCount - left.paperCount)
      || left.name.localeCompare(right.name)
    ));
}

function workShare(workCount, total) {
  if (!total) return "0.0";
  const share = (workCount / total) * 100;
  return share > 0 && share < 0.1 ? "<0.1" : share.toFixed(1);
}

function topicCard(topic, selected, totalWorks) {
  return `
    <button type="button" class="topic-card ${selected ? "is-active" : ""}" data-topic-label="${escapeHtml(topic.label)}" aria-pressed="${selected}">
      <span class="topic-card-kicker">Reviewed Core concept</span>
      <strong>${escapeHtml(topic.label)}</strong>
      <small>${Number(topic.workCount).toLocaleString()} unique works · ${workShare(topic.workCount, totalWorks)}% of scope</small>
    </button>
  `;
}

function renderSelectedTopic(topic, index, analysisArtifact, scope) {
  if (!topic) {
    return `<div class="empty-state compact"><strong>No Core concept matches</strong><span>Try a more specific phrase such as “concept erasure” or “ordinary differential equation”.</span></div>`;
  }
  const recordIds = new Set(topic.records.map((record) => record.id));
  const authors = matchingAuthors(analysisArtifact, scope, recordIds);
  return `
    <section class="topic-focus" aria-live="polite">
      <header class="topic-focus-head">
        <div>
          <p class="eyebrow">Selected reviewed Core concept</p>
          <h3>${escapeHtml(topic.label)}</h3>
          <p>${Number(topic.workCount).toLocaleString()} unique works in this scope · ${workShare(topic.workCount, index.workCount)}% of ${Number(index.workCount).toLocaleString()} unique works</p>
        </div>
        <div class="topic-focus-actions">
          <button type="button" class="topic-primary-action" data-explore-core-topic="${escapeHtml(topic.label)}">Open exact papers on Map</button>
          <button type="button" class="topic-secondary-action" data-open-author-map-topic="${escapeHtml(topic.label)}">View collaboration context</button>
        </div>
      </header>
      <div class="topic-focus-grid">
        <section>
          <h4>Representative works</h4>
          <div class="topic-work-list">
            ${topic.records.slice(0, TOPIC_WORK_LIMIT).map((record) => `
              <button type="button" data-topic-record-id="${escapeHtml(record.id)}">
                <strong>${escapeHtml(plainMathTitle(record.title))}</strong>
                <small>${escapeHtml(record.authors || "Authors unavailable")}</small>
              </button>
            `).join("")}
          </div>
        </section>
        <section>
          <h4>Resolved authors on these works</h4>
          <div class="topic-author-list">
            ${authors.slice(0, TOPIC_AUTHOR_LIMIT).map((author) => `
              <span><b>${escapeHtml(author.name)}</b><em>${Number(author.matchingWorkCount).toLocaleString()} matching work${author.matchingWorkCount === 1 ? "" : "s"}</em></span>
            `).join("") || "<small>No resolved author identity overlaps this selection.</small>"}
          </div>
          <p class="topic-trust-note">Author identities use email when available; otherwise a name is merged only with shared coauthor context. This is not an affiliation claim.</p>
        </section>
      </div>
    </section>
  `;
}

function bindDashboard(target, index, analysisArtifact, onOpenRecord, onExploreTopic, onOpenAuthorMap) {
  const query = dashboardState.query.trim().toLocaleLowerCase();
  const matching = index.topics.filter((topic) => matchesConceptSearch(topic.label, query));
  const boardEyebrow = query ? "Search results" : "Repeated in this scope";
  const boardTitle = query ? `${Number(matching.length).toLocaleString()} matching concepts` : "Start with the recurring concepts";
  if (!matching.some((topic) => topic.label === dashboardState.selectedTopic)) {
    dashboardState.selectedTopic = matching[0]?.label || "";
  }
  const selected = matching.find((topic) => topic.label === dashboardState.selectedTopic) || null;
  target.innerHTML = `
    <section class="topics-dashboard">
      <header class="topics-dashboard-head">
        <div>
          <p class="eyebrow">Reviewed concept explorer</p>
          <h2>Topics</h2>
          <p>Browse concrete concepts extracted from the complete Conference corpus corpus, then inspect the exact works and author identities behind them.</p>
        </div>
        <label class="topics-scope">
          <span>Scope</span>
          <select id="topicsScope">
            <option value="all"${dashboardState.scope === "all" ? " selected" : ""}>All accepted works</option>
            <option value="main"${dashboardState.scope === "main" ? " selected" : ""}>Main conference</option>
            <option value="workshop"${dashboardState.scope === "workshop" ? " selected" : ""}>Workshops</option>
          </select>
        </label>
      </header>
      <div class="topics-method-note" role="note"><strong>How to read this</strong><span>Counts are unique works that carry a reviewed Core concept. This is a single-year Conference corpus corpus view, so it describes concentration rather than growth over time.</span></div>
      <div class="selection-stat-grid topics-stat-grid">
        <span><strong>${Number(index.workCount).toLocaleString()}</strong><small>unique works in scope</small></span>
        <span><strong>${Number(index.topics.length).toLocaleString()}</strong><small>reviewed Core concepts</small></span>
        <span><strong>${Number(index.topics.filter((topic) => topic.workCount > 1).length).toLocaleString()}</strong><small>repeated concepts</small></span>
      </div>
      <section class="topics-board" aria-label="Reviewed Core concept overview">
        <div class="topics-board-head">
          <div><p class="eyebrow">${boardEyebrow}</p><h3>${boardTitle}</h3></div>
          <label class="topics-search"><span>Find a Core concept</span><input id="topicsSearch" type="search" value="${escapeHtml(dashboardState.query)}" placeholder="e.g. concept erasure, ODE" autocomplete="off" /></label>
        </div>
        <div class="topics-card-grid">
          ${matching.slice(0, query ? TOPIC_SEARCH_LIMIT : TOPIC_CARD_LIMIT).map((topic) => topicCard(topic, topic.label === dashboardState.selectedTopic, index.workCount)).join("") || "<div class=\"empty-state compact\"><strong>No matching concept</strong><span>Try a shorter or more specific phrase.</span></div>"}
        </div>
      </section>
      ${renderSelectedTopic(selected, index, analysisArtifact, dashboardState.scope)}
    </section>
  `;
  target.querySelector("#topicsScope")?.addEventListener("change", (event) => {
    dashboardState.scope = event.target.value;
    dashboardState.selectedTopic = "";
    void renderTopicsDashboard(target, dashboardState.records, dashboardState.analysisArtifact, onOpenRecord, onExploreTopic, onOpenAuthorMap);
  });
  target.querySelector("#topicsSearch")?.addEventListener("input", (event) => {
    dashboardState.query = event.target.value;
    bindDashboard(target, index, analysisArtifact, onOpenRecord, onExploreTopic, onOpenAuthorMap);
    target.querySelector("#topicsSearch")?.focus();
  });
  target.querySelectorAll("[data-topic-label]").forEach((button) => button.addEventListener("click", () => {
    dashboardState.selectedTopic = button.dataset.topicLabel || "";
    bindDashboard(target, index, analysisArtifact, onOpenRecord, onExploreTopic, onOpenAuthorMap);
  }));
  target.querySelectorAll("[data-topic-record-id]").forEach((button) => button.addEventListener("click", () => onOpenRecord(button.dataset.topicRecordId)));
  target.querySelector("[data-explore-core-topic]")?.addEventListener("click", (event) => onExploreTopic(event.currentTarget.dataset.exploreCoreTopic || ""));
  target.querySelector("[data-open-author-map-topic]")?.addEventListener("click", (event) => onOpenAuthorMap(event.currentTarget.dataset.openAuthorMapTopic || "", dashboardState.scope));
}

export async function renderTopicsDashboard(target, records, analysisArtifact, onOpenRecord, onExploreTopic, onOpenAuthorMap) {
  if (!target || !records) return;
  dashboardState.records = records;
  dashboardState.analysisArtifact = analysisArtifact;
  if (!analysisArtifact?.scopes?.[dashboardState.scope]) {
    target.innerHTML = `<div class="empty-state"><strong>Finalized topic analysis pending</strong><span>This view opens after the reviewed concept and people analysis artifacts are verified against the current index.</span></div>`;
    return;
  }
  const index = buildReviewedTopicIndex(records, dashboardState.scope);
  if (!index.workCount) {
    target.innerHTML = `<div class="empty-state"><strong>Loading complete topic corpus</strong><span>Reading the remaining indexed works before showing topic counts.</span></div>`;
    return;
  }
  bindDashboard(target, index, analysisArtifact, onOpenRecord, onExploreTopic, onOpenAuthorMap);
}
