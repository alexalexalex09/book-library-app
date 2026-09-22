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
const { createAdminRouter } = require("../../src/admin-routes");
const { mountPublicConfigRoutes } = require("../../src/public-config");
const {
  createLibraryRouter,
  handlePublicShare,
} = require("../../src/library-routes");
const { createBooksRouter } = require("../../src/books-routes");
const { createOcrRouter } = require("../../src/ocr-routes");

const CLIENT_PATH = path.join(__dirname, "../../../client/src");

function createTestApp({
  supabase,
  fetchBooks,
  processImage = async () => ({ spines: [] }),
  syncBillingForUserId,
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

  const requireAuth = createRequireAuth(supabase);
  const booksRateLimit = createPlanRateLimiter({
    action: "books",
    windowMs: 60_000,
    message: "Book search limit reached for your plan. Please try again later.",
  });
  const ocrRateLimit = createPlanRateLimiter({
    action: "ocr",
    windowMs: 60_000,
    message: "OCR limit reached for your plan. Please try again later.",
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
    "/api/admin",
    createAdminRouter({
      supabase,
      requireAuth,
      syncBillingForUserId:
        syncBillingForUserId || billing.syncBillingForUserId,
    }),
  );

  app.use(
    "/api/ocr",
    createOcrRouter({
      requireAuth,
      rateLimit: ocrRateLimit,
      processImage,
    }),
  );

  app.use(
    "/api/books",
    createBooksRouter({
      requireAuth,
      rateLimit: booksRateLimit,
      fetchBooks,
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
      update(row) {
        ctx.mode = "update";
        ctx.payload = row;
        return api;
      },
      eq(field, value) {
        ctx.filters.push((row) => row[field] === value);
        return api;
      },
      is(field, value) {
        ctx.filters.push((row) => row[field] === value);
        return api;
      },
      in(field, values) {
        ctx.filters.push((row) => values.includes(row[field]));
        return api;
      },
      order() {
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
        const row = {
          id: table.length + 1,
          created_at: new Date().toISOString(),
          ...ctx.payload,
        };
        table.push(row);
        return { data: project(row), error: null };
      }

      let rows = table.filter((row) => ctx.filters.every((fn) => fn(row)));
      if (ctx.mode === "update") {
        for (const row of rows) Object.assign(row, ctx.payload);
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

  return { auth, from, _tables: tables };
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
