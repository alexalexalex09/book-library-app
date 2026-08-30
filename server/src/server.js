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

  // Pre-process image to 640x640 RGB Float32 NCHW Tensor
  const modelSize = 640;
  const { data, info } = await sharp(imageBuffer)
    .removeAlpha()
    .resize(modelSize, modelSize, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const float32Data = new Float32Array(3 * modelSize * modelSize);
  for (let i = 0; i < modelSize * modelSize; i++) {
    float32Data[i] = data[i * 3] / 255.0; // R
    float32Data[modelSize * modelSize + i] = data[i * 3 + 1] / 255.0; // G
    float32Data[2 * modelSize * modelSize + i] = data[i * 3 + 2] / 255.0; // B
  }

  const tensor = new ort.Tensor("float32", float32Data, [
    1,
    3,
    modelSize,
    modelSize,
  ]);
  const inputName = ortSession.inputNames[0];
  const results = await ortSession.run({ [inputName]: tensor });
  const outputName = ortSession.outputNames[0];
  const output = results[outputName].data; // Tensor Output Shape: [1, 5, 8400]

  // Parse YOLO detections (cx, cy, w, h, conf)
  const boxes = [];
  const numAnchors = 8400;
  const confThreshold = 0.35;

  for (let i = 0; i < numAnchors; i++) {
    const confidence = output[4 * numAnchors + i];
    if (confidence > confThreshold) {
      const cx = output[0 * numAnchors + i] / modelSize;
      const cy = output[1 * numAnchors + i] / modelSize;
      const w = output[2 * numAnchors + i] / modelSize;
      const h = output[3 * numAnchors + i] / modelSize;

      boxes.push({
        confidence,
        box: {
          minX: Math.max(0, cx - w / 2),
          minY: Math.max(0, cy - h / 2),
          maxX: Math.min(1, cx + w / 2),
          maxY: Math.min(1, cy + h / 2),
        },
      });
    }
  }

  // Non-Maximum Suppression (NMS)
  boxes.sort((a, b) => b.confidence - a.confidence);
  const selected = [];

  for (const candidate of boxes) {
    let keep = true;
    for (const approved of selected) {
      if (calculateIoU(candidate.box, approved.box) > 0.45) {
        keep = false;
        break;
      }
    }
    if (keep) selected.push(candidate);
  }

  // Format into standard boundingPoly objects for frontend consumption
  return selected.map((item) => ({
    name: "book",
    score: item.confidence,
    boundingPoly: {
      normalizedVertices: [
        { x: item.box.minX, y: item.box.minY },
        { x: item.box.maxX, y: item.box.minY },
        { x: item.box.maxX, y: item.box.maxY },
        { x: item.box.minX, y: item.box.maxY },
      ],
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

    // Fire Google Text Detection, Local ONNX Spine Detection, and Supabase Upload concurrently
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

    res.json({
      books: localSpines, // ONNX-detected spine boxes replace Vision object localization
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
