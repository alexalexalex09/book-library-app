const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("path");
const { describe, it } = require("node:test");
const { deleteShelfById } = require(path.join(
  __dirname,
  "../../client/src/js/shelf-delete.js",
));

function createMockClient({ error = null } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      const filters = [];
      const builder = {
        delete() {
          calls.push({ table, op: "delete", filters });
          return builder;
        },
        eq(column, value) {
          filters.push({ column, value });
          return builder;
        },
        then(resolve) {
          resolve({ data: null, error });
        },
      };
      return builder;
    },
  };
}

describe("deleteShelfById", () => {
  it("deletes only the shelf (books cascade) scoped to the owner", async () => {
    const client = createMockClient();
    const { error } = await deleteShelfById(client, {
      shelfId: 42,
      userId: "user-1",
    });
    assert.equal(error, null);
    assert.deepEqual(client.calls, [
      {
        table: "shelves",
        op: "delete",
        filters: [
          { column: "id", value: 42 },
          { column: "user_id", value: "user-1" },
        ],
      },
    ]);
  });

  it("returns a delete error without touching user_books", async () => {
    const client = createMockClient({
      error: { message: "network failed" },
    });
    const { error } = await deleteShelfById(client, {
      shelfId: 7,
      userId: "user-1",
    });
    assert.equal(error.message, "network failed");
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].table, "shelves");
  });

  it("rejects missing arguments without writing", async () => {
    const client = createMockClient();
    const missingShelf = await deleteShelfById(client, { userId: "user-1" });
    const missingUser = await deleteShelfById(client, { shelfId: 1 });
    const missingClient = await deleteShelfById(null, {
      shelfId: 1,
      userId: "user-1",
    });
    assert.match(missingShelf.error.message, /required/i);
    assert.match(missingUser.error.message, /required/i);
    assert.match(missingClient.error.message, /not available/i);
    assert.equal(client.calls.length, 0);
  });
});

describe("app.js shelf delete wiring", () => {
  it("deletes via deleteShelfById and does not wipe user_books first", () => {
    const appJs = fs.readFileSync(
      path.join(__dirname, "../../client/src/js/app.js"),
      "utf8",
    );
    const indexHtml = fs.readFileSync(
      path.join(__dirname, "../../client/src/index.html"),
      "utf8",
    );
    assert.match(indexHtml, /js\/shelf-delete\.js/);
    assert.match(appJs, /deleteShelfById\(supabaseClient/);
    assert.doesNotMatch(
      appJs,
      /from\("user_books"\)[\s\S]{0,120}\.delete\(\)[\s\S]{0,80}from\("shelves"\)[\s\S]{0,40}\.delete\(\)/,
    );
  });
});
