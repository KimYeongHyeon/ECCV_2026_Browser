import { assetUrl as configAssetUrl } from "./config.js";
import { els } from "./dom.js";
import {
  displayAvailabilityLabel,
  openReviewPdfUrl,
  paperPresentationKind,
  paperPresentationMode,
  statusLabel,
  typeLabel,
  viewerKindLabel,
} from "./records.js";
import { state } from "./state.js";
import { escapeHtml, plainMathTitle, queueMathTypeset } from "./utils.js";
import {
  destroyPdfViewer,
  isPdfAsset,
  mountPdfViewer,
  renderAssetOpenFallback,
} from "./pdf-viewer.js";
import { recordStudy } from "./study-features.js";
import { renderStudyPanel } from "./study-ui.js";

let viewerDeps = {};

export function configureViewer(deps) {
  viewerDeps = deps;
}

export function uniqueChipValues(values) {
  const seen = new Set();
  return values.filter(Boolean).filter((value) => {
    const key = String(value).trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function actionLink(href, label, primary = false) {
  if (!href) return "";
  return `<a class="action ${primary ? "primary" : ""}" href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`;
}

function assetActionHref(record, path) {
  if (!path) return "";
  if ((record.bestAssetKind === "pdf" || record.bestAssetKind === "slide") && isPdfAsset(path)) return "";
  return assetUrl(path);
}

function assetActionLabel(record) {
  if (record.bestAssetKind === "pdf") return "Preview PDF";
  if (record.bestAssetKind === "slide") return "Preview slides";
  if (record.bestAssetKind === "poster") return "Open poster";
  return "Open asset";
}

function assetUrl(path) {
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  // Local assets (pdfs/<id>.pdf and other site-root files) resolve against
  // the published site root in every hosting context (localhost, GitHub
  // Pages, jsDelivr mirrors).
  return configAssetUrl(path);
}

function fallbackPageUrl(record) {
  if (record.type === "workshop" && record.pdfUrl) return record.pdfUrl;
  return record.pageUrl || record.openreviewUrl || record.projectPageUrl || record.pdfUrl || "";
}

function fallbackPageLabel(record) {
  if (record.type === "paper" && /\/poster\//.test(record.pageUrl || "")) return "Official paper presentation page";
  if (record.availabilityStatus === "blocked") return `${typeLabel(record.type)} source page`;
  if (record.status === "downloaded") return "Downloaded source page";
  if (record.availabilityStatus === "metadata") return "Metadata source page";
  return "Source page";
}

function sourcePageEmbeddable(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return ![
      "icml.cc",
      "openreview.net",
      "docs.google.com",
      "drive.google.com",
      "sites.google.com",
    ].some((blockedHost) => host === blockedHost || host.endsWith(`.${blockedHost}`));
  } catch {
    return false;
  }
}

function renderSourcePageFallback(record, sourceUrl, message) {
  const canEmbed = sourcePageEmbeddable(sourceUrl);
  if (!canEmbed) {
    return renderViewerStatusRow(record, fallbackPageLabel(record), message);
  }

  return `
    <div class="source-page-shell">
      <div class="source-page-note">
        <strong>${escapeHtml(fallbackPageLabel(record))}</strong>
        <span>${escapeHtml(message)}</span>
      </div>
      <iframe src="${escapeHtml(sourceUrl)}" title="${escapeHtml(record.title)} source page"></iframe>
    </div>
  `;
}

function renderViewerStatusRow(record, title, message, statusClass = "") {
  return `
    <div class="viewer-status-row ${escapeHtml(statusClass || `status-${record.availabilityStatus || "metadata"}`)}">
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(message)}</span>
    </div>
  `;
}

function fullTextMessage(record) {
  if (record.pdfUrl) return "The PDF opens in a new tab — the abstract is shown below.";
  if (record.type === "workshop") return "The workshop PDF opens in a new tab — the abstract is shown below.";
  return "The full text is not public yet — the abstract is shown below, and the links above open the official sources.";
}

function renderPosterPreview(record, assetPath) {
  return `
    <div class="poster-preview" id="posterPreview">
      <button class="poster-zoom-toggle" type="button" aria-pressed="false" title="Click poster to enlarge. Click again to return.">
        <img src="${escapeHtml(assetUrl(assetPath))}" alt="${escapeHtml(record.title)} poster" />
      </button>
    </div>
  `;
}

function cleanAbstractLatex(value) {
  return String(value || "")
    .replace(/\[cite:\s*\d+(?:\s*,\s*\d+)*\]/gi, "")
    .replace(/\\cite(?:t|p)?\{[^{}]*\}/g, "")
    .replace(/\\(?:textit|texttt|textbf|textrm|textsc|emph|text)\{([^{}]*)\}/g, "$1")
    .replace(/\\(?:mathbb|mathbf|mathrm|mathsf|mathcal)\{([^{}]*)\}/g, "$1")
    .replace(/\$([^$]+)\$/g, (_, content) => {
      const text = String(content || "").trim();
      if (/^[A-Za-z0-9][A-Za-z0-9\s.,;:'"!?+\-/]*(?:\^[0-9]+)?$/.test(text)) return text;
      return `$${text}$`;
    })
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/\s{2,}/g, " ");
}

function renderInlineMarkdown(value) {
  let html = escapeHtml(value);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:]|$)/g, "$1<em>$2</em>");
  return html;
}

function renderSafeTextBlocks(value) {
  return String(value || "")
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      if (/^[-*]\s+/m.test(block)) {
        const items = block.split(/\n/).map((line) => line.replace(/^[-*]\s+/, "").trim()).filter(Boolean);
        return `<ul>${items.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</ul>`;
      }
      return `<p>${renderInlineMarkdown(block)}</p>`;
    })
    .join("");
}

function renderAbstractBlock(record) {
  const abstract = cleanAbstractLatex(record.abstract).trim();
  if (!abstract) return "";
  return `<div class="viewer-abstract"><h3>Abstract</h3><div class="viewer-abstract-body">${renderSafeTextBlocks(abstract)}</div></div>`;
}

export function checkedAtLabel(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(date);
}

function openStudyRecord(recordId) {
  const selected = viewerDeps.findDisplayRecord(recordId);
  if (!selected) return;
  state.selectedId = recordId;
  state.viewerMapRequested = true;
  state.viewerReferenceRequested = true;
  state.studyCompareSourceId = "";
  state.studyCompareTargetId = "";
  viewerDeps.renderResults();
  viewerDeps.renderMap();
  renderViewer(selected);
}

function mountStudyPanelActions(record) {
  els.viewerFrame.querySelectorAll("[data-study-id]").forEach((button) => {
    button.addEventListener("click", () => openStudyRecord(button.dataset.studyId));
  });
  els.viewerFrame.querySelectorAll(".compare-candidate").forEach((button) => {
    button.addEventListener("click", () => {
      state.studyCompareSourceId = record.id;
      state.studyCompareTargetId = button.dataset.compareId || "";
      renderViewer(record);
    });
  });
}

function referenceSummaryCoveredCount(summary = {}) {
  if (Object.prototype.hasOwnProperty.call(summary, "recordsWithReferences")) return Number(summary.recordsWithReferences || 0);
  if (Object.prototype.hasOwnProperty.call(summary, "matchedRecords")) return Number(summary.matchedRecords || 0);
  if (Object.prototype.hasOwnProperty.call(summary, "recordCount")) return Number(summary.recordCount || 0);
  return 0;
}

function referenceSummaryCandidateCount(summary = {}) {
  const matched = Number(summary.matchedRecords || 0);
  const unmatched = Number(summary.unmatchedRecords || 0);
  if (Object.prototype.hasOwnProperty.call(summary, "pdfRecords")) return Number(summary.pdfRecords || 0);
  if (Object.prototype.hasOwnProperty.call(summary, "matchedRecords") || Object.prototype.hasOwnProperty.call(summary, "unmatchedRecords")) return matched + unmatched;
  if (Object.prototype.hasOwnProperty.call(summary, "recordCount")) return Number(summary.recordCount || 0);
  return 0;
}

function referenceSummaryHasCandidateCount(summary = {}) {
  return Object.prototype.hasOwnProperty.call(summary, "pdfRecords")
    || Object.prototype.hasOwnProperty.call(summary, "matchedRecords")
    || Object.prototype.hasOwnProperty.call(summary, "unmatchedRecords")
    || Object.prototype.hasOwnProperty.call(summary, "recordCount");
}

export function referenceSummaryCoverageLabel(summary = {}) {
  const covered = referenceSummaryCoveredCount(summary);
  const total = referenceSummaryCandidateCount(summary);
  if (total) return `${Math.round((covered / total) * 100)}% coverage`;
  return referenceSummaryHasCandidateCount(summary) ? "0% coverage" : "coverage unknown";
}

function needsFullMetadata(record) {
  return Boolean(
    record
      && state.dataManifest
      && !state.dataShardsLoaded
      && record.type === "paper"
      && !record.abstract
      && record.mapAvailable
  );
}

export function renderViewer(record) {
  viewerDeps.destroyMiniGraph();
  destroyPdfViewer();
  els.viewerFrame.scrollTop = 0;
  if (!record) {
    els.viewerKind.textContent = "No selection";
    els.viewerTitle.textContent = "Select a record";
    els.viewerActions.innerHTML = "";
    els.viewerMeta.innerHTML = "";
    els.viewerFrame.innerHTML = `<div class="empty-state"><strong>No record selected</strong><span>Pick a result to preview its collected material.</span></div>`;
    queueMathTypeset(els.viewerFrame);
    return;
  }

  els.viewerKind.textContent = viewerKindLabel(record);
  els.viewerTitle.textContent = plainMathTitle(record.title);
  if (needsFullMetadata(record)) {
    els.viewerActions.innerHTML = "";
    els.viewerMeta.innerHTML = "";
    els.viewerFrame.innerHTML = `
      <div class="empty-state">
        <strong>Loading full metadata</strong>
        <span>Attaching abstract, semantic-map evidence, and study signals from the full paper shard.</span>
      </div>
    `;
    viewerDeps.hydrateSelectedRecord?.(record.id);
    queueMathTypeset(els.viewerFrame);
    return;
  }

  const primaryMeta = [
    ["Authors", record.authors || "Authors unavailable"],
    ["Session", uniqueChipValues([record.session, record.roomName, paperPresentationMode(record)]).join(" · ")],
    ["Type", uniqueChipValues([paperPresentationKind(record), record.group]).join(" · ")],
  ].filter(([, value]) => value);
  const secondaryMeta = uniqueChipValues([
    ...(record.presentationLabels || []),
    record.decision,
    displayAvailabilityLabel(record),
    statusLabel(record.status),
    record.type === "paper" && openReviewPdfUrl(record) ? "" : record.failureReason,
  ]);
  els.viewerMeta.innerHTML = [
    ...primaryMeta.map(([label, value]) => `<span class="viewer-meta-line">${escapeHtml(label)} <b>${escapeHtml(value)}</b></span>`),
    ...secondaryMeta.map((value) => `<span class="chip">${escapeHtml(value)}</span>`),
  ].join("");

  const preferred = record.bestAsset || "";
  const localAsset = record.localPdfPath || record.localSlidePath || record.localPosterPath;
  const actions = [
    localAsset ? actionLink(assetActionHref(record, localAsset), assetActionLabel(record), true) : "",
    !localAsset && record.pdfUrl ? actionLink(record.pdfUrl, "Open PDF (arXiv)", true) : "",
    actionLink(record.pageUrl, "Official page"),
    actionLink(record.doiUrl, "DOI"),
    record.openreviewUrl ? actionLink(record.openreviewUrl, "OpenReview") : "",
    record.projectPageUrl ? actionLink(record.projectPageUrl, "Project") : "",
  ].filter(Boolean).join("");
  els.viewerActions.innerHTML = actions;

  let abstractFirst = false;
  if (preferred && record.bestAssetKind === "poster") {
    els.viewerFrame.innerHTML = renderPosterPreview(record, preferred);
  } else if (preferred && (record.bestAssetKind === "pdf" || record.bestAssetKind === "slide")) {
    els.viewerFrame.innerHTML = renderAssetOpenFallback(record, preferred, assetUrl(preferred));
    void mountPdfViewer(preferred);
  } else if (fallbackPageUrl(record)) {
    abstractFirst = true;
    els.viewerFrame.innerHTML = renderViewerStatusRow(record, "Full text", fullTextMessage(record), "status-neutral");
  } else {
    abstractFirst = true;
    let title = "Full text";
    let message = "No public local media file was collected for this record.";
    if (record.availabilityStatus === "blocked") {
      message = record.failureReason || "The full text is not publicly downloadable yet — use the links above when it becomes available.";
    } else if (record.availabilityStatus === "metadata") {
      message = "The full text is not public in the collected official sources yet — use the links above when it becomes available.";
    } else if (record.availabilityStatus === "unavailable") {
      message = record.failureReason || "The linked source was not a direct downloadable material.";
    }
    els.viewerFrame.innerHTML = renderViewerStatusRow(record, title, message, "status-neutral");
  }
  const abstractBlock = renderAbstractBlock(record);
  if (abstractBlock) {
    // Abstract-first: when no embeddable PDF exists, the abstract IS the
    // preview area, so put it at the top of the frame.
    els.viewerFrame.insertAdjacentHTML(abstractFirst ? "afterbegin" : "beforeend", abstractBlock);
  }
  els.viewerFrame.querySelector(".poster-zoom-toggle")?.addEventListener("click", (event) => {
    const button = event.currentTarget;
    const preview = button.closest(".poster-preview");
    const zoomed = !preview.classList.contains("is-zoomed");
    preview.classList.toggle("is-zoomed", zoomed);
    button.setAttribute("aria-pressed", String(zoomed));
    if (!zoomed) preview.scrollIntoView({ block: "start" });
  });
  if (state.viewerMapRequested && record.mapAvailable && !state.mapData?.records?.length && viewerDeps.ensureMapData) {
    void viewerDeps.ensureMapData().then((payload) => {
      if (payload?.records?.length && state.selectedId === record.id) {
        renderViewer(viewerDeps.findDisplayRecord(record.id) || record);
      }
    });
  }
  const miniMap = viewerDeps.renderMiniMap(record);
  if (miniMap) {
    els.viewerFrame.insertAdjacentHTML("beforeend", miniMap);
    const neighborhood = viewerDeps.semanticNeighborhood(record);
    if (neighborhood) viewerDeps.mountMiniGraph(neighborhood.graphData, record.id);
    els.viewerFrame.querySelectorAll(".mini-graph-control").forEach((button) => {
      button.addEventListener("click", () => {
        viewerDeps.controlMiniGraph?.(button.dataset.miniAction, record);
      });
    });
    els.viewerFrame.querySelectorAll(".neighbor-item").forEach((button) => {
      button.addEventListener("click", () => {
        const selected = viewerDeps.findDisplayRecord(button.dataset.id);
        state.selectedId = button.dataset.id;
        state.viewerMapRequested = true;
        state.viewerReferenceRequested = true;
        viewerDeps.renderResults();
        viewerDeps.renderMap();
        renderViewer(selected);
      });
    });
  }
  if (record.mapAvailable && state.viewerMapRequested && !state.studyFeaturesLoaded && viewerDeps.ensureStudyFeatures) {
    void viewerDeps.ensureStudyFeatures().then(() => {
      if (state.selectedId === record.id) renderViewer(viewerDeps.findDisplayRecord(record.id) || record);
    });
  }
  const studyPanel = renderStudyPanel(record, recordStudy(record.id), viewerDeps.findDisplayRecord);
  if (studyPanel) {
    els.viewerFrame.insertAdjacentHTML("beforeend", studyPanel);
    mountStudyPanelActions(record);
  }
  els.viewerFrame.scrollTop = 0;
  queueMathTypeset(document.body);
}
