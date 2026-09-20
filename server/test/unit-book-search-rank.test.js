const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  buildGoogleBooksQuery,
  cleanSearchText,
  looksLikeIsbn,
  rankBookItems,
  scoreVolume,
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

  it("scores exact title matches highly", () => {
    const score = scoreVolume(
      { title: "Dune", authors: ["Frank Herbert"] },
      "Dune",
      "Herbert",
    );
    assert.ok(score > 0.7);
  });
});
