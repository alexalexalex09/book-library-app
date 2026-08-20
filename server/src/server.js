const express = require("express");
const cors = require("cors");
const multer = require("multer");
const vision = require("@google-cloud/vision");
require("dotenv").config();

const app = express();
app.use(cors());

// Use Multer to keep the uploaded image in memory so we can send it directly to Google
const upload = multer({ storage: multer.memoryStorage() });

// Initialize the Google Vision Client (it automatically finds the key from .env)
const client = new vision.ImageAnnotatorClient();

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// The OCR Endpoint
app.post("/api/ocr", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image uploaded" });
    }

    console.log("Image received, sending to Google Vision...");

    // Send the image buffer directly to the API
    console.log("Sending image to Google Vision for Objects AND Text...");

    const request = {
      image: { content: req.file.buffer },
      features: [
        { type: "OBJECT_LOCALIZATION" }, // Finds the books
        { type: "DOCUMENT_TEXT_DETECTION" }, // Finds the text
      ],
    };

    const [result] = await client.annotateImage(request);

    console.log(
      "Raw Objects Found:",
      (result.localizedObjectAnnotations || []).map((obj) => obj.name),
    );

    // Filter out anything that isn't a book (e.g., a shelf, a wall, a plant)
    const books = (result.localizedObjectAnnotations || []).filter(
      (obj) => obj.name.toLowerCase() === "book",
    );
    const words = result.textAnnotations || [];

    res.json({ books, words });
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
