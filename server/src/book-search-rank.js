/**
 * Google Books query shaping and result ranking for spine OCR titles.
 */

const SUGGEST_SCORE = 0.45;

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanSearchText(value) {
  return String(value || "")
    .replace(/[$€£]\s*\d+(?:[.,]\d+)?/g, " ")
    .replace(/\b(?:unlabeled\s+spine)\b/gi, " ")
    .replace(/[|•·]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
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

function buildGoogleBooksQuery(title, author, { rawText } = {}) {
  const cleanedTitle = cleanSearchText(title);
  const cleanedAuthor = cleanSearchText(author);

  if (cleanedTitle && looksLikeIsbn(cleanedTitle)) {
    return `isbn:${cleanedTitle.replace(/[^0-9Xx]/g, "")}`;
  }

  const isbnFromRaw = extractIsbnFromText(rawText);
  if (isbnFromRaw) {
    return `isbn:${isbnFromRaw}`;
  }

  if (!cleanedTitle && !cleanedAuthor) return "";

  const parts = [];
  if (cleanedTitle) {
    parts.push(`intitle:"${cleanedTitle.replace(/"/g, "")}"`);
  }
  if (cleanedAuthor) {
    parts.push(`inauthor:"${cleanedAuthor.replace(/"/g, "")}"`);
  }
  return parts.join(" ") || cleanedTitle;
}

function tokenSet(text) {
  const normalized = normalizeText(text);
  if (!normalized) return new Set();
  return new Set(normalized.split(" ").filter((t) => t.length > 1));
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

function extractIsbn(volumeInfo) {
  const ids = volumeInfo?.industryIdentifiers || [];
  const isbn13 = ids.find((x) => x.type === "ISBN_13")?.identifier;
  const isbn10 = ids.find((x) => x.type === "ISBN_10")?.identifier;
  return isbn13 || isbn10 || null;
}

function scoreVolume(volumeInfo, queryTitle, queryAuthor, queryPublisher) {
  const volTitle = volumeInfo?.title || "";
  const volAuthors = Array.isArray(volumeInfo?.authors)
    ? volumeInfo.authors.join(" ")
    : "";
  const volPublisher = volumeInfo?.publisher || "";

  const qTitleTokens = tokenSet(queryTitle);
  const qAuthorTokens = tokenSet(queryAuthor);
  const qPublisherTokens = tokenSet(queryPublisher);
  const vTitleTokens = tokenSet(volTitle);
  const vAuthorTokens = tokenSet(volAuthors);
  const vPublisherTokens = tokenSet(volPublisher);

  const titleScore = jaccard(qTitleTokens, vTitleTokens);
  const authorScore = qAuthorTokens.size
    ? jaccard(qAuthorTokens, vAuthorTokens)
    : 0;
  const publisherScore = qPublisherTokens.size
    ? jaccard(qPublisherTokens, vPublisherTokens)
    : 0;

  const normTitle = normalizeText(volTitle);
  const normQuery = normalizeText(queryTitle);
  let bonus = 0;
  if (normTitle && normQuery && normTitle === normQuery) bonus += 0.35;
  else if (normTitle && normQuery && normTitle.includes(normQuery)) bonus += 0.15;
  else if (normTitle && normQuery && normQuery.includes(normTitle)) bonus += 0.1;

  if (publisherScore > 0) bonus += Math.min(0.08, publisherScore * 0.08);

  return Math.min(
    1,
    titleScore * 0.7 + authorScore * 0.25 + bonus,
  );
}

function rankBookItems(items, { title, author, publisher } = {}, limit = 5) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const scored = items.map((item) => {
    const volumeInfo = item.volumeInfo || {};
    const score = scoreVolume(volumeInfo, title, author, publisher);
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

function needsTitleOnlyRetry(rankedItems, author, threshold = SUGGEST_SCORE) {
  if (!cleanSearchText(author)) return false;
  const list = Array.isArray(rankedItems) ? rankedItems : [];
  if (!list.length) return true;
  const best = Number(list[0]?.matchScore);
  return !Number.isFinite(best) || best < threshold;
}

module.exports = {
  SUGGEST_SCORE,
  normalizeText,
  cleanSearchText,
  looksLikeIsbn,
  extractIsbnFromText,
  buildGoogleBooksQuery,
  scoreVolume,
  rankBookItems,
  extractIsbn,
  preferStrongerBookResults,
  needsTitleOnlyRetry,
};
