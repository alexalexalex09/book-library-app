function parseRateLimitHeaders(headers) {
  const limit = Number(headers.get("ratelimit-limit"));
  const remaining = Number(headers.get("ratelimit-remaining"));
  const reset = Number(headers.get("ratelimit-reset"));
  if (!Number.isFinite(limit) || !Number.isFinite(remaining)) return null;
  return {
    limit,
    remaining,
    resetSeconds: Number.isFinite(reset) ? reset : null,
  };
}

window.__hiLibraryRateLimitState = window.__hiLibraryRateLimitState || {
  ocr: null,
  books: null,
};

async function authenticatedFetch(input, init = {}) {
  const {
    data: { session },
    error,
  } = await supabaseClient.auth.getSession();

  if (error || !session?.access_token) {
    throw new Error("Authentication required");
  }

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${session.access_token}`);

  const response = await fetch(input, { ...init, headers });
  try {
    const url = typeof input === "string" ? input : input.url;
    const snapshot = parseRateLimitHeaders(response.headers);
    if (snapshot) {
      if (url.includes("/api/ocr")) {
        window.__hiLibraryRateLimitState.ocr = snapshot;
      } else if (url.includes("/api/books")) {
        window.__hiLibraryRateLimitState.books = snapshot;
      }
      window.dispatchEvent(
        new CustomEvent("hilibrary:rate-limit", {
          detail: window.__hiLibraryRateLimitState,
        }),
      );
    }
  } catch {
    // ignore header parse issues
  }
  return response;
}

async function fetchBillingStatus() {
  const response = await authenticatedFetch("/api/billing/status");
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Failed to load billing status");
  return data;
}

async function createBillingCheckout(interval) {
  const response = await authenticatedFetch("/api/billing/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ interval }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Failed to start checkout");
  return data;
}

async function fetchAccountSummary() {
  const response = await authenticatedFetch("/api/account");
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Failed to load account");
  return data;
}

async function requestAccountDeletion() {
  const response = await authenticatedFetch("/api/account/delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: "DELETE" }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Failed to delete account");
  return data;
}

async function createBillingPortal() {
  const response = await authenticatedFetch("/api/billing/portal", {
    method: "POST",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Failed to open billing portal");
  return data;
}
