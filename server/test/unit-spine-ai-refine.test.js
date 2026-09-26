const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  buildRefineSpinePayload,
  buildRefineSpinePrompt,
  spinesForClientResponse,
} = require("../src/spine-ai-refine");

describe("spine-ai-refine", () => {
  it("sends assembled title as the title source plus rawText for author/publisher", () => {
    const payload = buildRefineSpinePayload([
      {
        title: "The Hobbit",
        rawText: "The Hobbit Tolkien HarperCollins",
        matchedWords: [{ text: "ignored" }],
      },
    ]);

    assert.deepEqual(payload, [
      {
        id: 0,
        title: "The Hobbit",
        rawText: "The Hobbit Tolkien HarperCollins",
      },
    ]);
    assert.equal("matchedWords" in payload[0], false);
  });

  it("prompt keeps assembled title and uses rawText only for author/publisher", () => {
    const prompt = buildRefineSpinePrompt([
      { id: 0, title: "The Hobbit", rawText: "The Hobbit Tolkien" },
    ]);
    assert.match(prompt, /already in reading order/);
    assert.match(prompt, /Do not rebuild or reorder the title from "rawText"/);
    assert.match(prompt, /Use "rawText" only to fill author and publisher/);
    assert.match(prompt, /"title": "The Hobbit"/);
    assert.match(prompt, /"rawText": "The Hobbit Tolkien"/);
  });

  it("keeps assembled title when AI returns empty title and strips matchedWords", () => {
    const spines = [
      {
        title: "The Hobbit",
        author: "",
        publisher: "",
        rawText: "The Hobbit Tolkien HarperCollins",
        score: 0.9,
        box: { minX: 0, maxX: 1, minY: 0, maxY: 1 },
        polygon: [{ x: 0, y: 0 }],
        matchedWords: [{ text: "The" }, { text: "Hobbit" }],
      },
    ];
    const result = spinesForClientResponse(spines, [
      { id: 0, title: "", author: "J. R. R. Tolkien", publisher: "HarperCollins" },
    ]);

    assert.equal(result.length, 1);
    assert.equal(result[0].title, "The Hobbit");
    assert.equal(result[0].author, "J. R. R. Tolkien");
    assert.equal(result[0].publisher, "HarperCollins");
    assert.equal(result[0].rawText, "The Hobbit Tolkien HarperCollins");
    assert.equal("matchedWords" in result[0], false);
  });

  it("falls back to spine fields when AI list is missing", () => {
    const result = spinesForClientResponse(
      [
        {
          title: "Dune",
          author: "",
          publisher: "",
          rawText: "Dune Herbert",
          score: 0.5,
          box: null,
          polygon: null,
          matchedWords: [{ text: "Dune" }],
        },
      ],
      null,
    );
    assert.equal(result[0].title, "Dune");
    assert.equal(result[0].rawText, "Dune Herbert");
    assert.equal(result[0].score, 0.5);
    assert.equal("matchedWords" in result[0], false);
  });
});
