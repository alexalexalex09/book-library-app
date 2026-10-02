const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  buildGoogleBooksQuery,
  cleanSearchText,
  looksLikeIsbn,
  extractIsbnFromText,
  shapeSearchFields,
  rankBookItems,
  scoreVolume,
  preferStrongerBookResults,
  needsSearchFallback,
  needsTitleOnlyRetry,
  SUGGEST_SCORE,
} = require("../src/book-search-rank");

describe("book-search-rank", () => {
  it("cleans OCR noise without reordering words", () => {
    assert.equal(cleanSearchText("The Hobbit $12.99"), "The Hobbit");
    assert.equal(cleanSearchText("Unlabeled spine"), "");
    assert.equal(cleanSearchText("Hobbit | Tolkien •"), "Hobbit Tolkien");
    assert.equal(cleanSearchText("Hobbit \uFFFD ★"), "Hobbit");
    assert.equal(
      cleanSearchText("All the Ways Our Dead Still Speak WILDE"),
      "All the Ways Our Dead Still Speak WILDE",
    );
  });

  it("detects ISBN-shaped queries", () => {
    assert.equal(looksLikeIsbn("9780261103573"), true);
    assert.equal(looksLikeIsbn("The Hobbit"), false);
  });

  it("extracts ISBN from raw OCR text", () => {
    assert.equal(
      extractIsbnFromText("HarperCollins 978-0-261-10357-3 Tolkien"),
      "9780261103573",
    );
    assert.equal(extractIsbnFromText("The Hobbit"), null);
  });

  it("sends the refined title as a general query and ignores extra fields", () => {
    assert.equal(buildGoogleBooksQuery("The Hobbit", "Tolkien"), "The Hobbit");
    assert.equal(buildGoogleBooksQuery("9780261103573", ""), "9780261103573");
    assert.equal(
      buildGoogleBooksQuery("All the Ways Our Dead Still Speak WILDE", "Wilde"),
      "All the Ways Our Dead Still Speak WILDE",
    );
    assert.equal(
      buildGoogleBooksQuery("The Hobbit", "Tolkien", {
        rawText: "scrambled raw text 9780261103573",
        mode: "intitle",
      }),
      "The Hobbit",
    );
    assert.equal(buildGoogleBooksQuery("Dune $12.99", "Herbert"), "Dune");
    assert.equal(buildGoogleBooksQuery("Unlabeled Spine"), "");
  });

  it("still describes author salvage for callers that ask for it directly", () => {
    const shaped = shapeSearchFields(
      "All the Ways Our Dead Still Speak WILDE",
      "",
    );
    assert.equal(shaped.title, "All the Ways Our Dead Still Speak");
    assert.equal(shaped.author, "WILDE");
  });

  it("ranks closer title matches higher", () => {
    const items = [
      { id: "a", volumeInfo: { title: "Completely Unrelated", authors: ["X"] } },
      {
        id: "b",
        volumeInfo: { title: "The Hobbit", authors: ["J. R. R. Tolkien"] },
      },
      {
        id: "c",
        volumeInfo: { title: "The Hobbit Companion", authors: ["Other"] },
      },
    ];
    const ranked = rankBookItems(items, "The Hobbit");
    assert.equal(ranked[0].id, "b");
    assert.ok(ranked[0].matchScore >= ranked[1].matchScore);
  });

  it("prefers exact title+author over weak Speak/Dead keyword overlap", () => {
    const items = [
      {
        id: "sciens",
        volumeInfo: {
          title: "How to Speak with the Dead, a Practical Handbook",
          authors: ["Sciens"],
        },
      },
      {
        id: "wilde",
        volumeInfo: {
          title: "All the Ways Our Dead Still Speak",
          authors: ["Caleb Wilde"],
        },
      },
    ];
    const ranked = rankBookItems(items, "All the Ways Our Dead Still Speak WILDE");
    assert.equal(ranked[0].id, "wilde");
    assert.ok(ranked[0].matchScore > ranked[1].matchScore);

    const correct = scoreVolume(
      {
        title: "All the Ways Our Dead Still Speak",
        authors: ["Caleb Wilde"],
      },
      "All the Ways Our Dead Still Speak WILDE",
    );
    const wrong = scoreVolume(
      {
        title: "How to Speak with the Dead, a Practical Handbook",
        authors: ["Sciens"],
      },
      "All the Ways Our Dead Still Speak WILDE",
    );
    assert.ok(correct > wrong);
    assert.ok(correct - wrong > 0.3);
  });

  it("ranks a volume higher when the query words also match its publisher", () => {
    const query = "Dune Messiah Ace";
    const withPublisher = scoreVolume(
      {
        title: "Dune Messiah",
        authors: ["Frank Herbert"],
        publisher: "Ace Books",
      },
      query,
    );
    const without = scoreVolume(
      {
        title: "Dune Messiah",
        authors: ["Frank Herbert"],
        publisher: "Penguin",
      },
      query,
    );
    assert.ok(withPublisher > without);
  });

  it("scores exact title matches highly", () => {
    const score = scoreVolume(
      { title: "Dune", authors: ["Frank Herbert"] },
      "Dune",
    );
    assert.ok(score > 0.7);
  });

  it("needs search fallback when results are empty or weak", () => {
    assert.equal(needsSearchFallback([]), true);
    assert.equal(needsSearchFallback([{ matchScore: 0.2 }]), true);
    assert.equal(needsSearchFallback([{ matchScore: SUGGEST_SCORE }]), false);
    assert.equal(needsSearchFallback([{ matchScore: 0.1 }]), true);
    // Legacy alias still works; author arg is ignored.
    assert.equal(needsTitleOnlyRetry([], "Tolkien"), true);
    assert.equal(needsTitleOnlyRetry([{ matchScore: 0.1 }], ""), true);
  });

  it("prefers fallback when primary is empty or weaker below suggest score", () => {
    const weak = [{ id: "weak", matchScore: 0.2 }];
    const strong = [{ id: "strong", matchScore: 0.8 }];
    assert.equal(preferStrongerBookResults([], strong)[0].id, "strong");
    assert.equal(preferStrongerBookResults(weak, strong)[0].id, "strong");
    assert.equal(
      preferStrongerBookResults(
        [{ id: "ok", matchScore: 0.6 }],
        strong,
      )[0].id,
      "ok",
    );
    assert.equal(preferStrongerBookResults(strong, [])[0].id, "strong");
  });
});
