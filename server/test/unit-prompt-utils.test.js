const assert = require("node:assert/strict");
const path = require("path");
const { describe, it } = require("node:test");
const {
  normalizePromptResult,
  resolveShelfName,
} = require(path.join(__dirname, "../../client/src/js/prompt-utils.js"));

describe("normalizePromptResult", () => {
  it("maps blank to null when allowEmpty is false (default)", () => {
    assert.equal(normalizePromptResult(""), null);
    assert.equal(normalizePromptResult("   "), null);
    assert.equal(normalizePromptResult("", { allowEmpty: false }), null);
  });

  it("keeps empty string when allowEmpty is true", () => {
    assert.equal(normalizePromptResult("", { allowEmpty: true }), "");
    assert.equal(normalizePromptResult("  ", { allowEmpty: true }), "");
  });

  it("trims non-empty strings", () => {
    assert.equal(normalizePromptResult("  Living Room  "), "Living Room");
    assert.equal(
      normalizePromptResult("  Living Room  ", { allowEmpty: true }),
      "Living Room",
    );
  });

  it("passes through non-string results (cancel)", () => {
    assert.equal(normalizePromptResult(null), null);
    assert.equal(normalizePromptResult(null, { allowEmpty: true }), null);
  });
});

describe("resolveShelfName", () => {
  it("returns null when prompt was cancelled", () => {
    assert.equal(resolveShelfName(null), null);
  });

  it("uses Untitled Shelf for blank confirmed names", () => {
    assert.equal(resolveShelfName(""), "Untitled Shelf");
    assert.equal(resolveShelfName("   "), "Untitled Shelf");
  });

  it("preserves a non-empty name", () => {
    assert.equal(resolveShelfName("Kitchen"), "Kitchen");
    assert.equal(resolveShelfName("  Kitchen  "), "Kitchen");
  });

  it("blank allowEmpty confirm flows to Untitled Shelf", () => {
    const promptResult = normalizePromptResult("   ", { allowEmpty: true });
    assert.equal(promptResult, "");
    assert.equal(resolveShelfName(promptResult), "Untitled Shelf");
  });
});
