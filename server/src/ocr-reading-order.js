const { toBookTitleCase } = require("./title-case");

/**
 * Orientation-aware reading order for OCR words on book spines.
 * Words may include optional angleDeg (from Vision boundingPoly); missing
 * angles fall back to spine aspect-ratio sorting (legacy behavior).
 */

const BIN_TOLERANCE_DEG = 30;
const LINE_CLUSTER_THRESH = 0.02;
const COLUMN_SPREAD_THRESH = 0.03;

/** Normalize an angle in degrees to [0, 360). */
function normalizeAngleDeg(angleDeg) {
  if (!Number.isFinite(angleDeg)) return null;
  let a = angleDeg % 360;
  if (a < 0) a += 360;
  return a;
}

/**
 * Estimate text angle from Vision boundingPoly vertices (edge v0 → v1).
 * Returns degrees in [0, 360), or null if vertices are unusable.
 */
function angleFromVertices(vertices) {
  if (!Array.isArray(vertices) || vertices.length < 2) return null;
  const x0 = vertices[0].x || 0;
  const y0 = vertices[0].y || 0;
  const x1 = vertices[1].x || 0;
  const y1 = vertices[1].y || 0;
  const dx = x1 - x0;
  const dy = y1 - y0;
  if (dx === 0 && dy === 0) return null;
  return normalizeAngleDeg((Math.atan2(dy, dx) * 180) / Math.PI);
}

/**
 * Map angle to orientation bin:
 * 0 = horizontal upright, 90 = vertical (reading T→B),
 * 180 = upside-down horizontal, 270 = vertical opposite.
 */
function orientationBin(angleDeg) {
  const a = normalizeAngleDeg(angleDeg);
  if (a === null) return null;
  const targets = [0, 90, 180, 270];
  let best = 0;
  let bestDist = Infinity;
  for (const t of targets) {
    let d = Math.abs(a - t);
    if (d > 180) d = 360 - d;
    if (d < bestDist) {
      bestDist = d;
      best = t;
    }
  }
  return bestDist <= BIN_TOLERANCE_DEG ? best : null;
}

function wordCenter(word) {
  if (Number.isFinite(word.x) && Number.isFinite(word.y)) {
    return { x: word.x, y: word.y };
  }
  const box = word.box;
  if (!box) return { x: 0, y: 0 };
  return {
    x: (box.minX + box.maxX) / 2,
    y: (box.minY + box.maxY) / 2,
  };
}

function enrichWord(word) {
  const c = wordCenter(word);
  const angle =
    Number.isFinite(word.angleDeg) ? word.angleDeg : angleFromVertices(word.vertices);
  return {
    text: word.text || "",
    x: c.x,
    y: c.y,
    angleDeg: normalizeAngleDeg(angle),
    bin: orientationBin(angle),
  };
}

function clusterByY(words, thresh = LINE_CLUSTER_THRESH) {
  const sorted = [...words].sort((a, b) => a.y - b.y);
  const lines = [];
  for (const w of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last[0].y - w.y) <= thresh) {
      last.push(w);
    } else {
      lines.push([w]);
    }
  }
  return lines;
}

function clusterByAdjacent(words, key, thresh) {
  const sorted = [...words].sort((a, b) => a[key] - b[key]);
  const groups = [];
  for (const w of sorted) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(last[last.length - 1][key] - w[key]) <= thresh) {
      last.push(w);
    } else {
      groups.push([w]);
    }
  }
  return groups;
}

/** Circular mean of word angles, or null when none are known. */
function meanAngleDeg(words) {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const w of words) {
    if (!Number.isFinite(w.angleDeg)) continue;
    const rad = (w.angleDeg * Math.PI) / 180;
    sx += Math.cos(rad);
    sy += Math.sin(rad);
    n++;
  }
  if (!n) return null;
  return normalizeAngleDeg((Math.atan2(sy, sx) * 180) / Math.PI);
}

/**
 * Angle whose reading vector points downward (image +y).
 * Bottom-to-top spines are flipped so column order stays top-to-bottom
 * before sortVerticalUp reverses it.
 */
function downwardReadingAngle(words) {
  const angle = meanAngleDeg(words);
  if (angle == null) return 90;
  const rad = (angle * Math.PI) / 180;
  if (Math.sin(rad) < 0) return normalizeAngleDeg(angle + 180);
  return angle;
}

function projectOntoReadingAngle(word, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  const alongX = Math.cos(rad);
  const alongY = Math.sin(rad);
  return {
    ...word,
    along: word.x * alongX + word.y * alongY,
    across: word.x * -alongY + word.y * alongX,
  };
}

/** Horizontal upright: lines T→B, words L→R within line. */
function sortHorizontalUpright(words) {
  const lines = clusterByY(words);
  const ordered = [];
  for (const line of lines) {
    line.sort((a, b) => a.x - b.x);
    ordered.push(...line);
  }
  return ordered;
}

/** Upside-down horizontal: reverse of upright. */
function sortHorizontalUpsideDown(words) {
  return sortHorizontalUpright(words).reverse();
}

/**
 * Vertical reading down the spine (T→B). Columns are separated on the axis
 * perpendicular to the text angle. A tilted single line drifts in x and must
 * not be split into right-to-left columns. Multiple real columns are still
 * read R→L, then along the reading direction within each column.
 */
function sortVerticalDown(words) {
  if (words.length <= 1) return [...words];
  const angle = downwardReadingAngle(words);
  const projected = words.map((w) => projectOntoReadingAngle(w, angle));
  const acrossValues = projected.map((w) => w.across);
  const spread = Math.max(...acrossValues) - Math.min(...acrossValues);
  if (spread < COLUMN_SPREAD_THRESH) {
    return projected.sort((a, b) => a.along - b.along || a.x - b.x);
  }
  const cols = clusterByAdjacent(
    projected,
    "across",
    Math.max(LINE_CLUSTER_THRESH, spread / 4),
  );
  // Right-to-left columns
  cols.sort((a, b) => {
    const ax = a.reduce((s, w) => s + w.x, 0) / a.length;
    const bx = b.reduce((s, w) => s + w.x, 0) / b.length;
    return bx - ax;
  });
  const ordered = [];
  for (const col of cols) {
    col.sort((a, b) => a.along - b.along || a.y - b.y);
    ordered.push(...col);
  }
  return ordered;
}

/** Opposite vertical (bottom→top lettering): reverse of vertical-down. */
function sortVerticalUp(words) {
  return sortVerticalDown(words).reverse();
}

function sortClusterByBin(words, bin) {
  switch (bin) {
    case 0:
      return sortHorizontalUpright(words);
    case 90:
      return sortVerticalDown(words);
    case 180:
      return sortHorizontalUpsideDown(words);
    case 270:
      return sortVerticalUp(words);
    default:
      return [...words].sort((a, b) => a.y - b.y || a.x - b.x);
  }
}

function clusterCentroid(words) {
  if (!words.length) return { x: 0, y: 0 };
  return {
    x: words.reduce((s, w) => s + w.x, 0) / words.length,
    y: words.reduce((s, w) => s + w.y, 0) / words.length,
  };
}

/**
 * Legacy fallback: single-axis sort by spine aspect ratio (no angles).
 */
function assembleSpineTitleLegacy(matchedWords, spineBox) {
  const words = matchedWords.map((w) => enrichWord(w));
  const isHorizontal =
    spineBox &&
    spineBox.maxX - spineBox.minX > spineBox.maxY - spineBox.minY;
  words.sort((a, b) => (isHorizontal ? a.x - b.x : a.y - b.y));
  return toBookTitleCase(
    words
      .map((w) => w.text)
      .join(" ")
      .trim(),
  );
}

/**
 * Assemble a spine title from matched OCR words using orientation clusters.
 * @param {Array<{text:string, x?:number, y?:number, box?:object, angleDeg?:number, vertices?:Array}>} matchedWords
 * @param {{minX:number,maxX:number,minY:number,maxY:number}|null} spineBox
 * @returns {string}
 */
function assembleSpineTitle(matchedWords, spineBox) {
  if (!matchedWords || matchedWords.length === 0) return "";

  const enriched = matchedWords.map(enrichWord).filter((w) => w.text);
  if (enriched.length === 0) return "";

  const hasAngles = enriched.some((w) => w.bin !== null);
  if (!hasAngles) {
    return assembleSpineTitleLegacy(matchedWords, spineBox);
  }

  // Assign unknown bins to the dominant known bin, or infer from spine shape.
  const known = enriched.filter((w) => w.bin !== null);
  const binCounts = new Map();
  for (const w of known) {
    binCounts.set(w.bin, (binCounts.get(w.bin) || 0) + 1);
  }
  let dominantBin = 0;
  let dominantCount = -1;
  for (const [bin, count] of binCounts) {
    if (count > dominantCount) {
      dominantCount = count;
      dominantBin = bin;
    }
  }
  if (known.length === 0) {
    const isHorizontal =
      spineBox &&
      spineBox.maxX - spineBox.minX > spineBox.maxY - spineBox.minY;
    dominantBin = isHorizontal ? 0 : 90;
  }

  for (const w of enriched) {
    if (w.bin === null) w.bin = dominantBin;
  }

  const byBin = new Map();
  for (const w of enriched) {
    if (!byBin.has(w.bin)) byBin.set(w.bin, []);
    byBin.get(w.bin).push(w);
  }

  const clusters = [...byBin.entries()].map(([bin, words]) => ({
    bin,
    words,
    count: words.length,
    centroid: clusterCentroid(words),
  }));

  // Largest cluster first; remaining by spatial order (topmost, then leftmost).
  clusters.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    if (a.centroid.y !== b.centroid.y) return a.centroid.y - b.centroid.y;
    return a.centroid.x - b.centroid.x;
  });

  const parts = [];
  for (const cluster of clusters) {
    const ordered = sortClusterByBin(cluster.words, cluster.bin);
    const text = ordered
      .map((w) => w.text)
      .join(" ")
      .trim();
    if (text) parts.push(text);
  }

  return toBookTitleCase(parts.join(" ").trim());
}

module.exports = {
  assembleSpineTitle,
  assembleSpineTitleLegacy,
  angleFromVertices,
  orientationBin,
  normalizeAngleDeg,
  sortVerticalDown,
  sortHorizontalUpright,
  sortHorizontalUpsideDown,
};
