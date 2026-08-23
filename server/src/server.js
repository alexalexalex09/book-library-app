require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const vision = require("@google-cloud/vision");
const { createClient } = require("@supabase/supabase-js");
const path = require("path");

const app = express();
app.use(cors());

// Serve static frontend files from the "client" directory
app.use(express.static(path.join(__dirname, "client")));

// Use Multer to keep the uploaded image in memory
const upload = multer({ storage: multer.memoryStorage() });

// 1. Google Vision Client Setup
// Supports process.env.GOOGLE_CREDENTIALS JSON string on Render, or local credentials keyfile
const visionConfig = {};
if (process.env.GOOGLE_CREDENTIALS) {
  try {
    visionConfig.credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  } catch (err) {
    console.error("Failed to parse GOOGLE_CREDENTIALS JSON string:", err);
  }
}
const client = new vision.ImageAnnotatorClient(visionConfig);

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// 2. Supabase Setup
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
);

// 3. OCR Endpoint
app.post("/api/ocr", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image uploaded" });
    }

    console.log(
      "Image received! Uploading to Supabase and sending to Google Vision...",
    );

    const fileName = `shelf_${Date.now()}.jpg`;

    // Prepare Google Vision request
    const request = {
      image: { content: req.file.buffer },
      features: [
        { type: "OBJECT_LOCALIZATION" },
        { type: "DOCUMENT_TEXT_DETECTION" },
      ],
    };

    // Prepare Supabase Upload
    const supabaseUpload = supabase.storage
      .from("shelves")
      .upload(fileName, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false,
      });

    // Fire both tasks simultaneously
    const [[result], { data: uploadData, error: uploadError }] =
      await Promise.all([client.annotateImage(request), supabaseUpload]);

    if (uploadError) {
      console.error("Supabase Upload Error:", uploadError);
      throw uploadError;
    }

    // Retrieve public URL
    const { data: publicUrlData } = supabase.storage
      .from("shelves")
      .getPublicUrl(fileName);

    const books = (result.localizedObjectAnnotations || []).filter(
      (obj) => obj.name.toLowerCase() === "book",
    );
    const words = result.textAnnotations || [];

    res.json({
      books,
      words,
      imageUrl: publicUrlData.publicUrl,
    });
  } catch (error) {
    console.error("OCR Error:", error);
    res.status(500).json({ error: "Failed to process image" });
  }
});

// 4. Google Books Proxy Endpoint
app.get("/api/books", async (req, res) => {
  const searchQuery = req.query.q;

  if (!searchQuery) {
    return res.status(400).json({ error: "Missing search query" });
  }

  const apiKey = process.env.GOOGLE_BOOKS_API_KEY;
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(
    searchQuery,
  )}&maxResults=1&key=${apiKey}`;

  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    try {
      attempts++;
      console.log(`Attempt ${attempts}: Fetching ${searchQuery}...`);

      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "LibraryFinderApp/1.0",
        },
      });

      const data = await response.json();

      if (!response.ok) {
        if (response.status >= 500 && attempts < maxAttempts) {
          console.warn(
            `Google API 503 Error. Retrying in ${attempts * 1000}ms...`,
          );
          await delay(attempts * 1000);
          continue;
        } else {
          console.error("Google API Final Error:", data);
          return res.status(response.status).json(data);
        }
      }

      return res.json(data);
    } catch (error) {
      console.error(`Fetch Error on attempt ${attempts}:`, error);
      if (attempts >= maxAttempts) {
        return res.status(500).json({
          error: "Failed to fetch book data after multiple attempts",
        });
      }
      await delay(attempts * 1000);
    }
  }
});

// 5. Fallback Route: Serve index.html for non-API requests
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "client", "index.html"));
});

// 6. Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
