import { STUDY_FEATURES_URL } from "./config.js";
import { versionedUrl } from "./data-loader.js";
import { state } from "./state.js";

export async function loadStudyFeatures() {
  if (state.studyFeaturesLoaded) return state.studyFeatures;
  state.studyFeaturesLoaded = true;
  try {
    const response = await fetch(versionedUrl(STUDY_FEATURES_URL, state.dataManifest?.version), { cache: "reload" });
    state.studyFeatures = response.ok ? await response.json() : null;
  } catch {
    state.studyFeatures = null;
  }
  return state.studyFeatures;
}

export function recordStudy(recordId) {
  return state.studyFeatures?.records?.[recordId] || null;
}

export function topicLensForRecord(record) {
  if (!record?.embeddingClusterId) return null;
  return state.studyFeatures?.topics?.[record.embeddingClusterId] || null;
}

export function unusualDirectionForRecord(recordId) {
  return (state.studyFeatures?.outliers || []).find((item) => item.recordId === recordId) || null;
}
