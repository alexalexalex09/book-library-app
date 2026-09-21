const assert = require("node:assert/strict");
const path = require("path");
const { describe, it } = require("node:test");
const {
  createScanRequestGuard,
} = require(path.join(__dirname, "../../client/src/js/scan-request.js"));

describe("createScanRequestGuard", () => {
  it("treats only the latest begin() id as current", () => {
    const guard = createScanRequestGuard();
    const first = guard.begin();
    const second = guard.begin();

    assert.equal(first, 1);
    assert.equal(second, 2);
    assert.equal(guard.current, 2);
    assert.equal(guard.isCurrent(first), false);
    assert.equal(guard.isCurrent(second), true);
  });

  it("ignores a stale OCR payload after a newer scan starts", async () => {
    const guard = createScanRequestGuard();
    let applied = null;

    async function fakeRunShelfOcr(photo, delayMs) {
      const requestId = guard.begin();
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (!guard.isCurrent(requestId)) return;
      applied = photo;
    }

    const first = fakeRunShelfOcr("photo-a", 30);
    const second = fakeRunShelfOcr("photo-b", 5);
    await Promise.all([first, second]);

    assert.equal(applied, "photo-b");
  });

  it("does not apply a duplicate-shelf redirect from a superseded scan", async () => {
    const guard = createScanRequestGuard();
    let navigatedTo = null;

    async function handleOcrResponse(data, requestId) {
      if (!guard.isCurrent(requestId)) return;
      if (data.duplicate) {
        navigatedTo = data.shelfId;
      }
    }

    const staleId = guard.begin();
    const liveId = guard.begin();
    await handleOcrResponse({ duplicate: true, shelfId: 11 }, staleId);
    await handleOcrResponse({ duplicate: false, shelfId: null }, liveId);

    assert.equal(navigatedTo, null);
  });

  it("identifies fetch AbortError so callers can skip failure toasts", () => {
    const guard = createScanRequestGuard();
    const abortError = new Error("The operation was aborted.");
    abortError.name = "AbortError";
    assert.equal(guard.isAbortError(abortError), true);
    assert.equal(guard.isAbortError(new Error("Scan failed")), false);
    assert.equal(guard.isAbortError(null), false);
  });
});
