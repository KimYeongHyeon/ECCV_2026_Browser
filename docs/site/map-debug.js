import { state } from "./state.js";

export function installMapDebugProbe() {
  if (!new URLSearchParams(window.location.search).has("verify")) return;
  window.__icmlMapDebug = {
    forceZoom() {
      return state.mapGraph?.zoom?.() || null;
    },
    mapData() {
      return state.mapData || {};
    },
    mapSearchInfo() {
      return {
        seedCount: state.mapSearchSeedIds.size,
        semanticCount: state.mapSearchSemanticIds.size,
        kind: state.mapSearchKind,
        topScore: state.mapSearchTopScore,
        pending: state.mapSearchPending,
        message: state.mapSearchMessage,
        seedIds: [...state.mapSearchSeedIds],
        semanticIds: [...state.mapSearchSemanticIds],
      };
    },
    forceProbePoints(limit = 80) {
      if (!state.mapGraph || typeof state.mapGraph.graph2ScreenCoords !== "function") return [];
      return (state.mapGraphData?.nodes || []).slice(0, limit).map((node) => {
        const point = state.mapGraph.graph2ScreenCoords(node.x || 0, node.y || 0);
        return {
          x: point.x,
          y: point.y,
          title: node.title,
        };
      });
    },
    miniProbePoints(limit = 40) {
      if (!state.miniGraph || typeof state.miniGraph.graph2ScreenCoords !== "function") return [];
      const nodes = state.miniGraph.graphData?.().nodes || [];
      return nodes.slice(0, limit).map((node) => {
        const point = state.miniGraph.graph2ScreenCoords(node.x || 0, node.y || 0);
        return {
          x: point.x,
          y: point.y,
          title: node.title,
        };
      });
    },
    miniGraphInfo() {
      const graphData = state.miniGraph?.graphData?.();
      return {
        depth: state.miniGraphDepth,
        nodes: graphData?.nodes?.length || 0,
        links: graphData?.links?.length || 0,
        zoom: state.miniGraph?.zoom?.() || null,
      };
    },
  };
}
