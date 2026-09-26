const { toBookTitleCase } = require("./title-case");

/**
 * Build the Gemini refine payload. Assembled `title` is the title source;
 * `rawText` is only for author/publisher extraction.
 */
function buildRefineSpinePayload(spines) {
  return (spines || []).map((spine, idx) => ({
    id: idx,
    title: spine.title || "",
    rawText: spine.rawText || "",
  }));
}

function buildRefineSpinePrompt(spinePayload) {
  return `You are an expert librarian AI parsing messy OCR text from book spines.
For each item, "title" is already in reading order — return it with only typo fixes from that string. Do not rebuild or reorder the title from "rawText".
Return every title in book title case: capitalize each principal word, and leave short function words lowercase (a, an, the, and, but, or, nor, for, of, in, on, to, with, and similar) unless that word is first or last.
Use "rawText" only to fill author and publisher (if visible). Ignore price tags and logos.
Return ONLY a JSON array.

Input:
${JSON.stringify(spinePayload, null, 2)}

Output format JSON array:
[
  { "id": 0, "title": "Clean Title", "author": "Author Name", "publisher": "Publisher Name" }
]`;
}

/**
 * Strip internal matchedWords and keep client-facing spine fields.
 */
function spinesForClientResponse(spines, aiList) {
  const parsedList = Array.isArray(aiList) ? aiList : [];
  return (spines || []).map((spine, idx) => {
    const aiMatch = parsedList.find((item) => item.id === idx) || null;
    const aiTitle = aiMatch?.title != null ? String(aiMatch.title).trim() : "";
    return {
      title: toBookTitleCase(aiTitle || spine.title || "Unlabeled Spine"),
      author: (aiMatch?.author != null ? String(aiMatch.author) : "") || spine.author || "",
      publisher:
        (aiMatch?.publisher != null ? String(aiMatch.publisher) : "") ||
        spine.publisher ||
        "",
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
