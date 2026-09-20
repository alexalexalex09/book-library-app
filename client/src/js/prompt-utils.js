/**
 * Shared helpers for promptDialog / shelf naming.
 * Loaded in the browser before app.js; also require()-able for Node unit tests.
 */

function normalizePromptResult(result, { allowEmpty = false } = {}) {
  if (typeof result !== "string") return result;
  const trimmed = result.trim();
  if (trimmed === "") return allowEmpty ? "" : null;
  return trimmed;
}

function resolveShelfName(promptResult) {
  if (promptResult === null) return null; // cancelled
  return String(promptResult || "").trim() || "Untitled Shelf";
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { normalizePromptResult, resolveShelfName };
}
