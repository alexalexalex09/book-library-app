require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const vision = require("@google-cloud/vision");
const { createClient } = require("@supabase/supabase-js");
const path = require("path");
const sharp = require("sharp");
const crypto = require("crypto");

sharp.cache(false);

const app = express();
app.use(cors());

const clientPath = path.join(__dirname, "../../client/src");
app.use(express.static(clientPath));

const upload = multer({ storage: multer.memoryStorage() });

// --- INITIALIZATION ---
const visionClient = new vision.ImageAnnotatorClient();

const rawUrl = process.env.SUPABASE_URL || "";
const rawKey =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  "";
const supabaseUrl = rawUrl.trim().replace(/^["']|["']$/g, "");
const supabaseKey = rawKey.trim().replace(/^["']|["']$/g, "");
const supabase = createClient(supabaseUrl, supabaseKey);

// --- COCO RLE DECODER & POLYGON EXTRACTION ---

// Decodes COCO LEB128 Run-Length Encoded (RLE) string into a binary mask
function decodeCOCORLE(counts, h, w) {
  const mask = new Uint8Array(h * w);
  let i = 0;
  const cnts = [];

  while (i < counts.length) {
    let x = 0;
    let k = 0;
    let more = 1;

    while (more) {
      const c = counts.charCodeAt(i) - 48;
      x |= (c & 31) << k;
      more = c & 32;
      i++;
      k += 5;
      if (!more && c & 16) {
        x |= -1 << k;
      }
    }

    if (cnts.length > 2) {
      x += cnts[cnts.length - 1];
    }
    cnts.push(x);
  }

  let p = 0;
  let val = 0;
  for (let j = 0; j < cnts.length; j++) {
    const c = cnts[j];
    if (val === 1) {
      for (let r = 0; r < c && p < h * w; r++) {
        mask[p++] = 1;
      }
    } else {
      p += c;
    }
    val = 1 - val;
  }

  return mask;
}

// Samples normalized boundary polygon points from decoded COCO bitmask
function extractPolygonFromRLE(rleMask) {
  const [h, w] = rleMask.size; // h = size[0], w = size[1]
  const mask = decodeCOCORLE(rleMask.counts, h, w);
  const points = [];

  // Sample perimeter points along height (column-major mask: pixel (x,y) = x * h + y)
  const stepY = Math.max(1, Math.floor(h / 80));

  for (let y = 0; y < h; y += stepY) {
    let minX = -1;
    let maxX = -1;

    for (let x = 0; x < w; x++) {
      if (mask[x * h + y] === 1) {
        if (minX === -1) minX = x;
        maxX = x;
      }
    }

    if (minX !== -1) {
      points.push({ x: minX / w, y: y / h });
      if (maxX !== minX) points.push({ x: maxX / w, y: y / h });
    }
  }

  return points;
}

// --- GEOMETRY & OCR MAPPING HELPERS ---

// Ray-Casting algorithm to test if point is inside a polygon
function isPointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x,
      yi = polygon[i].y;
    const xj = polygon[j].x,
      yj = polygon[j].y;

    const intersect =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// Maps Cloud Vision OCR words to physical spine masks
function mapOcrWordsToSpines(spines, ocrWords) {
  const spineBuckets = spines.map((spine) => ({
    ...spine,
    matchedWords: [],
  }));

  ocrWords.forEach((word) => {
    const wordCenter = {
      x: (word.box.minX + word.box.maxX) / 2,
      y: (word.box.minY + word.box.maxY) / 2,
    };

    for (const spine of spineBuckets) {
      if (isPointInPolygon(wordCenter, spine.polygon)) {
        spine.matchedWords.push({
          text: word.text,
          y: wordCenter.y,
          x: wordCenter.x,
        });
        break;
      }
    }
  });

  return spineBuckets.map((spine) => {
    const isHorizontal =
      spine.box.maxX - spine.box.minX > spine.box.maxY - spine.box.minY;
    spine.matchedWords.sort((a, b) => (isHorizontal ? a.x - b.x : a.y - b.y));

    const fullTitle = spine.matchedWords
      .map((w) => w.text)
      .join(" ")
      .trim();

    return {
      title: fullTitle || "Unlabeled Spine",
      author: "",
      score: spine.confidence,
      box: spine.box,
      polygon: spine.polygon,
    };
  });
}

// --- PIPELINE PASSES ---

async function extractTextWithCloudVision(imageBuffer, imgWidth, imgHeight) {
  const [result] = await visionClient.documentTextDetection(imageBuffer);
  const annotations = result.textAnnotations;

  if (!annotations || annotations.length === 0) return [];

  return annotations.slice(1).map((annotation) => {
    const vertices = annotation.boundingPoly.vertices;
    const xs = vertices.map((v) => (v.x || 0) / imgWidth);
    const ys = vertices.map((v) => (v.y || 0) / imgHeight);

    return {
      text: annotation.description,
      box: {
        minX: Math.max(0, Math.min(1, Math.min(...xs))),
        maxX: Math.max(0, Math.min(1, Math.max(...xs))),
        minY: Math.max(0, Math.min(1, Math.min(...ys))),
        maxY: Math.max(0, Math.min(1, Math.max(...ys))),
      },
    };
  });
}

// Reduces high-resolution polygon arrays to a target point count using uniform sampling
// Calculates the perpendicular distance from a point to a line segment
function pointLineDistance(point, start, end) {
  if (start.x === end.x && start.y === end.y) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }
  const numerator = Math.abs(
    (end.y - start.y) * point.x -
      (end.x - start.x) * point.y +
      end.x * start.y -
      end.y * start.x,
  );
  const denominator = Math.hypot(end.x - start.x, end.y - start.y);
  return numerator / denominator;
}

// Ramer-Douglas-Peucker algorithm to preserve corners while drastically reducing points
function simplifyPolygon(points, epsilon = 10) {
  if (points.length <= 2) return points;

  let maxDist = 0;
  let index = 0;
  const end = points.length - 1;

  for (let i = 1; i < end; i++) {
    const dist = pointLineDistance(points[i], points[0], points[end]);
    if (dist > maxDist) {
      maxDist = dist;
      index = i;
    }
  }

  if (maxDist > epsilon) {
    const left = simplifyPolygon(points.slice(0, index + 1), epsilon);
    const right = simplifyPolygon(points.slice(index), epsilon);
    return left.slice(0, left.length - 1).concat(right);
  } else {
    return [points[0], points[end]];
  }
}

const axios = require("axios");

async function extractSpatialPolygonsRoboflow(
  imageBuffer,
  imgWidth,
  imgHeight,
) {
  const apiKey = process.env.ROBOFLOW_API_KEY;
  if (!apiKey) {
    throw new Error("ROBOFLOW_API_KEY environment variable is missing.");
  }

  const base64Image = imageBuffer.toString("base64");
  const modelId = "book-spine-3dgvf";
  const modelVersion = "8";

  // Modern Serverless Cloud API direct model URL
  const url = `https://serverless.roboflow.com/${modelId}/${modelVersion}`;

  const response = await axios({
    method: "POST",
    url: url,
    params: {
      api_key: apiKey,
      confidence: 0.3, // Minimum confidence threshold (0.0 to 1.0)
    },
    data: base64Image,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });

  const predictions = response.data?.predictions || [];

  return predictions
    .map((pred) => {
      let polygon = [];

      // 1. Extract vector points if returned
      if (pred.points || pred.polygon) {
        let rawPoints = pred.points || pred.polygon || [];

        // RDP naturally reduces straight edges to ~4-10 points total
        rawPoints = simplifyPolygon(rawPoints, 10);

        polygon = rawPoints.map((pt) => ({
          x: pt.x > 1 ? pt.x / imgWidth : pt.x,
          y: pt.y > 1 ? pt.y / imgHeight : pt.y,
        }));
      }
      // 2. Decode RLE mask if returned
      else if (pred.rle_mask && pred.rle_mask.counts) {
        polygon = extractPolygonFromRLE(pred.rle_mask);
      }
      // 3. Fallback to bounding box rectangle
      else if (pred.width && pred.height) {
        const w = pred.width > 1 ? pred.width / imgWidth : pred.width;
        const h = pred.height > 1 ? pred.height / imgHeight : pred.height;
        const cx = pred.x > 1 ? pred.x / imgWidth : pred.x;
        const cy = pred.y > 1 ? pred.y / imgHeight : pred.y;

        const minX = Math.max(0, cx - w / 2);
        const maxX = Math.min(1, cx + w / 2);
        const minY = Math.max(0, cy - h / 2);
        const maxY = Math.min(1, cy + h / 2);

        polygon = [
          { x: minX, y: minY },
          { x: maxX, y: minY },
          { x: maxX, y: maxY },
          { x: minX, y: maxY },
        ];
      }

      const xs = polygon.map((p) => p.x);
      const ys = polygon.map((p) => p.y);

      return {
        confidence: pred.confidence || 0.5,
        cx: xs.length ? (Math.min(...xs) + Math.max(...xs)) / 2 : 0.5,
        cy: ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : 0.5,
        box: {
          minX: xs.length ? Math.min(...xs) : 0,
          maxX: xs.length ? Math.max(...xs) : 1,
          minY: ys.length ? Math.min(...ys) : 0,
          maxY: ys.length ? Math.max(...ys) : 1,
        },
        polygon,
      };
    })
    .filter((spine) => spine.polygon.length >= 3);
}

// --- ROUTE HANDLERS ---

app.post("/api/ocr", upload.single("image"), async (req, res) => {
  const reqStart = Date.now();
  const timestamp = new Date().toLocaleTimeString();

  console.log(`\n==================================================`);
  console.log(`[${timestamp}] 📸 Processing Bookshelf Scanning Request`);

  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image uploaded" });
    }

    // Process raw upload without .rotate() to preserve unrotated EXIF dimensions
    const rawBuffer = req.file.buffer;
    const metadata = await sharp(rawBuffer).metadata();
    const imgWidth = metadata.width || 1;
    const imgHeight = metadata.height || 1;

    const imageHash = crypto
      .createHash("sha256")
      .update(rawBuffer)
      .digest("hex");

    const fileName = `shelf_${Date.now()}.jpg`;

    let ocrWords = null;
    try {
      const { data: cached } = await supabase
        .from("ocr_cache")
        .select("words")
        .eq("hash", imageHash)
        .maybeSingle();

      if (
        cached &&
        Array.isArray(cached.words) &&
        cached.words.length > 0 &&
        cached.words[0].text
      ) {
        ocrWords = cached.words;
        console.log(
          `[${timestamp}] ⚡ CACHE HIT! Retrieved Cloud Vision OCR data.`,
        );
      }
    } catch (cacheErr) {
      console.warn(`[${timestamp}] Cache read warning:`, cacheErr.message);
    }

    const supabaseUpload = supabase.storage
      .from("shelves")
      .upload(fileName, rawBuffer, {
        contentType: req.file.mimetype,
        upsert: false,
      });

    let spineMasks = [];

    if (!ocrWords) {
      console.log(
        `[${timestamp}] 🌐 Executing Parallel Pass (Cloud Vision + Roboflow Workflow)...`,
      );

      const [visionResult, roboflowResult, { error: uploadError }] =
        await Promise.all([
          extractTextWithCloudVision(rawBuffer, imgWidth, imgHeight),
          extractSpatialPolygonsRoboflow(rawBuffer, imgWidth, imgHeight),
          supabaseUpload,
        ]);

      if (uploadError) throw uploadError;
      ocrWords = visionResult;
      spineMasks = roboflowResult;

      try {
        await supabase
          .from("ocr_cache")
          .upsert({ hash: imageHash, words: ocrWords }, { onConflict: "hash" });
      } catch (cacheSaveErr) {
        console.warn(
          `[${timestamp}] Cache save warning:`,
          cacheSaveErr.message,
        );
      }
    } else {
      console.log(`[${timestamp}] 🌐 Executing Roboflow Workflow Pass...`);
      const [roboflowResult, { error: uploadError }] = await Promise.all([
        extractSpatialPolygonsRoboflow(rawBuffer, imgWidth, imgHeight),
        supabaseUpload,
      ]);
      if (uploadError) throw uploadError;
      spineMasks = roboflowResult;
    }

    const { data: publicUrlData } = supabase.storage
      .from("shelves")
      .getPublicUrl(fileName);

    const formattedSpines = mapOcrWordsToSpines(spineMasks, ocrWords);

    const elapsed = ((Date.now() - reqStart) / 1000).toFixed(2);
    console.log(
      `[${timestamp}] ✅ Complete in ${elapsed}s | Fused ${formattedSpines.length} books.`,
    );
    console.log(`==================================================\n`);

    res.json({ spines: formattedSpines, imageUrl: publicUrlData.publicUrl });
  } catch (error) {
    console.error(`[${timestamp}] 💥 Pipeline Error:`, error);
    res.status(500).json({ error: "Failed to process image" });
  }
});

app.get("/api/books", async (req, res) => {
  const searchQuery = req.query.q;
  if (!searchQuery) {
    return res.status(400).json({ error: "Missing search query" });
  }

  const apiKey = (process.env.GOOGLE_BOOKS_API_KEY || "").trim();
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(
    searchQuery,
  )}&maxResults=1${apiKey ? `&key=${apiKey}` : ""}`;

  try {
    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch book data" });
  }
});

app.use((req, res) => res.sendFile(path.join(clientPath, "index.html")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
