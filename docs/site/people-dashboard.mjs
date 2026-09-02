import { researchConceptTags } from "./research-concepts.mjs";
import { escapeHtml, plainMathTitle } from "./utils.js";

const dashboardState = {
  mode: "authors",
  scope: "all",
  query: "",
  page: 0,
  selectedIndex: 0,
  records: null,
  analysisArtifact: null,
  cache: new Map(),
  renderToken: 0,
};

const PEOPLE_PAGE_SIZE = 20;

export function clearPeopleDashboardCache() {
  dashboardState.cache.clear();
}

function scopeRecords(records, scope) {
  if (scope === "workshop") return records.filter((record) => record.type === "workshop");
  if (scope === "main") return records.filter((record) => record.type === "paper" || record.type === "poster");
  return records;
}

function topicBars(topics = []) {
  const primaryTopics = topics.slice(0, 1);
  const max = Math.max(1, ...primaryTopics.map((topic) => topic.count));
  return primaryTopics.map((topic) => `
    <span class="people-topic-row">
      <span><b>${escapeHtml(topic.label)}</b><small>${Number(topic.count).toLocaleString()}</small></span>
      <i style="--topic-share:${Math.round((topic.count / max) * 100)}%"></i>
    </span>
  `).join("") || "<small>No topic tags available.</small>";
}

function entityLabel(entity, mode) {
  if (mode === "authors") return entity.name;
  return entity.members.slice(0, 3).join(" · ");
}

function entitySearchText(entity, mode) {
  const names = mode === "authors" ? [entity.name, ...(entity.aliases || [])] : entity.members;
  return [...names, ...(entity.topics || []).map((topic) => topic.label)].join(" ").toLocaleLowerCase();
}

export function renderTopicTrends(topicTrends) {
  const topics = (topicTrends?.topics || []).slice(0, 4);
  return `
    <section class="author-map-insights people-topic-prevalence" aria-label="Topics in this 2026 corpus">
      <div class="author-map-insights-head">
        <p class="eyebrow">Topics in this 2026 corpus</p>
        <span>${escapeHtml(topicTrends?.note || "Single-year prevalence; no temporal growth claim.")}</span>
      </div>
      <div class="author-map-insight-grid">
        ${topics.map((topic, index) => `
          <button type="button" data-people-topic="${escapeHtml(topic.label)}" aria-label="Explore ${escapeHtml(topic.label)} related papers on Map">
            <em>Reviewed Core concept · Rank ${index + 1}</em>
            <strong>${escapeHtml(topic.label)}</strong>
            <span>${Number(topic.workCount).toLocaleString()} unique works · ${Number(topic.workShare) > 0 && Number(topic.workShare) < 0.001 ? "<0.1" : (Number(topic.workShare) * 100).toFixed(1)}% of this scope</span>
            <small>Explore related papers on Map →</small>
          </button>
        `).join("") || "<article><em>Pending</em><strong>No finalized topic counts</strong><span>The analysis artifact contains no reviewed Core concepts for this scope.</span></article>"}
      </div>
    </section>
  `;
}

function renderDetail(entity, mode, recordById) {
  if (!entity) return `<div class="empty-state"><strong>No matching entity</strong><span>Adjust the people search.</span></div>`;
  const label = entityLabel(entity, mode);
  const aliases = mode === "authors" && entity.aliases?.length > 1
    ? `<p class="people-aliases"><b>Name variants</b>${entity.aliases.map(escapeHtml).join(" · ")}</p>`
    : "";
  const members = mode === "groups"
    ? `<div class="people-members">${entity.members.map((member) => `<span>${escapeHtml(member)}</span>`).join("")}</div>`
    : "";
  const papers = entity.recordIds.map((id) => recordById.get(id)).filter(Boolean).slice(0, 16);
  return `
    <section class="people-detail-card">
      <p class="eyebrow">${mode === "authors" ? "Resolved author" : "Repeated coauthor community"}</p>
      <h3>${escapeHtml(label)}</h3>
      <p class="people-detail-summary"><b>${Number(entity.paperCount).toLocaleString()}</b> unique accepted works in this scope</p>
      ${aliases}
      ${members}
      <div class="people-detail-grid">
        <div>
          <h4>Topic concentration</h4>
          <div class="people-topic-bars">${topicBars(entity.topics)}</div>
        </div>
        <div>
          <h4>Accepted works</h4>
          <div class="people-paper-list">
            ${papers.map((record) => `
              <button type="button" data-record-id="${escapeHtml(record.id)}">
                <strong>${escapeHtml(plainMathTitle(record.title))}</strong>
                <small>${escapeHtml(researchConceptTags(record, "detail").join(" · ") || "No reviewed research concepts.")}</small>
              </button>
            `).join("") || "<small>No linked work in the loaded index.</small>"}
          </div>
        </div>
      </div>
    </section>
  `;
}

function mountDashboard(target, analytics, records, onOpenRecord, onExploreTopic) {
  const entities = dashboardState.mode === "authors" ? analytics.authors : analytics.groups;
  const query = dashboardState.query.trim().toLocaleLowerCase();
  const matching = entities.filter((entity) => !query || entitySearchText(entity, dashboardState.mode).includes(query));
  const pageCount = Math.max(1, Math.ceil(matching.length / PEOPLE_PAGE_SIZE));
  dashboardState.page = Math.min(dashboardState.page, pageCount - 1);
  const pageStart = dashboardState.page * PEOPLE_PAGE_SIZE;
  const visible = matching.slice(pageStart, pageStart + PEOPLE_PAGE_SIZE);
  const selected = visible[dashboardState.selectedIndex] || visible[0];
  const recordById = new Map(records.map((record) => [record.id, record]));
  target.innerHTML = `
    <section class="people-dashboard">
      <header class="people-dashboard-head">
        <div>
          <p class="eyebrow">Authorship intelligence</p>
          <h2>Authors & collaboration groups</h2>
        </div>
        <label class="people-scope">
          <span>Scope</span>
          <select id="peopleScope">
            <option value="all"${dashboardState.scope === "all" ? " selected" : ""}>All accepted works</option>
            <option value="main"${dashboardState.scope === "main" ? " selected" : ""}>Main conference</option>
            <option value="workshop"${dashboardState.scope === "workshop" ? " selected" : ""}>Workshops</option>
          </select>
        </label>
      </header>
      <div class="people-method-note" role="note">
        <strong>Identity method</strong>
        <span>Email is the primary key when present; otherwise normalized names are merged only when their coauthor context overlaps. Rankings use one reviewed Core concept; open a work to inspect up to six reviewed Detail concepts. Current public records contain ${Number(analytics.summary.emailIdentityCount).toLocaleString()} email-backed identities.</span>
      </div>
      <div class="selection-stat-grid people-stat-grid">
        <span><strong>${Number(analytics.summary.uniqueWorks).toLocaleString()}</strong><small>unique works</small></span>
        <span><strong>${Number(analytics.summary.authorCount).toLocaleString()}</strong><small>resolved identities</small></span>
        <span><strong>${Number(analytics.summary.groupCount).toLocaleString()}</strong><small>coauthor communities</small></span>
        <span><strong>${Number(analytics.summary.emailIdentityCount).toLocaleString()}</strong><small>email-backed</small></span>
      </div>
      ${renderTopicTrends(analytics.topicTrends)}
      <div class="people-toolbar">
        <div class="people-mode" role="group" aria-label="Analysis unit">
          <button type="button" data-mode="authors" class="${dashboardState.mode === "authors" ? "is-active" : ""}">Authors</button>
          <button type="button" data-mode="groups" class="${dashboardState.mode === "groups" ? "is-active" : ""}">Collaboration groups</button>
        </div>
        <label class="people-search">
          <span>Find</span>
          <input id="peopleSearch" type="search" value="${escapeHtml(dashboardState.query)}" placeholder="Name or topic" autocomplete="off" />
        </label>
      </div>
      ${dashboardState.mode === "groups" ? `
        <p class="people-proxy-note"><b>Research-lab proxy:</b> these are connected groups where author pairs appear together on at least two unique works. They are not verified institutional affiliations.</p>
      ` : ""}
      <div class="people-analysis-grid">
        <div class="people-ranking" aria-label="Ranked people analysis">
          <div class="people-ranking-list">
            ${visible.map((entity, index) => `
              <button type="button" data-entity-index="${index}" class="${entity === selected ? "is-active" : ""}">
                <span class="neighbor-rank">${pageStart + index + 1}</span>
                <span>
                  <strong>${escapeHtml(entityLabel(entity, dashboardState.mode))}</strong>
                  <small>${Number(entity.paperCount).toLocaleString()} works · ${(entity.topics || []).slice(0, 1).map((topic) => escapeHtml(topic.label)).join("") || "no reviewed Core concept"}</small>
                </span>
                ${dashboardState.mode === "groups" ? `<em>${Number(entity.members.length).toLocaleString()} people</em>` : ""}
              </button>
            `).join("") || `<div class="empty-state compact"><strong>No matches</strong><span>Try another name or topic.</span></div>`}
          </div>
          ${matching.length ? `
            <nav class="people-pagination" aria-label="People result pages">
              <small>${(pageStart + 1).toLocaleString()}–${Math.min(pageStart + PEOPLE_PAGE_SIZE, matching.length).toLocaleString()} of ${matching.length.toLocaleString()}</small>
              <span>
                <button type="button" data-people-page="previous" ${dashboardState.page === 0 ? "disabled" : ""} aria-label="Previous 20 people">←</button>
                <button type="button" data-people-page="next" ${dashboardState.page >= pageCount - 1 ? "disabled" : ""} aria-label="Next 20 people">→</button>
              </span>
            </nav>
          ` : ""}
        </div>
        <div id="peopleDetail">${renderDetail(selected, dashboardState.mode, recordById)}</div>
      </div>
    </section>
  `;

  target.querySelector("#peopleScope")?.addEventListener("change", (event) => {
    dashboardState.scope = event.target.value;
    dashboardState.page = 0;
    dashboardState.selectedIndex = 0;
    void renderPeopleDashboard(target, dashboardState.records, dashboardState.analysisArtifact, onOpenRecord, onExploreTopic);
  });
  target.querySelectorAll("[data-mode]").forEach((button) => button.addEventListener("click", () => {
    dashboardState.mode = button.dataset.mode;
    dashboardState.page = 0;
    dashboardState.selectedIndex = 0;
    mountDashboard(target, analytics, records, onOpenRecord, onExploreTopic);
  }));
  target.querySelector("#peopleSearch")?.addEventListener("input", (event) => {
    dashboardState.query = event.target.value;
    dashboardState.page = 0;
    dashboardState.selectedIndex = 0;
    mountDashboard(target, analytics, records, onOpenRecord, onExploreTopic);
    target.querySelector("#peopleSearch")?.focus();
  });
  target.querySelectorAll("[data-entity-index]").forEach((button) => button.addEventListener("click", () => {
    dashboardState.selectedIndex = Number(button.dataset.entityIndex);
    mountDashboard(target, analytics, records, onOpenRecord, onExploreTopic);
  }));
  target.querySelectorAll("[data-people-page]").forEach((button) => button.addEventListener("click", () => {
    dashboardState.page += button.dataset.peoplePage === "next" ? 1 : -1;
    dashboardState.selectedIndex = 0;
    mountDashboard(target, analytics, records, onOpenRecord, onExploreTopic);
  }));
  target.querySelectorAll("[data-record-id]").forEach((button) => button.addEventListener("click", () => onOpenRecord(button.dataset.recordId)));
  target.querySelectorAll("[data-people-topic]").forEach((button) => button.addEventListener("click", () => {
    onExploreTopic?.(button.dataset.peopleTopic || "");
  }));
}

export async function renderPeopleDashboard(target, records, analysisArtifact, onOpenRecord, onExploreTopic) {
  if (!target || !records) return;
  if (dashboardState.records !== records || dashboardState.analysisArtifact !== analysisArtifact) {
    dashboardState.records = records;
    dashboardState.analysisArtifact = analysisArtifact;
    dashboardState.cache.clear();
  }
  const token = ++dashboardState.renderToken;
  let analytics = dashboardState.cache.get(dashboardState.scope);
  const scoped = scopeRecords(records, dashboardState.scope);
  if (!analytics) {
    analytics = analysisArtifact?.scopes?.[dashboardState.scope];
    if (!analytics) {
      target.innerHTML = `<div class="empty-state"><strong>Finalized people analysis pending</strong><span>This view activates after the complete reviewed-concept artifact and its matching author/topic analysis artifact are published.</span></div>`;
      return;
    }
    dashboardState.cache.set(dashboardState.scope, analytics);
  }
  if (token !== dashboardState.renderToken || !target.isConnected) return;
  mountDashboard(target, analytics, scoped, onOpenRecord, onExploreTopic);
}
