function createMailer() {
  async function sendEmail({ subject } = {}) {
    console.warn("mail: outbound email is disabled; skipping:", subject || "(no subject)");
    return { ok: false, skipped: true, reason: "mail_not_configured" };
  }

  return {
    isConfigured: false,
    resolveTo() {
      return [];
    },
    sendEmail,
  };
}

module.exports = {
  createMailer,
};
