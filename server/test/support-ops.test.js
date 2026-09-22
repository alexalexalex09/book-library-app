const assert = require("node:assert/strict");
const { after, before, describe, it } = require("node:test");
const {
  createTestApp,
  createMockSupabase,
  listen,
} = require("./helpers/app-harness");

const USER_UUID = "22222222-2222-4222-8222-222222222222";
const ADMIN_UUID = "11111111-1111-4111-8111-111111111111";

describe("support + usage + ops", () => {
  let harness;
  let server;
  let baseUrl;
  let tables;
  let sentMail;

  const user = {
    id: USER_UUID,
    email: "reader@example.com",
    created_at: "2026-01-01T00:00:00Z",
    app_metadata: { plan: "free" },
  };
  const adminUser = {
    id: ADMIN_UUID,
    email: "ops@shelfmapper.com",
    created_at: "2026-01-01T00:00:00Z",
    app_metadata: { role: "admin", plan: "free" },
  };

  before(async () => {
    tables = {
      admin_audit_log: [],
      admin_settings: [
        { key: "signup_notify_mode", value: { mode: "immediate" } },
        { key: "support_notify_mode", value: { mode: "immediate" } },
      ],
      signup_events: [],
      support_tickets: [],
      support_ticket_messages: [],
      api_usage_events: [],
      user_engagement: [],
      libraries: [],
      shelves: [],
      user_books: [],
      library_shares: [],
      ocr_cache: [],
    };
    sentMail = [];
    const supabase = createMockSupabase({
      usersByToken: {
        "user-token": user,
        "admin-token": adminUser,
      },
      tables,
    });
    supabase.auth.admin.listUsers = async () => ({
      data: { users: [user, adminUser] },
      error: null,
    });
    supabase.auth.admin.getUserById = async (id) => {
      const map = { [USER_UUID]: user, [ADMIN_UUID]: adminUser };
      const found = map[id];
      if (!found) return { data: { user: null }, error: { message: "missing" } };
      return { data: { user: found }, error: null };
    };

    harness = createTestApp({
      supabase,
      env: {
        NODE_ENV: "production",
        ADMIN_EMAILS: "ops@shelfmapper.com",
        CORS_ORIGINS: "https://shelfmapper.com,https://admin.shelfmapper.com",
        ADMIN_ORIGINS: "https://admin.shelfmapper.com",
        CRON_SECRET: "cron-test-secret",
        GEMINI_API_KEY: "fake-key",
      },
      mail: {
        async sendEmail(payload) {
          sentMail.push(payload);
          return { ok: true };
        },
      },
      processImage: async () => ({ spines: [{ title: "Test" }] }),
      fetchBooks: async () => ({
        status: 200,
        data: { items: [] },
      }),
    });
    ({ server, baseUrl } = await listen(harness.app));
  });

  after(async () => {
    await server?.close();
    harness?.restoreEnv();
  });

  async function request(path, { token, method = "GET", origin, body } = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(origin ? { Origin: origin } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    return { status: response.status, data };
  }

  it("creates a support ticket without auth and kicks AI suggestion", async () => {
    const beforeCount = tables.support_tickets.length;
    const res = await request("/api/support/tickets", {
      method: "POST",
      body: {
        email: "guest@example.com",
        category: "billing",
        subject: "Refund question",
        body: "I was charged twice.",
      },
    });
    assert.equal(res.status, 201);
    assert.ok(res.data.ticket?.public_id);
    assert.equal(res.data.ticket.ai_suggestion, undefined);
    assert.equal(tables.support_tickets.length, beforeCount + 1);
    assert.ok(tables.support_ticket_messages.length >= 1);

    // Allow background AI kickoff
    await new Promise((r) => setTimeout(r, 50));
    const ticket = tables.support_tickets.find(
      (t) => t.public_id === res.data.ticket.public_id,
    );
    assert.ok(ticket);
    assert.ok(
      ticket.ai_suggestion_status === "ready" ||
        ticket.ai_suggestion_status === "pending" ||
        ticket.ai_suggestion_status === "skipped",
    );
  });

  it("lists own tickets for authenticated user", async () => {
    const created = await request("/api/support/tickets", {
      method: "POST",
      token: "user-token",
      body: {
        email: "reader@example.com",
        category: "ocr",
        subject: "Scan failed",
        body: "Nothing detected",
      },
    });
    assert.equal(created.status, 201);

    const list = await request("/api/support/tickets", { token: "user-token" });
    assert.equal(list.status, 200);
    assert.ok(list.data.tickets.some((t) => t.subject === "Scan failed"));
    assert.equal(list.data.tickets[0].ai_suggestion, undefined);
  });

  it("records usage events on OCR success and engagement on auth", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const form = new FormData();
    form.append(
      "image",
      new Blob([png], { type: "image/png" }),
      "tiny.png",
    );
    const response = await fetch(`${baseUrl}/api/ocr`, {
      method: "POST",
      headers: { Authorization: "Bearer user-token" },
      body: form,
    });
    assert.equal(response.status, 200);
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(
      tables.api_usage_events.some(
        (e) => e.user_id === USER_UUID && e.action === "ocr_ok",
      ),
    );
    assert.ok(
      tables.user_engagement.some((e) => e.user_id === USER_UUID),
    );
  });

  it("admin can reply only from admin origin and regenerate suggestion", async () => {
    const ticket = tables.support_tickets[0];
    assert.ok(ticket);

    const denied = await request(`/api/admin/support/tickets/${ticket.id}/reply`, {
      token: "admin-token",
      method: "POST",
      origin: "https://evil.example",
      body: { body: "Nope" },
    });
    assert.equal(denied.status, 403);

    const ok = await request(`/api/admin/support/tickets/${ticket.id}/reply`, {
      token: "admin-token",
      method: "POST",
      origin: "https://admin.shelfmapper.com",
      body: { body: "Happy to help — checking billing now." },
    });
    assert.equal(ok.status, 201);

    const suggest = await request(
      `/api/admin/support/tickets/${ticket.id}/suggest`,
      {
        token: "admin-token",
        method: "POST",
        origin: "https://admin.shelfmapper.com",
      },
    );
    assert.equal(suggest.status, 200);
    assert.ok(["ready", "skipped", "failed"].includes(suggest.data.status));
  });

  it("returns overview shape for admin", async () => {
    const res = await request("/api/admin/stats/overview", {
      token: "admin-token",
    });
    assert.equal(res.status, 200);
    assert.ok(res.data.growth);
    assert.ok(res.data.activation);
    assert.ok(res.data.usage);
    assert.ok(res.data.support);
    assert.ok(res.data.engagement);
    assert.ok(res.data.billing);
  });

  it("ops digest requires cron secret", async () => {
    const denied = await request("/api/internal/ops/digest", { method: "POST" });
    assert.equal(denied.status, 401);

    const ok = await request("/api/internal/ops/digest?force=1", {
      method: "POST",
      headers: undefined,
    });
    // without secret still 401
    assert.equal(ok.status, 401);

    const response = await fetch(`${baseUrl}/api/internal/ops/digest?force=1`, {
      method: "POST",
      headers: { "x-cron-secret": "cron-test-secret" },
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.ok(data.signupMode || data.supportMode || data.sent != null);
  });
});
