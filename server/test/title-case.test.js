const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { toBookTitleCase } = require("../src/title-case");

describe("toBookTitleCase", () => {
  it("capitalizes principal words and lowercases function words", () => {
    assert.equal(
      toBookTitleCase("LONG ACCOMPANY THEM WITH SINGING - THE CHRISTIAN FUNERAL"),
      "Long Accompany Them with Singing - the Christian Funeral",
    );
    assert.equal(toBookTitleCase("THE LORD OF THE RINGS"), "The Lord of the Rings");
    assert.equal(toBookTitleCase("A TALE OF TWO CITIES"), "A Tale of Two Cities");
    assert.equal(toBookTitleCase("FOR WHOM THE BELL TOLLS"), "For Whom the Bell Tolls");
    assert.equal(toBookTitleCase("the catcher in the rye"), "The Catcher in the Rye");
  });

  it("keeps the first and last words capitalized", () => {
    assert.equal(toBookTitleCase("THE END"), "The End");
    assert.equal(toBookTitleCase("OF MICE AND MEN"), "Of Mice and Men");
  });

  it("leaves already mixed-case titles alone", () => {
    assert.equal(toBookTitleCase("The Hobbit"), "The Hobbit");
    assert.equal(toBookTitleCase("RightTop RightBot"), "RightTop RightBot");
    assert.equal(toBookTitleCase("iPhone User Guide"), "iPhone User Guide");
  });

  it("title-cases hyphenated compounds and contractions", () => {
    assert.equal(toBookTitleCase("STATE-OF-THE-ART"), "State-of-the-Art");
    assert.equal(toBookTitleCase("DON'T STOP"), "Don't Stop");
    assert.equal(toBookTitleCase("O'BRIEN'S GUIDE"), "O'Brien's Guide");
  });

  it("returns empty input unchanged", () => {
    assert.equal(toBookTitleCase(""), "");
  });
});
