import { REFERENCES_INSIGHTS_URL, REFERENCES_MANIFEST_URL } from "./config.js";
import { versionedUrl } from "./data-loader.js";
import { state } from "./state.js";

let manifestPromise = null;
let insightsPromise = null;

async function loadManifest() {
  if (state.referencesManifestLoaded) return state.referencesManifest;
  if (!manifestPromise) {
    manifestPromise = (async () => {
      try {
        const response = await fetch(versionedUrl(REFERENCES_MANIFEST_URL, state.dataManifest?.version), { cache: "reload" });
        state.referencesManifest = response.ok ? await response.json() : null;
      } catch {
        state.referencesManifest = null;
      }
      state.referencesManifestLoaded = true;
      manifestPromise = null;
      return state.referencesManifest;
    })();
  }
  return manifestPromise;
}

export async function loadReferencesManifest() {
  return loadManifest();
}

export async function loadReferenceInsights() {
  if (state.referenceInsightsLoaded) return state.referenceInsights;
  if (!insightsPromise) {
    insightsPromise = (async () => {
      try {
        const response = await fetch(versionedUrl(REFERENCES_INSIGHTS_URL, state.referencesManifest?.generatedAt || state.dataManifest?.version), { cache: "reload" });
        state.referenceInsights = response.ok ? await response.json() : null;
      } catch {
        state.referenceInsights = null;
      }
      state.referenceInsightsLoaded = true;
      insightsPromise = null;
      return state.referenceInsights;
    })();
  }
  return insightsPromise;
}

export async function loadReferenceRecord(recordId) {
  if (!recordId) return null;
  if (state.referenceRecords.has(recordId)) return state.referenceRecords.get(recordId);
  const manifest = await loadManifest();
  const entry = manifest?.records?.[recordId];
  if (!entry?.url) {
    state.referenceRecords.set(recordId, null);
    return null;
  }
  try {
    const response = await fetch(versionedUrl(entry.url, manifest.generatedAt || state.dataManifest?.version), { cache: "reload" });
    const payload = response.ok ? await response.json() : null;
    state.referenceRecords.set(recordId, payload);
    return payload;
  } catch {
    state.referenceRecords.set(recordId, null);
    return null;
  }
}

export function referenceManifestSummary() {
  return state.referencesManifest?.summary || null;
}
