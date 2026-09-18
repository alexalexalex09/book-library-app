const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  filterBooksForShare,
  resolveSharedLibraryBookScope,
} = require("../src/share-library");

const ownerBooks = [
  { id: 1, shelf_id: 10, title: "Room A book" },
  { id: 2, shelf_id: 11, title: "Room A book 2" },
  { id: 3, shelf_id: 20, title: "Room B book" },
];

describe("resolveSharedLibraryBookScope", () => {
  it("restricts room-scoped shares even when the room has no shelves", () => {
    const scope = resolveSharedLibraryBookScope({ library_id: 99 }, []);
    assert.equal(scope.restrictToShelfIds, true);
    assert.deepEqual(scope.shelfIds, []);
  });

  it("restricts room-scoped shares to that room's shelves", () => {
    const scope = resolveSharedLibraryBookScope({ library_id: 5 }, [
      { id: 10 },
      { id: 11 },
    ]);
    assert.equal(scope.restrictToShelfIds, true);
    assert.deepEqual(scope.shelfIds, [10, 11]);
  });

  it("keeps whole-library shares unrestricted when there are no shelves", () => {
    const scope = resolveSharedLibraryBookScope({ library_id: null }, []);
    assert.equal(scope.restrictToShelfIds, false);
  });
});

describe("filterBooksForShare", () => {
  it("does not leak the owner's catalog through an empty room share", () => {
    const books = filterBooksForShare({ library_id: 99 }, [], ownerBooks);
    assert.deepEqual(books, []);
  });

  it("returns only books on shelves in the shared room", () => {
    const books = filterBooksForShare({ library_id: 5 }, [{ id: 20 }], ownerBooks);
    assert.deepEqual(books, [{ id: 3, shelf_id: 20, title: "Room B book" }]);
  });

  it("returns all owner books for a whole-library share with no shelves", () => {
    const books = filterBooksForShare({ library_id: null }, [], ownerBooks);
    assert.equal(books.length, 3);
  });
});
