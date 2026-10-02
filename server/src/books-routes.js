const express = require("express");
const {
  cleanSearchText,
  needsSearchFallback,
  planBookSearchQueries,
  rankBookItems,
} = require("./book-search-rank");
const {
  createBooksCache,
  defaultFetchBooks,
  normalizeBooksError,
  stripImageLinks,
} = require("./google-books");

function mergeBookItems(primary, fallback) {
  const seen = new Set();
  const merged = [];
  for (const item of [...primary, ...fallback]) {
    const id = item?.id || "";
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    merged.push(item);
  }
  return merged;
}

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

    const queries = planBookSearchQueries(rawTitle);
    if (!queries.length) {
      return res.status(400).json({ error: "Missing search query" });
    }

    const rankText = cleanSearchText(rawTitle) || queries[0];
    const first = await loadQuery(queries[0]);
    if (first.status !== 200) {
      return res.status(first.status).json(normalizeBooksError(first.status, first.data));
    }

    let items = first.data?.items || [];
    let rankedItems = rankBookItems(items, rankText, 5);

    if (queries[1] && needsSearchFallback(rankedItems)) {
      const second = await loadQuery(queries[1]);
      if (second.status === 200) {
        items = mergeBookItems(items, second.data?.items || []);
        rankedItems = rankBookItems(items, rankText, 5);
      }
    }

    if (usageAnalytics) {
      usageAnalytics.recordEvent(req.user?.id, "books_ok", {});
    }
    return res.json({
      ...first.data,
      items: rankedItems,
      query: queries[0],
    });
  });

  return router;
}

module.exports = {
  createBooksRouter,
  defaultFetchBooks,
};
