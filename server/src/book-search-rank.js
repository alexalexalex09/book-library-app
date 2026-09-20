/**
 * Google Books query shaping and result ranking for spine OCR titles.
 */

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

function buildGoogleBooksQuery(title, author) {
  const cleanedTitle = cleanSearchText(title);
  const cleanedAuthor = cleanSearchText(author);

  if (!cleanedTitle && !cleanedAuthor) return "";

  if (cleanedTitle && looksLikeIsbn(cleanedTitle)) {
    return `isbn:${cleanedTitle.replace(/[^0-9Xx]/g, "")}`;
  }

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

function scoreVolume(volumeInfo, queryTitle, queryAuthor) {
  const volTitle = volumeInfo?.title || "";
  const volAuthors = Array.isArray(volumeInfo?.authors)
    ? volumeInfo.authors.join(" ")
    : "";

  const qTitleTokens = tokenSet(queryTitle);
  const qAuthorTokens = tokenSet(queryAuthor);
  const vTitleTokens = tokenSet(volTitle);
  const vAuthorTokens = tokenSet(volAuthors);

  const titleScore = jaccard(qTitleTokens, vTitleTokens);
  const authorScore = qAuthorTokens.size
    ? jaccard(qAuthorTokens, vAuthorTokens)
    : 0;

  const normTitle = normalizeText(volTitle);
  const normQuery = normalizeText(queryTitle);
  let bonus = 0;
  if (normTitle && normQuery && normTitle === normQuery) bonus += 0.35;
  else if (normTitle && normQuery && normTitle.includes(normQuery)) bonus += 0.15;
  else if (normTitle && normQuery && normQuery.includes(normTitle)) bonus += 0.1;

  return Math.min(1, titleScore * 0.7 + authorScore * 0.25 + bonus);
}

function rankBookItems(items, { title, author } = {}, limit = 5) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const scored = items.map((item) => {
    const volumeInfo = item.volumeInfo || {};
    const score = scoreVolume(volumeInfo, title, author);
    return { item, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, limit)).map(({ item, score }) => ({
    ...item,
    matchScore: Number(score.toFixed(3)),
  }));
}

module.exports = {
  normalizeText,
  cleanSearchText,
  looksLikeIsbn,
  buildGoogleBooksQuery,
  scoreVolume,
  rankBookItems,
  extractIsbn,
};
