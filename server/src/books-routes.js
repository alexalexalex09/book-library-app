const express = require("express");

function createBooksRouter({
  requireAuth,
  rateLimit,
  fetchBooks = defaultFetchBooks,
}) {
  const router = express.Router();

  router.get("/", requireAuth, rateLimit, async (req, res) => {
    const searchQuery =
      typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!searchQuery) {
      return res.status(400).json({ error: "Missing search query" });
    }
    if (searchQuery.length > 200) {
      return res.status(400).json({ error: "Search query is too long" });
    }

    try {
      const { status, data } = await fetchBooks(searchQuery);
      if (status !== 200) return res.status(status).json(data);
      return res.json(data);
    } catch (error) {
      return res.status(500).json({ error: "Failed to fetch book data" });
    }
  });

  return router;
}

async function defaultFetchBooks(searchQuery) {
  const apiKey = (process.env.GOOGLE_BOOKS_API_KEY || "").trim();
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(searchQuery)}&maxResults=3${apiKey ? `&key=${apiKey}` : ""}`;
  const response = await fetch(url);
  const data = await response.json();
  return { status: response.status, data };
}

module.exports = {
  createBooksRouter,
  defaultFetchBooks,
};
