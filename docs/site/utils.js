import { MATHJAX_RETRY_LIMIT } from "./config.js";
export { containsNormalizedPhrase, normalize } from "./search-utils.js";

export function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function queueMathTypeset(root = document.body, attempt = 0) {
  if (!root) return;
  if (window.MathJax?.typesetPromise) {
    window.MathJax.typesetPromise([root]).catch(() => {});
    return;
  }
  if (attempt < MATHJAX_RETRY_LIMIT) {
    window.setTimeout(() => queueMathTypeset(root, attempt + 1), 150);
  }
}

export function plainMathTitle(value) {
  const greek = {
    alpha: "α",
    beta: "β",
    gamma: "γ",
    delta: "δ",
    epsilon: "ε",
    lambda: "λ",
    mu: "μ",
    pi: "π",
    sigma: "σ",
    theta: "θ",
  };
  let title = String(value || "");
  title = title.replaceAll("\\mathbb{R}", "ℝ");
  title = title.replaceAll("\\mathcal{O}", "O");
  title = title.replace(/\\(?:texttt|textbf|textit|mathrm|mathbf|mathsf|operatorname)\{([^{}]+)\}/g, "$1");
  title = title.replace(/\\([a-zA-Z]+)/g, (_, command) => greek[command] || command);
  title = title.replace(/\$([^$]+)\$/g, "$1");
  title = title.replace(/:([A-Za-z])/g, ": $1");
  title = title.replace(/\s+/g, " ").trim();
  return title;
}
