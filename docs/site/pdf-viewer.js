import { PDFJS_MODULE_URL, PDFJS_WORKER_URL } from "./config.js";
import { els } from "./dom.js";
import { state } from "./state.js";
import { escapeHtml } from "./utils.js";

let pdfJsPromise = null;
const WHEEL_PAGE_THRESHOLD = 90;
const WHEEL_PAGE_COOLDOWN_MS = 180;
const PDF_LOAD_ATTEMPTS = 3;
const PDF_LOAD_RETRY_MS = 700;

export function isPdfAsset(path) {
  return /\.pdf(?:$|[?#])/i.test(path || "");
}

export function destroyPdfViewer() {
  state.pdfViewer.token += 1;
  state.pdfViewer.renderTask?.cancel?.();
  state.pdfViewer.loadingTask?.destroy?.();
  state.pdfViewer.renderTask = null;
  state.pdfViewer.loadingTask = null;
}

async function loadPdfJs() {
  if (!pdfJsPromise) {
    pdfJsPromise = import(PDFJS_MODULE_URL).then((pdfjsLib) => {
      pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
      return pdfjsLib;
    }).catch((error) => {
      pdfJsPromise = null;
      throw error;
    });
  }
  return pdfJsPromise;
}

function wait(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export function renderAssetOpenFallback(record, assetPath, url) {
  const canPreview = isPdfAsset(assetPath);
  const preview = canPreview
    ? `
      <div class="pdfjs-shell" data-pdf-src="${escapeHtml(url)}">
        <div class="pdfjs-toolbar" aria-label="PDF controls">
          <button type="button" class="icon-button" data-pdf-prev title="Previous page" aria-label="Previous page">‹</button>
          <span class="pdfjs-status" data-pdf-status>Loading PDF</span>
          <button type="button" class="icon-button" data-pdf-next title="Next page" aria-label="Next page">›</button>
          <button type="button" class="icon-button" data-pdf-zoom-out title="Zoom out" aria-label="Zoom out">−</button>
          <button type="button" class="icon-button" data-pdf-zoom-in title="Zoom in" aria-label="Zoom in">+</button>
          <a class="action" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">Open in new tab</a>
        </div>
        <div class="pdfjs-stage">
          <div class="pdfjs-scroll-cue">Scroll inside PDF · wheel turns pages at edges</div>
          <canvas data-pdf-canvas aria-label="${escapeHtml(record.title)} PDF preview"></canvas>
        </div>
        <div class="source-page-open pdfjs-error" data-pdf-error hidden>
          <strong>Rendered with the browser's built-in PDF viewer</strong>
          <span>The enhanced preview (pdf.js) could not be loaded; if the page below stays blank, open the PDF in a new tab.</span>
          <a class="action primary" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">Open in new tab</a>
        </div>
      </div>
    `
    : `
      <div class="source-page-open">
        <strong>Open when needed</strong>
        <span>Select the asset explicitly to view or download it.</span>
        <a class="action primary" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">Open asset</a>
      </div>
    `;
  return `
    <div class="source-page-shell asset-preview-shell">
      ${preview}
    </div>
  `;
}

function setPdfToolbarState(shell, pageNum, pageCount, isBusy = false) {
  const status = shell.querySelector("[data-pdf-status]");
  const prev = shell.querySelector("[data-pdf-prev]");
  const next = shell.querySelector("[data-pdf-next]");
  if (status) status.textContent = pageCount ? `${pageNum} / ${pageCount}` : "Loading PDF";
  if (prev) prev.disabled = isBusy || pageNum <= 1;
  if (next) next.disabled = isBusy || pageNum >= pageCount;
}

// pdf.js comes from a CDN and can be unavailable (offline demos, blocked
// networks). Every modern browser can render PDFs natively, so on failure the
// stage swaps to an <iframe> pointing at the same asset.
function mountNativePdfFallback(shell) {
  const stage = shell.querySelector(".pdfjs-stage");
  if (!stage || shell.querySelector("iframe[data-pdf-native]")) return;
  const frame = document.createElement("iframe");
  frame.setAttribute("data-pdf-native", "");
  frame.src = shell.dataset.pdfSrc || "";
  frame.title = shell.querySelector("[data-pdf-canvas]")?.getAttribute("aria-label") || "PDF preview";
  frame.className = "pdf-native-frame";
  frame.style.cssText = "width:100%;height:min(72vh,900px);border:0;background:#fff;";
  stage.removeAttribute("hidden");
  stage.replaceChildren(frame);
  shell.querySelector(".pdfjs-scroll-cue")?.setAttribute("hidden", "");
}

function showPdfError(shell) {
  mountNativePdfFallback(shell);
  shell.classList.add("has-error");
  shell.querySelector("[data-pdf-error]")?.removeAttribute("hidden");
  shell.querySelector("[data-pdf-status]").textContent = "Built-in viewer";
}

export async function mountPdfViewer(assetPath) {
  const shell = els.viewerFrame.querySelector(".pdfjs-shell");
  const canvas = shell?.querySelector("[data-pdf-canvas]");
  const stage = shell?.querySelector(".pdfjs-stage");
  if (!shell || !canvas || !stage || !isPdfAsset(assetPath)) return;

  const token = state.pdfViewer.token;
  const source = shell.dataset.pdfSrc;
  const context = canvas.getContext("2d");
  let pdfDoc = null;
  let pageNum = 1;
  let zoom = 1;
  let rendering = false;
  let pending = false;
  let wheelDelta = 0;
  let lastWheelPageTurn = 0;

  const setPage = (nextPageNum, scrollToBottom = false) => {
    if (!pdfDoc) return;
    const clampedPage = Math.max(1, Math.min(pdfDoc.numPages, nextPageNum));
    if (clampedPage === pageNum) return;
    pageNum = clampedPage;
    stage.scrollTop = scrollToBottom ? stage.scrollHeight : 0;
    void renderPage();
  };

  const canScrollStage = (deltaY) => {
    const maxScrollTop = Math.max(0, stage.scrollHeight - stage.clientHeight);
    if (maxScrollTop <= 1) return false;
    if (deltaY > 0) return stage.scrollTop < maxScrollTop - 1;
    if (deltaY < 0) return stage.scrollTop > 1;
    return false;
  };

  const handleStageWheel = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!pdfDoc || rendering) return;

    const primaryDelta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (!primaryDelta) return;

    if (canScrollStage(primaryDelta)) {
      stage.scrollTop += primaryDelta;
      wheelDelta = 0;
      return;
    }

    wheelDelta += primaryDelta;
    const now = performance.now();
    if (Math.abs(wheelDelta) < WHEEL_PAGE_THRESHOLD || now - lastWheelPageTurn < WHEEL_PAGE_COOLDOWN_MS) return;

    if (wheelDelta > 0) {
      setPage(pageNum + 1);
    } else {
      setPage(pageNum - 1, true);
    }
    wheelDelta = 0;
    lastWheelPageTurn = now;
  };

  const renderPage = async () => {
    if (!pdfDoc || token !== state.pdfViewer.token) return;
    if (rendering) {
      pending = true;
      return;
    }
    rendering = true;
    pending = false;
    setPdfToolbarState(shell, pageNum, pdfDoc.numPages, true);
    state.pdfViewer.renderTask?.cancel?.();
    try {
      const page = await pdfDoc.getPage(pageNum);
      if (token !== state.pdfViewer.token) return;
      const baseViewport = page.getViewport({ scale: 1 });
      const stageWidth = Math.max(320, stage.clientWidth - 32);
      const fitScale = Math.max(0.42, Math.min(1.8, stageWidth / baseViewport.width));
      const viewport = page.getViewport({ scale: fitScale * zoom });
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, viewport.width, viewport.height);
      const renderTask = page.render({ canvasContext: context, viewport });
      state.pdfViewer.renderTask = renderTask;
      await renderTask.promise;
      if (pageNum === 1) stage.scrollTop = 0;
      setPdfToolbarState(shell, pageNum, pdfDoc.numPages, false);
    } catch (error) {
      if (error?.name !== "RenderingCancelledException") {
        console.error("PDF preview failed", error);
        showPdfError(shell);
      }
    } finally {
      rendering = false;
      if (pending) void renderPage();
    }
  };

  try {
    for (let attempt = 1; attempt <= PDF_LOAD_ATTEMPTS; attempt += 1) {
      let loadingTask = null;
      try {
        const pdfjsLib = await loadPdfJs();
        if (token !== state.pdfViewer.token) return;
        loadingTask = pdfjsLib.getDocument({ url: source, withCredentials: false });
        state.pdfViewer.loadingTask = loadingTask;
        pdfDoc = await loadingTask.promise;
        break;
      } catch (error) {
        if (token !== state.pdfViewer.token) {
          loadingTask?.destroy?.();
          return;
        }
        if (state.pdfViewer.loadingTask === loadingTask) {
          loadingTask?.destroy?.();
          state.pdfViewer.loadingTask = null;
        }
        if (token !== state.pdfViewer.token || attempt >= PDF_LOAD_ATTEMPTS) throw error;
        await wait(PDF_LOAD_RETRY_MS * attempt);
      }
    }
    if (token !== state.pdfViewer.token) return;
    setPdfToolbarState(shell, pageNum, pdfDoc.numPages, false);
    stage.addEventListener("wheel", handleStageWheel, { passive: false });
    shell.querySelector("[data-pdf-prev]")?.addEventListener("click", () => {
      setPage(pageNum - 1);
    });
    shell.querySelector("[data-pdf-next]")?.addEventListener("click", () => {
      setPage(pageNum + 1);
    });
    shell.querySelector("[data-pdf-zoom-out]")?.addEventListener("click", () => {
      zoom = Math.max(0.65, zoom - 0.15);
      void renderPage();
    });
    shell.querySelector("[data-pdf-zoom-in]")?.addEventListener("click", () => {
      zoom = Math.min(2.4, zoom + 0.15);
      void renderPage();
    });
    void renderPage();
  } catch (error) {
    if (token !== state.pdfViewer.token || /Worker was destroyed/i.test(error?.message || "")) return;
    console.error("PDF.js load failed", error);
    showPdfError(shell);
  }
}
