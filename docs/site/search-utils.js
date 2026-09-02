export function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\+\+/g, " plusplus ")
    .replace(/#/g, " sharp ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function containsNormalizedPhrase(haystack, needle) {
  if (!needle) return true;
  return String(haystack || "").includes(needle);
}
