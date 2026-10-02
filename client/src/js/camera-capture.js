/**
 * Phone camera selection and still-frame orientation.
 * Loaded in the browser before app.js; also require()-able for Node unit tests.
 * Width is not an input: a wide phone and a narrow desktop are distinguished
 * by pointer and hover, not by the viewport.
 */

function isPhonePhotoSource(matchMediaFn) {
  if (typeof matchMediaFn !== "function") return false;
  const hoverNone = matchMediaFn("(hover: none)");
  const coarse = matchMediaFn("(pointer: coarse)");
  return Boolean(hoverNone && hoverNone.matches && coarse && coarse.matches);
}

function isUltraWideLabel(label) {
  return /ultra[\s-]*wide|ultrawide|fish\s*eye|fisheye/i.test(String(label || ""));
}

function isTelephotoLabel(label) {
  return /\btele(?:photo)?\b/i.test(String(label || ""));
}

function isFrontLabel(label) {
  const text = String(label || "");
  return (
    /\b(front|user|selfie)\b/i.test(text) &&
    !/\b(back|rear|environment)\b/i.test(text)
  );
}

/**
 * Pick the widest back camera that is not a fisheye or telephoto lens.
 * Empty labels mean the browser has not named the devices; keep the
 * environment track the caller already opened.
 */
function chooseBackCamera(devices) {
  const cams = (devices || []).filter((device) => device && device.deviceId);
  const labeled = cams.filter((device) => String(device.label || "").trim());
  if (!labeled.length) {
    return { deviceId: null, keepEnvironment: true, camera: null };
  }

  const back = labeled.filter((device) => !isFrontLabel(device.label));
  let pool = back.length ? back : labeled;
  const notFisheye = pool.filter((device) => !isUltraWideLabel(device.label));
  if (notFisheye.length) pool = notFisheye;
  const notTele = pool.filter((device) => !isTelephotoLabel(device.label));
  if (notTele.length) pool = notTele;

  const ranked = [...pool].sort((a, b) => {
    const aMin = Number.isFinite(a.zoomMin) ? a.zoomMin : Number.POSITIVE_INFINITY;
    const bMin = Number.isFinite(b.zoomMin) ? b.zoomMin : Number.POSITIVE_INFINITY;
    if (aMin !== bMin) return aMin - bMin;
    return String(a.label).localeCompare(String(b.label));
  });
  const camera = ranked[0];
  return { deviceId: camera.deviceId, keepEnvironment: false, camera };
}

/**
 * Zoom to apply when a track first opens.
 * A range that starts below 1 and reaches 1 uses 1, so the fisheye end is skipped.
 * Otherwise start at the widest setting of that lens.
 */
function startingZoom(zoom) {
  if (!zoom || !Number.isFinite(Number(zoom.min)) || !Number.isFinite(Number(zoom.max))) {
    return null;
  }
  const min = Number(zoom.min);
  const max = Number(zoom.max);
  if (min < 1 && max >= 1) return 1;
  if (min >= 1) return min;
  return max;
}

function describeCamera(settings, capabilities, label) {
  const zoom = capabilities && capabilities.zoom;
  const zoomRange =
    zoom && Number.isFinite(Number(zoom.min)) && Number.isFinite(Number(zoom.max))
      ? {
          min: Number(zoom.min),
          max: Number(zoom.max),
          step: Number.isFinite(Number(zoom.step)) ? Number(zoom.step) : null,
        }
      : null;
  return {
    deviceId: settings?.deviceId || null,
    label: label || "",
    facingMode: settings?.facingMode || null,
    zoom: zoomRange,
  };
}

function formatCameraReadout(record) {
  const name = record?.label || record?.deviceId || "Back camera";
  const facing = record?.facingMode ? ` (${record.facingMode})` : "";
  if (!record?.zoom) return `${name}${facing} · zoom not exposed`;
  const start = Number.isFinite(record.appliedZoom) ? ` · start ${record.appliedZoom}` : "";
  return `${name}${facing} · zoom ${record.zoom.min}–${record.zoom.max}${start}`;
}

/**
 * How to draw a camera frame so a portrait hold is stored upright.
 * Degrees are clockwise. 0 and 180 are portrait holds; 90 and 270 are landscape.
 */
function captureFrameTransform(videoWidth, videoHeight, orientationAngle) {
  const w = Number(videoWidth) || 0;
  const h = Number(videoHeight) || 0;
  const angle = ((Number(orientationAngle) || 0) % 360 + 360) % 360;
  if (!w || !h) return { rotateDeg: 0, outWidth: w, outHeight: h };
  const portraitHold = angle === 0 || angle === 180;
  const landscapeHold = angle === 90 || angle === 270;
  const frameLandscape = w >= h;
  if (portraitHold && frameLandscape) {
    return {
      rotateDeg: angle === 180 ? 270 : 90,
      outWidth: h,
      outHeight: w,
    };
  }
  if (landscapeHold && !frameLandscape) {
    return {
      rotateDeg: angle === 270 ? 90 : 270,
      outWidth: h,
      outHeight: w,
    };
  }
  return { rotateDeg: 0, outWidth: w, outHeight: h };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    isPhonePhotoSource,
    isUltraWideLabel,
    isTelephotoLabel,
    isFrontLabel,
    chooseBackCamera,
    startingZoom,
    describeCamera,
    formatCameraReadout,
    captureFrameTransform,
  };
}
