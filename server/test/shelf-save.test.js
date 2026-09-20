const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  buildUserBooksRows,
  bookIdsToDeleteAfterInsert,
} = require("../../client/src/js/shelf-save.js");

describe("buildUserBooksRows", () => {
  it("maps detected spines onto user_books rows", () => {
    const rows = buildUserBooksRows({
      userId: "user-1",
      shelfId: 42,
      imagePath: "user-1/abc.jpg",
      spines: [
        {
          title: "  Dune  ",
          box: { minX: 0 },
          polygon: [{ x: 0, y: 0 }],
          thumbnail: "http://covers.example/dune.jpg",
        },
      ],
    });

    assert.deepEqual(rows, [
      {
        user_id: "user-1",
        shelf_id: 42,
        title: "Dune",
        bounding_box: { minX: 0 },
        polygon: [{ x: 0, y: 0 }],
        cover: "https://covers.example/dune.jpg",
        shelf_image_url: "user-1/abc.jpg",
      },
    ]);
  });

  it("falls back to Untitled Book when OCR title is empty", () => {
    const rows = buildUserBooksRows({
      userId: "user-1",
      shelfId: 7,
      imagePath: "user-1/hash.jpg",
      spines: [{ title: "   " }],
    });
    assert.equal(rows[0].title, "Untitled Book");
  });
});

describe("bookIdsToDeleteAfterInsert", () => {
  it("does not delete existing books when the replacement insert failed", () => {
    assert.deepEqual(
      bookIdsToDeleteAfterInsert([{ id: 1 }, { id: 2 }], false),
      [],
    );
  });

  it("deletes prior book ids only after a successful insert", () => {
    assert.deepEqual(
      bookIdsToDeleteAfterInsert([{ id: 10 }, { id: 11 }, {}], true),
      [10, 11],
    );
  });

  it("replaces existing shelf books without dropping them first", () => {
    const db = [{ id: 1, title: "Old OCR" }];
    const previous = db.map((row) => ({ id: row.id }));
    const incoming = buildUserBooksRows({
      userId: "user-1",
      shelfId: 42,
      imagePath: "user-1/abc.jpg",
      spines: [{ title: "Corrected Title" }],
    });

    const nextId = 100;
    const inserted = incoming.map((row, index) => ({ ...row, id: nextId + index }));
    db.push(...inserted);

    const deleteIds = bookIdsToDeleteAfterInsert(previous, true);
    const remaining = db.filter((row) => !deleteIds.includes(row.id));

    assert.deepEqual(
      remaining.map((row) => row.title),
      ["Corrected Title"],
    );
  });
});
