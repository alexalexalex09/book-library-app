const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  resolveNormalizationSize,
  mapContainPixelToImageNormalized,
  mapPolygonFromRleMaskSpace,
} = require("../src/image-geometry");

describe("resolveNormalizationSize", () => {
  it("prefers oriented dimensions when available", () => {
    const size = resolveNormalizationSize({
      storedWidth: 4032,
      storedHeight: 3024,
      orientedWidth: 3024,
      orientedHeight: 4032,
    });
    assert.equal(size.width, 3024);
    assert.equal(size.height, 4032);
  });

  it("falls back to stored dimensions when oriented metadata is missing", () => {
    const size = resolveNormalizationSize({
      storedWidth: 1600,
      storedHeight: 900,
      orientedWidth: 0,
      orientedHeight: undefined,
    });
    assert.equal(size.width, 1600);
    assert.equal(size.height, 900);
  });
});

describe("letterbox geometry mapping", () => {
  it("maps square-mask coordinates back to a portrait image with horizontal padding", () => {
    const dims = {
      inferenceWidth: 640,
      inferenceHeight: 640,
      imageWidth: 3000,
      imageHeight: 4000,
    };

    const leftEdge = mapContainPixelToImageNormalized({
      pixelX: 80,
      pixelY: 0,
      ...dims,
    });
    const rightEdge = mapContainPixelToImageNormalized({
      pixelX: 560,
      pixelY: 640,
      ...dims,
    });

    assert.ok(Math.abs(leftEdge.x - 0) < 1e-9);
    assert.ok(Math.abs(leftEdge.y - 0) < 1e-9);
    assert.ok(Math.abs(rightEdge.x - 1) < 1e-9);
    assert.ok(Math.abs(rightEdge.y - 1) < 1e-9);
  });

  it("unletterboxes RLE-space polygons before returning normalized points", () => {
    const poly = mapPolygonFromRleMaskSpace(
      [
        { x: 80 / 640, y: 0 / 640 },
        { x: 560 / 640, y: 640 / 640 },
      ],
      {
        maskWidth: 640,
        maskHeight: 640,
        imageWidth: 3000,
        imageHeight: 4000,
      },
    );

    assert.equal(poly.length, 2);
    assert.ok(Math.abs(poly[0].x - 0) < 1e-9);
    assert.ok(Math.abs(poly[1].x - 1) < 1e-9);
  });
});
