export function createMapCoreConceptHandoff(topicLabel) {
  const mapCoreConceptFilter = String(topicLabel || "").trim();
  if (!mapCoreConceptFilter) return null;
  return {
    tab: "map",
    query: "",
    selectedId: "",
    mapCoreConceptFilter,
  };
}

export function clearMapCoreConceptFilter(mapState) {
  mapState.mapCoreConceptFilter = "";
}
