const assert = require("node:assert/strict");
const { after, before, describe, it } = require("node:test");
const fs = require("fs");
const path = require("path");
const {
  createTestApp,
  createMockSupabase,
  listen,
} = require("../helpers/app-harness");

const FIXTURES = path.join(__dirname, "../fixtures");
const FREE_USER = {
  id: "user-free",
  email: "free@example.com",
  app_metadata: { plan: "free" },
};
const PREMIUM_USER = {
  id: "user-premium",
  email: "premium@example.com",
  app_metadata: { plan: "premium" },
};

describe("API integration", () => {
  let baseUrl;
  let close;
  let restoreEnv;
  let supabase;

  before(async () => {
    supabase = createMockSupabase({
      usersByToken: {
        "token-free": FREE_USER,
        "token-premium": PREMIUM_USER,
      },
      tables: {
        library_shares: [
          {
            id: 1,
            user_id: "user-premium",
            token: "valid-share-token",
            library_id: null,
            revoked_at: null,
          },
        ],
        shelves: [
          {
            id: 10,
            user_id: "user-premium",
            library_id: null,
            name: "Shelf A",
          },
        ],
        user_books: [
          {
            id: 100,
            user_id: "user-premium",
            shelf_id: 10,
            title: "Test Book",
            author: "Author",
            cover: null,
            bounding_box: null,
            polygon: null,
            created_at: "2026-01-01T00:00:00.000Z",
          },
        ],
        libraries: [],
      },
    });

    const built = createTestApp({
      supabase,
      fetchBooks: async (q) => ({
        status: 200,
        data: {
          items: [
            {
              id: "vol-1",
              volumeInfo: {
                title: "The Hobbit",
                authors: ["J. R. R. Tolkien"],
                publishedDate: "1937",
                industryIdentifiers: [{ type: "ISBN_13", identifier: "9780261103573" }],
              },
            },
          ],
        },
        // Echo query so tests can assert shaping if needed
        _echoQuery: q,
      }),
      processImage: async () => ({ spines: [], imageHash: "abc" }),
      env: {
        // Force billing unconfigured for most tests
        STRIPE_SECRET_KEY: "",
        STRIPE_WEBHOOK_SECRET: "",
        STRIPE_PRICE_ID_MONTHLY: "",
        STRIPE_PRICE_ID_ANNUAL: "",
        APP_BASE_URL: "http://127.0.0.1:3000",
      },
    });
    restoreEnv = built.restoreEnv;
    const listening = await listen(built.app);
    baseUrl = listening.baseUrl;
    close = listening.close;
  });

  after(async () => {
    if (close) await close();
    if (restoreEnv) restoreEnv();
  });

  function authHeaders(token) {
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  describe("auth gates", () => {
    for (const route of [
      ["POST", "/api/ocr"],
      ["GET", "/api/books?q=test"],
      ["GET", "/api/rooms"],
      ["GET", "/api/shares"],
      ["GET", "/api/billing/status"],
      ["GET", "/api/account"],
    ]) {
      it(`returns 401 for ${route[0]} ${route[1]} without Bearer`, async () => {
        const response = await fetch(`${baseUrl}${route[1]}`, {
          method: route[0],
        });
        assert.equal(response.status, 401);
      });
    }
  });

  describe("public config and static pages", () => {
    it("serves public-config.js with app origin assignment", async () => {
      const response = await fetch(`${baseUrl}/api/public-config.js`);
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.match(text, /window\.__SHELFMAPPER_PUBLIC__/);
      assert.match(response.headers.get("content-type") || "", /javascript/);
    });

    it("sets CSP without unsafe-inline scripts", async () => {
      const response = await fetch(`${baseUrl}/api/public-config`);
      const csp = response.headers.get("content-security-policy") || "";
      assert.match(csp, /script-src 'self'/);
      assert.doesNotMatch(csp, /unsafe-inline/);
    });

    for (const page of ["/", "/terms.html", "/privacy.html", "/pricing.html"]) {
      it(`returns 200 for ${page}`, async () => {
        const response = await fetch(`${baseUrl}${page}`);
        assert.equal(response.status, 200);
      });
    }
  });

  describe("OCR upload validation", () => {
    it("rejects missing image", async () => {
      const response = await fetch(`${baseUrl}/api/ocr`, {
        method: "POST",
        headers: authHeaders("token-free"),
      });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.match(body.error, /No image/i);
    });

    it("rejects non-image upload", async () => {
      const form = new FormData();
      form.append("image", new Blob(["hello"], { type: "text/plain" }), "x.txt");
      const response = await fetch(`${baseUrl}/api/ocr`, {
        method: "POST",
        headers: authHeaders("token-free"),
        body: form,
      });
      assert.ok(response.status === 400 || response.status === 415);
    });

    it("accepts valid JPEG and returns mocked spines", async () => {
      const jpeg = fs.readFileSync(path.join(FIXTURES, "tiny.jpg"));
      const form = new FormData();
      form.append(
        "image",
        new Blob([jpeg], { type: "image/jpeg" }),
        "tiny.jpg",
      );
      const response = await fetch(`${baseUrl}/api/ocr`, {
        method: "POST",
        headers: authHeaders("token-free"),
        body: form,
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.ok(Array.isArray(body.spines));
    });
  });

  describe("books proxy", () => {
    it("requires a search query", async () => {
      const response = await fetch(`${baseUrl}/api/books`, {
        headers: authHeaders("token-free"),
      });
      assert.equal(response.status, 400);
    });

    it("returns ranked mocked results when authenticated", async () => {
      const response = await fetch(
        `${baseUrl}/api/books?q=hobbit&author=Tolkien`,
        {
          headers: authHeaders("token-free"),
        },
      );
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.items[0].volumeInfo.title, "The Hobbit");
      assert.ok(String(body.query).includes("intitle:"));
      assert.ok(String(body.query).includes("inauthor:"));
      assert.ok(Number.isFinite(body.items[0].matchScore));
    });
  });

  describe("premium gates", () => {
    it("blocks free users from creating shares", async () => {
      const response = await fetch(`${baseUrl}/api/shares`, {
        method: "POST",
        headers: {
          ...authHeaders("token-free"),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ libraryId: null }),
      });
      assert.equal(response.status, 403);
      const body = await response.json();
      assert.equal(body.code, "FEATURE_LOCKED");
    });

    it("blocks free users from creating rooms", async () => {
      const response = await fetch(`${baseUrl}/api/rooms`, {
        method: "POST",
        headers: {
          ...authHeaders("token-free"),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Study" }),
      });
      assert.equal(response.status, 403);
    });

    it("blocks free users from custom covers", async () => {
      const response = await fetch(`${baseUrl}/api/books/1/cover`, {
        method: "POST",
        headers: {
          ...authHeaders("token-free"),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ cover: "https://example.com/c.jpg" }),
      });
      assert.equal(response.status, 403);
    });

    it("allows free users to list default room", async () => {
      const response = await fetch(`${baseUrl}/api/rooms`, {
        headers: authHeaders("token-free"),
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body[0].isDefault, true);
    });
  });

  describe("billing", () => {
    it("returns BILLING_NOT_CONFIGURED when Stripe env is missing", async () => {
      const response = await fetch(`${baseUrl}/api/billing/status`, {
        headers: authHeaders("token-free"),
      });
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.code, "BILLING_NOT_CONFIGURED");
    });

    it("rejects checkout with invalid interval", async () => {
      // Need billing configured for interval validation path — use nested app
      const configured = createTestApp({
        supabase,
        env: {
          STRIPE_SECRET_KEY: "sk_test_x",
          STRIPE_WEBHOOK_SECRET: "whsec_x",
          STRIPE_PRICE_ID_MONTHLY: "price_m",
          STRIPE_PRICE_ID_ANNUAL: "price_y",
          APP_BASE_URL: "http://127.0.0.1:3000",
        },
      });
      const listening = await listen(configured.app);
      try {
        const response = await fetch(`${listening.baseUrl}/api/billing/checkout`, {
          method: "POST",
          headers: {
            ...authHeaders("token-free"),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ interval: "weekly" }),
        });
        assert.equal(response.status, 400);
      } finally {
        await listening.close();
        configured.restoreEnv();
      }
    });

    it("rejects webhook with invalid signature", async () => {
      const configured = createTestApp({
        supabase,
        env: {
          STRIPE_SECRET_KEY: "sk_test_x",
          STRIPE_WEBHOOK_SECRET: "whsec_x",
          STRIPE_PRICE_ID_MONTHLY: "price_m",
          STRIPE_PRICE_ID_ANNUAL: "price_y",
          APP_BASE_URL: "http://127.0.0.1:3000",
        },
      });
      const listening = await listen(configured.app);
      try {
        const response = await fetch(`${listening.baseUrl}/api/billing/webhook`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "stripe-signature": "bad",
          },
          body: "{}",
        });
        assert.equal(response.status, 400);
      } finally {
        await listening.close();
        configured.restoreEnv();
      }
    });
  });

  describe("shares public read", () => {
    it("returns 404 for unknown token", async () => {
      const response = await fetch(`${baseUrl}/api/share/missing-token`);
      assert.equal(response.status, 404);
    });

    it("returns shelves and books for a valid token", async () => {
      const response = await fetch(`${baseUrl}/api/share/valid-share-token`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.shelves.length, 1);
      assert.equal(body.books[0].title, "Test Book");
    });
  });
});
