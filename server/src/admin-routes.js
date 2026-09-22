const express = require("express");
const {
  createAdminRateLimiter,
  requireAdmin,
  requireAdminOrigin,
  normalizeEmail,
  normalizePlan,
} = require("./http-security");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEARCH_MIN_LEN = 3;
const SEARCH_PAGE_SIZE = 20;
const LIST_PER_PAGE = 200;
const LIST_MAX_PAGES = 5;

const BILLING_META_KEYS = [
  "plan",
  "stripe_subscription_status",
  "stripe_subscription_id",
  "stripe_customer_id",
  "stripe_price_id",
  "trial_ends_at",
  "trial_used",
  "renewal_notice",
  "role",
];

function projectUserForAdmin(user) {
  if (!user) return null;
  const meta = user.app_metadata || {};
  const billing = {};
  for (const key of BILLING_META_KEYS) {
    if (meta[key] !== undefined) billing[key] = meta[key];
  }
  billing.plan = normalizePlan(meta.plan);
  return {
    id: user.id,
    email: user.email || null,
    created_at: user.created_at || null,
    last_sign_in_at: user.last_sign_in_at || null,
    email_confirmed_at: user.email_confirmed_at || null,
    app_metadata: billing,
  };
}

function clientIp(req) {
  const forwarded = String(req.get("x-forwarded-for") || "")
    .split(",")[0]
    .trim();
  return forwarded || req.ip || null;
}

function createAdminRouter({
  supabase,
  requireAuth,
  syncBillingForUserId,
}) {
  const router = express.Router();
  const adminRateLimit = createAdminRateLimiter();

  async function writeAudit({
    actorUserId,
    action,
    targetUserId = null,
    meta = {},
    req,
  }) {
    try {
      const { error } = await supabase.from("admin_audit_log").insert({
        actor_user_id: actorUserId,
        action,
        target_user_id: targetUserId,
        meta,
        ip: clientIp(req),
      });
      if (error) {
        console.error("admin audit log failed:", error.message || error);
      }
    } catch (error) {
      console.error("admin audit log failed:", error?.message || error);
    }
  }

  async function searchUsersByQuery(q) {
    const needle = String(q || "").trim();
    if (needle.length < SEARCH_MIN_LEN) {
      const err = new Error(`Query must be at least ${SEARCH_MIN_LEN} characters`);
      err.code = "QUERY_TOO_SHORT";
      throw err;
    }

    if (UUID_RE.test(needle)) {
      const { data, error } = await supabase.auth.admin.getUserById(needle);
      if (error || !data?.user) return [];
      return [data.user];
    }

    const lower = needle.toLowerCase();
    const matches = [];
    let page = 1;
    while (page <= LIST_MAX_PAGES && matches.length < SEARCH_PAGE_SIZE) {
      const { data, error } = await supabase.auth.admin.listUsers({
        page,
        perPage: LIST_PER_PAGE,
      });
      if (error) throw new Error(error.message || "Failed to list users");
      const users = data?.users || [];
      for (const user of users) {
        const email = normalizeEmail(user.email);
        if (email && email.includes(lower)) {
          matches.push(user);
          if (matches.length >= SEARCH_PAGE_SIZE) break;
        }
      }
      if (users.length < LIST_PER_PAGE) break;
      page += 1;
    }
    return matches.slice(0, SEARCH_PAGE_SIZE);
  }

  router.use(requireAuth, requireAdmin, requireAdminOrigin, adminRateLimit);

  router.get("/me", async (req, res) => {
    await writeAudit({
      actorUserId: req.user.id,
      action: "admin.me",
      req,
    });
    return res.json({
      id: req.user.id,
      email: req.user.email || null,
      role: "admin",
    });
  });

  router.get("/users", async (req, res) => {
    try {
      const q = String(req.query.q || "").trim();
      const users = await searchUsersByQuery(q);
      await writeAudit({
        actorUserId: req.user.id,
        action: "admin.users.search",
        meta: { q, resultCount: users.length },
        req,
      });
      return res.json({
        users: users.map(projectUserForAdmin),
      });
    } catch (error) {
      if (error?.code === "QUERY_TOO_SHORT") {
        return res.status(400).json({
          error: error.message,
          code: "QUERY_TOO_SHORT",
        });
      }
      console.error("admin users search failed:", error?.message || error);
      return res.status(500).json({ error: "Failed to search users" });
    }
  });

  router.get("/users/:id", async (req, res) => {
    try {
      const userId = String(req.params.id || "").trim();
      if (!UUID_RE.test(userId)) {
        return res.status(400).json({ error: "Invalid user id" });
      }
      const { data, error } = await supabase.auth.admin.getUserById(userId);
      if (error || !data?.user) {
        return res.status(404).json({ error: "User not found" });
      }
      await writeAudit({
        actorUserId: req.user.id,
        action: "admin.users.get",
        targetUserId: userId,
        req,
      });
      return res.json({ user: projectUserForAdmin(data.user) });
    } catch (error) {
      console.error("admin user get failed:", error?.message || error);
      return res.status(500).json({ error: "Failed to load user" });
    }
  });

  router.post("/users/:id/sync-billing", async (req, res) => {
    try {
      const userId = String(req.params.id || "").trim();
      if (!UUID_RE.test(userId)) {
        return res.status(400).json({ error: "Invalid user id" });
      }
      if (typeof syncBillingForUserId !== "function") {
        return res.status(503).json({
          error: "Billing sync is unavailable.",
          code: "BILLING_NOT_CONFIGURED",
        });
      }
      const user = await syncBillingForUserId(userId);
      await writeAudit({
        actorUserId: req.user.id,
        action: "admin.users.sync_billing",
        targetUserId: userId,
        meta: {
          plan: normalizePlan(user?.app_metadata?.plan),
          status: user?.app_metadata?.stripe_subscription_status || null,
        },
        req,
      });
      return res.json({ user: projectUserForAdmin(user) });
    } catch (error) {
      const code = error?.code || "SYNC_FAILED";
      if (code === "BILLING_NOT_CONFIGURED") {
        return res.status(503).json({
          error: error.message,
          code,
        });
      }
      if (code === "USER_NOT_FOUND") {
        return res.status(404).json({ error: "User not found", code });
      }
      if (code === "NO_SUBSCRIPTION") {
        return res.status(404).json({ error: error.message, code });
      }
      console.error("admin sync-billing failed:", error?.message || error);
      return res.status(500).json({ error: "Failed to sync billing" });
    }
  });

  return router;
}

module.exports = {
  createAdminRouter,
  projectUserForAdmin,
  SEARCH_MIN_LEN,
  SEARCH_PAGE_SIZE,
};
