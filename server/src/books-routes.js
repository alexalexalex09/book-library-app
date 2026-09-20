const express = require("express");
const {
  buildGoogleBooksQuery,
  cleanSearchText,
  rankBookItems,
} = require("./book-search-rank");

function createBooksRouter({
  requireAuth,
  rateLimit,
  fetchBooks = defaultFetchBooks,
}) {
  const router = express.Router();

  router.get("/", requireAuth, rateLimit, async (req, res) => {
    const rawTitle =
      typeof req.query.q === "string" ? req.query.q.trim() : "";
    const rawAuthor =
      typeof req.query.author === "string" ? req.query.author.trim() : "";
    const title = cleanSearchText(rawTitle);
    const author = cleanSearchText(rawAuthor);

    if (!title && !author) {
      return res.status(400).json({ error: "Missing search query" });
    }
    if (rawTitle.length > 200 || rawAuthor.length > 200) {
      return res.status(400).json({ error: "Search query is too long" });
    }

    const googleQuery = buildGoogleBooksQuery(title, author);
    if (!googleQuery) {
      return res.status(400).json({ error: "Missing search query" });
    }

    try {
      const { status, data } = await fetchBooks(googleQuery);
      if (status !== 200) return res.status(status).json(data);

      const rankedItems = rankBookItems(
        data?.items || [],
        { title, author },
        5,
      );
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
