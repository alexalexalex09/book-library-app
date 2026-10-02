const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MIN_INTERVAL_MS = 800;
const MAX_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 8000;
const BACKOFF_MS = [500, 1500, 3500];
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const VOLUME_FIELDS =
  "kind,totalItems,items(id,volumeInfo(title,authors,publisher,publishedDate,industryIdentifiers))";

function stripImageLinks(data) {
  if (!data || typeof data !== "object") return data;
  const next = { ...data };
  if (!Array.isArray(next.items)) return next;
  next.items = next.items.map((item) => {
    if (!item?.volumeInfo || !Object.prototype.hasOwnProperty.call(item.volumeInfo, "imageLinks")) {
      return item;
    }
    const volumeInfo = { ...item.volumeInfo };
    delete volumeInfo.imageLinks;
    return { ...item, volumeInfo };
  });
  return next;
}

function normalizeBooksError(status, data) {
  if (typeof data?.error === "string" && data.error.trim()) {
    return { error: data.error.trim() };
  }
  const nested = data?.error;
  const message =
    nested && typeof nested === "object" && typeof nested.message === "string"
      ? nested.message.trim()
      : "";
  if (!status) return { error: "Could not reach Google Books." };
  if (message) return { error: `Google Books is unavailable (${status}): ${message}` };
  return { error: `Google Books is unavailable (${status}).` };
}

function retryDelayMs(headers, attempt, random) {
  const header = headers?.get?.("retry-after");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) {
      return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, seconds * 1000));
    }
    const when = Date.parse(header);
    if (Number.isFinite(when)) {
      return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, when - Date.now()));
    }
  }
  const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
  const jitter = Math.floor(random() * 200);
  return base + jitter;
}

function createGoogleBooksFetcher({
  fetchImpl = globalThis.fetch.bind(globalThis),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  minIntervalMs = MIN_INTERVAL_MS,
  maxAttempts = MAX_ATTEMPTS,
  random = Math.random,
} = {}) {
  let chain = Promise.resolve();
  let lastStart = 0;

  function pace(task) {
    const run = chain.then(async () => {
      if (lastStart) {
        const wait = minIntervalMs - (Date.now() - lastStart);
        if (wait > 0) await sleep(wait);
      }
      lastStart = Date.now();
      return task();
    });
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function fetchOnce(searchQuery) {
    const apiKey = (process.env.GOOGLE_BOOKS_API_KEY || "").trim();
    const params = new URLSearchParams({
      q: searchQuery,
      maxResults: "10",
      fields: VOLUME_FIELDS,
    });
    if (apiKey) params.set("key", apiKey);
    const response = await fetchImpl(
      `https://www.googleapis.com/books/v1/volumes?${params.toString()}`,
    );
    let data = {};
    try {
      data = await response.json();
    } catch {
      data = {};
    }
    return {
      status: response.status,
      data: stripImageLinks(data),
      headers: response.headers,
    };
  }

  async function fetchWithRetry(searchQuery) {
    let lastStatus = 0;
    let lastData = {};
    let lastHeaders = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const result = await fetchOnce(searchQuery);
        lastStatus = result.status;
        lastData = result.data;
        lastHeaders = result.headers;
        if (result.status === 200 || !RETRY_STATUSES.has(result.status)) {
          return { status: result.status, data: result.data };
        }
      } catch {
        lastStatus = 0;
        lastData = {};
        lastHeaders = null;
      }
      if (attempt < maxAttempts - 1) {
        await sleep(retryDelayMs(lastHeaders, attempt, random));
      }
    }
    if (!lastStatus) {
      return { status: 503, data: { error: "Could not reach Google Books." } };
    }
    return {
      status: lastStatus,
      data: normalizeBooksError(lastStatus, lastData),
    };
  }

  return function fetchBooks(searchQuery) {
    return pace(() => fetchWithRetry(searchQuery));
  };
}

function createBooksCache({ supabase } = {}) {
  const memory = new Map();
  const inflight = new Map();

  async function get(queryKey) {
    const cached = memory.get(queryKey);
    if (cached && cached.expiresAt > Date.now()) return cached.payload;
    if (cached) memory.delete(queryKey);
    if (!supabase) return null;
    try {
      const { data, error } = await supabase
        .from("google_books_cache")
        .select("payload, expires_at")
        .eq("query_key", queryKey)
        .maybeSingle();
      if (error || !data?.payload) return null;
      const expiresAt = Date.parse(data.expires_at);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
      memory.set(queryKey, { payload: data.payload, expiresAt });
      return data.payload;
    } catch (err) {
      console.warn("Google Books cache read failed:", err?.message || err);
      return null;
    }
  }

  async function set(queryKey, payload) {
    const expiresAt = Date.now() + CACHE_TTL_MS;
    memory.set(queryKey, { payload, expiresAt });
    if (!supabase) return;
    try {
      const { error } = await supabase.from("google_books_cache").upsert(
        {
          query_key: queryKey,
          payload,
          fetched_at: new Date().toISOString(),
          expires_at: new Date(expiresAt).toISOString(),
        },
        { onConflict: "query_key" },
      );
      if (error) {
        console.warn("Google Books cache write failed:", error.message || error);
      }
    } catch (err) {
      console.warn("Google Books cache write failed:", err?.message || err);
    }
  }

  function coalesce(queryKey, factory) {
    const existing = inflight.get(queryKey);
    if (existing) return existing;
    const job = Promise.resolve()
      .then(factory)
      .finally(() => {
        if (inflight.get(queryKey) === job) inflight.delete(queryKey);
      });
    inflight.set(queryKey, job);
    return job;
  }

  function clear() {
    memory.clear();
    inflight.clear();
  }

  return { get, set, coalesce, clear };
}

const defaultFetchBooks = createGoogleBooksFetcher();

module.exports = {
  CACHE_TTL_MS,
  MIN_INTERVAL_MS,
  VOLUME_FIELDS,
  stripImageLinks,
  normalizeBooksError,
  retryDelayMs,
  createGoogleBooksFetcher,
  createBooksCache,
  defaultFetchBooks,
};
