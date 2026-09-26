const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  buildGoogleBooksQuery,
  cleanSearchText,
  looksLikeIsbn,
  extractIsbnFromText,
  rankBookItems,
  scoreVolume,
  preferStrongerBookResults,
  needsTitleOnlyRetry,
  SUGGEST_SCORE,
} = require("../src/book-search-rank");

describe("book-search-rank", () => {
  it("cleans OCR noise from search text", () => {
    assert.equal(cleanSearchText("The Hobbit $12.99"), "The Hobbit");
    assert.equal(cleanSearchText("Unlabeled spine"), "");
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

  it("builds intitle/inauthor Google queries", () => {
    assert.equal(
      buildGoogleBooksQuery("The Hobbit", "Tolkien"),
      'intitle:"The Hobbit" inauthor:"Tolkien"',
    );
    assert.equal(
      buildGoogleBooksQuery("9780261103573", ""),
      "isbn:9780261103573",
    );
  });

  it("builds isbn query from rawText when title is not an ISBN", () => {
    assert.equal(
      buildGoogleBooksQuery("The Hobbit", "Tolkien", {
        rawText: "The Hobbit 9780261103573",
      }),
      "isbn:9780261103573",
    );
  });

  it("does not put publisher into the Google query string", () => {
    const query = buildGoogleBooksQuery("Dune", "Herbert", {
      rawText: "Dune Frank Herbert Ace Books",
    });
    assert.equal(query.includes("inpublisher"), false);
    assert.equal(query, 'intitle:"Dune" inauthor:"Herbert"');
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
    const ranked = rankBookItems(items, {
      title: "The Hobbit",
      author: "Tolkien",
    });
    assert.equal(ranked[0].id, "b");
    assert.ok(ranked[0].matchScore >= ranked[1].matchScore);
  });

  it("gives a small ranking bonus for matching publisher", () => {
    const volume = {
      title: "Dune Messiah",
      authors: ["Frank Herbert"],
      publisher: "Ace Books",
    };
    const without = scoreVolume(volume, "Dune", "Herbert", "");
    const withPublisher = scoreVolume(volume, "Dune", "Herbert", "Ace");
    assert.ok(withPublisher > without);
    assert.ok(withPublisher - without <= 0.08 + 1e-9);
  });

  it("scores exact title matches highly", () => {
    const score = scoreVolume(
      { title: "Dune", authors: ["Frank Herbert"] },
      "Dune",
      "Herbert",
    );
    assert.ok(score > 0.7);
  });

  it("needs title-only retry when author search is empty or weak", () => {
    assert.equal(needsTitleOnlyRetry([], "Tolkien"), true);
    assert.equal(
      needsTitleOnlyRetry([{ matchScore: 0.2 }], "Tolkien"),
      true,
    );
    assert.equal(
      needsTitleOnlyRetry([{ matchScore: SUGGEST_SCORE }], "Tolkien"),
      false,
    );
    assert.equal(needsTitleOnlyRetry([{ matchScore: 0.1 }], ""), false);
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
