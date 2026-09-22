const express = require("express");

const MODES = new Set(["off", "immediate", "daily"]);
const MODE_KEY = "signup_notify_mode";
const DEFAULT_MODE = "immediate";
const SIGNUP_ACK_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const LIST_PER_PAGE = 200;
const LIST_MAX_PAGES = 5;
const HISTORY_LIMIT = 50;

function normalizeMode(value) {
  const mode = String(value || "")
    .trim()
    .toLowerCase();
  return MODES.has(mode) ? mode : null;
}

function signupProvider(user) {
  const fromMeta = user?.app_metadata?.provider;
  if (fromMeta) return String(fromMeta);
  const identity = Array.isArray(user?.identities) ? user.identities[0] : null;
  if (identity?.provider) return String(identity.provider);
  return "email";
}

function createSignupNotify({ supabase, mail }) {
  async function getNotifyMode() {
    const { data, error } = await supabase
      .from("admin_settings")
      .select("value")
      .eq("key", MODE_KEY)
      .maybeSingle();
    if (error) {
      console.error("signup-notify: get mode failed", error.message || error);
      return DEFAULT_MODE;
    }
    const mode = normalizeMode(data?.value?.mode);
    return mode || DEFAULT_MODE;
  }

  async function setNotifyMode(mode) {
    const next = normalizeMode(mode);
    if (!next) {
      const err = new Error("mode must be off, immediate, or daily");
      err.code = "INVALID_MODE";
      throw err;
    }
    const { error } = await supabase.from("admin_settings").upsert(
      {
        key: MODE_KEY,
        value: { mode: next },
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" },
    );
    if (error) throw new Error(error.message || "Failed to save notify mode");
    return next;
  }

  async function sendImmediateEmail(event) {
    const when = event.created_at
      ? new Date(event.created_at).toISOString()
      : "unknown time";
    const subject = `New ShelfMapper signup: ${event.email || event.user_id}`;
    const text = [
      "A new user signed up for ShelfMapper.",
      "",
      `Email: ${event.email || "(none)"}`,
      `User id: ${event.user_id}`,
      `Provider: ${event.provider || "unknown"}`,
      `Created: ${when}`,
      "",
      "Change notification settings in the admin console.",
    ].join("\n");
    return mail.sendEmail({ subject, text });
  }

  async function recordSignup(user, { source = "ack" } = {}) {
    if (!user?.id) return { created: false };
    const createdAt = user.created_at || new Date().toISOString();
    const event = {
      user_id: user.id,
      email: user.email || null,
      provider: signupProvider(user),
      created_at: createdAt,
    };

    const { data: existing, error: existingError } = await supabase
      .from("signup_events")
      .select(
        "user_id,email,provider,created_at,immediate_notified_at,digest_notified_at",
      )
      .eq("user_id", user.id)
      .maybeSingle();
    if (existingError) {
      throw new Error(existingError.message || "Failed to read signup_events");
    }
    if (existing) {
      return { created: false, event: existing };
    }

    const { data: inserted, error: insertError } = await supabase
      .from("signup_events")
      .insert(event)
      .select(
        "user_id,email,provider,created_at,immediate_notified_at,digest_notified_at",
      )
      .maybeSingle();
    if (insertError) {
      // Race: another writer inserted first
      if (/duplicate|unique/i.test(String(insertError.message || ""))) {
        return { created: false };
      }
      throw new Error(insertError.message || "Failed to record signup");
    }

    const row = inserted || event;
    const mode = await getNotifyMode();
    if (mode === "immediate" && source === "ack") {
      const result = await sendImmediateEmail(row);
      if (result.ok || result.skipped) {
        await supabase
          .from("signup_events")
          .update({ immediate_notified_at: new Date().toISOString() })
          .eq("user_id", user.id);
      }
    }

    return { created: true, event: row, source, mode };
  }

  async function listRecentFromAuth(limit = HISTORY_LIMIT) {
    const collected = [];
    let page = 1;
    while (page <= LIST_MAX_PAGES && collected.length < limit * 2) {
      const { data, error } = await supabase.auth.admin.listUsers({
        page,
        perPage: LIST_PER_PAGE,
      });
      if (error) throw new Error(error.message || "Failed to list users");
      const users = data?.users || [];
      collected.push(...users);
      if (users.length < LIST_PER_PAGE) break;
      page += 1;
    }
    collected.sort(
      (a, b) =>
        new Date(b.created_at || 0).getTime() -
        new Date(a.created_at || 0).getTime(),
    );
    return collected.slice(0, limit);
  }

  async function syncFromAuth() {
    const users = await listRecentFromAuth(HISTORY_LIMIT);
    let created = 0;
    for (const user of users) {
      const result = await recordSignup(user, { source: "sync" });
      if (result.created) created += 1;
    }
    return { scanned: users.length, created };
  }

  async function listSignupHistory(limit = HISTORY_LIMIT) {
    try {
      await syncFromAuth();
    } catch (error) {
      console.error("signup-notify: sync failed", error?.message || error);
    }

    const { data, error } = await supabase
      .from("signup_events")
      .select(
        "user_id,email,provider,created_at,recorded_at,immediate_notified_at,digest_notified_at",
      )
      .order("created_at", { ascending: false })
      .limit(Math.min(Math.max(Number(limit) || HISTORY_LIMIT, 1), 100));
    if (error) throw new Error(error.message || "Failed to load signups");
    return data || [];
  }

  async function sendDailyDigest({ force = false } = {}) {
    const mode = await getNotifyMode();
    if (!force && mode !== "daily") {
      return { sent: false, reason: "mode_not_daily", mode };
    }

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from("signup_events")
      .select("user_id,email,provider,created_at,digest_notified_at")
      .gte("created_at", since)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message || "Failed to load digest rows");

    const pending = (data || []).filter((row) => !row.digest_notified_at);
    if (!pending.length) {
      return { sent: false, reason: "no_new_signups", count: 0, mode };
    }

    const lines = pending.map(
      (row) =>
        `- ${row.email || row.user_id} (${row.provider || "unknown"}) @ ${row.created_at}`,
    );
    const subject = `ShelfMapper daily signup summary (${pending.length})`;
    const text = [
      `New ShelfMapper signups in the last 24 hours: ${pending.length}`,
      "",
      ...lines,
      "",
      "Change notification settings in the admin console.",
    ].join("\n");

    const result = await mail.sendEmail({ subject, text });
    if (!result.ok && !result.skipped) {
      return { sent: false, reason: result.reason || "send_failed", count: pending.length };
    }

    const now = new Date().toISOString();
    for (const row of pending) {
      await supabase
        .from("signup_events")
        .update({ digest_notified_at: now })
        .eq("user_id", row.user_id);
    }
    return {
      sent: Boolean(result.ok),
      skipped: Boolean(result.skipped),
      count: pending.length,
      mode,
    };
  }

  async function ackCurrentUser(user) {
    if (!user?.id || !user.created_at) {
      return { created: false, reason: "missing_user" };
    }
    const age = Date.now() - new Date(user.created_at).getTime();
    if (Number.isNaN(age) || age < 0 || age > SIGNUP_ACK_MAX_AGE_MS) {
      return { created: false, reason: "outside_window" };
    }
    return recordSignup(user, { source: "ack" });
  }

  return {
    MODES: [...MODES],
    getNotifyMode,
    setNotifyMode,
    recordSignup,
    listSignupHistory,
    syncFromAuth,
    sendDailyDigest,
    ackCurrentUser,
  };
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length) return false;
  const { timingSafeEqual } = require("node:crypto");
  return timingSafeEqual(left, right);
}

function mountSignupNotifyRoutes(app, { requireAuth, signupNotify, env = process.env }) {
  const router = express.Router();

  router.post("/signup-ack", requireAuth, async (req, res) => {
    try {
      const result = await signupNotify.ackCurrentUser(req.user);
      return res.json({ ok: true, ...result });
    } catch (error) {
      console.error("signup-ack failed:", error?.message || error);
      return res.status(500).json({ error: "Failed to record signup" });
    }
  });

  router.post("/internal/signups/digest", async (req, res) => {
    const expected = String(env.CRON_SECRET || "").trim();
    const provided = String(
      req.get("x-cron-secret") ||
        (req.get("authorization") || "").replace(/^Bearer\s+/i, ""),
    ).trim();
    if (!expected || !timingSafeEqualString(expected, provided)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      const result = await signupNotify.sendDailyDigest({
        force: req.query.force === "1",
      });
      return res.json(result);
    } catch (error) {
      console.error("signup digest failed:", error?.message || error);
      return res.status(500).json({ error: "Failed to send digest" });
    }
  });

  app.use("/api", router);
}

module.exports = {
  createSignupNotify,
  mountSignupNotifyRoutes,
  normalizeMode,
  signupProvider,
  MODE_KEY,
  DEFAULT_MODE,
  HISTORY_LIMIT,
};
