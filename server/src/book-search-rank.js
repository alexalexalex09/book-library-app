/**
 * Google Books query shaping and result ranking for spine OCR titles.
 */

const SUGGEST_SCORE = 0.45;

const TITLE_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "at",
  "by",
  "for",
  "from",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanSearchText(value) {
  const stripped = String(value || "")
    .replace(/[$€£]\s*\d+(?:[.,]\d+)?/g, " ")
    .replace(/\b(?:unlabeled\s+spine)\b/gi, " ")
    .replace(/[|•·]+/g, " ")
    .replace(/\uFFFD/g, " ");
  const words = stripped
    .split(/\s+/)
    .filter((word) => word && /[\p{L}\p{N}]/u.test(word));
  return words.join(" ").slice(0, 200);
}

function looksLikeIsbn(value) {
  const digits = String(value || "").replace(/[^0-9Xx]/g, "");
  return digits.length === 10 || digits.length === 13;
}

/** Find a 10- or 13-digit ISBN substring in free text (e.g. OCR rawText). */
function extractIsbnFromText(value) {
  const text = String(value || "");
  const compact = text.replace(/[^0-9Xx]/g, "");
  if (compact.length === 10 || compact.length === 13) return compact;

  const thirteen = text.match(/(?:97[89][\s-]*)?(?:\d[\s-]*){9}[\dXx]/);
  if (thirteen) {
    const digits = thirteen[0].replace(/[^0-9Xx]/g, "");
    if (digits.length === 10 || digits.length === 13) return digits;
  }

  const ten = text.match(/\b(?:\d[\s-]*){9}[\dXx]\b/);
  if (ten) {
    const digits = ten[0].replace(/[^0-9Xx]/g, "");
    if (digits.length === 10 || digits.length === 13) return digits;
  }

  return null;
}

function splitWords(value) {
  const normalized = normalizeText(value);
  if (!normalized) return [];
  return normalized.split(" ").filter(Boolean);
}

function significantTokens(text) {
  return new Set(
    splitWords(text).filter(
      (t) => t.length > 1 && !TITLE_STOPWORDS.has(t),
    ),
  );
}

function tokenSet(text) {
  const normalized = normalizeText(text);
  if (!normalized) return new Set();
  return new Set(normalized.split(" ").filter((t) => t.length > 1));
}

/**
 * Strip trailing author-like tokens from a spine title and salvage author
 * when the dedicated author field is empty or redundant with the title.
 */
function looksLikeAuthorToken(word) {
  const raw = String(word || "");
  const norm = normalizeText(raw);
  if (!norm || norm.length < 2 || TITLE_STOPWORDS.has(norm)) return false;
  return (
    /^[A-Z][A-Za-z'’-]+$/.test(raw) ||
    (raw === raw.toUpperCase() && /^[A-Z]{2,}$/.test(raw))
  );
}

/**
 * Strip trailing author-like tokens from a spine title and salvage author
 * when the dedicated author field is empty or redundant with the title.
 */
function shapeSearchFields(title, author, { salvageAuthor = true } = {}) {
  const cleanedTitle = cleanSearchText(title);
  const cleanedAuthor = cleanSearchText(author);
  if (!cleanedTitle && !cleanedAuthor) {
    return { title: "", author: "" };
  }

  const titleWords = cleanedTitle
    ? cleanedTitle.split(/\s+/).filter(Boolean)
    : [];
  const authorWords = cleanedAuthor
    ? cleanedAuthor.split(/\s+/).filter(Boolean)
    : [];
  const authorNorm = authorWords.map((w) => normalizeText(w)).filter(Boolean);

  let shapedTitleWords = [...titleWords];
  let shapedAuthor = cleanedAuthor;

  const trailingMatchesAuthor = () => {
    if (!authorNorm.length || shapedTitleWords.length <= authorNorm.length) {
      return false;
    }
    const trailing = shapedTitleWords
      .slice(-authorNorm.length)
      .map((w) => normalizeText(w));
    return trailing.every((w, i) => w === authorNorm[i]);
  };

  const trailingMatchesAuthorSurname = () => {
    if (!authorNorm.length || shapedTitleWords.length < 2) return false;
    const lastAuthor = authorNorm[authorNorm.length - 1];
    const lastTitle = normalizeText(
      shapedTitleWords[shapedTitleWords.length - 1],
    );
    return Boolean(lastAuthor && lastTitle && lastAuthor === lastTitle);
  };

  if (trailingMatchesAuthor()) {
    shapedTitleWords = shapedTitleWords.slice(0, -authorNorm.length);
  } else if (trailingMatchesAuthorSurname()) {
    shapedTitleWords = shapedTitleWords.slice(0, -1);
  } else if (
    salvageAuthor &&
    !shapedAuthor &&
    shapedTitleWords.length >= 2 &&
    looksLikeAuthorToken(shapedTitleWords[shapedTitleWords.length - 1])
  ) {
    shapedAuthor = shapedTitleWords[shapedTitleWords.length - 1];
    shapedTitleWords = shapedTitleWords.slice(0, -1);
  }

  return {
    title: shapedTitleWords.join(" ").trim(),
    author: shapedAuthor,
  };
}

/**
 * General Google Books query. The string is the title /ocr already returned.
 * Author, rawText, and mode are ignored so the query is not split or wrapped
 * in intitle:/inauthor:/isbn:.
 */
function buildGoogleBooksQuery(title, _author, _options) {
  return cleanSearchText(title);
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) {
    if (b.has(t)) inter += 1;
  }
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Fraction of query significant tokens covered by the candidate title. */
function coverage(queryTokens, volumeTokens) {
  if (queryTokens.size === 0) return 0;
  let hit = 0;
  for (const t of queryTokens) {
    if (volumeTokens.has(t)) hit += 1;
  }
  return hit / queryTokens.size;
}

function extractIsbn(volumeInfo) {
  const ids = volumeInfo?.industryIdentifiers || [];
  const isbn13 = ids.find((x) => x.type === "ISBN_13")?.identifier;
  const isbn10 = ids.find((x) => x.type === "ISBN_10")?.identifier;
  return isbn13 || isbn10 || null;
}

function scoreVolume(volumeInfo, queryText) {
  const query = cleanSearchText(queryText);
  const volTitle = volumeInfo?.title || "";
  const volAuthors = Array.isArray(volumeInfo?.authors)
    ? volumeInfo.authors.join(" ")
    : "";
  const volPublisher = volumeInfo?.publisher || "";
  const blob = [volTitle, volAuthors, volPublisher].filter(Boolean).join(" ");

  const qTokens = significantTokens(query);
  const vTokens = significantTokens(blob);
  const tokenCoverage = coverage(qTokens, vTokens);
  const tokenJaccard = jaccard(qTokens, vTokens);
  const textScore = tokenCoverage * 0.65 + tokenJaccard * 0.35;

  const normTitle = normalizeText(volTitle);
  const normQuery = normalizeText(query);
  const normBlob = normalizeText(blob);
  let bonus = 0;
  if (normTitle && normQuery && normTitle === normQuery) bonus += 0.4;
  else if (normQuery && normBlob.includes(normQuery)) bonus += 0.22;
  else if (
    normTitle &&
    normQuery &&
    normQuery.includes(normTitle) &&
    normTitle.split(" ").length >= 2
  ) {
    bonus += 0.18;
  } else if (tokenCoverage >= 0.85 && qTokens.size >= 3) bonus += 0.12;

  return Math.max(0, Math.min(1, textScore + bonus));
}

function rankBookItems(items, query, limit = 5) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const queryText = typeof query === "string" ? query : query?.title || "";
  const scored = items.map((item) => {
    const volumeInfo = item.volumeInfo || {};
    const score = scoreVolume(volumeInfo, queryText);
    return { item, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, limit)).map(({ item, score }) => ({
    ...item,
    matchScore: Number(score.toFixed(3)),
  }));
}

/**
 * Prefer primary results unless they are empty or the best score is below
 * threshold and the fallback set is stronger.
 */
function preferStrongerBookResults(
  primary,
  fallback,
  threshold = SUGGEST_SCORE,
) {
  const primaryList = Array.isArray(primary) ? primary : [];
  const fallbackList = Array.isArray(fallback) ? fallback : [];
  if (!primaryList.length) return fallbackList;
  if (!fallbackList.length) return primaryList;

  const bestPrimary = Number(primaryList[0]?.matchScore);
  const bestFallback = Number(fallbackList[0]?.matchScore);
  const primaryScore = Number.isFinite(bestPrimary) ? bestPrimary : -1;
  const fallbackScore = Number.isFinite(bestFallback) ? bestFallback : -1;

  if (primaryScore < threshold && fallbackScore > primaryScore) {
    return fallbackList;
  }
  return primaryList;
}

function needsSearchFallback(rankedItems, threshold = SUGGEST_SCORE) {
  const list = Array.isArray(rankedItems) ? rankedItems : [];
  if (!list.length) return true;
  const best = Number(list[0]?.matchScore);
  return !Number.isFinite(best) || best < threshold;
}

/** @deprecated Prefer needsSearchFallback — kept for callers that pass author. */
function needsTitleOnlyRetry(rankedItems, _author, threshold = SUGGEST_SCORE) {
  return needsSearchFallback(rankedItems, threshold);
}

module.exports = {
  SUGGEST_SCORE,
  normalizeText,
  cleanSearchText,
  looksLikeIsbn,
  extractIsbnFromText,
  shapeSearchFields,
  buildGoogleBooksQuery,
  scoreVolume,
  rankBookItems,
  extractIsbn,
  preferStrongerBookResults,
  needsSearchFallback,
  needsTitleOnlyRetry,
};
