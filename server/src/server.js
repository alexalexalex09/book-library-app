require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const vision = require("@google-cloud/vision");
const { createClient } = require("@supabase/supabase-js");
const path = require("path");
const sharp = require("sharp");
const ort = require("onnxruntime-node");

const app = express();
app.use(cors());

const clientPath = path.join(__dirname, "../../client/src");
app.use(express.static(clientPath));

const upload = multer({ storage: multer.memoryStorage() });

// 1. Load ONNX Model
let ortSession = null;
async function initONNX() {
  try {
    const modelPath = path.join(__dirname, "spines.onnx");
    ortSession = await ort.InferenceSession.create(modelPath);
    console.log("ONNX spine model loaded successfully.");
  } catch (err) {
    console.error("Failed to load spines.onnx model:", err);
  }
}
initONNX();

// 2. Vision & Supabase Setup
const visionConfig = {};
if (process.env.GOOGLE_CREDENTIALS) {
  try {
    visionConfig.credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  } catch (err) {
    console.error("Failed to parse GOOGLE_CREDENTIALS:", err);
  }
}
const client = new vision.ImageAnnotatorClient(visionConfig);

const rawUrl = process.env.SUPABASE_URL || "";
const rawKey = process.env.SUPABASE_ANON_KEY || "";
const supabaseUrl = rawUrl.trim().replace(/^["']|["']$/g, "");
const supabaseKey = rawKey.trim().replace(/^["']|["']$/g, "");
const supabase = createClient(supabaseUrl, supabaseKey);

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// Helper: Single Tile Inference
async function runONNXTile(tileBuffer, tileW, tileH, cropL, cropT, imgW, imgH) {
  const modelSize = 640;
  const scale = Math.min(modelSize / tileW, modelSize / tileH);
  const padX = (modelSize - tileW * scale) / 2;
  const padY = (modelSize - tileH * scale) / 2;

  const { data } = await sharp(tileBuffer)
    .removeAlpha()
    .resize(modelSize, modelSize, {
      fit: "contain",
      background: { r: 114, g: 114, b: 114 },
    })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const float32Data = new Float32Array(3 * modelSize * modelSize);
  for (let i = 0; i < modelSize * modelSize; i++) {
    float32Data[i] = data[i * 3] / 255.0;
    float32Data[modelSize * modelSize + i] = data[i * 3 + 1] / 255.0;
    float32Data[2 * modelSize * modelSize + i] = data[i * 3 + 2] / 255.0;
  }

  const tensor = new ort.Tensor("float32", float32Data, [
    1,
    3,
    modelSize,
    modelSize,
  ]);
  const inputName = ortSession.inputNames[0];
  const results = await ortSession.run({ [inputName]: tensor });

  const outputTensor = results[ortSession.outputNames[0]];
  const output = outputTensor.data;
  const dims = outputTensor.dims;
  const numChannels = dims[1];
  const numAnchors = dims[2];

  const confThreshold = 0.2;
  const boxes = [];

  for (let i = 0; i < numAnchors; i++) {
    const confidence = output[4 * numAnchors + i];

    if (confidence > confThreshold) {
      const cx = output[0 * numAnchors + i];
      const cy = output[1 * numAnchors + i];
      const w = output[2 * numAnchors + i];
      const h = output[3 * numAnchors + i];

      const angle =
        numChannels >= 6 ? output[(numChannels - 1) * numAnchors + i] : 0;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);

      const unrotatedCorners = [
        { dx: -w / 2, dy: -h / 2 },
        { dx: w / 2, dy: -h / 2 },
        { dx: w / 2, dy: h / 2 },
        { dx: -w / 2, dy: h / 2 },
      ];

      // Convert 640px model space -> tile space -> full image normalized space
      const rotatedCornersNormalized = unrotatedCorners.map((p) => {
        const x640 = cx + (p.dx * cos - p.dy * sin);
        const y640 = cy + (p.dx * sin + p.dy * cos);

        const xTilePx = (x640 - padX) / scale;
        const yTilePx = (y640 - padY) / scale;

        const xFullPx = cropL + xTilePx;
        const yFullPx = cropT + yTilePx;

        return {
          x: Math.max(0, Math.min(1, xFullPx / imgW)),
          y: Math.max(0, Math.min(1, yFullPx / imgH)),
        };
      });

      const xs = rotatedCornersNormalized.map((c) => c.x);
      const ys = rotatedCornersNormalized.map((c) => c.y);

      const realW = w / scale / imgW;
      const realH = h / scale / imgH;

      boxes.push({
        confidence,
        cx: (cropL + (cx - padX) / scale) / imgW,
        cy: (cropT + (cy - padY) / scale) / imgH,
        thickness: Math.min(realW, realH),
        length: Math.max(realW, realH),
        polygon: rotatedCornersNormalized,
        box: {
          minX: Math.min(...xs),
          minY: Math.min(...ys),
          maxX: Math.max(...xs),
          maxY: Math.max(...ys),
        },
      });
    }
  }

  return boxes;
}

// 3. Sliced Inference (Tiling Pipeline)
async function detectSpinesONNX(imageBuffer) {
  if (!ortSession) return [];

  const metadata = await sharp(imageBuffer).metadata();
  const imgW = metadata.width || 1;
  const imgH = metadata.height || 1;

  // Determine grid tiles based on resolution (2x3 for tall photos, 2x2 for medium)
  const tileCols = imgW > 1800 ? 2 : 1;
  const tileRows = imgH > 2200 ? 3 : imgH > 1200 ? 2 : 1;
  const overlap = 0.2; // 20% overlap between adjacent tiles

  const tileW = Math.ceil(imgW / tileCols);
  const tileH = Math.ceil(imgH / tileRows);

  const tilePromises = [];

  for (let r = 0; r < tileRows; r++) {
    for (let c = 0; c < tileCols; c++) {
      if (c >= tileCols) break;

      const cropL = Math.max(
        0,
        Math.floor(c * tileW - (c > 0 ? tileW * overlap : 0)),
      );
      const cropT = Math.max(
        0,
        Math.floor(r * tileH - (r > 0 ? tileH * overlap : 0)),
      );
      const cropW = Math.min(imgW - cropL, Math.ceil(tileW * (1 + overlap)));
      const cropH = Math.min(imgH - cropT, Math.ceil(tileH * (1 + overlap)));

      const promise = sharp(imageBuffer)
        .extract({ left: cropL, top: cropT, width: cropW, height: cropH })
        .toBuffer()
        .then((tileBuf) =>
          runONNXTile(tileBuf, cropW, cropH, cropL, cropT, imgW, imgH),
        );

      tilePromises.push(promise);
    }
  }

  const tileResults = await Promise.all(tilePromises);
  const allBoxes = tileResults.flat();

  // Anchor-level NMS across all slices
  allBoxes.sort((a, b) => b.confidence - a.confidence);
  const selected = [];

  for (const candidate of allBoxes) {
    let keep = true;
    for (const approved of selected) {
      const dx = Math.abs(candidate.cx - approved.cx);
      const dy = Math.abs(candidate.cy - approved.cy);

      const maxThickness = Math.max(candidate.thickness, approved.thickness);
      const maxLength = Math.max(candidate.length, approved.length);

      if (dx < maxThickness * 0.5 && dy < maxLength * 0.3) {
        keep = false;
        break;
      }
    }
    if (keep) selected.push(candidate);
  }

  return selected.map((item) => ({
    name: "spine",
    score: item.confidence,
    boundingPoly: {
      normalizedVertices: item.polygon,
    },
  }));
}

// 4. OCR Endpoint
app.post("/api/ocr", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image uploaded" });
    }

    const fileName = `shelf_${Date.now()}.jpg`;

    const imageMetadata = await sharp(req.file.buffer).metadata();
    const imgWidth = imageMetadata.width || 1;
    const imgHeight = imageMetadata.height || 1;

    const visionRequest = {
      image: { content: req.file.buffer },
      features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
    };

    const supabaseUpload = supabase.storage
      .from("shelves")
      .upload(fileName, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false,
      });

    const [[visionResult], localSpines, { error: uploadError }] =
      await Promise.all([
        client.annotateImage(visionRequest),
        detectSpinesONNX(req.file.buffer),
        supabaseUpload,
      ]);

    if (uploadError) throw uploadError;

    const { data: publicUrlData } = supabase.storage
      .from("shelves")
      .getPublicUrl(fileName);

    const words = visionResult.textAnnotations || [];

    const processedSpines = assignTextToSpines(
      localSpines,
      words,
      imgWidth,
      imgHeight,
    );

    res.json({
      spines: processedSpines,
      words: words,
      imageUrl: publicUrlData.publicUrl,
    });
  } catch (error) {
    console.error("OCR Error:", error);
    res.status(500).json({ error: "Failed to process image" });
  }
});

// 5. Google Books Endpoint
app.get("/api/books", async (req, res) => {
  const searchQuery = req.query.q;
  if (!searchQuery)
    return res.status(400).json({ error: "Missing search query" });

  const apiKey = (process.env.GOOGLE_BOOKS_API_KEY || "").trim();
  const keyParam = apiKey ? `&key=${apiKey}` : "";
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(
    searchQuery,
  )}&maxResults=1${keyParam}`;

  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    try {
      attempts++;
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "LibraryFinderApp/1.0",
        },
      });

      const data = await response.json();
      if (!response.ok) {
        if (response.status >= 500 && attempts < maxAttempts) {
          await delay(attempts * 1000);
          continue;
        } else {
          return res.status(response.status).json(data);
        }
      }
      return res.json(data);
    } catch (error) {
      if (attempts >= maxAttempts) {
        return res
          .status(500)
          .json({ error: "Failed to fetch book data after multiple attempts" });
      }
      await delay(attempts * 1000);
    }
  }
});

// Fallback Route
app.use((req, res) => {
  res.sendFile(path.join(clientPath, "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// --- HELPER FUNCTIONS ---

function assignTextToSpines(spines, words, imgWidth, imgHeight) {
  const wordList = words && words.length > 1 ? words.slice(1) : [];

  const rawMappedSpines = spines.map((spine) => {
    const onnxRotatedPolygon = spine.boundingPoly.normalizedVertices.map(
      (v) => ({
        x: v.x * imgWidth,
        y: v.y * imgHeight,
      }),
    );

    // Inflate polygon by 25% relative to its centroid for OCR word matching
    const cxPoly = onnxRotatedPolygon.reduce((s, p) => s + p.x, 0) / 4;
    const cyPoly = onnxRotatedPolygon.reduce((s, p) => s + p.y, 0) / 4;
    const inflatedPolygon = onnxRotatedPolygon.map((p) => ({
      x: cxPoly + (p.x - cxPoly) * 1.25,
      y: cyPoly + (p.y - cyPoly) * 1.25,
    }));

    const matchedWords = wordList.filter((w) => {
      const v = w.boundingPoly?.vertices || [];
      if (v.length < 4) return false;
      const cx =
        ((v[0].x || 0) + (v[1].x || 0) + (v[2].x || 0) + (v[3].x || 0)) / 4;
      const cy =
        ((v[0].y || 0) + (v[1].y || 0) + (v[2].y || 0) + (v[3].y || 0)) / 4;

      return isPointInPolygon({ x: cx, y: cy }, inflatedPolygon);
    });

    matchedWords.sort(
      (a, b) =>
        (a.boundingPoly.vertices[0].y || 0) -
        (b.boundingPoly.vertices[0].y || 0),
    );

    const title = matchedWords
      .map((w) => w.description)
      .join(" ")
      .trim();

    const xs = onnxRotatedPolygon.map((p) => p.x);
    const ys = onnxRotatedPolygon.map((p) => p.y);

    return {
      score: spine.score,
      box: {
        minX: Math.min(...xs),
        minY: Math.min(...ys),
        maxX: Math.max(...xs),
        maxY: Math.max(...ys),
      },
      rawPolygon: onnxRotatedPolygon,
      polygon: onnxRotatedPolygon,
      title: title || "Unlabeled Spine",
    };
  });

  return deduplicateSpines(rawMappedSpines);
}

function deduplicateSpines(spines) {
  if (!spines || spines.length === 0) return [];

  const sorted = [...spines].sort((a, b) => (b.score || 0) - (a.score || 0));
  const accepted = [];

  for (const candidate of sorted) {
    const polyA = candidate.rawPolygon || candidate.polygon;
    if (!polyA || polyA.length < 4) continue;

    const cxA = polyA.reduce((sum, p) => sum + p.x, 0) / polyA.length;
    const cyA = polyA.reduce((sum, p) => sum + p.y, 0) / polyA.length;

    const d01A = Math.hypot(polyA[1].x - polyA[0].x, polyA[1].y - polyA[0].y);
    const d12A = Math.hypot(polyA[2].x - polyA[1].x, polyA[2].y - polyA[1].y);
    const thicknessA = Math.min(d01A, d12A) || 50;

    let isDuplicate = false;

    for (const approved of accepted) {
      const polyB = approved.rawPolygon || approved.polygon;
      const cxB = polyB.reduce((sum, p) => sum + p.x, 0) / polyB.length;
      const cyB = polyB.reduce((sum, p) => sum + p.y, 0) / polyB.length;

      const d01B = Math.hypot(polyB[1].x - polyB[0].x, polyB[1].y - polyB[0].y);
      const d12B = Math.hypot(polyB[2].x - polyB[1].x, polyB[2].y - polyB[0].y);
      const thicknessB = Math.min(d01B, d12B) || 50;

      const centerDist = Math.hypot(cxA - cxB, cyA - cyB);
      const dx = Math.abs(cxA - cxB);
      const avgThickness = (thicknessA + thicknessB) / 2;
      const titleOverlap = getTitleWordOverlap(candidate.title, approved.title);

      if (centerDist < avgThickness * 0.45) {
        isDuplicate = true;
        break;
      }

      if (
        titleOverlap > 0.3 &&
        candidate.title !== "Unlabeled Spine" &&
        dx < avgThickness * 1.75
      ) {
        isDuplicate = true;
        break;
      }
    }

    if (!isDuplicate) {
      accepted.push(candidate);
    }
  }

  return accepted;
}

function getTitleWordOverlap(titleA, titleB) {
  if (!titleA || !titleB) return 0;
  const normalize = (t) =>
    t
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 1);

  const wordsA = new Set(normalize(titleA));
  const wordsB = new Set(normalize(titleB));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  const union = new Set([...wordsA, ...wordsB]).size;
  return intersection / union;
}

function isPointInPolygon(point, polygon) {
  let isInside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x,
      yi = polygon[i].y;
    const xj = polygon[j].x,
      yj = polygon[j].y;
    const intersect =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi;
    if (intersect) isInside = !isInside;
  }
  return isInside;
}
