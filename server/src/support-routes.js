const crypto = require("node:crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const { getBearerToken } = require("./http-security");
const { normalizeMode } = require("./signup-notify");

const CATEGORIES = new Set(["billing", "ocr", "account", "bug", "other"]);
const STATUSES = new Set(["open", "pending", "resolved", "closed"]);
const SUPPORT_MODE_KEY = "support_notify_mode";
const DEFAULT_SUPPORT_MODE = "immediate";
const PUBLIC_TICKET_FIELDS =
  "id,public_id,email,category,subject,body,status,priority,created_at,updated_at,user_id";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function stripAiFields(ticket) {
  if (!ticket) return ticket;
  const {
    ai_suggestion,
    ai_suggestion_status,
    ai_suggestion_generated_at,
    ...safe
  } = ticket;
  return safe;
}

function createSupportNotifyHelpers(supabase) {
  async function getSupportNotifyMode() {
    const { data, error } = await supabase
      .from("admin_settings")
      .select("value")
      .eq("key", SUPPORT_MODE_KEY)
      .maybeSingle();
    if (error) {
      console.error("support-notify: get mode failed", error.message || error);
      return DEFAULT_SUPPORT_MODE;
    }
    return normalizeMode(data?.value?.mode) || DEFAULT_SUPPORT_MODE;
  }

  async function setSupportNotifyMode(mode) {
    const next = normalizeMode(mode);
    if (!next) {
      const err = new Error("mode must be off, immediate, or daily");
      err.code = "INVALID_MODE";
      throw err;
    }
    const { error } = await supabase.from("admin_settings").upsert(
      {
        key: SUPPORT_MODE_KEY,
        value: { mode: next },
        updated_at: new Date().toISOString(),
      },
      { onConflict: "key" },
    );
    if (error) throw new Error(error.message || "Failed to save notify mode");
    return next;
  }

  return { getSupportNotifyMode, setSupportNotifyMode };
}

function createSupportRouter({
  supabase,
  mail,
  supportAi,
}) {
  const router = express.Router();
  const { getSupportNotifyMode } = createSupportNotifyHelpers(supabase);
  const optionalAuth = createOptionalAuth(supabase);

  const createLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 8,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many support requests. Please try again later." },
  });

  router.use(optionalAuth);

  async function notifyAdminsImmediate(ticket) {
    const mode = await getSupportNotifyMode();
    if (mode !== "immediate") return { skipped: true, mode };
    const subject = `Support ticket: ${ticket.subject}`;
    const text = [
      "A new ShelfMapper support ticket was opened.",
      "",
      `Public id: ${ticket.public_id}`,
      `Email: ${ticket.email}`,
      `Category: ${ticket.category}`,
      `Status: ${ticket.status}`,
      "",
      ticket.body,
      "",
      "Reply in the admin console.",
    ].join("\n");
    return mail.sendEmail({ subject, text });
  }

  async function notifyAdminsUserReply(ticket, body) {
    const mode = await getSupportNotifyMode();
    if (mode !== "immediate") return { skipped: true, mode };
    const subject = `Support reply: ${ticket.subject}`;
    const text = [
      "A customer replied on a support ticket.",
      "",
      `Public id: ${ticket.public_id}`,
      `Email: ${ticket.email}`,
      "",
      body,
    ].join("\n");
    return mail.sendEmail({ subject, text });
  }

  router.post("/tickets", createLimiter, async (req, res) => {
    try {
      const user = req.user || null;
      const email = String(req.body?.email || user?.email || "")
        .trim()
        .toLowerCase();
      const category = String(req.body?.category || "")
        .trim()
        .toLowerCase();
      const subject = String(req.body?.subject || "").trim();
      const body = String(req.body?.body || req.body?.message || "").trim();

      if (!email || !email.includes("@")) {
        return res.status(400).json({ error: "Valid email is required" });
      }
      if (!CATEGORIES.has(category)) {
        return res.status(400).json({
          error: "category must be billing, ocr, account, bug, or other",
        });
      }
      if (!subject || subject.length > 200) {
        return res.status(400).json({ error: "Subject is required (max 200)" });
      }
      if (!body || body.length > 8000) {
        return res.status(400).json({ error: "Message is required (max 8000)" });
      }

      const insert = {
        public_id: crypto.randomUUID(),
        email,
        category,
        subject,
        body,
        status: "open",
        priority: "normal",
        user_id: user?.id || null,
        ai_suggestion_status: "pending",
        meta: {},
      };

      const { data: ticket, error } = await supabase
        .from("support_tickets")
        .insert(insert)
        .select(PUBLIC_TICKET_FIELDS)
        .maybeSingle();
      if (error || !ticket) {
        throw new Error(error?.message || "Failed to create ticket");
      }

      await supabase.from("support_ticket_messages").insert({
        ticket_id: ticket.id,
        author_type: "user",
        author_user_id: user?.id || null,
        body,
      });

      notifyAdminsImmediate(ticket).catch((err) => {
        console.error("support notify failed:", err?.message || err);
      });
      if (supportAi) supportAi.kickOffSuggestion(ticket.id);

      return res.status(201).json({ ticket: stripAiFields(ticket) });
    } catch (error) {
      console.error("support create failed:", error?.message || error);
      return res.status(500).json({ error: "Failed to create support ticket" });
    }
  });

  router.get("/tickets", async (req, res) => {
    try {
      const user = req.user || null;
      if (!user?.id) {
        return res.status(401).json({ error: "Authentication required" });
      }
      const { data, error } = await supabase
        .from("support_tickets")
        .select(PUBLIC_TICKET_FIELDS)
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw new Error(error.message);
      return res.json({ tickets: (data || []).map(stripAiFields) });
    } catch (error) {
      console.error("support list failed:", error?.message || error);
      return res.status(500).json({ error: "Failed to list tickets" });
    }
  });

  router.get("/tickets/:publicId", async (req, res) => {
    try {
      const user = req.user || null;
      if (!user?.id) {
        return res.status(401).json({ error: "Authentication required" });
      }
      const publicId = String(req.params.publicId || "").trim();
      if (!UUID_RE.test(publicId)) {
        return res.status(400).json({ error: "Invalid ticket id" });
      }
      const { data: ticket, error } = await supabase
        .from("support_tickets")
        .select(PUBLIC_TICKET_FIELDS)
        .eq("public_id", publicId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!ticket) return res.status(404).json({ error: "Ticket not found" });

      const { data: messages, error: msgError } = await supabase
        .from("support_ticket_messages")
        .select("id,author_type,body,created_at")
        .eq("ticket_id", ticket.id)
        .order("created_at", { ascending: true });
      if (msgError) throw new Error(msgError.message);

      return res.json({
        ticket: stripAiFields(ticket),
        messages: messages || [],
      });
    } catch (error) {
      console.error("support get failed:", error?.message || error);
      return res.status(500).json({ error: "Failed to load ticket" });
    }
  });

  router.post("/tickets/:publicId/messages", createLimiter, async (req, res) => {
    try {
      const user = req.user || null;
      if (!user?.id) {
        return res.status(401).json({ error: "Authentication required" });
      }
      const publicId = String(req.params.publicId || "").trim();
      const body = String(req.body?.body || req.body?.message || "").trim();
      if (!UUID_RE.test(publicId)) {
        return res.status(400).json({ error: "Invalid ticket id" });
      }
      if (!body || body.length > 8000) {
        return res.status(400).json({ error: "Message is required (max 8000)" });
      }

      const { data: ticket, error } = await supabase
        .from("support_tickets")
        .select(PUBLIC_TICKET_FIELDS)
        .eq("public_id", publicId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!ticket) return res.status(404).json({ error: "Ticket not found" });
      if (ticket.status === "closed") {
        return res.status(400).json({ error: "Ticket is closed" });
      }

      const { data: message, error: msgError } = await supabase
        .from("support_ticket_messages")
        .insert({
          ticket_id: ticket.id,
          author_type: "user",
          author_user_id: user.id,
          body,
        })
        .select("id,author_type,body,created_at")
        .maybeSingle();
      if (msgError) throw new Error(msgError.message);

      const nextStatus = ticket.status === "resolved" ? "open" : "pending";
      await supabase
        .from("support_tickets")
        .update({
          status: nextStatus,
          updated_at: new Date().toISOString(),
          ai_suggestion_status: "pending",
        })
        .eq("id", ticket.id);

      notifyAdminsUserReply(ticket, body).catch((err) => {
        console.error("support reply notify failed:", err?.message || err);
      });
      if (supportAi) supportAi.kickOffSuggestion(ticket.id);

      return res.status(201).json({ message, status: nextStatus });
    } catch (error) {
      console.error("support reply failed:", error?.message || error);
      return res.status(500).json({ error: "Failed to post reply" });
    }
  });

  return router;
}

function createOptionalAuth(supabase) {
  return async function optionalAuth(req, _res, next) {
    const token = getBearerToken(req.get("authorization"));
    if (!token) return next();
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser(token);
      if (user) req.user = user;
    } catch {
      /* ignore */
    }
    return next();
  };
}

module.exports = {
  createSupportRouter,
  createSupportNotifyHelpers,
  createOptionalAuth,
  stripAiFields,
  CATEGORIES,
  STATUSES,
  SUPPORT_MODE_KEY,
  DEFAULT_SUPPORT_MODE,
};
