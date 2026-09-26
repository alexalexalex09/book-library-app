const express = require("express");
const {
  buildGoogleBooksQuery,
  cleanSearchText,
  rankBookItems,
  preferStrongerBookResults,
  needsTitleOnlyRetry,
  SUGGEST_SCORE,
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
    const rawAuthor =
      typeof req.query.author === "string" ? req.query.author.trim() : "";
    const rawPublisher =
      typeof req.query.publisher === "string" ? req.query.publisher.trim() : "";
    const rawText =
      typeof req.query.rawText === "string" ? req.query.rawText.trim() : "";
    const title = cleanSearchText(rawTitle);
    const author = cleanSearchText(rawAuthor);
    const publisher = cleanSearchText(rawPublisher);

    if (!title && !author && !rawText) {
      return res.status(400).json({ error: "Missing search query" });
    }
    if (
      rawTitle.length > 200 ||
      rawAuthor.length > 200 ||
      rawPublisher.length > 200 ||
      rawText.length > 400
    ) {
      return res.status(400).json({ error: "Search query is too long" });
    }

    const googleQuery = buildGoogleBooksQuery(title, author, { rawText });
    if (!googleQuery) {
      return res.status(400).json({ error: "Missing search query" });
    }

    try {
      const { status, data } = await fetchBooks(googleQuery);
      if (status !== 200) return res.status(status).json(data);

      let rankedItems = rankBookItems(
        data?.items || [],
        { title, author, publisher },
        5,
      );

      if (needsTitleOnlyRetry(rankedItems, author, SUGGEST_SCORE)) {
        const titleOnlyQuery = buildGoogleBooksQuery(title, "", { rawText });
        if (titleOnlyQuery && titleOnlyQuery !== googleQuery) {
          const fallback = await fetchBooks(titleOnlyQuery);
          if (fallback.status === 200) {
            const fallbackRanked = rankBookItems(
              fallback.data?.items || [],
              { title, author: "", publisher },
              5,
            );
            rankedItems = preferStrongerBookResults(
              rankedItems,
              fallbackRanked,
              SUGGEST_SCORE,
            );
          }
        }
      }

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
