const { toBookTitleCase } = require("./title-case");
const { normalizeText } = require("./book-search-rank");

const NAME_STOPWORDS = new Set([
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

/**
 * Build the Gemini refine payload. The assembled title is fixed.
 * `rawText` is only for author extraction.
 */
function buildRefineSpinePayload(spines) {
  return (spines || []).map((spine, idx) => ({
    id: idx,
    title: spine.title || "",
    rawText: spine.rawText || "",
  }));
}

function buildRefineSpinePrompt(spinePayload) {
  return `You are an expert librarian AI reading OCR text from book spines.
Do not return a title or a publisher. The title is already decided.
For each item, identify the author. A surname printed on the spine is enough to return the full name.
Ignore price tags and logos.
Return ONLY a JSON array.

Input:
${JSON.stringify(spinePayload, null, 2)}

Output format JSON array:
[
  { "id": 0, "author": "Author Name" }
]`;
}

function significantNameTokens(text) {
  return normalizeText(text)
    .split(" ")
    .filter((token) => token.length >= 3 && !NAME_STOPWORDS.has(token));
}

/** True when any significant author token was actually read on the spine. */
function authorAppearsOnSpine(author, spine) {
  const nameTokens = significantNameTokens(author);
  if (!nameTokens.length) return false;
  const spineTokens = new Set(
    normalizeText(`${spine?.title || ""} ${spine?.rawText || ""}`)
      .split(" ")
      .filter(Boolean),
  );
  return nameTokens.some((token) => spineTokens.has(token));
}

/**
 * Strip internal matchedWords and keep client-facing spine fields.
 * The title is the assembled OCR line. Publisher is left empty.
 */
function spinesForClientResponse(spines, aiList) {
  const parsedList = Array.isArray(aiList) ? aiList : [];
  return (spines || []).map((spine, idx) => {
    const aiMatch = parsedList.find((item) => item.id === idx) || null;
    const aiAuthor = aiMatch?.author != null ? String(aiMatch.author).trim() : "";
    let author = "";
    if (authorAppearsOnSpine(aiAuthor, spine)) author = aiAuthor;
    else if (!aiAuthor) author = spine.author || "";
    return {
      title: toBookTitleCase(spine.title || "Unlabeled Spine"),
      author,
      publisher: "",
      rawText: spine.rawText || "",
      score: spine.score,
      box: spine.box,
      polygon: spine.polygon,
    };
  });
}

module.exports = {
  buildRefineSpinePayload,
  buildRefineSpinePrompt,
  spinesForClientResponse,
};
