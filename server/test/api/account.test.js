const assert = require("node:assert/strict");
const { after, before, describe, it } = require("node:test");
const {
  createTestApp,
  createMockSupabase,
  listen,
} = require("../helpers/app-harness");

const FREE_USER = {
  id: "user-free",
  email: "free@example.com",
  created_at: "2026-01-15T00:00:00.000Z",
  email_confirmed_at: "2026-01-15T01:00:00.000Z",
  app_metadata: { plan: "free" },
  identities: [{ provider: "email" }],
};

const PAID_USER = {
  id: "user-paid",
  email: "paid@example.com",
  created_at: "2026-02-01T00:00:00.000Z",
  email_confirmed_at: "2026-02-01T01:00:00.000Z",
  app_metadata: {
    plan: "premium",
    stripe_customer_id: "cus_test",
    stripe_subscription_id: "sub_test",
  },
  identities: [{ provider: "email" }],
};

describe("account API", { concurrency: 1 }, () => {
  let baseUrl;
  let close;
  let restoreEnv;
  let supabase;

  before(async () => {
    supabase = createMockSupabase({
      usersByToken: {
        "token-free": FREE_USER,
        "token-paid": PAID_USER,
      },
      tables: {
        user_books: [
          { id: 1, user_id: "user-free", title: "One" },
          { id: 2, user_id: "user-free", title: "Two" },
          { id: 3, user_id: "user-paid", title: "Paid book" },
        ],
        shelves: [{ id: 10, user_id: "user-free", name: "Shelf" }],
        libraries: [
          { id: 20, user_id: "user-free", name: "Room" },
          { id: 21, user_id: "user-free", name: "Room 2" },
        ],
        support_tickets: [
          {
            id: 7,
            user_id: "user-free",
            email: "free@example.com",
            subject: "Help",
            body: "Please help",
          },
        ],
      },
    });

    const built = createTestApp({
      supabase,
      env: {
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
    return { Authorization: `Bearer ${token}` };
  }

  it("returns 401 without a bearer token", async () => {
    const response = await fetch(`${baseUrl}/api/account`);
    assert.equal(response.status, 401);
  });

  it("returns plan identity and library counts", async () => {
    const response = await fetch(`${baseUrl}/api/account`, {
      headers: authHeaders("token-free"),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.email, "free@example.com");
    assert.equal(body.emailConfirmedAt, "2026-01-15T01:00:00.000Z");
    assert.equal(body.createdAt, "2026-01-15T00:00:00.000Z");
    assert.deepEqual(body.providers, ["email"]);
    assert.equal(body.counts.books, 2);
    assert.equal(body.counts.shelves, 1);
    assert.equal(body.counts.libraries, 2);
  });

  it("rejects account deletion without the confirmation phrase", async () => {
    const response = await fetch(`${baseUrl}/api/account/delete`, {
      method: "POST",
      headers: {
        ...authHeaders("token-free"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ confirm: "delete" }),
    });
    assert.equal(response.status, 400);
    const stillThere = await supabase.auth.getUser("token-free");
    assert.equal(stillThere.data.user.email, "free@example.com");
  });

  it("refuses to delete a paid account when Stripe is not configured", async () => {
    const response = await fetch(`${baseUrl}/api/account/delete`, {
      method: "POST",
      headers: {
        ...authHeaders("token-paid"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ confirm: "DELETE" }),
    });
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.match(body.error, /billing/i);
    const stillThere = await supabase.auth.getUser("token-paid");
    assert.equal(stillThere.data.user.id, "user-paid");
    assert.equal(
      supabase._tables.user_books.some((row) => row.user_id === "user-paid"),
      true,
    );
  });

  it("deletes a free account and its support history", async () => {
    const response = await fetch(`${baseUrl}/api/account/delete`, {
      method: "POST",
      headers: {
        ...authHeaders("token-free"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ confirm: " DELETE " }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.ok, true);
    const gone = await supabase.auth.getUser("token-free");
    assert.equal(gone.data.user, null);
    assert.equal(
      supabase._tables.support_tickets.some((row) => row.user_id === "user-free"),
      false,
    );
  });
});