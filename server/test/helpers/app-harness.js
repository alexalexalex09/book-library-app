const path = require("path");
const express = require("express");
const cors = require("cors");
const {
  PLAN_QUOTAS,
  createRequireAuth,
  createPlanRateLimiter,
  createCorsOriginDelegate,
  requirePremium,
  getUserPlan,
  setSecurityHeaders,
  handleUploadError,
} = require("../../src/http-security");
const { createBillingRouter } = require("../../src/billing");
const { createAccountRouter } = require("../../src/account-routes");
const { createAdminRouter } = require("../../src/admin-routes");
const { mountPublicConfigRoutes } = require("../../src/public-config");
const { createMailer } = require("../../src/mail");
const {
  createSignupNotify,
  mountSignupNotifyRoutes,
} = require("../../src/signup-notify");
const {
  createLibraryRouter,
  handlePublicShare,
} = require("../../src/library-routes");
const { createBooksRouter } = require("../../src/books-routes");
const { createOcrRouter } = require("../../src/ocr-routes");
const { createUsageAnalytics } = require("../../src/usage-analytics");
const { createSupportAi } = require("../../src/support-ai");
const { createSupportRouter } = require("../../src/support-routes");
const { mountOpsDigestRoutes } = require("../../src/ops-digest");

const CLIENT_PATH = path.join(__dirname, "../../../client/src");

function createTestApp({
  supabase,
  fetchBooks,
  processImage = async () => ({ spines: [] }),
  syncBillingForUserId,
  mail,
  supportAi,
  env = {},
} = {}) {
  const previousEnv = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === null) delete process.env[key];
    else process.env[key] = String(value);
  }
  if (!process.env.APP_BASE_URL) process.env.APP_BASE_URL = "http://127.0.0.1:3000";
  if (!process.env.CORS_ORIGINS) {
    process.env.CORS_ORIGINS =
      "http://127.0.0.1:3000,https://admin.shelfmapper.com";
  }
  if (!process.env.ADMIN_ORIGINS) {
    process.env.ADMIN_ORIGINS = "https://admin.shelfmapper.com";
  }

  const app = express();
  app.disable("x-powered-by");
  app.use(setSecurityHeaders);
  app.use(
    cors({
      origin: createCorsOriginDelegate(process.env),
      methods: ["GET", "POST", "OPTIONS"],
    }),
  );
  app.use(express.json({ limit: "1mb" }));

  const usageAnalytics = createUsageAnalytics(supabase);
  const requireAuth = createRequireAuth(supabase, {
    onAuthenticated(user) {
      return usageAnalytics.touchEngagement(user.id);
    },
  });
  const booksRateLimit = createPlanRateLimiter({
    action: "books",
    windowMs: 60_000,
    message: "Book search limit reached for your plan. Please try again later.",
    onRateLimited(req) {
      return usageAnalytics.recordEvent(req.user?.id, "books_rate_limit", {});
    },
  });
  const ocrRateLimit = createPlanRateLimiter({
    action: "ocr",
    windowMs: 60_000,
    message: "OCR limit reached for your plan. Please try again later.",
    onRateLimited(req) {
      return usageAnalytics.recordEvent(req.user?.id, "ocr_rate_limit", {});
    },
  });

  mountPublicConfigRoutes(app);
  app.use(express.static(CLIENT_PATH, { index: false }));

  const billing = createBillingRouter({
    supabase,
    requireAuth,
    requirePremium,
    planQuotas: PLAN_QUOTAS,
  });
  app.post(
    "/api/billing/webhook",
    express.raw({ type: "application/json" }),
    billing.webhookHandler,
  );
  app.use("/api/billing", billing.router);
  app.use(
    "/api/account",
    createAccountRouter({
      supabase,
      requireAuth,
      cancelBillingForUser: billing.cancelBillingForDeletedUser,
    }),
  );

  const mailer = mail || createMailer(process.env);
  const signupNotify = createSignupNotify({ supabase, mail: mailer });
  const ai =
    supportAi ||
    createSupportAi({
      supabase,
      env: process.env,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      reply: "Thanks for contacting support.",
                      pathForward: "Confirm account details",
                    }),
                  },
                ],
              },
            },
          ],
        }),
      }),
    });
  mountSignupNotifyRoutes(app, {
    requireAuth,
    signupNotify,
    env: process.env,
  });
  mountOpsDigestRoutes(app, {
    supabase,
    mail: mailer,
    signupNotify,
    env: process.env,
  });
  app.use(
    "/api/support",
    createSupportRouter({
      supabase,
      mail: mailer,
      supportAi: ai,
    }),
  );
  app.use(
    "/api/admin",
    createAdminRouter({
      supabase,
      requireAuth,
      syncBillingForUserId:
        syncBillingForUserId || billing.syncBillingForUserId,
      signupNotify,
      supportAi: ai,
      env: process.env,
    }),
  );

  app.use(
    "/api/ocr",
    createOcrRouter({
      requireAuth,
      rateLimit: ocrRateLimit,
      processImage,
      usageAnalytics,
    }),
  );

  app.use(
    "/api/books",
    createBooksRouter({
      requireAuth,
      rateLimit: booksRateLimit,
      fetchBooks,
      usageAnalytics,
    }),
  );

  app.use(
    "/api",
    createLibraryRouter({
      supabase,
      requireAuth,
      requirePremium,
      getUserPlan,
    }),
  );
  app.get("/api/share/:token", (req, res) => handlePublicShare(req, res, supabase));

  app.get(["/", "/index.html"], (req, res) => {
    res.sendFile(path.join(CLIENT_PATH, "index.html"));
  });

  app.use(handleUploadError);
  app.use((error, req, res, next) => {
    res.status(500).json({ error: "Internal server error" });
  });

  return {
    app,
    restoreEnv() {
      for (const key of Object.keys(process.env)) {
        if (!(key in previousEnv)) delete process.env[key];
      }
      Object.assign(process.env, previousEnv);
    },
  };
}

function createMockSupabase({ usersByToken = {}, tables = {} } = {}) {
  const auth = {
    async getUser(token) {
      const user = usersByToken[token];
      if (!user) return { data: { user: null }, error: { message: "invalid" } };
      return { data: { user }, error: null };
    },
    admin: {
      async getUserById(userId) {
        const user = Object.values(usersByToken).find((u) => u.id === userId);
        if (!user) return { data: { user: null }, error: { message: "missing" } };
        return { data: { user }, error: null };
      },
      async listUsers({ page = 1, perPage = 50 } = {}) {
        const all = Object.values(usersByToken);
        const start = (page - 1) * perPage;
        const users = all.slice(start, start + perPage);
        return {
          data: { users, aud: "authenticated" },
          error: null,
        };
      },
      async updateUserById(userId, patch) {
        const user = Object.values(usersByToken).find((u) => u.id === userId);
        if (!user) return { error: { message: "missing" } };
        if (patch.app_metadata) {
          user.app_metadata = { ...(user.app_metadata || {}), ...patch.app_metadata };
        }
        return { data: { user }, error: null };
      },
      async deleteUser(userId) {
        const token = Object.keys(usersByToken).find(
          (key) => usersByToken[key]?.id === userId,
        );
        if (!token) return { data: { user: null }, error: { message: "missing" } };
        const user = usersByToken[token];
        delete usersByToken[token];
        return { data: { user }, error: null };
      },
    },
  };

  function from(tableName) {
    if (!tables[tableName]) tables[tableName] = [];
    const table = tables[tableName];
    const ctx = {
      filters: [],
      mode: "select",
      payload: null,
      wantSingle: false,
      wantMaybe: false,
      columns: "*",
    };

    const api = {
      select(cols = "*") {
        ctx.columns = cols;
        return api;
      },
      insert(row) {
        ctx.mode = "insert";
        ctx.payload = row;
        return api;
      },
      upsert(row) {
        ctx.mode = "upsert";
        ctx.payload = Array.isArray(row) ? row[0] : row;
        return api;
      },
      update(row) {
        ctx.mode = "update";
        ctx.payload = row;
        return api;
      },
      delete() {
        ctx.mode = "delete";
        return api;
      },
      eq(field, value) {
        ctx.filters.push((row) => row[field] === value);
        return api;
      },
      gte(field, value) {
        ctx.filters.push((row) => String(row[field] || "") >= String(value));
        return api;
      },
      is(field, value) {
        ctx.filters.push((row) => row[field] === value);
        return api;
      },
      in(field, values) {
        const set = new Set(values);
        ctx.filters.push((row) => set.has(row[field]));
        return api;
      },
      order(field, { ascending = true } = {}) {
        ctx.order = { field, ascending };
        return api;
      },
      limit(n) {
        ctx.limit = Number(n);
        return api;
      },
      single() {
        ctx.wantSingle = true;
        return Promise.resolve(execute());
      },
      maybeSingle() {
        ctx.wantMaybe = true;
        return Promise.resolve(execute());
      },
      then(resolve, reject) {
        return Promise.resolve(execute()).then(resolve, reject);
      },
    };

    function project(row) {
      if (ctx.columns === "*") return { ...row };
      const out = {};
      for (const field of String(ctx.columns).split(",").map((f) => f.trim())) {
        out[field] = row[field];
      }
      return out;
    }

    function execute() {
      if (ctx.mode === "insert") {
        const payloads = Array.isArray(ctx.payload)
          ? ctx.payload
          : [ctx.payload];
        const inserted = payloads.map((payload) => {
          const row = {
            id: table.length + 1,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            ...payload,
          };
          table.push(row);
          return row;
        });
        const row = inserted[0];
        return { data: project(row), error: null };
      }

      if (ctx.mode === "upsert") {
        const key =
          ctx.payload.key != null
            ? "key"
            : ctx.payload.user_id != null
              ? "user_id"
              : "id";
        const existing = table.find((row) => row[key] === ctx.payload[key]);
        if (existing) {
          Object.assign(existing, ctx.payload);
          return { data: project(existing), error: null };
        }
        const row = {
          id: table.length + 1,
          created_at: new Date().toISOString(),
          ...ctx.payload,
        };
        table.push(row);
        return { data: project(row), error: null };
      }

      let rows = table.filter((row) => ctx.filters.every((fn) => fn(row)));
      if (ctx.mode === "delete") {
        const removed = [];
        for (let i = table.length - 1; i >= 0; i -= 1) {
          if (ctx.filters.every((fn) => fn(table[i]))) {
            removed.push(table.splice(i, 1)[0]);
          }
        }
        return { data: removed.map(project), error: null };
      }

      if (ctx.mode === "update") {
        for (const row of rows) Object.assign(row, ctx.payload);
      }

      if (ctx.order?.field) {
        const { field, ascending } = ctx.order;
        rows = [...rows].sort((a, b) => {
          const left = a[field];
          const right = b[field];
          if (left === right) return 0;
          if (left == null) return 1;
          if (right == null) return -1;
          if (left < right) return ascending ? -1 : 1;
          return ascending ? 1 : -1;
        });
      }
      if (ctx.limit != null && Number.isFinite(ctx.limit)) {
        rows = rows.slice(0, ctx.limit);
      }

      if (ctx.wantSingle) {
        if (!rows[0]) return { data: null, error: { message: "not found" } };
        return { data: project(rows[0]), error: null };
      }
      if (ctx.wantMaybe) {
        return { data: rows[0] ? project(rows[0]) : null, error: null };
      }
      return { data: rows.map(project), error: null };
    }

    return api;
  }

  const storage = {
    from() {
      return {
        async list() {
          return { data: [], error: null };
        },
        async remove(paths) {
          return { data: paths || [], error: null };
        },
      };
    },
  };

  return { auth, from, storage, _tables: tables };
}

async function listen(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

module.exports = {
  CLIENT_PATH,
  createTestApp,
  createMockSupabase,
  listen,
};
