/**
 * Book title case for OCR and catalog titles.
 * Principal words are capitalized. Short function words stay lowercase
 * unless they are the first or last word.
 */

const MINOR_WORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "but",
  "or",
  "nor",
  "for",
  "yet",
  "so",
  "as",
  "at",
  "by",
  "in",
  "of",
  "off",
  "on",
  "per",
  "to",
  "up",
  "via",
  "vs",
  "from",
  "into",
  "onto",
  "over",
  "upon",
  "with",
  "down",
  "near",
  "past",
]);

const CONTRACTION_SUFFIX = new Set(["s", "t", "re", "ve", "ll", "d", "m"]);

function lettersOf(token) {
  return token.match(/\p{L}/gu) || [];
}

/** Every letter is uppercase (OCR shout) or every letter is lowercase. */
function needsTitleCase(token) {
  const letters = lettersOf(token);
  if (letters.length === 0) return false;
  const allUpper = letters.every(
    (ch) => ch === ch.toUpperCase() && ch !== ch.toLowerCase(),
  );
  const allLower = letters.every(
    (ch) => ch === ch.toLowerCase() && ch !== ch.toUpperCase(),
  );
  return allUpper || allLower;
}

function lowercaseLetters(token) {
  return token.replace(/\p{L}+/gu, (part) => part.toLowerCase());
}

function capitalizePiece(piece) {
  const lower = piece.toLowerCase();
  return lower.replace(/\p{L}+/gu, (part, offset) => {
    const prev = offset > 0 ? lower[offset - 1] : "";
    const afterApostrophe = prev === "'" || prev === "\u2019";
    if (afterApostrophe && CONTRACTION_SUFFIX.has(part)) return part;
    return part.charAt(0).toUpperCase() + part.slice(1);
  });
}

function styleToken(token, forceCapitalize) {
  const parts = token.split(/([-–—])/);
  const letterPartIndexes = [];
  parts.forEach((part, index) => {
    if (lettersOf(part).length) letterPartIndexes.push(index);
  });

  if (letterPartIndexes.length <= 1) {
    const core = lettersOf(token).join("").toLowerCase();
    if (!forceCapitalize && MINOR_WORDS.has(core)) return lowercaseLetters(token);
    return capitalizePiece(token);
  }

  return parts
    .map((part, index) => {
      const letterPos = letterPartIndexes.indexOf(index);
      if (letterPos === -1) return part;
      const edge = letterPos === 0 || letterPos === letterPartIndexes.length - 1;
      const core = lettersOf(part).join("").toLowerCase();
      if (!edge && MINOR_WORDS.has(core)) return lowercaseLetters(part);
      return capitalizePiece(part);
    })
    .join("");
}

/**
 * @param {string} input
 * @returns {string}
 */
function toBookTitleCase(input) {
  const text = String(input ?? "");
  if (!text) return text;

  const tokens = text.split(/(\s+)/);
  const wordIndexes = [];
  tokens.forEach((token, index) => {
    if (lettersOf(token).length) wordIndexes.push(index);
  });
  if (wordIndexes.length === 0) return text;

  return tokens
    .map((token, index) => {
      if (!needsTitleCase(token)) return token;
      const pos = wordIndexes.indexOf(index);
      const forceCapitalize = pos === 0 || pos === wordIndexes.length - 1;
      return styleToken(token, forceCapitalize);
    })
    .join("");
}

module.exports = {
  toBookTitleCase,
};
