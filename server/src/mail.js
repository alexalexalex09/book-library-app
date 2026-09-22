function parseRecipients(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function createMailer(env = process.env) {
  const apiKey = String(env.RESEND_API_KEY || "").trim();
  const from =
    String(env.MAIL_FROM || "").trim() || "ShelfMapper <onboarding@resend.dev>";

  function resolveTo(override) {
    const list = parseRecipients(override || env.SIGNUP_NOTIFY_TO || env.ADMIN_EMAILS);
    return list;
  }

  async function sendEmail({ to, subject, text, html }) {
    const recipients = Array.isArray(to) ? to : resolveTo(to);
    if (!recipients.length) {
      return { ok: false, skipped: true, reason: "no_recipients" };
    }
    if (!apiKey) {
      console.warn("mail: RESEND_API_KEY unset; skipping send:", subject);
      return { ok: false, skipped: true, reason: "mail_not_configured" };
    }

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: recipients,
        subject,
        text,
        ...(html ? { html } : {}),
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error("mail: Resend error", response.status, body);
      return { ok: false, skipped: false, reason: "send_failed", status: response.status };
    }
    return { ok: true };
  }

  return {
    isConfigured: Boolean(apiKey),
    resolveTo,
    sendEmail,
  };
}

module.exports = {
  createMailer,
  parseRecipients,
};
