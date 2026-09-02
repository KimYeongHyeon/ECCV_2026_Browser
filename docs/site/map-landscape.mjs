export function matchesLandscapeCluster(record, landscapeClusterId = "") {
  return !landscapeClusterId || record?.embeddingClusterId === landscapeClusterId;
}
