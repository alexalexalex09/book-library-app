const express = require("express");
const { buildGoogleBooksQuery, rankBookItems } = require("./book-search-rank");
const {
  createBooksCache,
  defaultFetchBooks,
  normalizeBooksError,
  stripImageLinks,
} = require("./google-books");

function createBooksRouter({
  requireAuth,
  rateLimit,
  fetchBooks = defaultFetchBooks,
  supabase,
  usageAnalytics,
  booksCache,
}) {
  const router = express.Router();
  const cache = booksCache || createBooksCache({ supabase });

  async function loadQuery(query) {
    const cached = await cache.get(query);
    if (cached) return { status: 200, data: cached };
    return cache.coalesce(query, async () => {
      const again = await cache.get(query);
      if (again) return { status: 200, data: again };
      try {
        const result = await fetchBooks(query);
        if (result?.status === 200) {
          const data = stripImageLinks(result.data);
          await cache.set(query, data);
          return { status: 200, data };
        }
        const status = result?.status || 503;
        return { status, data: normalizeBooksError(status, result?.data) };
      } catch {
        return {
          status: 503,
          data: { error: "Could not reach Google Books." },
        };
      }
    });
  }

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

    const { status, data } = await loadQuery(googleQuery);
    if (status !== 200) {
      return res.status(status).json(normalizeBooksError(status, data));
    }

    const rankedItems = rankBookItems(data?.items || [], googleQuery, 5);

    if (usageAnalytics) {
      usageAnalytics.recordEvent(req.user?.id, "books_ok", {});
    }
    return res.json({
      ...data,
      items: rankedItems,
      query: googleQuery,
    });
  });

  return router;
}

module.exports = {
  createBooksRouter,
  defaultFetchBooks,
};
