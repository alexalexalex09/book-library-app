const Stripe = require("stripe");

const OVERVIEW_CACHE_MS = 5 * 60 * 1000;
const BILLING_CACHE_MS = 10 * 60 * 1000;

function dayStartUtc(daysAgo) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d;
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function createAdminStats({ supabase, env = process.env }) {
  let overviewCache = null;
  let billingCache = null;

  async function countRows(table, filters = []) {
    let query = supabase.from(table).select("id");
    for (const apply of filters) query = apply(query);
    const { data, error } = await query;
    if (error) {
      console.error(`admin-stats: count ${table} failed`, error.message || error);
      return 0;
    }
    return (data || []).length;
  }

  async function distinctUserCount(table) {
    const { data, error } = await supabase.from(table).select("user_id");
    if (error) {
      console.error(
        `admin-stats: distinct ${table} failed`,
        error.message || error,
      );
      return 0;
    }
    return new Set((data || []).map((r) => r.user_id).filter(Boolean)).size;
  }

  async function loadUsageBuckets() {
    const since7d = isoDaysAgo(7);
    const since24h = isoDaysAgo(1);
    const { data, error } = await supabase
      .from("api_usage_events")
      .select("action,created_at")
      .gte("created_at", since7d)
      .limit(5000);
    if (error) {
      console.error("admin-stats: usage failed", error.message || error);
      return emptyUsage();
    }
    const empty = emptyUsage();
    for (const row of data || []) {
      const action = row.action;
      if (!empty.last7d[action] && empty.last7d[action] !== 0) continue;
      empty.last7d[action] = (empty.last7d[action] || 0) + 1;
      if (String(row.created_at) >= since24h) {
        empty.last24h[action] = (empty.last24h[action] || 0) + 1;
      }
    }
    return empty;
  }

  function emptyUsage() {
    const keys = [
      "ocr_ok",
      "ocr_error",
      "ocr_rate_limit",
      "books_ok",
      "books_rate_limit",
    ];
    const zero = Object.fromEntries(keys.map((k) => [k, 0]));
    return { last24h: { ...zero }, last7d: { ...zero } };
  }

  async function loadSupportHealth() {
    const { data: tickets, error } = await supabase
      .from("support_tickets")
      .select("id,status,created_at,updated_at")
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) {
      console.error("admin-stats: support failed", error.message || error);
      return {
        open: 0,
        pending: 0,
        oldestOpenAgeHours: null,
        openedLast7d: 0,
        resolvedLast7d: 0,
        medianFirstAdminReplyMs: null,
      };
    }

    const since7d = isoDaysAgo(7);
    let open = 0;
    let pending = 0;
    let oldestOpen = null;
    let openedLast7d = 0;
    let resolvedLast7d = 0;
    const openIds = [];

    for (const t of tickets || []) {
      if (t.status === "open") {
        open += 1;
        openIds.push(t.id);
        const created = new Date(t.created_at).getTime();
        if (!oldestOpen || created < oldestOpen) oldestOpen = created;
      }
      if (t.status === "pending") pending += 1;
      if (String(t.created_at) >= since7d) openedLast7d += 1;
      if (
        (t.status === "resolved" || t.status === "closed") &&
        String(t.updated_at || t.created_at) >= since7d
      ) {
        resolvedLast7d += 1;
      }
    }

    const replyAges = [];
    for (const ticketId of openIds.slice(0, 100).concat(
      (tickets || [])
        .filter((t) => t.status !== "open")
        .slice(0, 100)
        .map((t) => t.id),
    )) {
      const ticket = (tickets || []).find((t) => t.id === ticketId);
      if (!ticket) continue;
      const { data: msgs } = await supabase
        .from("support_ticket_messages")
        .select("author_type,created_at")
        .eq("ticket_id", ticketId)
        .order("created_at", { ascending: true })
        .limit(20);
      const firstAdmin = (msgs || []).find((m) => m.author_type === "admin");
      if (firstAdmin) {
        replyAges.push(
          new Date(firstAdmin.created_at).getTime() -
            new Date(ticket.created_at).getTime(),
        );
      }
    }

    return {
      open,
      pending,
      oldestOpenAgeHours:
        oldestOpen == null
          ? null
          : Math.round((Date.now() - oldestOpen) / 36e5),
      openedLast7d,
      resolvedLast7d,
      medianFirstAdminReplyMs: median(replyAges.filter((n) => n >= 0)),
    };
  }

  async function loadRetention(signups, engagementByUser) {
    function cohortRetention(daysAgo) {
      const start = dayStartUtc(daysAgo);
      const end = dayStartUtc(daysAgo - 1);
      const cohort = (signups || []).filter((s) => {
        const t = new Date(s.created_at).getTime();
        return t >= start.getTime() && t < end.getTime();
      });
      const sampleSize = cohort.length;
      if (!sampleSize) {
        return { rate: null, sampleSize: 0 };
      }
      const retained = cohort.filter((s) => {
        const eng = engagementByUser.get(s.user_id);
        if (!eng?.last_seen_at) return false;
        return new Date(eng.last_seen_at).getTime() >= end.getTime();
      }).length;
      return { rate: retained / sampleSize, sampleSize };
    }

    return {
      d1: cohortRetention(1),
      d7: cohortRetention(7),
      d30: cohortRetention(30),
    };
  }

  async function getOverview({ force = false } = {}) {
    if (
      !force &&
      overviewCache &&
      Date.now() - overviewCache.at < OVERVIEW_CACHE_MS
    ) {
      return overviewCache.data;
    }

    const since24h = isoDaysAgo(1);
    const since7d = isoDaysAgo(7);

    const { data: signups } = await supabase
      .from("signup_events")
      .select("user_id,email,provider,created_at")
      .order("created_at", { ascending: false })
      .limit(2000);

    const signupRows = signups || [];
    const signups24h = signupRows.filter(
      (s) => String(s.created_at) >= since24h,
    ).length;
    const signups7d = signupRows.filter(
      (s) => String(s.created_at) >= since7d,
    ).length;
    const providerMix = {};
    for (const s of signupRows.filter((r) => String(r.created_at) >= since7d)) {
      const p = s.provider || "email";
      providerMix[p] = (providerMix[p] || 0) + 1;
    }

    let confirmed = 0;
    let unconfirmed = 0;
    const recentIds = signupRows
      .filter((s) => String(s.created_at) >= since7d)
      .map((s) => s.user_id)
      .slice(0, 40);
    for (const userId of recentIds) {
      try {
        const { data } = await supabase.auth.admin.getUserById(userId);
        if (data?.user?.email_confirmed_at) confirmed += 1;
        else unconfirmed += 1;
      } catch {
        /* ignore */
      }
    }

    const [
      usersWithLibrary,
      usersWithShelf,
      usersWithBook,
      librariesTotal,
      shelvesTotal,
      booksTotal,
      sharesActive,
      sharesCreated7d,
      ocrCacheTotal,
      audit7d,
    ] = await Promise.all([
      distinctUserCount("libraries"),
      distinctUserCount("shelves"),
      distinctUserCount("user_books"),
      countRows("libraries"),
      countRows("shelves"),
      countRows("user_books"),
      countRows("library_shares", [(q) => q.is("revoked_at", null)]),
      countRows("library_shares", [(q) => q.gte("created_at", since7d)]),
      countRows("ocr_cache"),
      countRows("admin_audit_log", [(q) => q.gte("created_at", since7d)]),
    ]);

    let revokedCount = 0;
    try {
      const { data: allShares } = await supabase
        .from("library_shares")
        .select("revoked_at");
      revokedCount = (allShares || []).filter((s) => s.revoked_at).length;
    } catch {
      revokedCount = 0;
    }

    const { data: bookUsers } = await supabase
      .from("user_books")
      .select("user_id");
    const booksByUser = new Map();
    for (const row of bookUsers || []) {
      if (!row.user_id) continue;
      booksByUser.set(row.user_id, (booksByUser.get(row.user_id) || 0) + 1);
    }
    const usersWithBooks = booksByUser.size;
    const avgBooksPerUser =
      usersWithBooks === 0
        ? 0
        : [...booksByUser.values()].reduce((a, b) => a + b, 0) / usersWithBooks;

    const { data: engagement } = await supabase
      .from("user_engagement")
      .select("user_id,last_seen_at,first_seen_at,request_count")
      .limit(5000);
    const engagementByUser = new Map(
      (engagement || []).map((e) => [e.user_id, e]),
    );
    const active24h = (engagement || []).filter(
      (e) => String(e.last_seen_at) >= since24h,
    ).length;
    const active7d = (engagement || []).filter(
      (e) => String(e.last_seen_at) >= since7d,
    ).length;

    const emptyAccounts = signupRows.filter(
      (s) => !engagementByUser.has(s.user_id),
    ).length;

    const [support, usage, retention] = await Promise.all([
      loadSupportHealth(),
      loadUsageBuckets(),
      loadRetention(signupRows, engagementByUser),
    ]);

    let ocrCacheInserts7d = null;
    try {
      const { data: ocrRows } = await supabase
        .from("ocr_cache")
        .select("created_at")
        .gte("created_at", since7d);
      if (Array.isArray(ocrRows)) ocrCacheInserts7d = ocrRows.length;
    } catch {
      ocrCacheInserts7d = null;
    }

    const data = {
      generatedAt: new Date().toISOString(),
      growth: {
        signups24h,
        signups7d,
        providerMix,
        confirmedAmongRecent: confirmed,
        unconfirmedAmongRecent: unconfirmed,
        recentSampleSize: recentIds.length,
      },
      activation: {
        usersWithLibrary,
        usersWithShelf,
        usersWithBook,
        librariesTotal,
        shelvesTotal,
        booksTotal,
        avgBooksPerUser: Math.round(avgBooksPerUser * 100) / 100,
        emptyAccountCount: emptyAccounts,
      },
      sharing: {
        active: sharesActive,
        revoked: revokedCount,
        createdLast7d: sharesCreated7d,
      },
      ocrCache: {
        total: ocrCacheTotal,
        insertsLast7d: ocrCacheInserts7d,
      },
      support,
      engagement: {
        activeUsers24h: active24h,
        activeUsers7d: active7d,
        retention,
      },
      adminOps: {
        auditActionsLast7d: audit7d,
      },
      usage,
    };

    overviewCache = { at: Date.now(), data };
    return data;
  }

  async function getUsageStats() {
    return loadUsageBuckets();
  }

  function getStripeClient() {
    const secret = String(env.STRIPE_SECRET_KEY || "").trim();
    if (!secret) return null;
    return new Stripe(secret, { apiVersion: "2025-08-27.basil" });
  }

  async function getBillingStats({ force = false } = {}) {
    if (
      !force &&
      billingCache &&
      Date.now() - billingCache.at < BILLING_CACHE_MS
    ) {
      return billingCache.data;
    }

    const stripe = getStripeClient();
    const monthlyPriceId = String(env.STRIPE_PRICE_ID_MONTHLY || "").trim();
    const annualPriceId = String(env.STRIPE_PRICE_ID_ANNUAL || "").trim();

    if (!stripe) {
      const data = {
        configured: false,
        reason: "billing_not_configured",
      };
      billingCache = { at: Date.now(), data };
      return data;
    }

    try {
      const statuses = [
        "active",
        "trialing",
        "past_due",
        "unpaid",
        "canceled",
      ];
      const counts = Object.fromEntries(statuses.map((s) => [s, 0]));
      let monthly = 0;
      let annual = 0;
      let mrrCents = 0;
      let newSubscribers7d = 0;
      let trialsEnding7d = 0;
      const since7d = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const until7d = Date.now() + 7 * 24 * 60 * 60 * 1000;

      for (const status of statuses) {
        let startingAfter;
        // Cap pages to keep admin endpoint bounded
        for (let page = 0; page < 5; page += 1) {
          const listed = await stripe.subscriptions.list({
            status,
            limit: 100,
            ...(startingAfter ? { starting_after: startingAfter } : {}),
            expand: ["data.items.data.price"],
          });
          for (const sub of listed.data || []) {
            counts[status] += 1;
            const price = sub.items?.data?.[0]?.price;
            const priceId = price?.id || "";
            const amount = Number(price?.unit_amount || 0);
            const interval = price?.recurring?.interval;
            if (status === "active" || status === "trialing") {
              if (priceId && priceId === monthlyPriceId) monthly += 1;
              else if (priceId && priceId === annualPriceId) annual += 1;
              else if (interval === "month") monthly += 1;
              else if (interval === "year") annual += 1;

              if (status === "active" && amount > 0) {
                if (interval === "year") mrrCents += amount / 12;
                else mrrCents += amount;
              }
            }
            const createdMs = (sub.created || 0) * 1000;
            if (
              (status === "active" || status === "trialing") &&
              createdMs >= since7d
            ) {
              newSubscribers7d += 1;
            }
            if (status === "trialing" && sub.trial_end) {
              const endMs = sub.trial_end * 1000;
              if (endMs >= Date.now() && endMs <= until7d) {
                trialsEnding7d += 1;
              }
            }
          }
          if (!listed.has_more || !(listed.data || []).length) break;
          startingAfter = listed.data[listed.data.length - 1].id;
        }
      }

      const data = {
        configured: true,
        counts,
        monthly,
        annual,
        estimatedMrr: Math.round(mrrCents) / 100,
        newSubscribers7d,
        trialsEnding7d,
        generatedAt: new Date().toISOString(),
      };
      billingCache = { at: Date.now(), data };
      return data;
    } catch (error) {
      console.error("admin-stats: stripe failed", error?.message || error);
      const data = {
        configured: true,
        error: "stripe_fetch_failed",
        message: error?.message || "Stripe error",
      };
      billingCache = { at: Date.now(), data };
      return data;
    }
  }

  return {
    getOverview,
    getUsageStats,
    getBillingStats,
    clearCaches() {
      overviewCache = null;
      billingCache = null;
    },
  };
}

module.exports = {
  createAdminStats,
  OVERVIEW_CACHE_MS,
  BILLING_CACHE_MS,
  median,
  dayStartUtc,
};
