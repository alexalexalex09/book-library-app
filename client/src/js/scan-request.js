/**
 * Generation tokens for in-flight shelf scans.
 * Loaded in the browser before app.js; also require()-able for Node unit tests.
 *
 * OCR + auto-match are async. A newer upload/crop/rescan must invalidate
 * older responses so they cannot overlay spines onto the wrong photo.
 */

function createScanRequestGuard() {
  let currentId = 0;

  return {
    get current() {
      return currentId;
    },
    begin() {
      currentId += 1;
      return currentId;
    },
    isCurrent(requestId) {
      return requestId === currentId;
    },
    isAbortError(error) {
      return Boolean(
        error &&
          (error.name === "AbortError" ||
            error.code === "ABORT_ERR" ||
            /aborted|AbortError/i.test(String(error.message || ""))),
      );
    },
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { createScanRequestGuard };
}
