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

// 1. Load ONNX Spine Detection Model
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

// 2. Google Vision & Supabase Setup
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

// Helper: Run ONNX Inference & NMS Post-Processing
async function detectSpinesONNX(imageBuffer) {
  if (!ortSession) return [];

  const modelSize = 640;

  const metadata = await sharp(imageBuffer).metadata();
  const imgWidth = metadata.width || 1;
  const imgHeight = metadata.height || 1;

  const scale = Math.min(modelSize / imgWidth, modelSize / imgHeight);
  const padX = (modelSize - imgWidth * scale) / 2;
  const padY = (modelSize - imgHeight * scale) / 2;

  const { data } = await sharp(imageBuffer)
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

  // 🛑 Lowered threshold to 0.20 to catch lower confidence spines (e.g. 0.28)
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

      const rotatedCornersNormalized = unrotatedCorners.map((p) => {
        const x640 = cx + (p.dx * cos - p.dy * sin);
        const y640 = cy + (p.dx * sin + p.dy * cos);

        const xOrigPx = (x640 - padX) / scale;
        const yOrigPx = (y640 - padY) / scale;

        return {
          x: Math.max(0, Math.min(1, xOrigPx / imgWidth)),
          y: Math.max(0, Math.min(1, yOrigPx / imgHeight)),
        };
      });

      const xs = rotatedCornersNormalized.map((c) => c.x);
      const ys = rotatedCornersNormalized.map((c) => c.y);

      // Temporary debug log inside the anchor loop:
      if (confidence > 0.05) {
        console.log(
          `Candidate at cx:${cx.toFixed(2)}, cy:${cy.toFixed(2)} | Confidence: ${confidence.toFixed(2)}`,
        );
      }

      boxes.push({
        confidence,
        cx: (cx - padX) / scale / imgWidth,
        cy: (cy - padY) / scale / imgHeight,
        w: w / scale / imgWidth,
        h: h / scale / imgHeight,
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

  // Center-Distance NMS optimized for tall/narrow book spines
  boxes.sort((a, b) => b.confidence - a.confidence);
  const selected = [];

  for (const candidate of boxes) {
    let keep = true;
    for (const approved of selected) {
      const dx = Math.abs(candidate.cx - approved.cx);
      const dy = Math.abs(candidate.cy - approved.cy);
      const maxW = Math.max(candidate.w, approved.w);
      const maxH = Math.max(candidate.h, approved.h);

      // Suppress duplicate detections targeting the same physical spine
      if (dx < maxW * 0.65 && dy < maxH * 0.55) {
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

// IoU Helper for NMS
function calculateIoU(a, b) {
  const interMinX = Math.max(a.minX, b.minX);
  const interMinY = Math.max(a.minY, b.minY);
  const interMaxX = Math.min(a.maxX, b.maxX);
  const interMaxY = Math.min(a.maxY, b.maxY);

  const interWidth = Math.max(0, interMaxX - interMinX);
  const interHeight = Math.max(0, interMaxY - interMinY);
  const interArea = interWidth * interHeight;

  const areaA = (a.maxX - a.minX) * (a.maxY - a.minY);
  const areaB = (b.maxX - b.minX) * (b.maxY - b.minY);

  return interArea / (areaA + areaB - interArea);
}

// 3. OCR Endpoint
app.post("/api/ocr", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image uploaded" });
    }

    const fileName = `shelf_${Date.now()}.jpg`;

    // 1. Fetch image dimensions using sharp
    const imageMetadata = await sharp(req.file.buffer).metadata();
    const imgWidth = imageMetadata.width || 1;
    const imgHeight = imageMetadata.height || 1;

    // 2. Prepare Vision OCR and Supabase upload tasks
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

    // 3. Execute detection, OCR, and upload concurrently
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

    // 4. Map OCR text directly into ONNX spine bounding boxes
    const processedSpines = assignTextToSpines(
      localSpines,
      words,
      imgWidth,
      imgHeight,
    );

    res.json({
      spines: processedSpines, // Server-constructed final spines
      words: words,
      imageUrl: publicUrlData.publicUrl,
    });
  } catch (error) {
    console.error("OCR Error:", error);
    res.status(500).json({ error: "Failed to process image" });
  }
});

// 4. Google Books Endpoint
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

function assignTextToSpines(spines, words, imgWidth, imgHeight) {
  const wordList = words && words.length > 1 ? words.slice(1) : [];

  return spines.map((spine) => {
    // 1. Scale the exact 4 rotated OBB corners from ONNX to image pixel space
    const onnxRotatedPolygon = spine.boundingPoly.normalizedVertices.map(
      (v) => ({
        x: v.x * imgWidth,
        y: v.y * imgHeight,
      }),
    );

    // 2. Filter OCR words whose center point lies inside this ONNX rotated polygon
    const matchedWords = wordList.filter((w) => {
      const v = w.boundingPoly?.vertices || [];
      if (v.length < 4) return false;
      const cx =
        ((v[0].x || 0) + (v[1].x || 0) + (v[2].x || 0) + (v[3].x || 0)) / 4;
      const cy =
        ((v[0].y || 0) + (v[1].y || 0) + (v[2].y || 0) + (v[3].y || 0)) / 4;

      return isPointInPolygon({ x: cx, y: cy }, onnxRotatedPolygon);
    });

    // 3. Sort matching words top-to-bottom to preserve reading order
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
      box: {
        minX: Math.min(...xs),
        minY: Math.min(...ys),
        maxX: Math.max(...xs),
        maxY: Math.max(...ys),
      },
      rawPolygon: onnxRotatedPolygon, // Preserves exact rotated ONNX output
      polygon: onnxRotatedPolygon, // Uses exact rotated ONNX output for highlights
      title: title || "Unlabeled Spine",
    };
  });
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
