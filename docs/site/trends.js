import { TRENDS_URL } from "./config.js";
import { versionedUrl } from "./data-loader.js";
import { state } from "./state.js";

export async function loadTrends() {
  if (state.trendsLoaded) return state.trendData;
  state.trendsLoaded = true;
  try {
    const response = await fetch(versionedUrl(TRENDS_URL, state.dataManifest?.version), { cache: "reload" });
    state.trendData = response.ok ? await response.json() : null;
  } catch {
    state.trendData = null;
  }
  return state.trendData;
}
