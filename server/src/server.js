require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const vision = require("@google-cloud/vision");

const app = express();
app.use(cors());

// Use Multer to keep the uploaded image in memory so we can send it directly to Google
const upload = multer({ storage: multer.memoryStorage() });

// Initialize the Google Vision Client (it automatically finds the key from .env)
const client = new vision.ImageAnnotatorClient();

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

const { createClient } = require("@supabase/supabase-js");
console.log(process.env);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
);

// The OCR Endpoint
// The OCR Endpoint
app.post("/api/ocr", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image uploaded" });
    }

    console.log(
      "Image received! Uploading to Supabase and sending to Google Vision...",
    );

    const fileName = `shelf_${Date.now()}.jpg`;

    // 1. Prepare Google Vision request
    const request = {
      image: { content: req.file.buffer },
      features: [
        { type: "OBJECT_LOCALIZATION" },
        { type: "DOCUMENT_TEXT_DETECTION" },
      ],
    };

    // 2. Prepare Supabase Upload
    const supabaseUpload = supabase.storage
      .from("shelves")
      .upload(fileName, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false,
      });

    // 3. Fire both tasks simultaneously
    const [[result], { data: uploadData, error: uploadError }] =
      await Promise.all([client.annotateImage(request), supabaseUpload]);

    if (uploadError) {
      console.error("Supabase Upload Error:", uploadError);
      throw uploadError;
    }

    // 4. Retrieve the public URL for the uploaded photo
    const { data: publicUrlData } = supabase.storage
      .from("shelves")
      .getPublicUrl(fileName);

    const books = (result.localizedObjectAnnotations || []).filter(
      (obj) => obj.name.toLowerCase() === "book",
    );
    const words = result.textAnnotations || [];

    // 5. Return books, words, AND the public imageUrl back to the client
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

app.get("/api/books", async (req, res) => {
  const searchQuery = req.query.q;

  if (!searchQuery) {
    return res.status(400).json({ error: "Missing search query" });
  }

  const apiKey = process.env.GOOGLE_BOOKS_API_KEY;
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(searchQuery)}&maxResults=1&key=${apiKey}`;

  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    try {
      attempts++;
      console.log(`Attempt ${attempts}: Fetching ${searchQuery}...`);

      const response = await fetch(url, {
        headers: {
          "Accept": "application/json",
          "User-Agent": "LibraryFinderApp/1.0",
        },
      });

      const data = await response.json();

      // If Google throws a 503 (or any 500-level error), catch it and retry
      if (!response.ok) {
        if (response.status >= 500 && attempts < maxAttempts) {
          console.warn(
            `Google API 503 Error. Retrying in ${attempts * 1000}ms...`,
          );
          await delay(attempts * 1000); // Wait 1s, then 2s...
          continue; // Jump back to the top of the while loop
        } else {
          // If we are out of attempts or it's a different error, give up
          console.error("Google API Final Error:", data);
          return res.status(response.status).json(data);
        }
      }

      // If successful, send the data and exit the route
      return res.json(data);
    } catch (error) {
      console.error(`Fetch Error on attempt ${attempts}:`, error);
      if (attempts >= maxAttempts) {
        return res
          .status(500)
          .json({ error: "Failed to fetch book data after multiple attempts" });
      }
      await delay(attempts * 1000);
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
