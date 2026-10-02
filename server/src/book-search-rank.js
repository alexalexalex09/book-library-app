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

/** Sticker and shelf-mark words that are not part of the title or author. */
const SPINE_NOISE = new Set(["used", "sale", "bargain"]);

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
 * Words worth sending to Google Books. Short fragments, stopwords, and
 * sticker noise are dropped. Original spelling and order are kept.
 */
function spineSearchTokens(text) {
  const cleaned = cleanSearchText(text);
  if (!cleaned) return [];
  return cleaned.split(/\s+/).filter((word) => {
    const norm = normalizeText(word);
    if (!norm || norm.length < 3) return false;
    if (TITLE_STOPWORDS.has(norm)) return false;
    if (SPINE_NOISE.has(norm)) return false;
    return true;
  });
}

/**
 * Higher means the token is less likely to be a real title or author word.
 * Ordinary words, including short ones such as "Our", score 0.
 */
function damageScore(word) {
  const norm = normalizeText(word);
  if (!norm) return 0;
  let score = 0;
  if (!/[aeiouy]/.test(norm)) score += 4;
  if (/\d/.test(norm)) score += 4;
  if (/(.)\1\1/.test(norm)) score += 3;
  return score;
}

/**
 * One or two Google Books queries for an OCR spine.
 * The primary query is the whole cleaned spine, in order. An ISBN is sent
 * whole. A second query, used only when the first match is weak, drops the
 * single token that looks least like a word.
 */
function planBookSearchQueries(title) {
  const cleaned = cleanSearchText(title);
  if (!cleaned) return [];

  const isbn = extractIsbnFromText(cleaned);
  if (isbn) return [isbn];

  const tokens = spineSearchTokens(cleaned);
  if (!tokens.length) return [];

  const primary = tokens.join(" ");
  if (tokens.length < 3) return [primary];

  let suspectIndex = -1;
  let suspectScore = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const score = damageScore(tokens[i]);
    if (score > suspectScore) {
      suspectScore = score;
      suspectIndex = i;
    }
  }
  if (suspectIndex < 0) return [primary];

  const secondary = tokens.filter((_, index) => index !== suspectIndex).join(" ");
  if (!secondary || secondary === primary) return [primary];
  return [primary, secondary];
}

/**
 * Primary Google Books query. Author, rawText, and mode are ignored so the
 * query is not wrapped in intitle:/inauthor:/isbn:.
 */
function buildGoogleBooksQuery(title, _author, _options) {
  return planBookSearchQueries(title)[0] || "";
}

function editAllowance(token) {
  if (token.length >= 8) return 2;
  if (token.length >= 5) return 1;
  return 0;
}

function withinEditDistance(a, b, limit) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > limit) return false;
  const row = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) row[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    let best = row[0];
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + cost);
      previous = current;
      if (row[j] < best) best = row[j];
    }
    if (best > limit) return false;
  }
  return row[b.length] <= limit;
}

function tokensMatch(left, right) {
  if (left === right) return true;
  const allowance = Math.min(editAllowance(left), editAllowance(right));
  if (!allowance) return false;
  return withinEditDistance(left, right, allowance);
}

function tokenInSet(token, tokens) {
  if (tokens.has(token)) return true;
  for (const other of tokens) {
    if (tokensMatch(token, other)) return true;
  }
  return false;
}

/** Fraction of needle tokens found in the haystack, allowing damaged words. */
function fuzzyCoverage(needles, haystack) {
  if (needles.size === 0 || haystack.size === 0) return 0;
  let hit = 0;
  for (const token of needles) {
    if (tokenInSet(token, haystack)) hit += 1;
  }
  return hit / needles.size;
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
  const titleTokens = significantTokens(volTitle);
  const queryCoverage = fuzzyCoverage(qTokens, vTokens);
  const titleRecall = titleTokens.size
    ? fuzzyCoverage(titleTokens, qTokens)
    : queryCoverage;
  const textScore = titleTokens.size
    ? titleRecall * 0.55 + queryCoverage * 0.45
    : queryCoverage;

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
  } else if (titleRecall >= 0.8 && titleTokens.size >= 2) bonus += 0.18;
  else if (queryCoverage >= 0.85 && qTokens.size >= 3) bonus += 0.12;

  const headroom = Math.max(0.5, 1 - textScore);
  return Math.max(0, Math.min(1, textScore + bonus * headroom));
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
  planBookSearchQueries,
  buildGoogleBooksQuery,
  scoreVolume,
  rankBookItems,
  extractIsbn,
  preferStrongerBookResults,
  needsSearchFallback,
  needsTitleOnlyRetry,
};
