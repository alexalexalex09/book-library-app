const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  buildRefineSpinePayload,
  buildRefineSpinePrompt,
  spinesForClientResponse,
} = require("../src/spine-ai-refine");

describe("spine-ai-refine", () => {
  it("sends assembled title as the title source plus rawText for the author", () => {
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

  it("asks only for an author and does not request a title or publisher", () => {
    const prompt = buildRefineSpinePrompt([
      { id: 0, title: "The Hobbit", rawText: "The Hobbit Tolkien" },
    ]);
    assert.match(prompt, /Do not return a title or a publisher/);
    assert.match(prompt, /surname printed on the spine is enough/);
    const outputExample = prompt.slice(prompt.indexOf("Output format"));
    assert.match(outputExample, /"author": "Author Name"/);
    assert.doesNotMatch(outputExample, /"title"/);
    assert.doesNotMatch(outputExample, /"publisher"/);
    assert.match(prompt, /"title": "The Hobbit"/);
    assert.match(prompt, /"rawText": "The Hobbit Tolkien"/);
  });

  it("keeps the assembled title and a spine-grounded author", () => {
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
    assert.equal(result[0].publisher, "");
    assert.equal(result[0].rawText, "The Hobbit Tolkien HarperCollins");
    assert.equal("matchedWords" in result[0], false);
  });

  it("keeps a full author when only the surname was read", () => {
    const result = spinesForClientResponse(
      [
        {
          title: "OUR KIDS THE AMERICAN DREAM IN CRISIS PUTNAM",
          author: "",
          publisher: "",
          rawText: "OUR KIDS PUTNAM",
          score: 0.8,
          box: null,
          polygon: null,
          matchedWords: [],
        },
      ],
      [
        {
          id: 0,
          title: "Robert D Putnam",
          author: "Robert D. Putnam",
          publisher: "Simon & Schuster",
        },
      ],
    );
    assert.equal(
      result[0].title,
      "Our Kids the American Dream in Crisis Putnam",
    );
    assert.equal(result[0].author, "Robert D. Putnam");
    assert.equal(result[0].publisher, "");
  });

  it("falls back to spine fields when AI list is missing", () => {
    const result = spinesForClientResponse(
      [
        {
          title: "Dune",
          author: "",
          publisher: "Ace",
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
    assert.equal(result[0].author, "");
    assert.equal(result[0].publisher, "");
    assert.equal(result[0].rawText, "Dune Herbert");
    assert.equal(result[0].score, 0.5);
    assert.equal("matchedWords" in result[0], false);
  });

  it("title-cases the OCR title and drops an author that was not on the spine", () => {
    const result = spinesForClientResponse(
      [
        {
          title: "THE LORD OF THE RINGS",
          author: "",
          publisher: "",
          rawText: "THE LORD OF THE RINGS TOLKIEN",
          score: 0.8,
          box: null,
          polygon: null,
          matchedWords: [],
        },
      ],
      [
        {
          id: 0,
          title: "FOR WHOM THE BELL TOLLS",
          author: "Ernest Hemingway",
          publisher: "HarperCollins",
        },
      ],
    );
    assert.equal(result[0].title, "The Lord of the Rings");
    assert.equal(result[0].author, "");
    assert.equal(result[0].publisher, "");
  });
});
