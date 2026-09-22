const express = require("express");
const {
  createAdminRateLimiter,
  requireAdmin,
  requireAdminOrigin,
  normalizeEmail,
  normalizePlan,
} = require("./http-security");
const { createAdminStats } = require("./admin-stats");
const {
  createSupportNotifyHelpers,
  STATUSES,
} = require("./support-routes");

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
  signupNotify,
  supportAi,
  env = process.env,
}) {
  const router = express.Router();
  const adminRateLimit = createAdminRateLimiter();
  const stats = createAdminStats({ supabase, env });
  const supportNotify = createSupportNotifyHelpers(supabase);

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

      let ticketCount = 0;
      let recentUsage = {};
      try {
        const { data: tickets } = await supabase
          .from("support_tickets")
          .select("id")
          .eq("user_id", userId);
        ticketCount = (tickets || []).length;
        const since7d = new Date(
          Date.now() - 7 * 24 * 60 * 60 * 1000,
        ).toISOString();
        const { data: events } = await supabase
          .from("api_usage_events")
          .select("action")
          .eq("user_id", userId)
          .gte("created_at", since7d)
          .limit(500);
        for (const ev of events || []) {
          recentUsage[ev.action] = (recentUsage[ev.action] || 0) + 1;
        }
      } catch (err) {
        console.error("admin user extras failed:", err?.message || err);
      }

      await writeAudit({
        actorUserId: req.user.id,
        action: "admin.users.get",
        targetUserId: userId,
        req,
      });
      return res.json({
        user: projectUserForAdmin(data.user),
        ticketCount,
        recentUsage,
      });
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

  router.get("/signups", async (req, res) => {
    try {
      if (!signupNotify) {
        return res.status(503).json({ error: "Signup history unavailable" });
      }
      const signups = await signupNotify.listSignupHistory();
      await writeAudit({
        actorUserId: req.user.id,
        action: "admin.signups.list",
        meta: { count: signups.length },
        req,
      });
      return res.json({ signups });
    } catch (error) {
      console.error("admin signups failed:", error?.message || error);
      return res.status(500).json({ error: "Failed to load signups" });
    }
  });

  router.get("/settings/notifications", async (req, res) => {
    try {
      if (!signupNotify) {
        return res
          .status(503)
          .json({ error: "Notification settings unavailable" });
      }
      const [signupNotifyMode, supportNotifyMode] = await Promise.all([
        signupNotify.getNotifyMode(),
        supportNotify.getSupportNotifyMode(),
      ]);
      return res.json({
        signupNotifyMode,
        supportNotifyMode,
        modes: signupNotify.MODES,
      });
    } catch (error) {
      console.error(
        "admin notify settings get failed:",
        error?.message || error,
      );
      return res
        .status(500)
        .json({ error: "Failed to load notification settings" });
    }
  });

  router.post("/settings/notifications", async (req, res) => {
    try {
      if (!signupNotify) {
        return res
          .status(503)
          .json({ error: "Notification settings unavailable" });
      }
      const updates = {};
      if (req.body?.signupNotifyMode != null) {
        updates.signupNotifyMode = await signupNotify.setNotifyMode(
          req.body.signupNotifyMode,
        );
      } else {
        updates.signupNotifyMode = await signupNotify.getNotifyMode();
      }
      if (req.body?.supportNotifyMode != null) {
        updates.supportNotifyMode =
          await supportNotify.setSupportNotifyMode(req.body.supportNotifyMode);
      } else {
        updates.supportNotifyMode =
          await supportNotify.getSupportNotifyMode();
      }
      await writeAudit({
        actorUserId: req.user.id,
        action: "admin.settings.notifications",
        meta: updates,
        req,
      });
      return res.json({ ...updates, modes: signupNotify.MODES });
    } catch (error) {
      if (error?.code === "INVALID_MODE") {
        return res
          .status(400)
          .json({ error: error.message, code: "INVALID_MODE" });
      }
      console.error(
        "admin notify settings save failed:",
        error?.message || error,
      );
      return res
        .status(500)
        .json({ error: "Failed to save notification settings" });
    }
  });

  router.get("/stats/overview", async (req, res) => {
    try {
      const overview = await stats.getOverview({
        force: req.query.refresh === "1",
      });
      let billing = null;
      try {
        billing = await stats.getBillingStats();
      } catch (err) {
        billing = {
          configured: false,
          error: err?.message || "billing_error",
        };
      }
      return res.json({ ...overview, billing });
    } catch (error) {
      console.error("admin overview failed:", error?.message || error);
      return res.status(500).json({ error: "Failed to load overview" });
    }
  });

  router.get("/stats/billing", async (req, res) => {
    try {
      const billing = await stats.getBillingStats({
        force: req.query.refresh === "1",
      });
      return res.json(billing);
    } catch (error) {
      console.error("admin billing stats failed:", error?.message || error);
      return res.status(500).json({ error: "Failed to load billing stats" });
    }
  });

  router.get("/stats/usage", async (req, res) => {
    try {
      const usage = await stats.getUsageStats();
      return res.json(usage);
    } catch (error) {
      console.error("admin usage stats failed:", error?.message || error);
      return res.status(500).json({ error: "Failed to load usage stats" });
    }
  });

  router.get("/audit", async (req, res) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      const { data, error } = await supabase
        .from("admin_audit_log")
        .select("id,actor_user_id,action,target_user_id,meta,ip,created_at")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw new Error(error.message);
      return res.json({ audit: data || [] });
    } catch (error) {
      console.error("admin audit failed:", error?.message || error);
      return res.status(500).json({ error: "Failed to load audit log" });
    }
  });

  router.get("/support/tickets", async (req, res) => {
    try {
      const status = String(req.query.status || "").trim().toLowerCase();
      let query = supabase
        .from("support_tickets")
        .select(
          "id,public_id,user_id,email,category,subject,body,status,priority,ai_suggestion,ai_suggestion_status,ai_suggestion_generated_at,created_at,updated_at",
        )
        .order("created_at", { ascending: false })
        .limit(100);
      if (status && STATUSES.has(status)) {
        query = query.eq("status", status);
      }
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      return res.json({ tickets: data || [] });
    } catch (error) {
      console.error("admin support list failed:", error?.message || error);
      return res.status(500).json({ error: "Failed to list support tickets" });
    }
  });

  router.get("/support/tickets/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "Invalid ticket id" });
      }
      const { data: ticket, error } = await supabase
        .from("support_tickets")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!ticket) return res.status(404).json({ error: "Ticket not found" });
      const { data: messages, error: msgError } = await supabase
        .from("support_ticket_messages")
        .select("id,author_type,author_user_id,body,created_at")
        .eq("ticket_id", id)
        .order("created_at", { ascending: true });
      if (msgError) throw new Error(msgError.message);
      return res.json({ ticket, messages: messages || [] });
    } catch (error) {
      console.error("admin support get failed:", error?.message || error);
      return res.status(500).json({ error: "Failed to load ticket" });
    }
  });

  router.post("/support/tickets/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "Invalid ticket id" });
      }
      const patch = {};
      if (req.body?.status != null) {
        const status = String(req.body.status).trim().toLowerCase();
        if (!STATUSES.has(status)) {
          return res.status(400).json({ error: "Invalid status" });
        }
        patch.status = status;
      }
      if (req.body?.priority != null) {
        const priority = String(req.body.priority).trim().toLowerCase();
        if (!["low", "normal", "high"].includes(priority)) {
          return res.status(400).json({ error: "Invalid priority" });
        }
        patch.priority = priority;
      }
      if (!Object.keys(patch).length) {
        return res.status(400).json({ error: "No updates provided" });
      }
      patch.updated_at = new Date().toISOString();
      const { data: ticket, error } = await supabase
        .from("support_tickets")
        .update(patch)
        .eq("id", id)
        .select("*")
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!ticket) return res.status(404).json({ error: "Ticket not found" });
      await writeAudit({
        actorUserId: req.user.id,
        action: "admin.support.update",
        meta: { ticketId: id, ...patch },
        req,
      });
      return res.json({ ticket });
    } catch (error) {
      console.error("admin support update failed:", error?.message || error);
      return res.status(500).json({ error: "Failed to update ticket" });
    }
  });

  router.post("/support/tickets/:id/reply", async (req, res) => {
    try {
      const id = Number(req.params.id);
      const body = String(req.body?.body || "").trim();
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "Invalid ticket id" });
      }
      if (!body || body.length > 8000) {
        return res.status(400).json({ error: "Reply body is required" });
      }
      const { data: ticket, error } = await supabase
        .from("support_tickets")
        .select("*")
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!ticket) return res.status(404).json({ error: "Ticket not found" });

      const { data: message, error: msgError } = await supabase
        .from("support_ticket_messages")
        .insert({
          ticket_id: id,
          author_type: "admin",
          author_user_id: req.user.id,
          body,
        })
        .select("id,author_type,author_user_id,body,created_at")
        .maybeSingle();
      if (msgError) throw new Error(msgError.message);

      const nextStatus =
        req.body?.status && STATUSES.has(String(req.body.status))
          ? String(req.body.status)
          : ticket.status === "open"
            ? "pending"
            : ticket.status;
      await supabase
        .from("support_tickets")
        .update({
          status: nextStatus,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id);

      await writeAudit({
        actorUserId: req.user.id,
        action: "admin.support.reply",
        meta: { ticketId: id, status: nextStatus },
        req,
      });
      return res.status(201).json({ message, status: nextStatus });
    } catch (error) {
      console.error("admin support reply failed:", error?.message || error);
      return res.status(500).json({ error: "Failed to reply" });
    }
  });

  router.post("/support/tickets/:id/suggest", async (req, res) => {
    try {
      if (!supportAi) {
        return res.status(503).json({ error: "AI suggestions unavailable" });
      }
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "Invalid ticket id" });
      }
      const result = await supportAi.generateSuggestion(id);
      await writeAudit({
        actorUserId: req.user.id,
        action: "admin.support.suggest",
        meta: { ticketId: id, status: result.status },
        req,
      });
      const { data: ticket } = await supabase
        .from("support_tickets")
        .select(
          "id,ai_suggestion,ai_suggestion_status,ai_suggestion_generated_at",
        )
        .eq("id", id)
        .maybeSingle();
      return res.json({ ...result, ticket });
    } catch (error) {
      console.error("admin support suggest failed:", error?.message || error);
      return res.status(500).json({ error: "Failed to generate suggestion" });
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
