(function () {
  // Keep in sync with client/src/js/app.js so logged-in sessions are shared.
  const SUPABASE_URL = "https://wqxvahmiblqgsjyywxpa.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_Oth3p_I48nLfY8tLkOcSvA_uegZywJY";

  const form = document.getElementById("supportForm");
  const statusEl = document.getElementById("supportStatus");
  const thanks = document.getElementById("supportThanks");
  const ticketIdEl = document.getElementById("supportTicketId");
  const emailInput = document.getElementById("supportEmail");

  function setStatus(text, { error = false } = {}) {
    if (!statusEl) return;
    statusEl.hidden = !text;
    statusEl.textContent = text || "";
    statusEl.classList.toggle("error", Boolean(error));
  }

  async function getAccessToken() {
    try {
      if (!window.supabase?.createClient) return null;
      const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      const { data } = await client.auth.getSession();
      if (data.session?.user?.email && emailInput && !emailInput.value) {
        emailInput.value = data.session.user.email;
      }
      return data.session?.access_token || null;
    } catch {
      return null;
    }
  }

  getAccessToken();

  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    setStatus("Sending…");
    const token = await getAccessToken();
    const payload = {
      email: emailInput.value.trim(),
      category: document.getElementById("supportCategory").value,
      subject: document.getElementById("supportSubject").value.trim(),
      body: document.getElementById("supportBody").value.trim(),
    };
    try {
      const response = await fetch("/api/support/tickets", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Failed to send");
      }
      form.hidden = true;
      thanks.hidden = false;
      thanks.classList.remove("hidden");
      ticketIdEl.textContent = data.ticket?.public_id || data.ticket?.id || "—";
      setStatus("");
    } catch (error) {
      setStatus(error.message || "Failed to send", { error: true });
    }
  });
})();
