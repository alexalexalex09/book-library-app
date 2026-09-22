(function () {
  const loginPanel = document.getElementById("loginPanel");
  const deniedPanel = document.getElementById("deniedPanel");
  const consolePanel = document.getElementById("consolePanel");
  const signupsPanel = document.getElementById("signupsPanel");
  const notifyPanel = document.getElementById("notifyPanel");
  const sessionBar = document.getElementById("sessionBar");
  const sessionEmail = document.getElementById("sessionEmail");
  const loginError = document.getElementById("loginError");
  const searchStatus = document.getElementById("searchStatus");
  const detailStatus = document.getElementById("detailStatus");
  const signupsStatus = document.getElementById("signupsStatus");
  const notifyStatus = document.getElementById("notifyStatus");
  const userList = document.getElementById("userList");
  const signupList = document.getElementById("signupList");
  const userDetail = document.getElementById("userDetail");
  const userDetailFields = document.getElementById("userDetailFields");
  const syncBillingBtn = document.getElementById("syncBillingBtn");
  const notifyMode = document.getElementById("notifyMode");

  let config = null;
  let supabaseClient = null;
  let accessToken = null;
  let selectedUserId = null;

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
    try {
      await supabaseClient?.auth.signOut();
    } catch {
      /* ignore */
    }
    hide(sessionBar);
    hide(consolePanel);
    hide(signupsPanel);
    hide(notifyPanel);
    hide(deniedPanel);
    show(loginPanel);
    userList.innerHTML = "";
    if (signupList) signupList.innerHTML = "";
    hide(userDetail);
  }

  function formatWhen(value) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString();
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

  async function loadNotifySettings() {
    setText(notifyStatus, "");
    try {
      const data = await api("/api/admin/settings/notifications");
      if (notifyMode && data.signupNotifyMode) {
        notifyMode.value = data.signupNotifyMode;
      }
    } catch (error) {
      setText(notifyStatus, error.message, { error: true });
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
      show(consolePanel);
      show(signupsPanel);
      show(notifyPanel);
      await Promise.all([loadSignups(), loadNotifySettings()]);
    } catch (error) {
      hide(consolePanel);
      hide(signupsPanel);
      hide(notifyPanel);
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

  function renderUserDetail(user) {
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
          renderUserDetail(data.user);
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

  document.getElementById("notifyForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    setText(notifyStatus, "Saving…");
    try {
      const data = await api("/api/admin/settings/notifications", {
        method: "POST",
        body: { signupNotifyMode: notifyMode.value },
      });
      notifyMode.value = data.signupNotifyMode;
      setText(notifyStatus, "Saved.");
    } catch (error) {
      setText(notifyStatus, error.message, { error: true });
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
