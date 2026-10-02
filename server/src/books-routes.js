const express = require("express");
const {
  buildGoogleBooksQuery,
  rankBookItems,
} = require("./book-search-rank");

function createBooksRouter({
  requireAuth,
  rateLimit,
  fetchBooks = defaultFetchBooks,
  usageAnalytics,
}) {
  const router = express.Router();

  router.get("/", requireAuth, rateLimit, async (req, res) => {
    const rawTitle =
      typeof req.query.q === "string" ? req.query.q.trim() : "";

    if (rawTitle.length > 200) {
      return res.status(400).json({ error: "Search query is too long" });
    }

    const googleQuery = buildGoogleBooksQuery(rawTitle);
    if (!googleQuery) {
      return res.status(400).json({ error: "Missing search query" });
    }

    try {
      const { status, data } = await fetchBooks(googleQuery);
      if (status !== 200) return res.status(status).json(data);

      const rankedItems = rankBookItems(data?.items || [], googleQuery, 5);

      if (usageAnalytics) {
        usageAnalytics.recordEvent(req.user?.id, "books_ok", {});
      }
      return res.json({
        ...data,
        items: rankedItems,
        query: googleQuery,
      });
    } catch (error) {
      return res.status(500).json({ error: "Failed to fetch book data" });
    }
  });

  return router;
}

async function defaultFetchBooks(searchQuery) {
  const apiKey = (process.env.GOOGLE_BOOKS_API_KEY || "").trim();
  const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(searchQuery)}&maxResults=10${apiKey ? `&key=${apiKey}` : ""}`;
  const response = await fetch(url);
  const data = await response.json();
  return { status: response.status, data };
}

module.exports = {
  createBooksRouter,
  defaultFetchBooks,
};
