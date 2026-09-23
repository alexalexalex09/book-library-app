(function () {
  const loginPanel = document.getElementById("loginPanel");
  const deniedPanel = document.getElementById("deniedPanel");
  const overviewPanel = document.getElementById("overviewPanel");
  const consolePanel = document.getElementById("consolePanel");
  const supportPanel = document.getElementById("supportPanel");
  const signupsPanel = document.getElementById("signupsPanel");
  const auditPanel = document.getElementById("auditPanel");
  const notifyPanel = document.getElementById("notifyPanel");
  const sessionBar = document.getElementById("sessionBar");
  const sessionEmail = document.getElementById("sessionEmail");
  const loginError = document.getElementById("loginError");
  const searchStatus = document.getElementById("searchStatus");
  const detailStatus = document.getElementById("detailStatus");
  const signupsStatus = document.getElementById("signupsStatus");
  const notifyStatus = document.getElementById("notifyStatus");
  const overviewStatus = document.getElementById("overviewStatus");
  const supportStatus = document.getElementById("supportStatus");
  const auditStatus = document.getElementById("auditStatus");
  const userList = document.getElementById("userList");
  const signupList = document.getElementById("signupList");
  const auditList = document.getElementById("auditList");
  const ticketList = document.getElementById("ticketList");
  const overviewCards = document.getElementById("overviewCards");
  const userDetail = document.getElementById("userDetail");
  const userDetailFields = document.getElementById("userDetailFields");
  const syncBillingBtn = document.getElementById("syncBillingBtn");
  const notifyMode = document.getElementById("notifyMode");
  const supportNotifyMode = document.getElementById("supportNotifyMode");
  const ticketDetail = document.getElementById("ticketDetail");

  let config = null;
  let supabaseClient = null;
  let accessToken = null;
  let selectedUserId = null;
  let selectedTicketId = null;
  let currentSuggestion = "";

  const authPanels = [
    overviewPanel,
    consolePanel,
    supportPanel,
    signupsPanel,
    auditPanel,
    notifyPanel,
  ];

  function show(el) {
    el?.classList.remove("hidden");
  }

  function hide(el) {
    el?.classList.add("hidden");
  }

  function setText(el, text, { error = false } = {}) {
    if (!el) return;
    el.hidden = !text;
    el.textContent = text || "";
    el.classList.toggle("error", Boolean(error));
  }

  async function loadConfig() {
    const response = await fetch("./config.json", { cache: "no-store" });
    if (!response.ok) throw new Error("Failed to load config.json");
    config = await response.json();
    if (!config.apiOrigin || !config.supabaseUrl || !config.supabaseAnonKey) {
      throw new Error("config.json is missing required fields");
    }
    config.apiOrigin = String(config.apiOrigin).replace(/\/$/, "");
  }

  function initSupabase() {
    if (!window.supabase?.createClient) {
      throw new Error("Supabase client library failed to load");
    }
    supabaseClient = window.supabase.createClient(
      config.supabaseUrl,
      config.supabaseAnonKey,
      {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: false,
          storageKey: "shelfmapper-admin-auth",
        },
      },
    );
  }

  async function api(path, { method = "GET", body } = {}) {
    if (!accessToken) throw new Error("Not signed in");
    const response = await fetch(`${config.apiOrigin}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error(data.error || `Request failed (${response.status})`);
      err.status = response.status;
      err.code = data.code || null;
      err.data = data;
      throw err;
    }
    return data;
  }

  async function signOut() {
    accessToken = null;
    selectedUserId = null;
    selectedTicketId = null;
    try {
      await supabaseClient?.auth.signOut();
    } catch {
      /* ignore */
    }
    hide(sessionBar);
    authPanels.forEach(hide);
    hide(deniedPanel);
    show(loginPanel);
    userList.innerHTML = "";
    if (signupList) signupList.innerHTML = "";
    if (ticketList) ticketList.innerHTML = "";
    if (auditList) auditList.innerHTML = "";
    if (overviewCards) overviewCards.innerHTML = "";
    hide(userDetail);
    hide(ticketDetail);
  }

  function formatWhen(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString();
  }

  const AUDIT_ACTIONS = {
    "admin.me": {
      title: "Session check",
      description:
        "Confirmed this browser session is an allowlisted admin (role + ADMIN_EMAILS).",
    },
    "admin.users.search": {
      title: "User search",
      description: "Searched for users by email fragment or UUID.",
    },
    "admin.users.get": {
      title: "Viewed user detail",
      description:
        "Opened a user’s billing and account projection (no passwords or secrets).",
    },
    "admin.users.sync_billing": {
      title: "Synced billing from Stripe",
      description:
        "Pulled the user’s Stripe subscription into Auth app_metadata (plan, status, IDs).",
    },
    "admin.signups.list": {
      title: "Viewed signup history",
      description: "Loaded the recent signups list (and may have synced from Auth).",
    },
    "admin.settings.notifications": {
      title: "Changed notification settings",
      description:
        "Updated signup and/or support email notify mode (off, immediate, or daily).",
    },
    "admin.support.update": {
      title: "Updated support ticket",
      description: "Changed a ticket’s status, priority, or other fields.",
    },
    "admin.support.reply": {
      title: "Replied to support ticket",
      description: "Posted an admin reply on a ticket (may email the requester).",
    },
    "admin.support.suggest": {
      title: "Regenerated AI suggestion",
      description:
        "Asked Gemini for a new suggested reply / path-forward on a ticket (not sent to the user).",
    },
  };

  function describeAuditAction(action) {
    const key = String(action || "");
    return (
      AUDIT_ACTIONS[key] || {
        title: key || "Unknown action",
        description: "No description is defined for this action code yet.",
      }
    );
  }

  function addStatCard(title, lines) {
    const card = document.createElement("article");
    card.className = "stat-card";
    const h = document.createElement("h3");
    h.textContent = title;
    card.appendChild(h);
    const ul = document.createElement("ul");
    for (const line of lines) {
      const li = document.createElement("li");
      li.textContent = line;
      ul.appendChild(li);
    }
    card.appendChild(ul);
    overviewCards.appendChild(card);
  }

  async function loadOverview() {
    setText(overviewStatus, "Loading…");
    overviewCards.innerHTML = "";
    try {
      const data = await api("/api/admin/stats/overview?refresh=1");
      const g = data.growth || {};
      const a = data.activation || {};
      const s = data.sharing || {};
      const u = data.usage || {};
      const support = data.support || {};
      const eng = data.engagement || {};
      const billing = data.billing || {};
      const ret = eng.retention || {};

      addStatCard("Growth", [
        `Signups 24h / 7d: ${g.signups24h ?? 0} / ${g.signups7d ?? 0}`,
        `Providers (7d): ${JSON.stringify(g.providerMix || {})}`,
        `Confirmed / unconfirmed (sample ${g.recentSampleSize || 0}): ${g.confirmedAmongRecent ?? 0} / ${g.unconfirmedAmongRecent ?? 0}`,
      ]);
      addStatCard("Activation", [
        `Users w/ library / shelf / book: ${a.usersWithLibrary ?? 0} / ${a.usersWithShelf ?? 0} / ${a.usersWithBook ?? 0}`,
        `Totals libs / shelves / books: ${a.librariesTotal ?? 0} / ${a.shelvesTotal ?? 0} / ${a.booksTotal ?? 0}`,
        `Avg books/user: ${a.avgBooksPerUser ?? 0}; empty accounts: ${a.emptyAccountCount ?? 0}`,
      ]);
      addStatCard("Sharing", [
        `Active / revoked: ${s.active ?? 0} / ${s.revoked ?? 0}`,
        `Created last 7d: ${s.createdLast7d ?? 0}`,
      ]);
      addStatCard("Usage", [
        `OCR ok/err/limit 24h: ${u.last24h?.ocr_ok ?? 0}/${u.last24h?.ocr_error ?? 0}/${u.last24h?.ocr_rate_limit ?? 0}`,
        `OCR ok/err/limit 7d: ${u.last7d?.ocr_ok ?? 0}/${u.last7d?.ocr_error ?? 0}/${u.last7d?.ocr_rate_limit ?? 0}`,
        `Books ok/limit 24h: ${u.last24h?.books_ok ?? 0}/${u.last24h?.books_rate_limit ?? 0}`,
      ]);
      addStatCard("Support health", [
        `Open / pending: ${support.open ?? 0} / ${support.pending ?? 0}`,
        `Oldest open (h): ${support.oldestOpenAgeHours ?? "—"}`,
        `Opened / resolved 7d: ${support.openedLast7d ?? 0} / ${support.resolvedLast7d ?? 0}`,
      ]);
      addStatCard("Engagement", [
        `Active 24h / 7d: ${eng.activeUsers24h ?? 0} / ${eng.activeUsers7d ?? 0}`,
        `D1: ${fmtRate(ret.d1)} · D7: ${fmtRate(ret.d7)} · D30: ${fmtRate(ret.d30)}`,
      ]);
      if (billing.configured) {
        addStatCard("Billing", [
          `Active / trial / past_due: ${billing.counts?.active ?? 0} / ${billing.counts?.trialing ?? 0} / ${billing.counts?.past_due ?? 0}`,
          `Monthly / annual: ${billing.monthly ?? 0} / ${billing.annual ?? 0}`,
          `Est. MRR: $${billing.estimatedMrr ?? 0}; new 7d: ${billing.newSubscribers7d ?? 0}; trials ending 7d: ${billing.trialsEnding7d ?? 0}`,
        ]);
      } else {
        addStatCard("Billing", ["Stripe not configured"]);
      }
      setText(overviewStatus, `Updated ${formatWhen(data.generatedAt)}`);
    } catch (error) {
      setText(overviewStatus, error.message, { error: true });
    }
  }

  function fmtRate(bucket) {
    if (!bucket || bucket.sampleSize === 0 || bucket.rate == null) {
      return `n/a (n=${bucket?.sampleSize || 0})`;
    }
    return `${Math.round(bucket.rate * 100)}% (n=${bucket.sampleSize})`;
  }

  async function loadSignups() {
    setText(signupsStatus, "Loading…");
    try {
      const data = await api("/api/admin/signups");
      const signups = data.signups || [];
      signupList.innerHTML = "";
      if (!signups.length) {
        setText(signupsStatus, "No signups recorded yet.");
        return;
      }
      setText(signupsStatus, `${signups.length} most recent`);
      for (const row of signups) {
        const li = document.createElement("li");
        const main = document.createElement("span");
        main.textContent = `${row.email || row.user_id} · ${row.provider || "email"}`;
        const meta = document.createElement("span");
        meta.className = "meta";
        meta.textContent = formatWhen(row.created_at);
        li.appendChild(main);
        li.appendChild(meta);
        signupList.appendChild(li);
      }
    } catch (error) {
      setText(signupsStatus, error.message, { error: true });
      signupList.innerHTML = "";
    }
  }

  async function loadAudit() {
    setText(auditStatus, "Loading…");
    try {
      const data = await api("/api/admin/audit?limit=50");
      const rows = data.audit || [];
      auditList.innerHTML = "";
      if (!rows.length) {
        setText(auditStatus, "No audit rows yet.");
        return;
      }
      setText(auditStatus, `${rows.length} recent`);
      for (const row of rows) {
        const info = describeAuditAction(row.action);
        const li = document.createElement("li");

        const rowEl = document.createElement("div");
        rowEl.className = "audit-row";

        const main = document.createElement("div");
        const title = document.createElement("span");
        title.className = "audit-title";
        title.textContent = info.title;
        const code = document.createElement("span");
        code.className = "audit-code";
        code.textContent = row.action || "—";
        main.appendChild(title);
        main.appendChild(code);

        const meta = document.createElement("span");
        meta.className = "meta";
        meta.textContent = formatWhen(row.created_at);

        rowEl.appendChild(main);
        rowEl.appendChild(meta);
        li.appendChild(rowEl);

        const desc = document.createElement("p");
        desc.className = "audit-desc";
        desc.textContent = info.description;
        li.appendChild(desc);

        if (row.target_user_id) {
          const target = document.createElement("p");
          target.className = "audit-target";
          target.textContent = `Target user: ${row.target_user_id}`;
          li.appendChild(target);
        }

        auditList.appendChild(li);
      }
    } catch (error) {
      setText(auditStatus, error.message, { error: true });
      auditList.innerHTML = "";
    }
  }

  async function loadNotifySettings() {
    setText(notifyStatus, "");
    try {
      const data = await api("/api/admin/settings/notifications");
      if (notifyMode && data.signupNotifyMode) {
        notifyMode.value = data.signupNotifyMode;
      }
      if (supportNotifyMode && data.supportNotifyMode) {
        supportNotifyMode.value = data.supportNotifyMode;
      }
    } catch (error) {
      setText(notifyStatus, error.message, { error: true });
    }
  }

  async function loadSupportTickets() {
    setText(supportStatus, "Loading…");
    try {
      const data = await api("/api/admin/support/tickets");
      const tickets = data.tickets || [];
      ticketList.innerHTML = "";
      if (!tickets.length) {
        setText(supportStatus, "No tickets yet.");
        hide(ticketDetail);
        return;
      }
      setText(supportStatus, `${tickets.length} ticket(s)`);
      for (const ticket of tickets) {
        const li = document.createElement("li");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = `[${ticket.status}] ${ticket.subject} · ${ticket.email}`;
        btn.addEventListener("click", () => openTicket(ticket.id, btn));
        li.appendChild(btn);
        ticketList.appendChild(li);
      }
    } catch (error) {
      setText(supportStatus, error.message, { error: true });
      ticketList.innerHTML = "";
    }
  }

  async function openTicket(id, btn) {
    selectedTicketId = id;
    ticketList.querySelectorAll("button").forEach((el) => {
      el.classList.toggle("is-active", el === btn);
    });
    try {
      const data = await api(`/api/admin/support/tickets/${id}`);
      const ticket = data.ticket;
      show(ticketDetail);
      document.getElementById("ticketSubject").textContent = ticket.subject;
      document.getElementById("ticketMeta").textContent =
        `${ticket.email} · ${ticket.category} · ${ticket.public_id} · ${formatWhen(ticket.created_at)}`;
      document.getElementById("ticketStatus").value = ticket.status;
      currentSuggestion = ticket.ai_suggestion || "";
      document.getElementById("aiSuggestionText").textContent =
        currentSuggestion ||
        `(${ticket.ai_suggestion_status || "pending"}) No suggestion yet`;
      const thread = document.getElementById("ticketThread");
      thread.innerHTML = "";
      for (const msg of data.messages || []) {
        const div = document.createElement("div");
        div.className = `msg msg-${msg.author_type}`;
        div.innerHTML = `<strong>${msg.author_type}</strong> <span class="meta">${formatWhen(msg.created_at)}</span><p></p>`;
        div.querySelector("p").textContent = msg.body;
        thread.appendChild(div);
      }
    } catch (error) {
      setText(supportStatus, error.message, { error: true });
    }
  }

  async function verifyAdminSession(session) {
    accessToken = session?.access_token || null;
    if (!accessToken) {
      await signOut();
      return;
    }
    sessionEmail.textContent = session.user?.email || "";
    show(sessionBar);
    hide(loginPanel);
    try {
      await api("/api/admin/me");
      hide(deniedPanel);
      authPanels.forEach(show);
      await Promise.all([
        loadOverview(),
        loadSignups(),
        loadNotifySettings(),
        loadSupportTickets(),
        loadAudit(),
      ]);
    } catch (error) {
      authPanels.forEach(hide);
      if (error.status === 403) {
        show(deniedPanel);
        return;
      }
      setText(loginError, error.message || "Admin session check failed", {
        error: true,
      });
      await signOut();
    }
  }

  function renderUserDetail(user, extras = {}) {
    selectedUserId = user.id;
    const meta = user.app_metadata || {};
    const rows = [
      ["ID", user.id],
      ["Email", user.email || "—"],
      ["Plan", meta.plan || "free"],
      ["Stripe status", meta.stripe_subscription_status || "—"],
      ["Subscription ID", meta.stripe_subscription_id || "—"],
      ["Customer ID", meta.stripe_customer_id || "—"],
      ["Price ID", meta.stripe_price_id || "—"],
      ["Trial ends", meta.trial_ends_at || "—"],
      ["Created", user.created_at || "—"],
      ["Last sign-in", user.last_sign_in_at || "—"],
      ["Support tickets", extras.ticketCount ?? "—"],
      ["Usage (7d)", JSON.stringify(extras.recentUsage || {})],
    ];
    userDetailFields.innerHTML = "";
    for (const [label, value] of rows) {
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value;
      userDetailFields.appendChild(dt);
      userDetailFields.appendChild(dd);
    }
    show(userDetail);
    setText(detailStatus, "");
  }

  function renderUserList(users) {
    userList.innerHTML = "";
    if (!users.length) {
      setText(searchStatus, "No users matched that query.");
      hide(userDetail);
      return;
    }
    setText(searchStatus, `${users.length} result(s)`);
    users.forEach((user) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = `${user.email || "(no email)"} · ${user.app_metadata?.plan || "free"}`;
      btn.addEventListener("click", async () => {
        userList.querySelectorAll("button").forEach((el) => {
          el.classList.toggle("is-active", el === btn);
        });
        try {
          const data = await api(`/api/admin/users/${encodeURIComponent(user.id)}`);
          renderUserDetail(data.user, {
            ticketCount: data.ticketCount,
            recentUsage: data.recentUsage,
          });
        } catch (error) {
          setText(detailStatus, error.message, { error: true });
          show(userDetail);
        }
      });
      li.appendChild(btn);
      userList.appendChild(li);
    });
  }

  document.getElementById("loginForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    setText(loginError, "");
    const email = document.getElementById("loginEmail").value.trim();
    const password = document.getElementById("loginPassword").value;
    const { data, error } = await supabaseClient.auth.signInWithPassword({
      email,
      password,
    });
    if (error) {
      setText(loginError, error.message || "Sign-in failed", { error: true });
      return;
    }
    await verifyAdminSession(data.session);
  });

  document.getElementById("signOutBtn")?.addEventListener("click", () => signOut());
  document.getElementById("deniedSignOutBtn")?.addEventListener("click", () => signOut());

  document.getElementById("searchForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = document.getElementById("searchInput").value.trim();
    setText(searchStatus, "Searching…");
    hide(userDetail);
    try {
      const data = await api(`/api/admin/users?q=${encodeURIComponent(q)}`);
      renderUserList(data.users || []);
    } catch (error) {
      setText(searchStatus, error.message, { error: true });
      userList.innerHTML = "";
    }
  });

  syncBillingBtn?.addEventListener("click", async () => {
    if (!selectedUserId) return;
    syncBillingBtn.disabled = true;
    setText(detailStatus, "Syncing from Stripe…");
    try {
      const data = await api(
        `/api/admin/users/${encodeURIComponent(selectedUserId)}/sync-billing`,
        { method: "POST" },
      );
      renderUserDetail(data.user);
      setText(detailStatus, "Billing metadata updated from Stripe.");
    } catch (error) {
      setText(detailStatus, error.message, { error: true });
    } finally {
      syncBillingBtn.disabled = false;
    }
  });

  document.getElementById("refreshSignupsBtn")?.addEventListener("click", () => {
    loadSignups();
  });
  document.getElementById("refreshOverviewBtn")?.addEventListener("click", () => {
    loadOverview();
  });
  document.getElementById("refreshSupportBtn")?.addEventListener("click", () => {
    loadSupportTickets();
  });
  document.getElementById("refreshAuditBtn")?.addEventListener("click", () => {
    loadAudit();
  });

  document.getElementById("notifyForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    setText(notifyStatus, "Saving…");
    try {
      const data = await api("/api/admin/settings/notifications", {
        method: "POST",
        body: {
          signupNotifyMode: notifyMode.value,
          supportNotifyMode: supportNotifyMode.value,
        },
      });
      notifyMode.value = data.signupNotifyMode;
      supportNotifyMode.value = data.supportNotifyMode;
      setText(notifyStatus, "Saved.");
    } catch (error) {
      setText(notifyStatus, error.message, { error: true });
    }
  });

  document.getElementById("ticketStatus")?.addEventListener("change", async (e) => {
    if (!selectedTicketId) return;
    try {
      await api(`/api/admin/support/tickets/${selectedTicketId}`, {
        method: "POST",
        body: { status: e.target.value },
      });
      await loadSupportTickets();
    } catch (error) {
      setText(supportStatus, error.message, { error: true });
    }
  });

  document.getElementById("useSuggestionBtn")?.addEventListener("click", () => {
    if (currentSuggestion) {
      document.getElementById("ticketReplyBody").value = currentSuggestion;
    }
  });

  document.getElementById("regenSuggestionBtn")?.addEventListener("click", async () => {
    if (!selectedTicketId) return;
    setText(supportStatus, "Generating suggestion…");
    try {
      const data = await api(
        `/api/admin/support/tickets/${selectedTicketId}/suggest`,
        { method: "POST" },
      );
      currentSuggestion = data.suggestion || data.ticket?.ai_suggestion || "";
      document.getElementById("aiSuggestionText").textContent =
        currentSuggestion || `(${data.status})`;
      setText(supportStatus, "");
    } catch (error) {
      setText(supportStatus, error.message, { error: true });
    }
  });

  document.getElementById("ticketReplyForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!selectedTicketId) return;
    const body = document.getElementById("ticketReplyBody").value.trim();
    try {
      await api(`/api/admin/support/tickets/${selectedTicketId}/reply`, {
        method: "POST",
        body: { body },
      });
      document.getElementById("ticketReplyBody").value = "";
      await openTicket(selectedTicketId);
      await loadSupportTickets();
    } catch (error) {
      setText(supportStatus, error.message, { error: true });
    }
  });

  (async function boot() {
    try {
      await loadConfig();
      initSupabase();
      const { data } = await supabaseClient.auth.getSession();
      if (data.session) await verifyAdminSession(data.session);
      else show(loginPanel);
      supabaseClient.auth.onAuthStateChange(async (event, session) => {
        if (event === "SIGNED_OUT") {
          accessToken = null;
          return;
        }
        if (session) await verifyAdminSession(session);
      });
    } catch (error) {
      setText(loginError, error.message || "Failed to start admin console", {
        error: true,
      });
      show(loginPanel);
    }
  })();
})();
