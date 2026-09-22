const assert = require("node:assert/strict");
const { after, before, describe, it } = require("node:test");
const {
  createTestApp,
  createMockSupabase,
  listen,
} = require("./helpers/app-harness");
const {
  isAdminUser,
  getAllowedCorsOrigins,
  getAdminOrigins,
  createCorsOriginDelegate,
} = require("../src/http-security");
const { projectUserForAdmin } = require("../src/admin-routes");

const ADMIN_UUID = "11111111-1111-4111-8111-111111111111";
const USER_UUID = "22222222-2222-4222-8222-222222222222";
const TARGET_UUID = "33333333-3333-4333-8333-333333333333";

describe("isAdminUser", () => {
  it("requires app_metadata.role=admin and allowlisted email", () => {
    const env = { ADMIN_EMAILS: "ops@shelfmapper.com" };
    assert.equal(
      isAdminUser(
        {
          email: "ops@shelfmapper.com",
          app_metadata: { role: "admin", plan: "free" },
        },
        env,
      ),
      true,
    );
    assert.equal(
      isAdminUser(
        {
          email: "ops@shelfmapper.com",
          user_metadata: { role: "admin" },
          app_metadata: {},
        },
        env,
      ),
      false,
    );
    assert.equal(
      isAdminUser(
        {
          email: "other@shelfmapper.com",
          app_metadata: { role: "admin" },
        },
        env,
      ),
      false,
    );
    assert.equal(
      isAdminUser(
        {
          email: "ops@shelfmapper.com",
          app_metadata: { role: "admin", plan: "premium" },
        },
        { ADMIN_EMAILS: "" },
      ),
      false,
    );
  });

  it("does not treat premium plan as admin", () => {
    assert.equal(
      isAdminUser(
        {
          email: "ops@shelfmapper.com",
          app_metadata: { plan: "premium" },
        },
        { ADMIN_EMAILS: "ops@shelfmapper.com" },
      ),
      false,
    );
  });
});

describe("CORS allowlist", () => {
  it("allows configured origins and rejects others", () => {
    const env = {
      NODE_ENV: "production",
      CORS_ORIGINS: "https://shelfmapper.com,https://admin.shelfmapper.com",
    };
    const allowed = getAllowedCorsOrigins(env);
    assert.equal(allowed.has("https://admin.shelfmapper.com"), true);
    assert.equal(allowed.has("https://evil.example"), false);

    const delegate = createCorsOriginDelegate(env);
    let reflected;
    delegate("https://admin.shelfmapper.com", (err, ok) => {
      assert.equal(err, null);
      reflected = ok;
    });
    assert.equal(reflected, true);

    delegate("https://evil.example", (err, ok) => {
      assert.equal(err, null);
      reflected = ok;
    });
    assert.equal(reflected, false);
  });

  it("derives admin origins from admin subdomain when ADMIN_ORIGINS unset", () => {
    const origins = getAdminOrigins({
      NODE_ENV: "production",
      CORS_ORIGINS: "https://shelfmapper.com,https://admin.shelfmapper.com",
    });
    assert.equal(origins.has("https://admin.shelfmapper.com"), true);
    assert.equal(origins.has("https://shelfmapper.com"), false);
  });
});

describe("projectUserForAdmin", () => {
  it("strips unexpected app_metadata fields", () => {
    const projected = projectUserForAdmin({
      id: TARGET_UUID,
      email: "user@example.com",
      created_at: "2026-01-01T00:00:00Z",
      last_sign_in_at: null,
      app_metadata: {
        plan: "premium",
        stripe_customer_id: "cus_123",
        secret_internal: "nope",
        role: "user",
      },
    });
    assert.equal(projected.app_metadata.plan, "premium");
    assert.equal(projected.app_metadata.stripe_customer_id, "cus_123");
    assert.equal(projected.app_metadata.secret_internal, undefined);
  });
});

describe("admin API", () => {
  let harness;
  let server;
  let baseUrl;

  const adminUser = {
    id: ADMIN_UUID,
    email: "ops@shelfmapper.com",
    created_at: "2026-01-01T00:00:00Z",
    last_sign_in_at: "2026-01-02T00:00:00Z",
    app_metadata: { role: "admin", plan: "free" },
  };
  const normalUser = {
    id: USER_UUID,
    email: "reader@example.com",
    created_at: "2026-01-01T00:00:00Z",
    app_metadata: { plan: "premium", secret_internal: "hide-me" },
  };
  const targetUser = {
    id: TARGET_UUID,
    email: "billing@example.com",
    created_at: "2026-01-01T00:00:00Z",
    app_metadata: {
      plan: "free",
      stripe_subscription_id: "sub_123",
      stripe_customer_id: "cus_123",
      stripe_subscription_status: "canceled",
    },
  };

  before(async () => {
    const supabase = createMockSupabase({
      usersByToken: {
        "admin-token": adminUser,
        "user-token": normalUser,
        "role-only-token": {
          id: "44444444-4444-4444-8444-444444444444",
          email: "not-allowlisted@example.com",
          app_metadata: { role: "admin" },
        },
        "email-only-token": {
          id: "55555555-5555-4555-8555-555555555555",
          email: "ops@shelfmapper.com",
          app_metadata: { plan: "premium" },
        },
      },
      tables: {
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
      },
    });    // Ensure getUserById / listUsers can see target users that are not tokens
    supabase.auth.admin.getUserById = async (userId) => {
      const map = {
        [ADMIN_UUID]: adminUser,
        [USER_UUID]: normalUser,
        [TARGET_UUID]: targetUser,
      };
      const user = map[userId];
      if (!user) return { data: { user: null }, error: { message: "missing" } };
      return { data: { user }, error: null };
    };
    supabase.auth.admin.listUsers = async () => ({
      data: { users: [adminUser, normalUser, targetUser] },
      error: null,
    });

    harness = createTestApp({
      supabase,
      env: {
        NODE_ENV: "production",
        ADMIN_EMAILS: "ops@shelfmapper.com",
        CORS_ORIGINS: "https://shelfmapper.com,https://admin.shelfmapper.com",
        ADMIN_ORIGINS: "https://admin.shelfmapper.com",
      },
      syncBillingForUserId: async (userId) => {
        assert.equal(userId, TARGET_UUID);
        targetUser.app_metadata = {
          ...targetUser.app_metadata,
          plan: "premium",
          stripe_subscription_status: "active",
        };
        return targetUser;
      },
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
    return { status: response.status, data, headers: response.headers };
  }

  it("rejects unauthenticated admin requests", async () => {
    const res = await request("/api/admin/me");
    assert.equal(res.status, 401);
  });

  it("rejects authenticated non-admin users", async () => {
    const res = await request("/api/admin/me", { token: "user-token" });
    assert.equal(res.status, 403);
    assert.equal(res.data.code, "ADMIN_REQUIRED");
  });

  it("rejects admin role without allowlisted email", async () => {
    const res = await request("/api/admin/me", { token: "role-only-token" });
    assert.equal(res.status, 403);
  });

  it("rejects allowlisted email without admin role", async () => {
    const res = await request("/api/admin/me", { token: "email-only-token" });
    assert.equal(res.status, 403);
  });

  it("allows dual-gated admin /me", async () => {
    const res = await request("/api/admin/me", { token: "admin-token" });
    assert.equal(res.status, 200);
    assert.equal(res.data.email, "ops@shelfmapper.com");
    assert.equal(res.data.role, "admin");
  });

  it("requires a search query of at least 3 characters", async () => {
    const res = await request("/api/admin/users?q=ab", { token: "admin-token" });
    assert.equal(res.status, 400);
    assert.equal(res.data.code, "QUERY_TOO_SHORT");
  });

  it("searches users and redacts unexpected metadata on detail", async () => {
    const search = await request("/api/admin/users?q=reader@", {
      token: "admin-token",
    });
    assert.equal(search.status, 200);
    assert.equal(search.data.users.length, 1);
    assert.equal(search.data.users[0].email, "reader@example.com");
    assert.equal(search.data.users[0].app_metadata.secret_internal, undefined);

    const detail = await request(`/api/admin/users/${USER_UUID}`, {
      token: "admin-token",
    });
    assert.equal(detail.status, 200);
    assert.equal(detail.data.user.app_metadata.secret_internal, undefined);
    assert.equal(detail.data.user.app_metadata.plan, "premium");
  });

  it("syncs billing when Origin is the admin site", async () => {
    const denied = await request(`/api/admin/users/${TARGET_UUID}/sync-billing`, {
      token: "admin-token",
      method: "POST",
      origin: "https://evil.example",
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.data.code, "ADMIN_ORIGIN_REQUIRED");

    const ok = await request(`/api/admin/users/${TARGET_UUID}/sync-billing`, {
      token: "admin-token",
      method: "POST",
      origin: "https://admin.shelfmapper.com",
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.user.app_metadata.plan, "premium");
    assert.equal(ok.data.user.app_metadata.stripe_subscription_status, "active");
  });

  it("reflects ACAO only for allowlisted CORS origins", async () => {
    const allowed = await request("/api/admin/me", {
      token: "admin-token",
      origin: "https://admin.shelfmapper.com",
    });
    assert.equal(
      allowed.headers.get("access-control-allow-origin"),
      "https://admin.shelfmapper.com",
    );

    const blocked = await request("/api/admin/me", {
      token: "admin-token",
      origin: "https://evil.example",
    });
    assert.equal(blocked.headers.get("access-control-allow-origin"), null);
  });

  it("lists recent signups from auth sync", async () => {
    const res = await request("/api/admin/signups", { token: "admin-token" });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data.signups));
    assert.ok(res.data.signups.length >= 1);
    assert.ok(res.data.signups.some((row) => row.email === "reader@example.com"));
  });

  it("reads and updates signup notification mode", async () => {
    const get = await request("/api/admin/settings/notifications", {
      token: "admin-token",
    });
    assert.equal(get.status, 200);
    assert.equal(get.data.signupNotifyMode, "immediate");
    assert.equal(get.data.supportNotifyMode, "immediate");

    const denied = await request("/api/admin/settings/notifications", {
      token: "admin-token",
      method: "POST",
      origin: "https://evil.example",
      body: { signupNotifyMode: "daily" },
    });
    assert.equal(denied.status, 403);

    const ok = await request("/api/admin/settings/notifications", {
      token: "admin-token",
      method: "POST",
      origin: "https://admin.shelfmapper.com",
      body: { signupNotifyMode: "daily", supportNotifyMode: "off" },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.signupNotifyMode, "daily");
    assert.equal(ok.data.supportNotifyMode, "off");

    const again = await request("/api/admin/settings/notifications", {
      token: "admin-token",
    });
    assert.equal(again.data.signupNotifyMode, "daily");
    assert.equal(again.data.supportNotifyMode, "off");
  });
});
