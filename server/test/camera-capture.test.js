const assert = require("node:assert/strict");
const path = require("path");
const { describe, it } = require("node:test");
const {
  isPhonePhotoSource,
  chooseBackCamera,
  startingZoom,
  describeCamera,
  formatCameraReadout,
  captureFrameTransform,
} = require(path.join(__dirname, "../../client/src/js/camera-capture.js"));

function matchMedia(map) {
  return (query) => ({ matches: Boolean(map[query]), media: query });
}

describe("phone photo source", () => {
  it("uses a coarse pointer without hover at any width", () => {
    assert.equal(
      isPhonePhotoSource(
        matchMedia({ "(hover: none)": true, "(pointer: coarse)": true }),
      ),
      true,
    );
  });

  it("keeps a fine pointer on the library picker even when hover is absent", () => {
    assert.equal(
      isPhonePhotoSource(
        matchMedia({ "(hover: none)": true, "(pointer: coarse)": false }),
      ),
      false,
    );
  });

  it("keeps a desktop with hover on the library picker", () => {
    assert.equal(
      isPhonePhotoSource(
        matchMedia({ "(hover: none)": false, "(pointer: coarse)": true }),
      ),
      false,
    );
  });
});

describe("back camera selection", () => {
  it("keeps the environment track when labels are empty", () => {
    const choice = chooseBackCamera([
      { deviceId: "a", label: "" },
      { deviceId: "b", label: "   " },
    ]);
    assert.equal(choice.keepEnvironment, true);
    assert.equal(choice.deviceId, null);
  });

  it("skips fisheye and telephoto and starts from the widest remaining back lens", () => {
    const choice = chooseBackCamera([
      { deviceId: "ultra", label: "Back Ultra Wide Camera", zoomMin: 0.5 },
      { deviceId: "tele", label: "Back Telephoto Camera", zoomMin: 2 },
      { deviceId: "wide", label: "Back Camera", zoomMin: 1 },
      { deviceId: "front", label: "Front Camera", zoomMin: 1 },
    ]);
    assert.equal(choice.deviceId, "wide");
  });

  it("prefers the smaller zoom minimum among non-fisheye back cameras", () => {
    const choice = chooseBackCamera([
      { deviceId: "tight", label: "Back Camera 2", zoomMin: 1.4 },
      { deviceId: "wide", label: "Back Camera", zoomMin: 1 },
    ]);
    assert.equal(choice.deviceId, "wide");
  });
});

describe("starting zoom", () => {
  it("skips the fisheye end of a range that includes 1", () => {
    assert.equal(startingZoom({ min: 0.5, max: 8, step: 0.1 }), 1);
  });

  it("starts at the widest setting when the lens is already at 1 or tighter", () => {
    assert.equal(startingZoom({ min: 1, max: 5 }), 1);
    assert.equal(startingZoom({ min: 2, max: 10 }), 2);
  });

  it("records that zoom is not exposed", () => {
    assert.equal(startingZoom(null), null);
    const record = describeCamera(
      { deviceId: "cam", facingMode: "environment" },
      {},
      "Back Camera",
    );
    assert.equal(record.zoom, null);
    assert.match(formatCameraReadout(record), /zoom not exposed/);
  });

  it("records the zoom range and the applied start", () => {
    const record = describeCamera(
      { deviceId: "cam", facingMode: "environment" },
      { zoom: { min: 0.5, max: 4, step: 0.1 } },
      "Back Camera",
    );
    record.appliedZoom = startingZoom(record.zoom);
    assert.equal(record.appliedZoom, 1);
    assert.match(formatCameraReadout(record), /zoom 0\.5–4 · start 1/);
  });
});

describe("portrait capture", () => {
  it("rotates a landscape frame when the phone is held upright", () => {
    const transform = captureFrameTransform(1920, 1080, 0);
    assert.equal(transform.rotateDeg, 90);
    assert.equal(transform.outWidth, 1080);
    assert.equal(transform.outHeight, 1920);
  });

  it("leaves an already-portrait frame upright", () => {
    const transform = captureFrameTransform(1080, 1920, 0);
    assert.equal(transform.rotateDeg, 0);
    assert.equal(transform.outWidth, 1080);
    assert.equal(transform.outHeight, 1920);
  });

  it("leaves a landscape hold on a landscape frame", () => {
    const transform = captureFrameTransform(1920, 1080, 90);
    assert.equal(transform.rotateDeg, 0);
    assert.equal(transform.outWidth, 1920);
    assert.equal(transform.outHeight, 1080);
  });
});
