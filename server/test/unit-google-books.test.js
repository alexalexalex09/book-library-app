const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  createTestApp,
  createMockSupabase,
  listen,
} = require("./helpers/app-harness");
const {
  createGoogleBooksFetcher,
  normalizeBooksError,
  stripImageLinks,
  VOLUME_FIELDS,
} = require("../src/google-books");

function jsonResponse(status, body, headers = {}) {
  return {
    status,
    headers: {
      get(name) {
        return headers[String(name).toLowerCase()] ?? null;
      },
    },
    async json() {
      return body;
    },
  };
}

describe("google books client", () => {
  it("requests catalog fields and strips image links", async () => {
    let url = "";
    const fetchBooks = createGoogleBooksFetcher({
      fetchImpl: async (nextUrl) => {
        url = nextUrl;
        return jsonResponse(200, {
          items: [
            {
              id: "vol",
              volumeInfo: {
                title: "Dune",
                imageLinks: { thumbnail: "http://books.google.com/x.jpg" },
              },
            },
          ],
        });
      },
      sleep: async () => {},
      minIntervalMs: 0,
      random: () => 0,
    });
    const result = await fetchBooks("dune");
    assert.match(url, /fields=/);
    assert.equal(decodeURIComponent(url).includes(VOLUME_FIELDS), true);
    assert.equal(decodeURIComponent(url).includes("imageLinks"), false);
    assert.equal(result.data.items[0].volumeInfo.imageLinks, undefined);
    assert.equal(result.data.items[0].volumeInfo.title, "Dune");
  });

  it("retries a 503 and returns the successful response", async () => {
    let calls = 0;
    const fetchBooks = createGoogleBooksFetcher({
      fetchImpl: async () => {
        calls += 1;
        if (calls < 3) {
          return jsonResponse(503, { error: { message: "Backend Error", code: 503 } });
        }
        return jsonResponse(200, { items: [{ id: "ok", volumeInfo: { title: "Ok" } }] });
      },
      sleep: async () => {},
      minIntervalMs: 0,
      random: () => 0,
    });
    const result = await fetchBooks("retry-me");
    assert.equal(calls, 3);
    assert.equal(result.status, 200);
    assert.equal(result.data.items[0].volumeInfo.title, "Ok");
  });

  it("returns a string error that includes 503 after three failures", async () => {
    let calls = 0;
    const fetchBooks = createGoogleBooksFetcher({
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(503, { error: { message: "Backend Error", code: 503 } });
      },
      sleep: async () => {},
      minIntervalMs: 0,
      random: () => 0,
    });
    const result = await fetchBooks("always-down");
    assert.equal(calls, 3);
    assert.equal(result.status, 503);
    assert.equal(typeof result.data.error, "string");
    assert.match(result.data.error, /503/);
    assert.match(result.data.error, /Backend Error/);
  });

  it("honors Retry-After and does not retry a 400", async () => {
    const delays = [];
    let calls = 0;
    const fetchBooks = createGoogleBooksFetcher({
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse(400, { error: { message: "Bad query" } }, { "retry-after": "9" });
      },
      sleep: async (ms) => {
        delays.push(ms);
      },
      minIntervalMs: 0,
      random: () => 0,
    });
    const result = await fetchBooks("bad");
    assert.equal(calls, 1);
    assert.equal(delays.length, 0);
    assert.equal(result.status, 400);
    assert.match(normalizeBooksError(result.status, result.data).error, /400/);
  });

  it("waits for Retry-After between transient failures", async () => {
    const delays = [];
    let calls = 0;
    const fetchBooks = createGoogleBooksFetcher({
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          return jsonResponse(503, { error: { message: "Busy" } }, { "retry-after": "2" });
        }
        return jsonResponse(200, { items: [] });
      },
      sleep: async (ms) => {
        delays.push(ms);
      },
      minIntervalMs: 0,
      random: () => 0,
    });
    const result = await fetchBooks("busy");
    assert.equal(result.status, 200);
    assert.deepEqual(delays, [2000]);
  });

  it("spaces different queries by the minimum interval", async () => {
    const delays = [];
    const fetchBooks = createGoogleBooksFetcher({
      fetchImpl: async () => jsonResponse(200, { items: [] }),
      sleep: async (ms) => {
        delays.push(ms);
      },
      minIntervalMs: 5000,
      random: () => 0,
    });
    await fetchBooks("one");
    await fetchBooks("two");
    assert.equal(delays.length, 1);
    assert.ok(delays[0] > 1000);
  });

  it("stripImageLinks leaves items without covers untouched", () => {
    const stripped = stripImageLinks({
      items: [{ id: "a", volumeInfo: { title: "Plain" } }],
    });
    assert.equal(stripped.items[0].volumeInfo.title, "Plain");
    assert.equal(stripped.items[0].volumeInfo.imageLinks, undefined);
  });
});

describe("books search cache and errors", () => {
  const user = {
    id: "user-free",
    email: "free@example.com",
    app_metadata: { plan: "free" },
  };

  async function start(fetchBooks) {
    const supabase = createMockSupabase({
      usersByToken: { "token-free": user },
      tables: {},
    });
    const built = createTestApp({
      supabase,
      fetchBooks,
      env: {
        STRIPE_SECRET_KEY: "",
        STRIPE_WEBHOOK_SECRET: "",
        STRIPE_PRICE_ID_MONTHLY: "",
        STRIPE_PRICE_ID_ANNUAL: "",
        APP_BASE_URL: "http://127.0.0.1:3000",
      },
    });
    const listening = await listen(built.app);
    return { supabase, restoreEnv: built.restoreEnv, ...listening };
  }

  it("does not call Google again for the same query", async () => {
    let calls = 0;
    const harness = await start(async () => {
      calls += 1;
      return {
        status: 200,
        data: {
          items: [
            {
              id: "vol",
              volumeInfo: {
                title: "Cached",
                imageLinks: { thumbnail: "https://books.google.com/c.jpg" },
              },
            },
          ],
        },
      };
    });
    try {
      const first = await fetch(`${harness.baseUrl}/api/books?q=cached-title`, {
        headers: { Authorization: "Bearer token-free" },
      });
      const second = await fetch(`${harness.baseUrl}/api/books?q=cached-title`, {
        headers: { Authorization: "Bearer token-free" },
      });
      assert.equal(first.status, 200);
      assert.equal(second.status, 200);
      assert.equal(calls, 1);
      const body = await second.json();
      assert.equal(body.items[0].volumeInfo.imageLinks, undefined);
      assert.equal(harness.supabase._tables.google_books_cache.length, 1);
    } finally {
      await harness.close();
      harness.restoreEnv();
    }
  });

  it("caches only a later success after a 503", async () => {
    let calls = 0;
    const harness = await start(async () => {
      calls += 1;
      if (calls === 1) {
        return { status: 503, data: { error: { message: "Backend Error", code: 503 } } };
      }
      return { status: 200, data: { items: [{ id: "ok", volumeInfo: { title: "Later" } }] } };
    });
    try {
      const failed = await fetch(`${harness.baseUrl}/api/books?q=flaky`, {
        headers: { Authorization: "Bearer token-free" },
      });
      const failedBody = await failed.json();
      const ok = await fetch(`${harness.baseUrl}/api/books?q=flaky`, {
        headers: { Authorization: "Bearer token-free" },
      });
      const again = await fetch(`${harness.baseUrl}/api/books?q=flaky`, {
        headers: { Authorization: "Bearer token-free" },
      });
      assert.equal(failed.status, 503);
      assert.equal(typeof failedBody.error, "string");
      assert.match(failedBody.error, /503/);
      assert.equal(ok.status, 200);
      assert.equal(again.status, 200);
      assert.equal(calls, 2);
    } finally {
      await harness.close();
      harness.restoreEnv();
    }
  });

  it("does not issue a second query when the search fails", async () => {
    const queries = [];
    const harness = await start(async (query) => {
      queries.push(query);
      return { status: 503, data: { error: { message: "Backend Error" } } };
    });
    try {
      const response = await fetch(`${harness.baseUrl}/api/books?q=missing`, {
        headers: { Authorization: "Bearer token-free" },
      });
      assert.equal(response.status, 503);
      assert.deepEqual(queries, ["missing"]);
    } finally {
      await harness.close();
      harness.restoreEnv();
    }
  });

  it("retries the full spine without one damaged word", async () => {
    const queries = [];
    const harness = await start(async (query) => {
      queries.push(query);
      if (query.includes("Xzq")) {
        return { status: 200, data: { items: [] } };
      }
      return {
        status: 200,
        data: {
          items: [
            {
              id: "youth",
              volumeInfo: {
                title: "Awakening Youth Discipleship",
                authors: ["Mahan", "Warren", "White"],
              },
            },
          ],
        },
      };
    });
    try {
      const spine = "Mahan Warren and White Awakening Youth Xzq Discipleship";
      const response = await fetch(
        `${harness.baseUrl}/api/books?q=${encodeURIComponent(spine)}`,
        { headers: { Authorization: "Bearer token-free" } },
      );
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.deepEqual(queries, [
        "Mahan Warren White Awakening Youth Xzq Discipleship",
        "Mahan Warren White Awakening Youth Discipleship",
      ]);
      assert.equal(body.items[0].volumeInfo.title, "Awakening Youth Discipleship");
      assert.ok(body.items[0].matchScore >= 0.72);
    } finally {
      await harness.close();
      harness.restoreEnv();
    }
  });

  it("searches the whole spine once when the match is strong", async () => {
    const queries = [];
    const harness = await start(async (query) => {
      queries.push(query);
      return {
        status: 200,
        data: {
          items: [
            {
              id: "wilde",
              volumeInfo: {
                title: "All the Ways Our Dead Still Speak",
                authors: ["Caleb Wilde"],
              },
            },
          ],
        },
      };
    });
    try {
      const spine = "All the Ways Our Dead Still Speak Wilde Av";
      const response = await fetch(
        `${harness.baseUrl}/api/books?q=${encodeURIComponent(spine)}`,
        { headers: { Authorization: "Bearer token-free" } },
      );
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.deepEqual(queries, ["All Ways Our Dead Still Speak Wilde"]);
      assert.equal(body.items[0].id, "wilde");
      assert.ok(body.items[0].matchScore >= 0.72);
    } finally {
      await harness.close();
      harness.restoreEnv();
    }
  });

  it("keeps the first results when the retry fails", async () => {
    const queries = [];
    const harness = await start(async (query) => {
      queries.push(query);
      if (queries.length === 1) {
        return {
          status: 200,
          data: {
            items: [
              {
                id: "weak",
                volumeInfo: { title: "Completely Unrelated", authors: ["Nobody"] },
              },
            ],
          },
        };
      }
      return { status: 503, data: { error: { message: "Backend Error" } } };
    });
    try {
      const spine = "Mahan Warren and White Awakening Youth Xzq Discipleship";
      const response = await fetch(
        `${harness.baseUrl}/api/books?q=${encodeURIComponent(spine)}`,
        { headers: { Authorization: "Bearer token-free" } },
      );
      const body = await response.json();
      assert.equal(response.status, 200);
      assert.equal(queries.length, 2);
      assert.equal(body.items[0].id, "weak");
    } finally {
      await harness.close();
      harness.restoreEnv();
    }
  });
});
