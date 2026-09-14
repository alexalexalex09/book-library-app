require("dotenv").config();
const express = require("express");
const cors = require("cors");
const vision = require("@google-cloud/vision");
const { createClient } = require("@supabase/supabase-js");
const path = require("path");
const fs = require("fs");
const sharp = require("sharp");
const crypto = require("crypto");
const axios = require("axios");
const {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_PIXELS,
  createPlanRateLimiter,
  createImageUpload,
  createRequireAuth,
  sniffImageMime,
  handleUploadError,
  setSecurityHeaders,
} = require("./http-security");

sharp.cache(false);

const app = express();
app.disable("x-powered-by");
app.use(setSecurityHeaders);

const allowedOrigin = process.env.CORS_ORIGIN?.trim();
app.use(
  cors({
    origin: allowedOrigin || false,
    methods: ["GET", "POST"],
  }),
);

const clientPath = path.join(__dirname, "../../client/src");
app.use(express.static(clientPath));

const upload = createImageUpload();

// --- INITIALIZATION ---
// Resolve Google Vision credentials from whatever form the current platform can
// provide, in priority order, without ever crashing the process on bad input:
//   1. GOOGLE_CREDENTIALS_B64 — base64-encoded service-account JSON. Preferred for
//      env-var-only / ephemeral hosts (Cloud Agents, Render env) because base64
//      round-trips the private key's newlines byte-for-byte.
//   2. GOOGLE_CREDENTIALS — inline service-account JSON string (back-compat).
//   3. GOOGLE_CREDENTIALS — a path to a service-account JSON file that exists.
//   4. Application Default Credentials — honors GOOGLE_APPLICATION_CREDENTIALS
//      (file path, e.g. a Render Secret File or a local key) or platform metadata.
function resolveVisionClient() {
  const b64 = (process.env.GOOGLE_CREDENTIALS_B64 || "").trim();
  if (b64) {
    try {
      const json = Buffer.from(b64, "base64").toString("utf8");
      return new vision.ImageAnnotatorClient({ credentials: JSON.parse(json) });
    } catch (err) {
      console.warn(
        `⚠️ GOOGLE_CREDENTIALS_B64 could not be decoded/parsed (${err.message}); trying other sources.`,
      );
    }
  }

  const raw = (process.env.GOOGLE_CREDENTIALS || "").trim();
  if (raw.startsWith("{") || raw.startsWith("[")) {
    return new vision.ImageAnnotatorClient({ credentials: JSON.parse(raw) });
  }

  if (raw && fs.existsSync(raw)) {
    return new vision.ImageAnnotatorClient({ keyFilename: raw });
  }

  if (raw) {
    console.warn(
      "⚠️ GOOGLE_CREDENTIALS is neither inline JSON nor an existing file path; falling back to Application Default Credentials.",
    );
  }
  return new vision.ImageAnnotatorClient();
}

const visionClient = resolveVisionClient();

const rawUrl = process.env.SUPABASE_URL || "";
const rawKey =
  process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabaseUrl = rawUrl.trim().replace(/^["']|["']$/g, "");
const supabaseKey = rawKey.trim().replace(/^["']|["']$/g, "");
if (!supabaseKey) {
  throw new Error(
    "Missing SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY for server.",
  );
}
const supabase = createClient(supabaseUrl, supabaseKey);
const requireAuth = createRequireAuth(supabase);
const ocrRateLimit = createPlanRateLimiter({
  action: "ocr",
  windowMs: 15 * 60 * 1000,
  message: "OCR limit reached for your plan. Please try again later.",
});
const booksRateLimit = createPlanRateLimiter({
  action: "books",
  windowMs: 60 * 1000,
  message: "Book search limit reached for your plan. Please try again later.",
});

// --- COCO RLE DECODER & POLYGON EXTRACTION ---

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

function extractPolygonFromRLE(rleMask) {
  const [h, w] = rleMask.size;
  const mask = decodeCOCORLE(rleMask.counts, h, w);
  const leftPoints = [];
  const rightPoints = [];

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
      leftPoints.push({ x: minX / w, y: y / h });
      rightPoints.push({ x: maxX / w, y: y / h });
    }
  }

  if (leftPoints.length === 0) return [];

  // Construct a continuous outer loop: down the right side, up the left side
  const perimeter = [...rightPoints, ...leftPoints.reverse()];

  // Run RDP simplification using normalized epsilon (0.008 = ~0.8% threshold)
  return simplifyPolygon(perimeter, 0.002);
}

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

// --- GEOMETRY & OCR MAPPING HELPERS ---

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
  const url = `https://serverless.roboflow.com/${modelId}/${modelVersion}`;

  const response = await axios({
    method: "POST",
    url: url,
    params: { confidence: 0.3 },
    data: base64Image,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Bearer ${apiKey}`,
    },
  });

  const predictions = response.data?.predictions || [];

  return predictions
    .map((pred) => {
      let polygon = [];

      if (pred.rle_mask && pred.rle_mask.counts) {
        polygon = extractPolygonFromRLE(pred.rle_mask);
      } else if (pred.points || pred.polygon) {
        let rawPoints = pred.points || pred.polygon || [];
        const normalizedPoints = rawPoints.map((pt) => ({
          x: pt.x > 1 ? pt.x / imgWidth : pt.x,
          y: pt.y > 1 ? pt.y / imgHeight : pt.y,
        }));
        // Downsample raw points with normalized epsilon
        polygon = simplifyPolygon(normalizedPoints, 0.002);
      } else if (pred.width && pred.height) {
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

app.post(
  "/api/ocr",
  requireAuth,
  ocrRateLimit,
  upload.single("image"),
  async (req, res) => {
  const reqStart = Date.now();
  const timestamp = new Date().toLocaleTimeString();

  console.log(`\n==================================================`);
  console.log(`[${timestamp}] 📸 Processing Bookshelf Scanning Request`);

  try {
    if (!req.file) return res.status(400).json({ error: "No image uploaded" });

    const detectedMime = sniffImageMime(req.file.buffer);
    if (!detectedMime || !ALLOWED_IMAGE_TYPES.has(detectedMime)) {
      return res.status(400).json({
        error: "Upload must be one JPEG, PNG, or WebP image",
      });
    }
    if (detectedMime !== req.file.mimetype) {
      return res.status(400).json({
        error: "Image content type does not match uploaded file type",
      });
    }

    const rawBuffer = req.file.buffer;
    const imageProcessor = sharp(rawBuffer, { limitInputPixels: MAX_IMAGE_PIXELS });
    const metadata = await imageProcessor.metadata();
    const imgWidth = metadata.width || 1;
    const imgHeight = metadata.height || 1;
    if (imgWidth > MAX_IMAGE_DIMENSION || imgHeight > MAX_IMAGE_DIMENSION) {
      return res.status(413).json({
        error: `Image dimensions exceed ${MAX_IMAGE_DIMENSION}px limit`,
      });
    }
    const normalizedBuffer = await imageProcessor
      .rotate()
      .jpeg({ quality: 92, mozjpeg: true })
      .toBuffer();
    const imageHash = crypto
      .createHash("sha256")
      .update(rawBuffer)
      .digest("hex");
    const userId = req.user.id;
    const forceRescan = req.body.force_rescan === "true";

    // 1. Check if shelf already exists in user's library (unless forcing a re-scan)
    if (userId && !forceRescan) {
      const { data: existingShelf, error: existingError } = await supabase
        .from("shelves")
        .select("*, user_books(*)")
        .eq("user_id", userId)
        .eq("image_url", `${userId}/${imageHash}.jpg`)
        .maybeSingle();

      if (existingError) {
        console.warn(
          `[${timestamp}] Duplicate lookup warning:`,
          existingError.message,
        );
      } else if (existingShelf) {
        console.log(
          `[${timestamp}] 🔁 Found duplicate shelf photo for user. Redirecting.`,
        );
        return res.json({
          duplicate: true,
          shelf: existingShelf,
          imageHash,
        });
      }
    }

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

    let spineMasks = [];

    if (!ocrWords) {
      console.log(
        `[${timestamp}] 🌐 Executing Parallel Pass (Cloud Vision + Roboflow Workflow)...`,
      );

      const [visionResult, roboflowResult] = await Promise.all([
        extractTextWithCloudVision(normalizedBuffer, imgWidth, imgHeight),
        extractSpatialPolygonsRoboflow(normalizedBuffer, imgWidth, imgHeight),
      ]);
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
      const roboflowResult = await extractSpatialPolygonsRoboflow(
        normalizedBuffer,
        imgWidth,
        imgHeight,
      );
      spineMasks = roboflowResult;
    }
    const formattedSpines = mapOcrWordsToSpines(spineMasks, ocrWords);

    // AI Refinement Pass
    const refinedSpines = await refineSpinesWithAI(formattedSpines);

    const elapsed = ((Date.now() - reqStart) / 1000).toFixed(2);
    console.log(
      `[${timestamp}] ✅ Complete in ${elapsed}s | Fused & Refined ${refinedSpines.length} books.`,
    );

    res.json({
      spines: refinedSpines,
      imageHash,
    });
  } catch (error) {
    console.error(`[${timestamp}] 💥 Pipeline Error:`, error);
    res.status(500).json({ error: "Failed to process image" });
  }
});

app.get("/api/books", requireAuth, booksRateLimit, async (req, res) => {
  const searchQuery =
    typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!searchQuery)
    return res.status(400).json({ error: "Missing search query" });
  if (searchQuery.length > 200)
    return res.status(400).json({ error: "Search query is too long" });

  const apiKey = (process.env.GOOGLE_BOOKS_API_KEY || "").trim();
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(searchQuery)}&maxResults=3${apiKey ? `&key=${apiKey}` : ""}`;

  try {
    const response = await fetch(url);
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch book data" });
  }
});

// Uses Gemini API to structure messy OCR fragments into clean metadata
async function refineSpinesWithAI(spines) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn("⚠️ GEMINI_API_KEY missing. Skipping AI spine refinement.");
    return spines;
  }

  // Build a lightweight batch prompt of raw OCR text for all detected spines
  const spinePayload = spines.map((s, idx) => ({
    id: idx,
    rawText: s.matchedWords?.map((w) => w.text).join(" ") || s.title,
  }));

  const prompt = `You are an expert librarian AI parsing messy OCR text from book spines.
For each item, infer the correct book title, author, and publisher (if visible).
Fix typos, handle vertical text misordering, ignore price tags/logos, and return ONLY a JSON array.

Input:
${JSON.stringify(spinePayload, null, 2)}

Output format JSON array:
[
  { "id": 0, "title": "Clean Title", "author": "Author Name", "publisher": "Publisher Name" }
]`;

  try {
    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent";

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          temperature: 0.1,
        },
      }),
    });

    const data = await response.json();
    const rawTextResponse = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!rawTextResponse) {
      throw new Error("No text content returned from Gemini API");
    }

    const content = JSON.parse(rawTextResponse);
    const parsedList = Array.isArray(content)
      ? content
      : content.spines || content.items || [];

    // Merge AI-cleaned results back into the spine objects
    return spines.map((spine, idx) => {
      const aiMatch = Array.isArray(parsedList)
        ? parsedList.find((item) => item.id === idx)
        : null;

      return {
        ...spine,
        title: aiMatch?.title || spine.title,
        author: aiMatch?.author || "",
        publisher: aiMatch?.publisher || "",
      };
    });
  } catch (err) {
    console.error("AI spine refinement error (Gemini):", err);
    return spines; // Fallback to raw OCR titles on error
  }
}

app.use((req, res) => res.sendFile(path.join(clientPath, "index.html")));
app.use(handleUploadError);
app.use((error, req, res, next) => {
  console.error("Unhandled request error:", error);
  res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () =>
  console.log(`Server running on 0.0.0.0:${PORT}`),
);
