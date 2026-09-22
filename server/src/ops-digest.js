const express = require("express");
const { timingSafeEqual } = require("node:crypto");
const {
  createSupportNotifyHelpers,
} = require("./support-routes");

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function createOpsDigest({ supabase, mail, signupNotify }) {
  const supportNotify = createSupportNotifyHelpers(supabase);

  async function sendOpsDigest({ force = false } = {}) {
    const [signupMode, supportMode] = await Promise.all([
      signupNotify.getNotifyMode(),
      supportNotify.getSupportNotifyMode(),
    ]);

    const wantSignup = force || signupMode === "daily";
    const wantSupport = force || supportMode === "daily";
    if (!wantSignup && !wantSupport) {
      return {
        sent: false,
        reason: "modes_not_daily",
        signupMode,
        supportMode,
      };
    }

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const sections = [];
    let signupResult = null;
    let supportCount = 0;
    let ocrErrors24h = 0;

    if (wantSignup) {
      signupResult = await signupNotify.sendDailyDigest({ force: true });
      if (signupResult.sent || signupResult.skipped) {
        sections.push(
          `Signups (last 24h pending digest): ${signupResult.count || 0}`,
        );
      }
    }

    if (wantSupport) {
      const { data: tickets } = await supabase
        .from("support_tickets")
        .select("id,public_id,email,subject,status,created_at")
        .in("status", ["open", "pending"])
        .order("created_at", { ascending: true })
        .limit(50);
      supportCount = (tickets || []).length;
      sections.push(`Open/pending support tickets: ${supportCount}`);
      for (const t of (tickets || []).slice(0, 15)) {
        sections.push(
          `- [${t.status}] ${t.subject} (${t.email}) ${t.public_id}`,
        );
      }
    }

    try {
      const { data: errors } = await supabase
        .from("api_usage_events")
        .select("id")
        .eq("action", "ocr_error")
        .gte("created_at", since)
        .limit(500);
      ocrErrors24h = (errors || []).length;
      if (ocrErrors24h >= 10) {
        sections.push(
          `OCR error spike: ${ocrErrors24h} ocr_error events in last 24h`,
        );
      }
    } catch (err) {
      console.error("ops-digest: usage read failed", err?.message || err);
    }

    if (!sections.length && !(signupResult?.sent || signupResult?.skipped)) {
      return {
        sent: false,
        reason: "nothing_to_report",
        signupMode,
        supportMode,
      };
    }

    // Signup digest already emailed when wantSignup; send combined ops mail for support/usage
    if (wantSupport || ocrErrors24h >= 10) {
      const subject = `ShelfMapper ops digest`;
      const text = [
        "ShelfMapper daily ops digest",
        "",
        ...sections,
        "",
        "Change notification settings in the admin console.",
      ].join("\n");
      const result = await mail.sendEmail({ subject, text });
      return {
        sent: Boolean(result.ok),
        skipped: Boolean(result.skipped),
        reason: result.reason,
        signupMode,
        supportMode,
        supportCount,
        ocrErrors24h,
        signupDigest: signupResult,
      };
    }

    return {
      sent: Boolean(signupResult?.sent),
      skipped: Boolean(signupResult?.skipped),
      signupMode,
      supportMode,
      supportCount,
      ocrErrors24h,
      signupDigest: signupResult,
    };
  }

  return { sendOpsDigest };
}

function mountOpsDigestRoutes(app, { supabase, mail, signupNotify, env = process.env }) {
  const router = express.Router();
  const digest = createOpsDigest({ supabase, mail, signupNotify });

  router.post("/internal/ops/digest", async (req, res) => {
    const expected = String(env.CRON_SECRET || "").trim();
    const provided = String(
      req.get("x-cron-secret") ||
        (req.get("authorization") || "").replace(/^Bearer\s+/i, ""),
    ).trim();
    if (!expected || !timingSafeEqualString(expected, provided)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    try {
      const result = await digest.sendOpsDigest({
        force: req.query.force === "1",
      });
      return res.json(result);
    } catch (error) {
      console.error("ops digest failed:", error?.message || error);
      return res.status(500).json({ error: "Failed to send ops digest" });
    }
  });

  app.use("/api", router);
}

module.exports = {
  createOpsDigest,
  mountOpsDigestRoutes,
};
