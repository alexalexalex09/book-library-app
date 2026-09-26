const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  assembleSpineTitle,
  assembleSpineTitleLegacy,
  angleFromVertices,
  orientationBin,
  sortVerticalDown,
  sortHorizontalUpright,
} = require("../src/ocr-reading-order");

const tallSpine = { minX: 0.4, maxX: 0.55, minY: 0.1, maxY: 0.9 };
const wideSpine = { minX: 0.1, maxX: 0.9, minY: 0.4, maxY: 0.55 };

describe("angleFromVertices / orientationBin", () => {
  it("estimates ~0° from a horizontal edge", () => {
    const angle = angleFromVertices([
      { x: 0, y: 10 },
      { x: 20, y: 10 },
    ]);
    assert.equal(orientationBin(angle), 0);
  });

  it("estimates ~90° from a vertical edge", () => {
    const angle = angleFromVertices([
      { x: 10, y: 0 },
      { x: 10, y: 20 },
    ]);
    assert.equal(orientationBin(angle), 90);
  });

  it("estimates ~180° from a leftward edge", () => {
    const angle = angleFromVertices([
      { x: 20, y: 10 },
      { x: 0, y: 10 },
    ]);
    assert.equal(orientationBin(angle), 180);
  });
});

describe("assembleSpineTitle — vertical T→B R→L", () => {
  it("reads right column then left column top-to-bottom", () => {
    // Two vertical columns; Vision-like emission order is L→R within rows.
    const words = [
      { text: "LeftTop", x: 0.42, y: 0.2, angleDeg: 90 },
      { text: "RightTop", x: 0.52, y: 0.2, angleDeg: 90 },
      { text: "LeftBot", x: 0.42, y: 0.7, angleDeg: 90 },
      { text: "RightBot", x: 0.52, y: 0.7, angleDeg: 90 },
    ];
    const title = assembleSpineTitle(words, tallSpine);
    assert.equal(title, "RightTop RightBot LeftTop LeftBot");
  });

  it("keeps a tilted single-line spine in top-to-bottom order", () => {
    // Logged shelf scan: ~64° text drifts in x, previously split into R→L columns.
    const words = [
      { text: "LONG", x: 0.457, y: 0.386, angleDeg: 66 },
      { text: "ACCOMPANY", x: 0.485, y: 0.429, angleDeg: 64 },
      { text: "THEM", x: 0.505, y: 0.459, angleDeg: 64 },
      { text: "WITH", x: 0.517, y: 0.479, angleDeg: 63 },
      { text: "SINGING", x: 0.532, y: 0.502, angleDeg: 64 },
      { text: "-", x: 0.543, y: 0.519, angleDeg: 65 },
      { text: "THE", x: 0.549, y: 0.529, angleDeg: 64 },
      { text: "CHRISTIAN", x: 0.567, y: 0.556, angleDeg: 64 },
      { text: "FUNERAL", x: 0.59, y: 0.592, angleDeg: 64 },
    ];
    assert.equal(
      assembleSpineTitle(words, tallSpine),
      "Long Accompany Them with Singing - the Christian Funeral",
    );
  });

  it("sorts a single vertical column top-to-bottom", () => {
    const words = [
      { text: "C", x: 0.5, y: 0.7, angleDeg: 90 },
      { text: "A", x: 0.5, y: 0.2, angleDeg: 90 },
      { text: "B", x: 0.5, y: 0.45, angleDeg: 90 },
    ];
    assert.equal(assembleSpineTitle(words, tallSpine), "A B C");
  });
});

describe("assembleSpineTitle — upside-down", () => {
  it("reverses upside-down horizontal tokens into readable order", () => {
    // Tokens stored top-to-bottom as seen on an inverted spine (last word first visually at top).
    const words = [
      { text: "World", x: 0.7, y: 0.45, angleDeg: 180 },
      { text: "Hello", x: 0.3, y: 0.45, angleDeg: 180 },
    ];
    // sortHorizontalUpsideDown reverses L→R upright → Hello World becomes World Hello then reverse → Hello World
    // Upright L→R of positions: Hello (0.3) then World (0.7) → "Hello World"; reverse → "World Hello"
    // For upside-down spines the physical reading order should be the reverse of the AABB L→R sort.
    const title = assembleSpineTitle(words, wideSpine);
    assert.equal(title, "World Hello");
  });
});

describe("assembleSpineTitle — mixed orientations", () => {
  it("puts the dominant vertical cluster first, then horizontal badge text", () => {
    const words = [
      { text: "Badge", x: 0.48, y: 0.15, angleDeg: 0 },
      { text: "The", x: 0.5, y: 0.35, angleDeg: 90 },
      { text: "Hobbit", x: 0.5, y: 0.55, angleDeg: 90 },
      { text: "Tolkien", x: 0.5, y: 0.75, angleDeg: 90 },
    ];
    const title = assembleSpineTitle(words, tallSpine);
    assert.equal(title, "The Hobbit Tolkien Badge");
  });
});

describe("assembleSpineTitle — legacy fallback", () => {
  it("falls back to aspect-ratio sort when angles are missing", () => {
    const words = [
      { text: "B", x: 0.5, y: 0.6 },
      { text: "A", x: 0.5, y: 0.3 },
    ];
    assert.equal(assembleSpineTitle(words, tallSpine), "A B");
    assert.equal(assembleSpineTitleLegacy(words, tallSpine), "A B");
  });

  it("sorts wide spines left-to-right without angles", () => {
    const words = [
      { text: "Two", x: 0.6, y: 0.5 },
      { text: "One", x: 0.2, y: 0.5 },
    ];
    assert.equal(assembleSpineTitle(words, wideSpine), "One Two");
  });
});

describe("sort helpers", () => {
  it("sortHorizontalUpright groups lines top-to-bottom", () => {
    const words = [
      { text: "b", x: 0.6, y: 0.2 },
      { text: "a", x: 0.2, y: 0.2 },
      { text: "c", x: 0.3, y: 0.5 },
    ];
    const ordered = sortHorizontalUpright(words).map((w) => w.text);
    assert.deepEqual(ordered, ["a", "b", "c"]);
  });

  it("sortVerticalDown uses R→L columns when spread is large", () => {
    const words = [
      { text: "L1", x: 0.4, y: 0.2 },
      { text: "R1", x: 0.6, y: 0.2 },
      { text: "L2", x: 0.4, y: 0.6 },
      { text: "R2", x: 0.6, y: 0.6 },
    ];
    const ordered = sortVerticalDown(words).map((w) => w.text);
    assert.deepEqual(ordered, ["R1", "R2", "L1", "L2"]);
  });
});
