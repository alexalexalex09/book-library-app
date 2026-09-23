const SUPABASE_URL = "https://wqxvahmiblqgsjyywxpa.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_Oth3p_I48nLfY8tLkOcSvA_uegZywJY";

// ==========================================
// 1. INITIALIZATION & CONFIGURATION
// ==========================================
const supabaseClient = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
);

let currentUser = null;
let myLibrary = [];
let myRooms = [];
let selectedRoomId = "";
let billingState = {
  plan: "free",
  status: null,
  interval: null,
  trialEndsAt: null,
  renewalNotice: null,
  quotas: { ocr: 10, books: 60 },
};
let usageState = {
  ocr: null,
  books: null,
};
let isPublicShareView = false;
let bookLookupTarget = null;
let customCoverTarget = null;
let bookSettingsTarget = null;
let currentDismissedTitles = [];
let lastShelvesSnapshot = [];
let offlineMode = !navigator.onLine;
const offlineStore = window.HiLibraryOffline || null;

const SEARCH_RESULT_LIMIT = 5;
const FREE_SEARCH_ALL_LIMIT = 5;
const SEARCH_CONCURRENCY = 3;
const AUTO_CONFIRM_SCORE = 0.72;
const SUGGEST_SCORE = 0.45;
const DEFAULT_SHELF_CARD_WIDTH = 300;
const MIN_SHELF_CARD_WIDTH = 160;
const BOOK_COVER_PLACEHOLDER =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="70"><rect width="100%" height="100%" fill="#e5e7eb"/><text x="50%" y="52%" text-anchor="middle" font-size="9" fill="#71717a">No cover</text></svg>',
  );
const FOLIO_COLORS = {
  primary: "#8b3a2f",
  success: "#6f8753",
  warning: "#9d7138",
  mapDefaultFill: "rgba(139, 58, 47, 0.2)",
  mapSelectedFill: "rgba(111, 135, 83, 0.65)",
};

function isOfflineActive() {
  return offlineMode || !navigator.onLine;
}

function setOfflineMode(enabled) {
  offlineMode = Boolean(enabled);
  const banner = document.getElementById("offlineBanner");
  if (!banner) return;
  banner.classList.toggle("hidden-element", !offlineMode);
}

function requireOnline(actionLabel = "This action", notify = true) {
  if (!isOfflineActive()) return true;
  if (notify) showToast(`${actionLabel} requires an internet connection.`, "info");
  return false;
}

function mediaCacheKeyForShelfPath(storagePath) {
  if (!storagePath) return "";
  return `/offline-media/shelves/${encodeURIComponent(storagePath)}`;
}

function mediaCacheKeyForCover(url) {
  if (!url) return "";
  return `/offline-media/covers/${encodeURIComponent(url)}`;
}

async function resolveCoverSourceUrl(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return toHttpsUrl(value);
  if (!currentUser?.id) return "";
  const { data, error } = await supabaseClient.storage
    .from("shelves")
    .createSignedUrl(value, 3600);
  if (error) return "";
  return data?.signedUrl || "";
}

async function resolveCoverImageSource(url) {
  if (!url || !offlineStore) return url;
  const cacheKey = mediaCacheKeyForCover(url);
  if (!cacheKey) return url;
  if (isOfflineActive()) {
    return (await offlineStore.getCachedMediaBlobUrl(cacheKey)) || url;
  }
  return (await offlineStore.getOrCacheMediaBlobUrl(cacheKey, url)) || url;
}

async function persistOfflineSnapshot() {
  if (!offlineStore || !currentUser?.id) return;
  try {
    await offlineStore.saveSnapshot({
      userId: currentUser.id,
      email: currentUser.email || "",
      books: myLibrary,
      shelves: lastShelvesSnapshot,
    });
    await offlineStore.setLastUser({
      userId: currentUser.id,
      email: currentUser.email || "",
    });
  } catch (error) {
    console.warn("Failed to persist offline snapshot:", error?.message || error);
  }
}

function listCoverPrefetchEntries() {
  const covers = myLibrary
    .map((book) => String(book?.cover || "").trim())
    .filter(Boolean);
  const unique = Array.from(new Set(covers));
  const max = isPremiumPlan() ? unique.length : Math.min(unique.length, 20);
  return unique.slice(0, max).map((value) => ({
    cacheKey: mediaCacheKeyForCover(value),
    sourceUrl: value,
  }));
}

function toHttpsUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return "";
  return rawUrl.trim().replace(/^http:\/\//i, "https://");
}

function coverUrlFromVolume(volumeInfo) {
  return toHttpsUrl(
    volumeInfo?.imageLinks?.thumbnail ||
      volumeInfo?.imageLinks?.smallThumbnail ||
      "",
  );
}

function createBookCoverImage(src, { hideOnError = false } = {}) {
  const img = document.createElement("img");
  img.className = "book-result-thumb";
  img.alt = "";
  img.referrerPolicy = "no-referrer";
  const httpsSrc = toHttpsUrl(src);
  img.src = BOOK_COVER_PLACEHOLDER;
  if (httpsSrc) {
    resolveCoverSourceUrl(httpsSrc)
      .then((resolvedRaw) => resolveCoverImageSource(resolvedRaw || httpsSrc))
      .then((resolved) => {
        img.src = resolved || httpsSrc;
      })
      .catch(() => {
        img.src = httpsSrc;
      });
  }
  img.addEventListener("error", () => {
    if (hideOnError) {
      img.remove();
      return;
    }
    if (img.dataset.fallbackApplied === "1") return;
    img.dataset.fallbackApplied = "1";
    img.src = BOOK_COVER_PLACEHOLDER;
  });
  return img;
}

function bookCoverSrc(book) {
  return String(book?.cover || "").trim();
}

function shelfDisplayWidth(shelf) {
  const width = Number(shelf?.map_width);
  if (Number.isFinite(width) && width > 0) return Math.round(width);
  const scale = Number(shelf?.map_scale);
  if (Number.isFinite(scale) && scale > 0) {
    return Math.round(DEFAULT_SHELF_CARD_WIDTH * scale);
  }
  return DEFAULT_SHELF_CARD_WIDTH;
}

function shelfMapSizePayload(widthPx) {
  const map_width = Math.max(MIN_SHELF_CARD_WIDTH, Math.round(widthPx));
  return {
    map_width,
    map_scale: map_width / DEFAULT_SHELF_CARD_WIDTH,
  };
}

function storagePathFromShelfImage(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    const segments = url.pathname.split("/").filter(Boolean);
    const marker = segments.findIndex((part) =>
      ["public", "authenticated", "sign"].includes(part),
    );
    const bucketIndex = marker >= 0 ? marker + 1 : segments.indexOf("shelves");
    if (bucketIndex < 0 || segments[bucketIndex] !== "shelves") return "";
    return decodeURIComponent(segments.slice(bucketIndex + 1).join("/"));
  } catch {
    return "";
  }
}

async function createShelfSignedUrl(path, expiresIn = 3600) {
  if (!path) return "";
  const { data, error } = await supabaseClient.storage
    .from("shelves")
    .createSignedUrl(path, expiresIn);
  if (error) {
    console.warn("Failed to sign shelf image:", error.message);
    return "";
  }
  return data?.signedUrl || "";
}

async function renderScanPastShelves(shelves = [], signedUrlByPath = new Map()) {
  const list = document.getElementById("scanPastShelves");
  if (!list) return;
  list.innerHTML = "";

  if (!Array.isArray(shelves) || shelves.length === 0) {
    const empty = document.createElement("li");
    empty.className = "scan-past-item scan-past-empty";
    empty.innerHTML = "<span><small>No saved shelves yet.</small></span>";
    list.appendChild(empty);
    return;
  }

  const entries = shelves.slice(0, 8);
  for (const shelf of entries) {
    const item = document.createElement("li");
    item.className = "scan-past-item";

    const img = document.createElement("img");
    const pathValue = storagePathFromShelfImage(shelf?.image_url);
    const cacheKey = mediaCacheKeyForShelfPath(pathValue);
    let imageSrc = signedUrlByPath.get(pathValue) || "";
    if (!imageSrc && /^https?:\/\//i.test(String(shelf?.image_url || ""))) {
      imageSrc = shelf.image_url;
    }
    if (!imageSrc && offlineStore && cacheKey) {
      imageSrc = (await offlineStore.getCachedMediaBlobUrl(cacheKey)) || "";
    }
    img.src =
      imageSrc ||
      "data:image/svg+xml," +
        encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" width="44" height="28"><rect width="100%" height="100%" fill="#efe4d2"/><text x="50%" y="55%" text-anchor="middle" font-size="8" fill="#8f7f67">Shelf</text></svg>',
        );
    img.alt = `${shelf?.name || "Shelf"} thumbnail`;

    const text = document.createElement("span");
    const title = document.createElement("strong");
    title.textContent = shelf?.name || "Untitled shelf";
    const count = Array.isArray(shelf?.user_books)
      ? shelf.user_books.length
      : Array.isArray(shelf?.detected_spines)
        ? shelf.detected_spines.length
        : 0;
    const meta = document.createElement("small");
    meta.textContent = `${count} book${count === 1 ? "" : "s"}`;

    text.appendChild(title);
    text.appendChild(meta);
    item.appendChild(img);
    item.appendChild(text);
    list.appendChild(item);
  }
}

function spinesForStorage(spines) {
  return (spines || []).map((spine) => ({
    title: spine.title || "",
    box: spine.box || spine.boundingBox || null,
    polygon: spine.polygon || null,
    confirmed: Boolean(spine.confirmed),
    confirmedTitle: spine.confirmedTitle || null,
    author: spine.author || null,
    thumbnail: toHttpsUrl(spine.thumbnail) || null,
    volumeId: spine.volumeId || null,
    isbn: spine.isbn || null,
  }));
}

function rememberDismissedTitle(title) {
  const value = String(title || "").trim();
  if (!value) return;
  const seen = currentDismissedTitles.map((t) => t.toLowerCase());
  if (!seen.includes(value.toLowerCase())) currentDismissedTitles.push(value);
}

function applyDismissedTitles(spines, dismissed) {
  const skip = new Set(
    (dismissed || []).map((title) => String(title).trim().toLowerCase()).filter(Boolean),
  );
  if (skip.size === 0) return spines || [];
  return (spines || []).filter(
    (spine) => !skip.has(String(spine.title || "").trim().toLowerCase()),
  );
}

function parseBookSearchItems(data) {
  if (!Array.isArray(data?.items) || data.items.length === 0) return [];
  return data.items.slice(0, SEARCH_RESULT_LIMIT).map((item) => {
    const vol = item.volumeInfo || {};
    const ids = vol.industryIdentifiers || [];
    const isbn =
      ids.find((x) => x.type === "ISBN_13")?.identifier ||
      ids.find((x) => x.type === "ISBN_10")?.identifier ||
      null;
    return {
      title: vol.title || "Unknown Title",
      authors: vol.authors ? vol.authors.join(", ") : "Unknown Author",
      thumbnail: coverUrlFromVolume(vol),
      year: vol.publishedDate ? String(vol.publishedDate).slice(0, 4) : null,
      isbn,
      volumeId: item.id || null,
      matchScore: Number.isFinite(item.matchScore) ? item.matchScore : null,
    };
  });
}

function renderBookSearchCards(container, books, { confirmLabel, onConfirm }) {
  container.innerHTML = "";
  if (!books.length) {
    container.innerHTML =
      "<span class='search-status-error'>No results found.</span>";
    return;
  }

  books.forEach((book) => {
    const card = document.createElement("div");
    card.className = "book-result-card";

    const infoCol = document.createElement("div");
    infoCol.className = "book-result-info";

    const titleEl = document.createElement("strong");
    titleEl.className = "book-result-title";
    titleEl.textContent = book.title;

    const authorEl = document.createElement("span");
    authorEl.className = "book-result-author";
    authorEl.textContent = `By ${book.authors}`;

    infoCol.appendChild(titleEl);
    infoCol.appendChild(authorEl);

    const metaParts = [];
    if (book.year) metaParts.push(book.year);
    if (book.isbn) metaParts.push(`ISBN ${book.isbn}`);
    if (metaParts.length) {
      const metaEl = document.createElement("span");
      metaEl.className = "book-result-meta";
      metaEl.textContent = metaParts.join(" · ");
      infoCol.appendChild(metaEl);
    }

    const confirmBtn = document.createElement("button");
    confirmBtn.textContent = confirmLabel;
    confirmBtn.className = "book-confirm-btn";
    confirmBtn.type = "button";
    confirmBtn.setAttribute("aria-label", `${confirmLabel} ${book.title}`);
    confirmBtn.addEventListener("click", () => onConfirm(book));

    infoCol.appendChild(confirmBtn);

    card.appendChild(createBookCoverImage(book.thumbnail));
    card.appendChild(infoCol);
    container.appendChild(card);
  });
}

function isSearchableSpineTitle(title) {
  const cleaned = String(title || "").trim().toLowerCase();
  return Boolean(cleaned) && cleaned !== "unlabeled spine";
}

function applyCatalogMatchToSpine(spine, book, titleInput, cardEl, resultsEl) {
  confirmSpineWithBook(spine, book);
  if (titleInput) titleInput.value = book.title;
  cardEl?.classList.add("is-confirmed");
  if (resultsEl) {
    resultsEl.innerHTML = "";
    const selectedRow = document.createElement("div");
    selectedRow.className = "spine-confirmed-row";
    if (spine.thumbnail) {
      selectedRow.appendChild(createBookCoverImage(spine.thumbnail));
    }
    const info = document.createElement("div");
    info.className = "book-result-info";
    const selectedTitle = document.createElement("strong");
    selectedTitle.className = "book-result-title";
    selectedTitle.textContent = spine.title || "Untitled Book";
    info.appendChild(selectedTitle);
    if (spine.author) {
      const selectedAuthor = document.createElement("span");
      selectedAuthor.className = "book-result-author";
      selectedAuthor.textContent = `By ${spine.author}`;
      info.appendChild(selectedAuthor);
    }
    const badge = document.createElement("span");
    badge.className = "spine-confirmed-badge";
    badge.textContent = "Confirmed";
    info.appendChild(badge);
    selectedRow.appendChild(info);
    resultsEl.appendChild(selectedRow);
  }
  showToast(`"${book.title}" confirmed.`, "success");
}

async function searchBooksByQuery(query, author = "") {
  const title = String(query || "").trim();
  const authorText = String(author || "").trim();
  if (!isSearchableSpineTitle(title) && !authorText) {
    return [];
  }
  const params = new URLSearchParams();
  if (title) params.set("q", title);
  if (authorText) params.set("author", authorText);
  const res = await authenticatedFetch(`/api/books?${params.toString()}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || `Search failed (${res.status})`);
    error.code = data.code || null;
    error.plan = data.plan || null;
    throw error;
  }
  return parseBookSearchItems(data);
}

async function mapPool(items, concurrency, workerFn) {
  const list = Array.from(items || []);
  if (!list.length) return [];
  const results = new Array(list.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, list.length) },
    async () => {
      while (cursor < list.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await workerFn(list[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function confirmSpineWithBook(spine, book) {
  spine.title = book.title;
  spine.confirmed = true;
  spine.confirmedTitle = book.title;
  spine.author = book.authors;
  spine.thumbnail = book.thumbnail;
  spine.volumeId = book.volumeId || null;
  spine.isbn = book.isbn || null;
  delete spine.bestMatch;
  delete spine.suggestedMatches;
}

async function autoMatchDetectedSpines({
  onlyUnconfirmed = true,
  notifyLimit = true,
} = {}) {
  if (!requireOnline("Book search", false)) return { matched: 0, limited: false };

  let targets = currentDetectedSpines.filter((spine) => {
    if (!isSearchableSpineTitle(spine.title)) return false;
    if (onlyUnconfirmed && spine.confirmed) return false;
    return true;
  });

  const totalSearchable = targets.length;
  if (!isPremiumPlan() && targets.length > FREE_SEARCH_ALL_LIMIT) {
    targets = targets.slice(0, FREE_SEARCH_ALL_LIMIT);
  }
  if (!targets.length) return { matched: 0, limited: false };

  let hitLimit = false;
  let matched = 0;

  await mapPool(targets, SEARCH_CONCURRENCY, async (spine) => {
    if (hitLimit) return;
    try {
      const books = await searchBooksByQuery(spine.title, spine.author || "");
      const best = books[0];
      if (!best) return;
      const score = Number.isFinite(best.matchScore) ? best.matchScore : 0;
      if (score >= AUTO_CONFIRM_SCORE) {
        confirmSpineWithBook(spine, best);
        matched += 1;
      } else if (score >= SUGGEST_SCORE) {
        spine.bestMatch = best;
        spine.suggestedMatches = books;
      }
    } catch (err) {
      if (err?.code === "PLAN_LIMIT") hitLimit = true;
    }
  });

  renderDetectedSpines();

  if (
    notifyLimit &&
    !isPremiumPlan() &&
    totalSearchable > FREE_SEARCH_ALL_LIMIT
  ) {
    showUpgradeModal({
      reason: `Free plan can match ${FREE_SEARCH_ALL_LIMIT} spines at once. Upgrade for full Match remaining.`,
      featureCode: "search_all_batch",
    });
  } else if (notifyLimit && hitLimit) {
    showUpgradeModal({
      reason: "Book search limit reached. Upgrade for higher limits.",
      featureCode: "books_rate_limit",
    });
  }

  return { matched, limited: hitLimit };
}

function isPremiumPlan() {
  return billingState.plan === "premium";
}

function trialDaysLeft() {
  if (!billingState.trialEndsAt) return null;
  const ends = new Date(billingState.trialEndsAt).getTime();
  if (!Number.isFinite(ends)) return null;
  const remaining = ends - Date.now();
  if (remaining <= 0) return 0;
  return Math.ceil(remaining / (24 * 60 * 60 * 1000));
}

function buildUsageText(action) {
  const quotaCap = billingState.quotas?.[action];
  const snap = usageState[action];
  if (!snap || !Number.isFinite(snap.limit) || !Number.isFinite(snap.remaining)) {
    return `--/${quotaCap || "--"}`;
  }
  const used = Math.max(0, snap.limit - snap.remaining);
  return `${used}/${snap.limit}`;
}

function renderBillingNav() {
  const badge = document.getElementById("planBadge");
  const usageMeter = document.getElementById("usageMeter");
  const usageRing = document.getElementById("usageRingProgress");
  const usageRingValue = document.getElementById("usageRingValue");
  const accountInitial = document.getElementById("accountInitial");
  const accountScansRemaining = document.getElementById("accountScansRemaining");
  const accountUpgradeLink = document.getElementById("accountUpgradeLink");
  const upgradeBtn = document.getElementById("upgradeBtn");
  const manageBtn = document.getElementById("manageBillingBtn");
  if (!badge || !usageMeter || !upgradeBtn || !manageBtn) return;

  const isTrial = billingState.status === "trialing";
  const daysLeft = trialDaysLeft();
  badge.textContent = isTrial
    ? daysLeft === null
      ? "Trial"
      : `Trial · ${daysLeft}d`
    : isPremiumPlan()
      ? "Premium"
      : "Free";
  const ocrUsage = usageState.ocr;
  const ocrLimit = Number.isFinite(ocrUsage?.limit) ? ocrUsage.limit : billingState.quotas?.ocr || 0;
  const ocrRemaining = Number.isFinite(ocrUsage?.remaining) ? ocrUsage.remaining : ocrLimit;
  const ocrUsed = Math.max(0, ocrLimit - ocrRemaining);
  usageMeter.textContent = `${ocrUsed}/${ocrLimit} scans`;
  if (accountScansRemaining) {
    accountScansRemaining.textContent = `Scans remaining: ${Math.max(0, ocrRemaining)}`;
  }
  if (usageRing) {
    const ratio = ocrLimit > 0 ? Math.min(1, ocrUsed / ocrLimit) : 0;
    const circumference = 62.8;
    usageRing.style.strokeDashoffset = String(circumference - ratio * circumference);
  }
  if (usageRingValue) usageRingValue.textContent = String(ocrUsed);
  if (accountInitial) {
    const initial = (currentUser?.email || "A").trim().charAt(0).toUpperCase();
    accountInitial.textContent = initial || "A";
  }

  const free = !isPremiumPlan();
  upgradeBtn.classList.toggle("hidden-element", !free);
  accountUpgradeLink?.classList.toggle("hidden-element", !free);
  manageBtn.classList.toggle("hidden-element", free);
  markCurrentPlanInUpgradeModal();
  renderRenewalBanner();

  const roomBtn = document.getElementById("newRoomBtn");
  const shareBtn = document.getElementById("shareLibraryBtn");
  if (roomBtn) {
    roomBtn.classList.toggle("is-premium-locked", free);
    const roomLabel = free ? "New room — Premium" : "New room";
    roomBtn.setAttribute("aria-label", roomLabel);
    roomBtn.setAttribute("title", roomLabel);
  }
  if (shareBtn) {
    shareBtn.classList.toggle("is-premium-locked", free);
    const shareLabel = free ? "Share library — Premium" : "Share library";
    shareBtn.setAttribute("aria-label", shareLabel);
    shareBtn.setAttribute("title", shareLabel);
  }
}

function formatRenewalAmount(notice) {
  const cents = Number(notice?.amountDueCents);
  if (!Number.isFinite(cents)) return null;
  const currency = String(notice?.currency || "USD").toUpperCase();
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).format(cents / 100);
  } catch {
    return `$${(cents / 100).toFixed(2)}`;
  }
}

function formatRenewalDate(notice) {
  if (!notice?.renewAt) return null;
  const date = new Date(notice.renewAt);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function renewalBannerDismissKey(notice) {
  return `shelfmapper_renewal_dismiss_${notice?.invoiceId || notice?.renewAt || "none"}`;
}

function renderRenewalBanner() {
  const banner = document.getElementById("renewalBanner");
  const textEl = document.getElementById("renewalBannerText");
  if (!banner || !textEl) return;

  const notice = billingState.renewalNotice;
  const hasNotice =
    isPremiumPlan() &&
    notice &&
    (notice.renewAt || Number.isFinite(Number(notice.amountDueCents)));

  if (!hasNotice) {
    banner.classList.add("hidden-element");
    return;
  }

  try {
    if (window.sessionStorage?.getItem(renewalBannerDismissKey(notice)) === "1") {
      banner.classList.add("hidden-element");
      return;
    }
  } catch {
    // ignore
  }

  const amount = formatRenewalAmount(notice);
  const when = formatRenewalDate(notice);
  if (amount && when) {
    textEl.textContent = `Your Premium plan renews on ${when} for ${amount}.`;
  } else if (when) {
    textEl.textContent = `Your Premium plan renews on ${when}.`;
  } else if (amount) {
    textEl.textContent = `Your Premium plan renews soon for ${amount}.`;
  } else {
    textEl.textContent = "Your Premium plan renews soon.";
  }
  banner.classList.remove("hidden-element");
}

function setupAccountMenu() {
  const menuBtn = document.getElementById("accountMenuBtn");
  const menu = document.getElementById("accountMenu");
  if (!menuBtn || !menu) return;

  const closeMenu = () => {
    menu.classList.add("hidden-element");
    menuBtn.setAttribute("aria-expanded", "false");
  };

  const openMenu = () => {
    menu.classList.remove("hidden-element");
    menuBtn.setAttribute("aria-expanded", "true");
  };

  menuBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    if (menu.classList.contains("hidden-element")) openMenu();
    else closeMenu();
  });

  menu.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  window.addEventListener("click", closeMenu);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenu();
  });
}

function requirePremiumFeature(featureLabel, featureCode) {
  if (isPremiumPlan()) return true;
  showUpgradeModal({
    reason:
      featureLabel ||
      "This feature requires Premium. Start your 7-day free trial.",
    featureCode,
  });
  return false;
}

async function refreshBillingState() {
  if (!currentUser?.id || isOfflineActive()) {
    billingState = {
      plan: "free",
      status: null,
      interval: null,
      trialEndsAt: null,
      renewalNotice: null,
      quotas: { ocr: 10, books: 60 },
    };
    renderBillingNav();
    return;
  }
  try {
    const status = await fetchBillingStatus();
    billingState = {
      plan: status.plan || "free",
      status: status.status || null,
      interval: status.interval || null,
      trialEndsAt: status.trialEndsAt || null,
      renewalNotice: status.renewalNotice || null,
      quotas: status.quotas || (status.plan === "premium" ? { ocr: 60, books: 300 } : { ocr: 10, books: 60 }),
    };
  } catch {
    billingState.plan = "free";
    billingState.renewalNotice = null;
  }
  renderBillingNav();
}

function downloadTextFile(filename, text, mimeType) {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportLibraryAsJson() {
  const payload = myLibrary.map((book) => ({
    title: book.title || "",
    author: book.author || "",
    shelf_id: book.shelf_id ?? null,
    cover: book.cover || "",
    created_at: book.created_at || null,
  }));
  downloadTextFile("shelfmapper-export.json", JSON.stringify(payload, null, 2), "application/json");
}

function exportLibraryAsCsv() {
  const header = ["title", "author", "shelf_id", "cover", "created_at"];
  const rows = myLibrary.map((book) =>
    [
      book.title || "",
      book.author || "",
      book.shelf_id ?? "",
      book.cover || "",
      book.created_at || "",
    ]
      .map((value) => `"${String(value).replace(/"/g, '""')}"`)
      .join(","),
  );
  const csv = [header.join(","), ...rows].join("\n");
  downloadTextFile("shelfmapper-export.csv", csv, "text/csv");
}

async function maybeRenderPublicShare() {
  const match = window.location.pathname.match(/^\/share\/([^/]+)$/);
  if (!match) return false;
  const token = match[1];
  const loggedOutView = document.getElementById("loggedOutView");
  const loggedInView = document.getElementById("loggedInView");
  if (loggedOutView) loggedOutView.classList.add("hidden-element");
  if (loggedInView) loggedInView.classList.remove("hidden-element");
  document.querySelector(".app-nav")?.remove();

  const mapContainer = document.getElementById("libraryView");
  const uploadView = document.getElementById("uploadView");
  if (uploadView) uploadView.remove();
  mapContainer?.classList.remove("hidden-view");
  mapContainer?.classList.add("active-view");

  try {
    const response = await fetch(`/api/share/${encodeURIComponent(token)}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Invalid share link");
    const viewport = document.getElementById("mapViewport");
    const list = document.getElementById("libraryList");
    if (viewport) viewport.innerHTML = "";
    if (list) list.innerHTML = "";
    const booksByShelf = new Map();
    (data.books || []).forEach((book) => {
      const key = String(book.shelf_id || "");
      if (!booksByShelf.has(key)) booksByShelf.set(key, []);
      booksByShelf.get(key).push(book);
      if (list) {
        const li = document.createElement("li");
        li.className = "library-row";
        li.textContent = `${book.title || "Untitled"}${book.author ? ` — ${book.author}` : ""}`;
        list.appendChild(li);
      }
    });
    (data.shelves || []).forEach((shelf, index) => {
      if (!viewport) return;
      const card = document.createElement("div");
      card.className = "shelf-card";
      card.style.left = `${shelf.map_x ?? index * 340 + 50}px`;
      card.style.top = `${shelf.map_y ?? 50}px`;
      card.style.width = `${shelfDisplayWidth(shelf)}px`;
      card.innerHTML = `
        <div class="shelf-card-header">
          <span class="shelf-card-name">${shelf.name || "Untitled Shelf"}</span>
        </div>
        <div class="shelf-img-wrap">
          <div class="empty-state">Read-only shared shelf (${(booksByShelf.get(String(shelf.id)) || []).length} books)</div>
        </div>
      `;
      viewport.appendChild(card);
    });
    updateMapEmptyState((data.shelves || []).length);
    requestAnimationFrame(() => fitMapToShelves({ persist: false }));
  } catch (error) {
    showToast(error.message || "Could not load shared library.", "error");
  }
  return true;
}

// ==========================================
// 1b. TOASTS + ACCESSIBLE DIALOGS (Step 7)
// Branded non-blocking feedback replaces alert();
// confirmDialog()/promptDialog() replace confirm()/prompt().
// ==========================================
function showToast(message, type = "info", durationMs = 4200) {
  const container = document.getElementById("toastContainer");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.setAttribute("role", type === "error" ? "alert" : "status");

  const text = document.createElement("span");
  text.className = "toast-message";
  text.textContent = message;

  const close = document.createElement("button");
  close.className = "toast-close";
  close.type = "button";
  close.setAttribute("aria-label", "Dismiss notification");
  close.textContent = "✕";
  close.addEventListener("click", () => toast.remove());

  toast.appendChild(text);
  toast.appendChild(close);
  container.appendChild(toast);

  while (container.children.length > 3) container.firstChild.remove();
  if (durationMs > 0) setTimeout(() => toast.remove(), durationMs);
}

let lastFocusedBeforeModal = null;

function getFocusableIn(container) {
  return Array.from(
    container.querySelectorAll(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => el.offsetParent !== null || el === document.activeElement);
}

function trapFocusInModal(modal, e) {
  if (e.key !== "Tab") return;
  const items = getFocusableIn(modal);
  if (items.length === 0) {
    e.preventDefault();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function openModalWithFocus(modal, focusTarget) {
  lastFocusedBeforeModal = document.activeElement;
  modal.classList.remove("hidden-view");
  const target = focusTarget || getFocusableIn(modal)[0];
  if (target) setTimeout(() => target.focus(), 0);
}

function closeModalAndRestore(modal) {
  modal.classList.add("hidden-view");
  if (lastFocusedBeforeModal && document.contains(lastFocusedBeforeModal)) {
    lastFocusedBeforeModal.focus();
  }
  lastFocusedBeforeModal = null;
}

let pendingUpgradeFeature = null;

function markCurrentPlanInUpgradeModal() {
  const freeLabel = document.getElementById("freePlanCurrentLabel");
  const premiumLabel = document.getElementById("premiumPlanCurrentLabel");
  if (!freeLabel || !premiumLabel) return;
  const premium = isPremiumPlan();
  freeLabel.classList.toggle("hidden-element", premium);
  premiumLabel.classList.toggle("hidden-element", !premium);
}

function showUpgradeModal({ reason = "", featureCode = "" } = {}) {
  const modal = document.getElementById("upgradeModal");
  if (!modal) return;
  const msg = modal.querySelector(".modal-message");
  if (msg) {
    msg.textContent =
      reason || "Start your 7-day free trial to unlock Premium features.";
  }
  markCurrentPlanInUpgradeModal();
  pendingUpgradeFeature = featureCode || null;
  openModalWithFocus(modal, document.getElementById("upgradeMonthlyBtn"));
}

function closeUpgradeModal() {
  const modal = document.getElementById("upgradeModal");
  if (!modal) return;
  pendingUpgradeFeature = null;
  closeModalAndRestore(modal);
}

async function startCheckout(interval) {
  if (!requireOnline("Checkout")) return;
  try {
    const { url } = await createBillingCheckout(interval);
    if (url) window.location.assign(url);
  } catch (error) {
    showToast(error?.message || "Unable to start checkout.", "error");
  }
}

async function openBillingPortal() {
  if (!requireOnline("Billing portal")) return;
  try {
    const { url } = await createBillingPortal();
    if (url) window.location.assign(url);
  } catch (error) {
    showToast(error?.message || "Unable to open billing portal.", "error");
  }
}

function setupBillingUi() {
  const upgradeBtn = document.getElementById("upgradeBtn");
  const upgradeLink = document.getElementById("accountUpgradeLink");
  const manageBtn = document.getElementById("manageBillingBtn");
  const modal = document.getElementById("upgradeModal");
  const monthlyBtn = document.getElementById("upgradeMonthlyBtn");
  const annualBtn = document.getElementById("upgradeAnnualBtn");
  const cancelBtn = document.getElementById("upgradeCancelBtn");

  upgradeBtn?.addEventListener("click", () => showUpgradeModal());
  upgradeLink?.addEventListener("click", () => showUpgradeModal());
  manageBtn?.addEventListener("click", () => openBillingPortal());
  monthlyBtn?.addEventListener("click", () => startCheckout("month"));
  annualBtn?.addEventListener("click", () => startCheckout("year"));
  cancelBtn?.addEventListener("click", closeUpgradeModal);
  modal?.addEventListener("click", (e) => {
    if (e.target === modal) closeUpgradeModal();
  });
  modal?.addEventListener("keydown", (e) => {
    trapFocusInModal(modal, e);
    if (e.key === "Escape") {
      e.stopPropagation();
      closeUpgradeModal();
    }
  });

  document.getElementById("renewalBannerManageBtn")?.addEventListener("click", () => {
    openBillingPortal();
  });
  document.getElementById("renewalBannerDismissBtn")?.addEventListener("click", () => {
    const notice = billingState.renewalNotice;
    try {
      if (notice) window.sessionStorage?.setItem(renewalBannerDismissKey(notice), "1");
    } catch {
      // ignore
    }
    document.getElementById("renewalBanner")?.classList.add("hidden-element");
  });
}
setupBillingUi();
setupAccountMenu();
setupLegalAcceptanceUi();

const Legal = window.ShelfMapperLegal || null;
let legalAcceptResolver = null;
let legalAcceptModalOpen = false;

function userNeedsLegalAcceptance(user) {
  if (!Legal || !user) return false;
  return !Legal.userHasCurrentLegalAcceptance(user);
}

async function persistLegalAcceptance(metadata) {
  const payload = metadata || Legal?.buildLegalAcceptanceMetadata();
  if (!payload) throw new Error("Legal versions unavailable");
  const { data, error } = await supabaseClient.auth.updateUser({ data: payload });
  if (error) throw error;
  if (data?.user) currentUser = data.user;
  return data?.user || currentUser;
}

async function applyPendingOAuthLegalAcceptance(user) {
  if (!Legal || !user || Legal.userHasCurrentLegalAcceptance(user)) return user;
  const pending = Legal.consumePendingLegalAcceptance();
  if (!pending) return user;
  try {
    return (await persistLegalAcceptance(pending)) || user;
  } catch (error) {
    console.warn("Failed to apply pending legal acceptance:", error?.message || error);
    return user;
  }
}

function closeLegalAcceptModal() {
  const modal = document.getElementById("legalAcceptModal");
  if (!modal) return;
  legalAcceptModalOpen = false;
  modal.classList.add("hidden-view");
  const checkbox = document.getElementById("legalAcceptCheckbox");
  if (checkbox) checkbox.checked = false;
}

function showLegalAcceptModal({ isUpdate = false } = {}) {
  const modal = document.getElementById("legalAcceptModal");
  if (!modal || !Legal) return;
  const title = document.getElementById("legalAcceptTitle");
  const message = document.getElementById("legalAcceptMessage");
  const termsVer = document.getElementById("legalAcceptTermsVersion");
  const privacyVer = document.getElementById("legalAcceptPrivacyVersion");
  if (title) {
    title.textContent = isUpdate ? "Updated terms" : "Agree to continue";
  }
  if (message) {
    message.textContent = isUpdate
      ? "We've updated our Terms of Service and/or Privacy Policy. Please review and accept to keep using ShelfMapper."
      : "Please review and accept the Terms of Service and Privacy Policy to continue using ShelfMapper.";
  }
  if (termsVer) termsVer.textContent = `Version ${Legal.CURRENT_TERMS_VERSION}`;
  if (privacyVer) privacyVer.textContent = `Version ${Legal.CURRENT_PRIVACY_VERSION}`;
  legalAcceptModalOpen = true;
  openModalWithFocus(modal, document.getElementById("legalAcceptCheckbox"));
}

function promptLegalAcceptance({ isUpdate = false } = {}) {
  return new Promise((resolve) => {
    legalAcceptResolver = resolve;
    showLegalAcceptModal({ isUpdate });
  });
}

async function ensureLegalAcceptance(user) {
  if (!user || isOfflineActive() || !Legal) return user;
  let nextUser = await applyPendingOAuthLegalAcceptance(user);
  if (!userNeedsLegalAcceptance(nextUser)) return nextUser;

  const prior = Legal.getLegalAcceptanceFromUser(nextUser);
  const isUpdate = Boolean(prior.termsVersion || prior.privacyVersion);
  const accepted = await promptLegalAcceptance({ isUpdate });
  if (!accepted) return null;
  return currentUser || nextUser;
}

function setupLegalAcceptanceUi() {
  const modal = document.getElementById("legalAcceptModal");
  const confirmBtn = document.getElementById("legalAcceptConfirmBtn");
  const declineBtn = document.getElementById("legalAcceptDeclineBtn");
  const checkbox = document.getElementById("legalAcceptCheckbox");
  if (!modal) return;

  confirmBtn?.addEventListener("click", async () => {
    if (!checkbox?.checked) {
      showToast("Please check the box to accept the Terms and Privacy Policy.", "error");
      checkbox?.focus();
      return;
    }
    confirmBtn.disabled = true;
    declineBtn && (declineBtn.disabled = true);
    try {
      await persistLegalAcceptance();
      closeLegalAcceptModal();
      const resolve = legalAcceptResolver;
      legalAcceptResolver = null;
      resolve?.(true);
    } catch (error) {
      showToast(error?.message || "Unable to save acceptance. Try again.", "error");
    } finally {
      confirmBtn.disabled = false;
      if (declineBtn) declineBtn.disabled = false;
    }
  });

  declineBtn?.addEventListener("click", async () => {
    closeLegalAcceptModal();
    const resolve = legalAcceptResolver;
    legalAcceptResolver = null;
    resolve?.(false);
    try {
      await supabaseClient.auth.signOut();
    } catch {
      // ignore
    }
  });

  modal.addEventListener("keydown", (e) => {
    trapFocusInModal(modal, e);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
    }
  });
}

function confirmDialog({ title = "Please confirm", message = "Are you sure?", confirmLabel = "Delete", cancelLabel = "Cancel" } = {}) {
  const modal = document.getElementById("confirmModal");
  const titleEl = document.getElementById("confirmModalTitle");
  const msgEl = document.getElementById("confirmModalMessage");
  const okBtn = document.getElementById("confirmModalOk");
  const cancelBtn = document.getElementById("confirmModalCancel");
  return new Promise((resolve) => {
    if (!modal || !okBtn || !cancelBtn) {
      resolve(window.confirm(message));
      return;
    }
    titleEl.textContent = title;
    msgEl.textContent = message;
    okBtn.textContent = confirmLabel;
    cancelBtn.textContent = cancelLabel;

    const onKey = (e) => {
      trapFocusInModal(modal, e);
      if (e.key === "Escape") {
        e.stopPropagation();
        cleanup(false);
      }
    };
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    const onOverlay = (e) => {
      if (e.target === modal) cleanup(false);
    };
    function cleanup(result) {
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      modal.removeEventListener("keydown", onKey);
      modal.removeEventListener("click", onOverlay);
      closeModalAndRestore(modal);
      resolve(result);
    }
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    modal.addEventListener("keydown", onKey);
    modal.addEventListener("click", onOverlay);
    openModalWithFocus(modal, cancelBtn);
  });
}

function promptDialog({
  title = "Rename",
  hint = "",
  initialValue = "",
  confirmLabel = "Save",
  cancelLabel = "Cancel",
  label = "Name",
  allowEmpty = false,
} = {}) {
  const modal = document.getElementById("promptModal");
  const titleEl = document.getElementById("promptModalTitle");
  const hintEl = document.getElementById("promptModalHint");
  const labelEl = modal?.querySelector(".modal-input-label");
  const input = document.getElementById("promptModalInput");
  const okBtn = document.getElementById("promptModalOk");
  const cancelBtn = document.getElementById("promptModalCancel");
  return new Promise((resolve) => {
    if (!modal || !input || !okBtn || !cancelBtn) {
      resolve(window.prompt(hint || title, initialValue));
      return;
    }
    titleEl.textContent = title;
    hintEl.textContent = hint;
    hintEl.style.display = hint ? "" : "none";
    if (labelEl) labelEl.textContent = label;
    input.value = initialValue ?? "";

    const onKey = (e) => {
      trapFocusInModal(modal, e);
      if (e.key === "Escape") {
        e.stopPropagation();
        cleanup(null);
      } else if (e.key === "Enter" && document.activeElement === input) {
        e.preventDefault();
        cleanup(input.value);
      }
    };
    const onOk = () => cleanup(input.value);
    const onCancel = () => cleanup(null);
    const onOverlay = (e) => {
      if (e.target === modal) cleanup(null);
    };
    function cleanup(result) {
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      modal.removeEventListener("keydown", onKey);
      modal.removeEventListener("click", onOverlay);
      closeModalAndRestore(modal);
      resolve(normalizePromptResult(result, { allowEmpty }));
    }
    okBtn.textContent = confirmLabel;
    cancelBtn.textContent = cancelLabel;
    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    modal.addEventListener("keydown", onKey);
    modal.addEventListener("click", onOverlay);
    openModalWithFocus(modal, input);
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
  });
}

// ==========================================
// 2. PROGRESSIVE BACKGROUND LOADING
// ==========================================
function loadHighResBackground() {
  const bgElement = document.querySelector(".auth-background");
  if (!bgElement) return;

  const previewUrl = "/img/anna-hunko-ajE5goOGzZc-unsplash-preview.jpg";
  const highResUrl = "/img/anna-hunko-ajE5goOGzZc-unsplash.jpg";
  bgElement.style.backgroundImage =
    `linear-gradient(105deg, rgba(44, 31, 14, 0.55) 0%, rgba(44, 31, 14, 0.28) 42%, rgba(44, 31, 14, 0.18) 100%), url('${previewUrl}')`;

  const imgLoader = new Image();
  imgLoader.onload = () => {
    bgElement.style.backgroundImage =
      `linear-gradient(105deg, rgba(44, 31, 14, 0.55) 0%, rgba(44, 31, 14, 0.28) 42%, rgba(44, 31, 14, 0.18) 100%), url('${highResUrl}')`;
  };
  imgLoader.src = highResUrl;
}
loadHighResBackground();

// ==========================================
// 3. AUTHENTICATION LOGIC
// ==========================================
let isSignUpMode = false;

const authForm = document.getElementById("authForm");
const authActionBtn = document.getElementById("authActionBtn");
const authToggleBtn = document.getElementById("authToggleBtn");
const authToggleText = document.getElementById("authToggleText");
const confirmPasswordInput = document.getElementById("confirmPasswordInput");
const emailInput = document.getElementById("emailInput");
const passwordInput = document.getElementById("passwordInput");
const passwordError = document.getElementById("passwordError");
const googleAuthBtn = document.getElementById("googleAuthBtn");
const googleAuthBtnText = document.getElementById("googleAuthBtnText");
const authProviderError = document.getElementById("authProviderError");
const loggedOutViewEl = document.getElementById("loggedOutView");
const guestNavLoginBtn = document.getElementById("guestNavLoginBtn");
const pitchStartBtn = document.getElementById("pitchStartBtn");
const authPanelCloseBtn = document.getElementById("authPanelCloseBtn");
const authTermsRow = document.getElementById("authTermsRow");
const authTermsCheckbox = document.getElementById("authTermsCheckbox");

function setAuthTermsVisible(visible) {
  if (!authTermsRow || !authTermsCheckbox) return;
  authTermsRow.classList.toggle("hidden-element", !visible);
  if (!visible) {
    authTermsCheckbox.checked = false;
    authTermsCheckbox.removeAttribute("required");
  } else {
    authTermsCheckbox.setAttribute("required", "true");
  }
}

function requireAuthTermsAccepted() {
  if (!authTermsCheckbox?.checked) {
    showToast("Please agree to the Terms of Service and Privacy Policy to continue.", "error");
    authTermsCheckbox?.focus();
    return false;
  }
  return true;
}

authTermsRow?.querySelectorAll("a").forEach((link) => {
  link.addEventListener("click", (e) => e.stopPropagation());
});

function isMobileAuthLayout() {
  return window.matchMedia("(max-width: 860px)").matches;
}

function openGuestAuth({ signUp = false } = {}) {
  if (signUp && !isSignUpMode) authToggleBtn?.click();
  if (!signUp && isSignUpMode) authToggleBtn?.click();
  if (!isMobileAuthLayout()) {
    document.getElementById("authPanel")?.scrollIntoView({ behavior: "smooth", block: "center" });
    emailInput?.focus();
    return;
  }
  loggedOutViewEl?.classList.add("auth-open");
  document.body.classList.add("guest-auth-open");
  const panel = document.getElementById("authPanel");
  if (panel) panel.setAttribute("aria-modal", "true");
  window.setTimeout(() => emailInput?.focus(), 50);
}

function closeGuestAuth() {
  loggedOutViewEl?.classList.remove("auth-open");
  document.body.classList.remove("guest-auth-open");
  const panel = document.getElementById("authPanel");
  if (panel) panel.setAttribute("aria-modal", "false");
}

guestNavLoginBtn?.addEventListener("click", () => openGuestAuth({ signUp: false }));
pitchStartBtn?.addEventListener("click", () => openGuestAuth({ signUp: true }));
authPanelCloseBtn?.addEventListener("click", () => closeGuestAuth());
document.getElementById("authBackdrop")?.addEventListener("click", () => closeGuestAuth());
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeGuestAuth();
});
window.addEventListener("resize", () => {
  if (!isMobileAuthLayout()) closeGuestAuth();
});

if (passwordInput) {
  passwordInput.removeAttribute("minlength");
  passwordInput.setAttribute("autocomplete", "current-password");
}

function checkPasswordMatch() {
  if (!isSignUpMode) return;

  if (
    confirmPasswordInput.value.length > 0 &&
    passwordInput.value !== confirmPasswordInput.value
  ) {
    passwordError.classList.remove("hidden-element");
  } else {
    passwordError.classList.add("hidden-element");
  }
}

passwordInput?.addEventListener("input", checkPasswordMatch);
confirmPasswordInput?.addEventListener("input", checkPasswordMatch);

authToggleBtn?.addEventListener("click", () => {
  isSignUpMode = !isSignUpMode;

  passwordError.classList.add("hidden-element");
  confirmPasswordInput.value = "";
  passwordInput.value = "";
  const authPanelTitle = document.getElementById("authPanelTitle");

  if (isSignUpMode) {
    confirmPasswordInput.classList.remove("hidden-element");
    confirmPasswordInput.setAttribute("required", "true");
    passwordInput.setAttribute("minlength", "8");
    passwordInput.setAttribute("autocomplete", "new-password");
    authActionBtn.textContent = "Create Account";
    authToggleText.textContent = "Already have an account?";
    authToggleBtn.textContent = "Log in here";
    if (authPanelTitle) authPanelTitle.textContent = "Create account";
    setAuthTermsVisible(true);
  } else {
    confirmPasswordInput.classList.add("hidden-element");
    confirmPasswordInput.removeAttribute("required");
    passwordInput.removeAttribute("minlength");
    passwordInput.setAttribute("autocomplete", "current-password");
    authActionBtn.textContent = "Log In";
    authToggleText.textContent = "Don't have an account?";
    authToggleBtn.textContent = "Sign up here";
    if (authPanelTitle) authPanelTitle.textContent = "Log in";
    setAuthTermsVisible(false);
  }
});

function getAuthRedirectTo() {
  const pageOrigin = String(window.location.origin || "").replace(/\/$/, "");
  const configured = String(
    window.__SHELFMAPPER_PUBLIC__?.appOrigin || "",
  ).replace(/\/$/, "");

  let origin = pageOrigin;
  if (configured) {
    try {
      const configuredHost = new URL(configured).hostname.toLowerCase();
      const pageHost = String(window.location.hostname || "").toLowerCase();
      const hostsMatch =
        configuredHost === pageHost ||
        configuredHost === `www.${pageHost}` ||
        pageHost === `www.${configuredHost}`;
      // Prefer the server-configured canonical origin when we're already on that host
      // (avoids http/https or www mismatches). Keep page origin for local dev.
      if (hostsMatch) origin = configured;
    } catch {
      // keep pageOrigin
    }
  }

  if (!origin) origin = configured || "http://localhost:3000";
  return `${origin}/`;
}

authForm?.addEventListener("submit", async (e) => {
  e.preventDefault();

  const email = emailInput.value.trim();
  const password = passwordInput.value;

  const originalText = authActionBtn.textContent;
  authActionBtn.textContent = "Processing...";
  authActionBtn.disabled = true;

  try {
    if (isSignUpMode) {
      const confirmPassword = confirmPasswordInput.value;
      if (password.length < 8) {
        showToast("Password must be at least 8 characters.", "error");
        return;
      }
      if (password !== confirmPassword) return;
      if (!requireAuthTermsAccepted()) return;
      const emailRedirectTo = getAuthRedirectTo();
      const legalMeta = Legal?.buildLegalAcceptanceMetadata() || {};

      const { error } = await supabaseClient.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo,
          data: legalMeta,
        },
      });
      if (error) {
        showToast("Sign up error: " + error.message, "error");
      } else {
        showToast("Account created successfully! You can now log in.", "success");
        authToggleBtn.click();
      }
    } else {
      const { error } = await supabaseClient.auth.signInWithPassword({
        email,
        password,
      });
      if (error) {
        showToast("Login error: " + error.message, "error");
      }
    }
  } finally {
    authActionBtn.textContent = originalText;
    authActionBtn.disabled = false;
  }
});

googleAuthBtn?.addEventListener("click", async () => {
  if (isSignUpMode && !requireAuthTermsAccepted()) return;
  if (isSignUpMode) Legal?.storePendingLegalAcceptance();

  const originalText = googleAuthBtnText.textContent;
  googleAuthBtn.disabled = true;
  googleAuthBtnText.textContent = "Connecting...";
  authProviderError.classList.add("hidden-element");
  authProviderError.textContent = "";

  try {
    const redirectTo = getAuthRedirectTo();
    const { error } = await supabaseClient.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo },
    });

    if (error) throw error;
  } catch (error) {
    authProviderError.textContent =
      error?.message || "Unable to connect to Google. Please try again.";
    authProviderError.classList.remove("hidden-element");
    googleAuthBtn.disabled = false;
    googleAuthBtnText.textContent = originalText;
  }
});

// ==========================================
// 4. AUTH STATE & NAVIGATION
// ==========================================
async function ackSignupIfRecent(user) {
  if (!user?.id || !user.created_at) return;
  const key = `signup-ack:${user.id}`;
  try {
    if (sessionStorage.getItem(key)) return;
  } catch {
    /* ignore */
  }
  const age = Date.now() - new Date(user.created_at).getTime();
  if (Number.isNaN(age) || age < 0 || age > 48 * 60 * 60 * 1000) return;
  try {
    await authenticatedFetch("/api/signup-ack", { method: "POST" });
    try {
      sessionStorage.setItem(key, "1");
    } catch {
      /* ignore */
    }
  } catch {
    /* best-effort; admin sync still picks up users */
  }
}

async function applyAuthState(session) {
  if (isPublicShareView) return;
  const loggedOutView = document.getElementById("loggedOutView");
  const loggedInView = document.getElementById("loggedInView");

  if (session?.user) {
    currentUser = session.user;
    if (window.location.search.includes("billing=success")) {
      try {
        await supabaseClient.auth.refreshSession();
      } catch {
        // ignore refresh errors, we still continue with existing session
      }
    }
    setOfflineMode(false);
    loggedOutView.classList.add("hidden-element");
    loggedInView.classList.remove("hidden-element");
    document.getElementById("userEmailDisplay").textContent = currentUser.email;

    const acceptedUser = await ensureLegalAcceptance(currentUser);
    if (!acceptedUser) {
      loggedInView.classList.add("hidden-element");
      loggedOutView.classList.remove("hidden-element");
      return;
    }
    currentUser = acceptedUser;
    document.getElementById("userEmailDisplay").textContent = currentUser.email;

    ackSignupIfRecent(currentUser).catch(() => {});
    await Promise.all([refreshBillingState(), loadLibraryData(), loadRooms(), loadLibraryMap()]);
    updateScanSteps();
    return;
  }

  closeLegalAcceptModal();
  document.getElementById("renewalBanner")?.classList.add("hidden-element");

  if (offlineStore && !navigator.onLine) {
    const lastUser = await offlineStore.getLastUser();
    const snapshot = await offlineStore.getSnapshot(lastUser?.userId);
    if (lastUser?.userId && snapshot) {
      currentUser = { id: lastUser.userId, email: lastUser.email || "Offline user" };
      setOfflineMode(true);
      loggedOutView.classList.add("hidden-element");
      loggedInView.classList.remove("hidden-element");
      document.getElementById("userEmailDisplay").textContent = `${currentUser.email} (offline)`;
      renderBillingNav();
      await Promise.all([loadLibraryData(), loadLibraryMap()]);
      updateScanSteps();
      return;
    }
  }

  currentUser = null;
  myRooms = [];
  selectedRoomId = "";
  setOfflineMode(false);
  renderBillingNav();
  loggedOutView.classList.remove("hidden-element");
  loggedInView.classList.add("hidden-element");
}

supabaseClient.auth.onAuthStateChange((event, session) => {
  if (event === "USER_UPDATED" && legalAcceptModalOpen) {
    if (session?.user) currentUser = session.user;
    return;
  }
  applyAuthState(session).catch((error) => {
    console.error("Failed to apply auth state:", error);
  });
});

window.addEventListener("offline", () => {
  setOfflineMode(true);
});

window.addEventListener("online", () => {
  setOfflineMode(false);
  if (currentUser?.id) {
    refreshBillingState();
    loadRooms();
    loadLibraryData();
    loadLibraryMap();
  }
});

window.addEventListener("hilibrary:rate-limit", (event) => {
  const next = event?.detail || {};
  usageState = {
    ocr: next.ocr || usageState.ocr,
    books: next.books || usageState.books,
  };
  renderBillingNav();
});

document.getElementById("logoutBtn")?.addEventListener("click", async () => {
  const userId = currentUser?.id;
  if (offlineStore && userId) {
    await offlineStore.clearUser(userId).catch(() => {});
    await offlineStore.clearMediaCache().catch(() => {});
  }
  supabaseClient.auth.signOut().catch(() => {});
  if (isOfflineActive()) {
    currentUser = null;
    const loggedOutView = document.getElementById("loggedOutView");
    const loggedInView = document.getElementById("loggedInView");
    loggedOutView?.classList.remove("hidden-element");
    loggedInView?.classList.add("hidden-element");
  }
});

// View Toggling
document.querySelectorAll(".nav-btn[data-target]").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    const targetBtn = e.currentTarget;

    document
      .querySelectorAll(".nav-btn[data-target]")
      .forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".view-section").forEach((v) => {
      v.classList.remove("active-view");
      v.classList.add("hidden-view");
    });

    targetBtn.classList.add("active");
    const targetId = targetBtn.getAttribute("data-target");
    if (!targetId) return;

    document.getElementById(targetId).classList.remove("hidden-view");
    document.getElementById(targetId).classList.add("active-view");

    if (targetId === "libraryView") loadLibraryMap();
  });
});

// Scan progress: 1 Upload -> 2 Review & save
function updateScanSteps() {
  const stepsEl = document.getElementById("scanSteps");
  const uploadView = document.getElementById("uploadView");
  const saveBtn = document.getElementById("saveShelfBtn");
  const cropCanvasBtnEl = document.getElementById("cropCanvasBtn");
  const sidebarStepNumber = document.getElementById("scanSidebarStepNumber");
  const sidebarStepName = document.getElementById("scanSidebarStepName");
  const wizardStepNumber = document.getElementById("scanWizardStepNumber");
  const wizardStepName = document.getElementById("scanWizardStepName");
  const wizardStepDescription = document.getElementById("scanWizardStepDescription");
  if (!stepsEl) return;
  const hasImage = Boolean(currentLoadedImage || currentUploadedFile);
  const hasSpines = hasImage && currentDetectedSpines.length > 0;
  const states = {
    upload: hasImage ? "done" : "active",
    review: !hasImage ? "todo" : "active",
  };
  if (uploadView) {
    const stage = !hasImage ? "upload" : "review";
    uploadView.setAttribute("data-scan-stage", stage);
    if (stage === "upload") {
      uploadView.classList.remove("shelf-photo-collapsed");
    } else {
      uploadView.classList.toggle("shelf-photo-collapsed", shelfPhotoCollapsed);
    }
    const stageMeta = {
      upload: {
        number: "Step 1 of 2",
        name: "Upload photo",
        title: "Photograph your shelf",
        description:
          "Take a straight-on shot of one shelf with spines facing forward. Decent light, no glare. That's all it takes.",
      },
      review: {
        number: "Step 2 of 2",
        name: "Review books",
        title: "Review detected spines",
        description:
          "Confirm the detected titles and skip any misreads before saving this shelf.",
      },
    }[stage];
    if (stageMeta) {
      if (sidebarStepNumber) sidebarStepNumber.textContent = stageMeta.number;
      if (sidebarStepName) sidebarStepName.textContent = stageMeta.name;
      if (wizardStepNumber) wizardStepNumber.textContent = stageMeta.number;
      if (wizardStepName) wizardStepName.textContent = stageMeta.title;
      if (wizardStepDescription) wizardStepDescription.textContent = stageMeta.description;
    }
  }
  if (saveBtn) {
    saveBtn.disabled = !hasSpines;
    saveBtn.textContent = hasSpines
      ? `Save shelf (${currentDetectedSpines.length})`
      : "Save shelf";
  }
  if (cropCanvasBtnEl) {
    cropCanvasBtnEl.disabled = !hasImage;
  }
  stepsEl.querySelectorAll(".scan-step").forEach((step) => {
    const key = step.getAttribute("data-step");
    step.classList.remove("is-active", "is-done");
    if (states[key] === "active") step.classList.add("is-active");
    if (states[key] === "done") step.classList.add("is-done");
    if (states[key] === "active") step.setAttribute("aria-current", "step");
    else step.removeAttribute("aria-current");
  });
}

function showLoadingOverlay(message = "Scanning Books...") {
  let overlay = document.getElementById("loadingOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "loadingOverlay";
    overlay.className = "loading-overlay";
    overlay.innerHTML = `
      <div class="loading-spinner"></div>
      <p id="loadingMessage" class="loading-message"></p>
    `;
    document.body.appendChild(overlay);
  }
  document.getElementById("loadingMessage").textContent = message;
  overlay.style.display = "flex";
}

function hideLoadingOverlay() {
  const overlay = document.getElementById("loadingOverlay");
  if (overlay) overlay.style.display = "none";
}

window.addEventListener("DOMContentLoaded", () => {
  setOfflineMode(offlineMode);
  maybeRenderPublicShare().then((active) => {
    isPublicShareView = active;
  });
});

// ==========================================
// 5. UPLOAD & SCANNING LOGIC (CANVAS)
// ==========================================
const imageUpload = document.getElementById("imageUpload");
const imageCapture = document.getElementById("imageCapture");
const shelfCanvas = document.getElementById("shelfCanvas");
const ctx = shelfCanvas?.getContext("2d");
const placeholderText = document.getElementById("placeholderText");
const canvasControls = document.getElementById("canvasControls");
const zoomSlider = document.getElementById("zoomSlider");
const resetZoomBtn = document.getElementById("resetZoomBtn");
const saveShelfBtn = document.getElementById("saveShelfBtn");
const cropCanvasBtn = document.getElementById("cropCanvasBtn");

function setCanvasChromeVisible(visible) {
  canvasControls?.classList.toggle("hidden-element", !visible);
  cropCanvasBtn?.classList.toggle("hidden-element", !visible);
}

let currentUploadedFile = null;
let currentLoadedImage = null;
let currentDetectedSpines = [];
let currentUploadedImageHash = null;
let pendingSavedShelfId = null;
let scanQueue = [];

saveShelfBtn?.addEventListener("click", () => {
  saveShelfToDatabase();
});

document.getElementById("hideShelfPhotoBtn")?.addEventListener("click", () => {
  setShelfPhotoCollapsed(true);
});

// Canvas Viewport & Editing State
let canvasState = {
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  isDragging: false,
  startX: 0,
  startY: 0,
};

const CANVAS_ZOOM_MIN = 1;
const CANVAS_ZOOM_MAX = 4;

function getSpineBounds(spine) {
  if (spine?.polygon && spine.polygon.length >= 3) {
    const xs = spine.polygon.map((p) => p.x);
    const ys = spine.polygon.map((p) => p.y);
    return {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
    };
  }
  return spine?.box || spine?.boundingBox || null;
}

/** Object URLs for per-spine review thumbs; revoked on each list re-render. */
let spineCropObjectUrls = [];
/** Review stage: shelf photo starts collapsed (list-first). */
let shelfPhotoCollapsed = true;

function revokeSpineCropUrls() {
  spineCropObjectUrls.forEach((url) => {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* ignore */
    }
  });
  spineCropObjectUrls = [];
}

function setShelfPhotoCollapsed(collapsed) {
  shelfPhotoCollapsed = Boolean(collapsed);
  const uploadView = document.getElementById("uploadView");
  uploadView?.classList.toggle("shelf-photo-collapsed", shelfPhotoCollapsed);
  syncShelfPhotoToggleButtons();
}

function syncShelfPhotoToggleButtons() {
  const collapsed = shelfPhotoCollapsed;
  const label = collapsed ? "Show shelf photo" : "Hide shelf photo";
  document.querySelectorAll(".maximize-spines-btn").forEach((btn) => {
    btn.textContent = label;
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.setAttribute("aria-expanded", String(!collapsed));
  });
}

/**
 * Crop a spine AABB from the shelf image into a thumbnail object URL,
 * with the detection highlighted inside the crop.
 * @returns {string|null}
 */
function cropSpineThumbnail(image, spine, { pad = 0.08, maxEdge = 400 } = {}) {
  const box = getSpineBounds(spine);
  if (!image || !box) return null;
  const natW = image.naturalWidth || image.width;
  const natH = image.naturalHeight || image.height;
  if (!natW || !natH) return null;
  if (
    !Number.isFinite(box.minX) ||
    !Number.isFinite(box.maxX) ||
    !Number.isFinite(box.minY) ||
    !Number.isFinite(box.maxY)
  ) {
    return null;
  }

  const minX = Math.max(0, Math.min(1, box.minX - pad));
  const maxX = Math.max(0, Math.min(1, box.maxX + pad));
  const minY = Math.max(0, Math.min(1, box.minY - pad));
  const maxY = Math.max(0, Math.min(1, box.maxY + pad));
  const sx = minX * natW;
  const sy = minY * natH;
  const sw = Math.max(1, (maxX - minX) * natW);
  const sh = Math.max(1, (maxY - minY) * natH);
  if (sw < 1 || sh < 1) return null;

  const scale = Math.min(1, maxEdge / Math.max(sw, sh));
  const dw = Math.max(1, Math.round(sw * scale));
  const dh = Math.max(1, Math.round(sh * scale));

  const canvas = document.createElement("canvas");
  canvas.width = dw;
  canvas.height = dh;
  const c = canvas.getContext("2d");
  if (!c) return null;
  try {
    c.drawImage(image, sx, sy, sw, sh, 0, 0, dw, dh);

    const toCrop = (nx, ny) => ({
      x: (nx * natW - sx) * (dw / sw),
      y: (ny * natH - sy) * (dh / sh),
    });

    c.save();
    c.strokeStyle = FOLIO_COLORS.success;
    c.lineWidth = Math.max(2, Math.round(Math.min(dw, dh) * 0.02));
    c.lineJoin = "round";

    const poly = spine.polygon;
    if (Array.isArray(poly) && poly.length >= 3) {
      c.beginPath();
      poly.forEach((pt, i) => {
        const p = toCrop(pt.x, pt.y);
        if (i === 0) c.moveTo(p.x, p.y);
        else c.lineTo(p.x, p.y);
      });
      c.closePath();
      c.stroke();
    } else {
      const tl = toCrop(box.minX, box.minY);
      const br = toCrop(box.maxX, box.maxY);
      const rw = Math.max(1, br.x - tl.x);
      const rh = Math.max(1, br.y - tl.y);
      c.strokeRect(tl.x, tl.y, rw, rh);
    }
    c.restore();

    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return null;
    const bin = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
    spineCropObjectUrls.push(url);
    return url;
  } catch {
    return null;
  }
}

function setCanvasZoom(newScale) {
  if (!shelfCanvas) return;
  const oldScale = canvasState.scale || CANVAS_ZOOM_MIN;
  newScale = Math.min(CANVAS_ZOOM_MAX, Math.max(CANVAS_ZOOM_MIN, newScale));
  const cw = shelfCanvas.width;
  const ch = shelfCanvas.height;

  if (newScale <= CANVAS_ZOOM_MIN) {
    canvasState.scale = CANVAS_ZOOM_MIN;
    canvasState.offsetX = 0;
    canvasState.offsetY = 0;
  } else {
    const viewCx = (cw / 2 - canvasState.offsetX) / oldScale;
    const viewCy = (ch / 2 - canvasState.offsetY) / oldScale;
    const imgCx = cw / 2;
    const imgCy = ch / 2;
    let targetImgX = viewCx;
    let targetImgY = viewCy;
    if (newScale < oldScale && oldScale > CANVAS_ZOOM_MIN) {
      const keep = (newScale - CANVAS_ZOOM_MIN) / (oldScale - CANVAS_ZOOM_MIN);
      targetImgX = imgCx + (viewCx - imgCx) * keep;
      targetImgY = imgCy + (viewCy - imgCy) * keep;
    }
    canvasState.scale = newScale;
    canvasState.offsetX = cw / 2 - targetImgX * newScale;
    canvasState.offsetY = ch / 2 - targetImgY * newScale;
  }

  if (zoomSlider) zoomSlider.value = String(canvasState.scale);
  redrawCanvasOverlays(activeEditingSpineIndex);
}

function zoomCanvasToSpine(spine) {
  if (!shelfCanvas || !spine) return;
  const box = getSpineBounds(spine);
  if (!box) return;

  const w = Math.max(0.02, box.maxX - box.minX) * shelfCanvas.width;
  const h = Math.max(0.02, box.maxY - box.minY) * shelfCanvas.height;
  const scale = Math.min(
    CANVAS_ZOOM_MAX,
    Math.max(
      CANVAS_ZOOM_MIN,
      Math.min((shelfCanvas.width * 0.55) / w, (shelfCanvas.height * 0.55) / h),
    ),
  );
  const cx = ((box.minX + box.maxX) / 2) * shelfCanvas.width;
  const cy = ((box.minY + box.maxY) / 2) * shelfCanvas.height;
  canvasState.scale = scale;
  canvasState.offsetX = shelfCanvas.width / 2 - cx * scale;
  canvasState.offsetY = shelfCanvas.height / 2 - cy * scale;
  if (zoomSlider) zoomSlider.value = String(Number(scale.toFixed(2)));
  redrawCanvasOverlays(activeEditingSpineIndex);
}

let activeEditingSpineIndex = null;
let activeControlPoint = null; // { spineIndex, pointIndex }

function getCanvasScaleFactor() {
  if (!shelfCanvas) return 1;
  const rect = shelfCanvas.getBoundingClientRect();
  return rect.width > 0 ? shelfCanvas.width / rect.width : 1;
}

function getNormalizedCanvasCoords(e) {
  if (!shelfCanvas) return { x: 0, y: 0, imgPxX: 0, imgPxY: 0 };
  const rect = shelfCanvas.getBoundingClientRect();
  const clientX = e.touches
    ? e.touches[0]?.clientX || e.changedTouches[0]?.clientX
    : e.clientX;
  const clientY = e.touches
    ? e.touches[0]?.clientY || e.changedTouches[0]?.clientY
    : e.clientY;

  const screenX = clientX - rect.left;
  const screenY = clientY - rect.top;

  const factor = shelfCanvas.width / rect.width;
  const canvasPxX = screenX * factor;
  const canvasPxY = screenY * factor;

  const imgPxX = (canvasPxX - canvasState.offsetX) / canvasState.scale;
  const imgPxY = (canvasPxY - canvasState.offsetY) / canvasState.scale;

  return {
    x: imgPxX / shelfCanvas.width,
    y: imgPxY / shelfCanvas.height,
    imgPxX,
    imgPxY,
  };
}

function isPointInNormalizedPolygon(pt, polygon) {
  if (!polygon || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x,
      yi = polygon[i].y;
    const xj = polygon[j].x,
      yj = polygon[j].y;
    const intersect =
      yi > pt.y !== yj > pt.y &&
      pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function updateSpineBox(spine) {
  if (!spine.polygon || spine.polygon.length === 0) return;
  const xs = spine.polygon.map((p) => p.x);
  const ys = spine.polygon.map((p) => p.y);
  spine.box = {
    minX: Math.max(0, Math.min(1, Math.min(...xs))),
    maxX: Math.max(0, Math.min(1, Math.max(...xs))),
    minY: Math.max(0, Math.min(1, Math.min(...ys))),
    maxY: Math.max(0, Math.min(1, Math.max(...ys))),
  };
}

function redrawCanvasOverlays(highlightedIndex = null) {
  if (!currentLoadedImage || !ctx) return;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, shelfCanvas.width, shelfCanvas.height);

  ctx.translate(canvasState.offsetX, canvasState.offsetY);
  ctx.scale(canvasState.scale, canvasState.scale);

  ctx.drawImage(currentLoadedImage, 0, 0);

  const baseThickness = Math.max(6, Math.round(shelfCanvas.width / 250));

  currentDetectedSpines.forEach((spine, index) => {
    const isSelected = index === activeEditingSpineIndex;
    const isHighlighted = isSelected || index === highlightedIndex;
    const strokeColor = isSelected
      ? FOLIO_COLORS.success
      : isHighlighted
        ? FOLIO_COLORS.warning
        : FOLIO_COLORS.primary;
    const fillColor = isHighlighted ? "rgba(139, 58, 47, 0.24)" : null;
    const lineWidth =
      (isHighlighted ? baseThickness * 2 : baseThickness) / canvasState.scale;

    if (spine.polygon && spine.polygon.length >= 3) {
      ctx.beginPath();
      spine.polygon.forEach((pt, i) => {
        const px = pt.x * shelfCanvas.width;
        const py = pt.y * shelfCanvas.height;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.closePath();

      if (fillColor) {
        ctx.fillStyle = fillColor;
        ctx.fill();
      }
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = lineWidth;
      ctx.stroke();

      if (isSelected) {
        const handleRadius = Math.max(10, 16 / canvasState.scale);
        spine.polygon.forEach((pt) => {
          const px = pt.x * shelfCanvas.width;
          const py = pt.y * shelfCanvas.height;

          ctx.beginPath();
          ctx.arc(px, py, handleRadius, 0, 2 * Math.PI);
          ctx.fillStyle = "#ffffff";
          ctx.fill();
          ctx.lineWidth = 4 / canvasState.scale;
          ctx.strokeStyle = FOLIO_COLORS.success;
          ctx.stroke();
        });
      }
    } else if (spine.box) {
      const x = spine.box.minX * shelfCanvas.width;
      const y = spine.box.minY * shelfCanvas.height;
      const w = (spine.box.maxX - spine.box.minX) * shelfCanvas.width;
      const h = (spine.box.maxY - spine.box.minY) * shelfCanvas.height;

      if (fillColor) {
        ctx.fillStyle = fillColor;
        ctx.fillRect(x, y, w, h);
      }
      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = lineWidth;
      ctx.strokeRect(x, y, w, h);
    }
  });

  ctx.restore();
}

zoomSlider?.addEventListener("input", (e) => {
  setCanvasZoom(parseFloat(e.target.value));
});

resetZoomBtn?.addEventListener("click", () => {
  setCanvasZoom(CANVAS_ZOOM_MIN);
});

const startCanvasDrag = (e) => {
  const norm = getNormalizedCanvasCoords(e);

  if (activeEditingSpineIndex !== null) {
    const spine = currentDetectedSpines[activeEditingSpineIndex];
    if (spine && spine.polygon) {
      const hitRadiusImgPx = Math.max(20, 30 / canvasState.scale);

      const pointIdx = spine.polygon.findIndex((pt) => {
        const px = pt.x * shelfCanvas.width;
        const py = pt.y * shelfCanvas.height;
        return Math.hypot(px - norm.imgPxX, py - norm.imgPxY) <= hitRadiusImgPx;
      });

      if (pointIdx !== -1) {
        activeControlPoint = {
          spineIndex: activeEditingSpineIndex,
          pointIndex: pointIdx,
        };
        return;
      }
    }
  }

  const clickedSpineIdx = currentDetectedSpines.findIndex((spine) => {
    if ((!spine.polygon || spine.polygon.length < 3) && spine.box) {
      spine.polygon = [
        { x: spine.box.minX, y: spine.box.minY },
        { x: spine.box.maxX, y: spine.box.minY },
        { x: spine.box.maxX, y: spine.box.maxY },
        { x: spine.box.minX, y: spine.box.maxY },
      ];
    }
    return isPointInNormalizedPolygon({ x: norm.x, y: norm.y }, spine.polygon);
  });

  if (clickedSpineIdx !== -1) {
    activeEditingSpineIndex = clickedSpineIdx;
    redrawCanvasOverlays(null);

    const sidebarCards = document.querySelectorAll("#pendingContainer > div");
    sidebarCards[clickedSpineIdx + 1]?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
    });
    return;
  }

  activeEditingSpineIndex = null;
  redrawCanvasOverlays(null);

  const pos = e.touches
    ? { x: e.touches[0].clientX, y: e.touches[0].clientY }
    : { x: e.clientX, y: e.clientY };
  const factor = getCanvasScaleFactor();
  canvasState.isDragging = true;
  canvasState.startX = pos.x - canvasState.offsetX / factor;
  canvasState.startY = pos.y - canvasState.offsetY / factor;
};

const moveCanvasDrag = (e) => {
  if (activeControlPoint) {
    if (e.touches) e.preventDefault();
    const norm = getNormalizedCanvasCoords(e);
    const spine = currentDetectedSpines[activeControlPoint.spineIndex];

    spine.polygon[activeControlPoint.pointIndex] = {
      x: Math.max(0, Math.min(1, norm.x)),
      y: Math.max(0, Math.min(1, norm.y)),
    };

    updateSpineBox(spine);
    redrawCanvasOverlays(activeControlPoint.spineIndex);
    return;
  }

  if (canvasState.isDragging) {
    if (e.touches) e.preventDefault();
    const pos = e.touches
      ? { x: e.touches[0].clientX, y: e.touches[0].clientY }
      : { x: e.clientX, y: e.clientY };
    const factor = getCanvasScaleFactor();

    canvasState.offsetX = (pos.x - canvasState.startX) * factor;
    canvasState.offsetY = (pos.y - canvasState.startY) * factor;
    redrawCanvasOverlays(null);
  }
};

const stopCanvasDrag = () => {
  activeControlPoint = null;
  canvasState.isDragging = false;
};

shelfCanvas?.addEventListener("mousedown", startCanvasDrag);
shelfCanvas?.addEventListener("touchstart", startCanvasDrag, {
  passive: false,
});
window.addEventListener("mousemove", moveCanvasDrag);
window.addEventListener("touchmove", moveCanvasDrag, { passive: false });
window.addEventListener("mouseup", stopCanvasDrag);
window.addEventListener("touchend", stopCanvasDrag);

function beginScanForFile(file) {
  if (!file) return;

  currentUploadedFile = null;
  currentDetectedSpines = [];
  currentUploadedImageHash = null;
  pendingSavedShelfId = null;
  currentDismissedTitles = [];
  placeholderText.style.display = "none";
  shelfCanvas.style.display = "block";
  setCanvasChromeVisible(true);
  document.getElementById("pendingContainer").innerHTML =
    "<p class='scan-loading-text'>Preparing photo...</p>";
  updateScanSteps();

  canvasState = {
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    isDragging: false,
    startX: 0,
    startY: 0,
  };
  activeEditingSpineIndex = null;
  if (zoomSlider) zoomSlider.value = "1";

  prepareImageFileForUpload(file)
    .then((prepared) => {
      currentUploadedFile = prepared;
      document.getElementById("pendingContainer").innerHTML =
        "<p class='scan-loading-text'>Scanning shelf...</p>";
      const img = new Image();
      img.onload = () => {
        shelfCanvas.width = img.width;
        shelfCanvas.height = img.height;
        currentLoadedImage = img;
        redrawCanvasOverlays(null);
        updateScanSteps();
        runShelfOcr(prepared, { forceRescan: false });
      };
      img.onerror = () => {
        showToast("Could not load that image. Try another file.", "error");
        resetScanWorkspace();
      };
      img.src = URL.createObjectURL(prepared);
    })
    .catch((err) => {
      console.error("Image prepare failed:", err);
      showToast("Could not prepare that image.", "error");
      resetScanWorkspace();
    });
}

const OCR_MAX_EDGE = 2000;
const OCR_JPEG_QUALITY = 0.85;

async function prepareImageFileForUpload(file) {
  if (!file || !String(file.type || "").startsWith("image/")) return file;

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Image decode failed"));
      el.src = objectUrl;
    });

    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return file;

    const longest = Math.max(w, h);
    const scale = longest > OCR_MAX_EDGE ? OCR_MAX_EDGE / longest : 1;
    // Skip recompress for already-small JPEGs
    if (scale >= 1 && file.type === "image/jpeg" && file.size < 1_500_000) {
      return file;
    }

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx2 = canvas.getContext("2d");
    ctx2.drawImage(img, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", OCR_JPEG_QUALITY),
    );
    if (!blob) return file;
    return new File([blob], "shelf_upload.jpg", { type: "image/jpeg" });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function handleSelectedImageFiles(fileList) {
  const files = Array.from(fileList || []).filter((file) =>
    String(file.type || "").startsWith("image/"),
  );
  if (files.length === 0) return;
  if (!isPremiumPlan() && files.length > 1) {
    showUpgradeModal({
      reason: "Batch scan queue is Premium only. Free users can scan one photo at a time.",
      featureCode: "batch_scan",
    });
  }
  const allowedFiles = isPremiumPlan() ? files : files.slice(0, 1);
  scanQueue = allowedFiles.slice(1);
  beginScanForFile(allowedFiles[0]);
}

imageUpload?.addEventListener("change", async (e) => {
  await handleSelectedImageFiles(e.target.files);
});

imageCapture?.addEventListener("change", async (e) => {
  await handleSelectedImageFiles(e.target.files);
});

function isMobilePhotoSourceLayout() {
  return window.matchMedia("(max-width: 768px)").matches;
}

function openPhotoSourceChooser() {
  // Desktop: open the library file picker directly (no camera/library modal).
  if (!isMobilePhotoSourceLayout()) {
    imageUpload?.click();
    return;
  }

  const modal = document.getElementById("photoSourceModal");
  const cameraBtn = document.getElementById("photoSourceCameraBtn");
  const libraryBtn = document.getElementById("photoSourceLibraryBtn");
  const cancelBtn = document.getElementById("photoSourceCancelBtn");
  if (!modal || !cameraBtn || !libraryBtn || !cancelBtn) {
    imageUpload?.click();
    return;
  }

  const onKey = (e) => {
    trapFocusInModal(modal, e);
    if (e.key === "Escape") {
      e.stopPropagation();
      cleanup();
    }
  };
  const onCamera = () => {
    imageCapture?.click();
    cleanup();
  };
  const onLibrary = () => {
    imageUpload?.click();
    cleanup();
  };
  const onCancel = () => cleanup();
  const onOverlay = (e) => {
    if (e.target === modal) cleanup();
  };

  function cleanup() {
    cameraBtn.removeEventListener("click", onCamera);
    libraryBtn.removeEventListener("click", onLibrary);
    cancelBtn.removeEventListener("click", onCancel);
    modal.removeEventListener("keydown", onKey);
    modal.removeEventListener("click", onOverlay);
    closeModalAndRestore(modal);
  }

  cameraBtn.addEventListener("click", onCamera);
  libraryBtn.addEventListener("click", onLibrary);
  cancelBtn.addEventListener("click", onCancel);
  modal.addEventListener("keydown", onKey);
  modal.addEventListener("click", onOverlay);
  openModalWithFocus(modal, cameraBtn);
}

// Empty canvas is the upload target: click, keyboard, and drag & drop.
function forwardFilesToImageUpload(files) {
  if (!imageUpload) return;
  const valid = (Array.isArray(files) ? files : [files]).filter(
    (file) => file && (!file.type || file.type.startsWith("image/")),
  );
  if (!valid.length) return;
  const limited = isPremiumPlan() ? valid : valid.slice(0, 1);
  const transfer = new DataTransfer();
  limited.forEach((file) => transfer.items.add(file));
  imageUpload.files = transfer.files;
  imageUpload.dispatchEvent(new Event("change", { bubbles: true }));
}

function setupCanvasDropzone() {
  const dropzone = document.getElementById("canvasDropzone");
  if (!dropzone || !placeholderText || !imageUpload) return;

  const activateUpload = () => openPhotoSourceChooser();

  placeholderText.addEventListener("click", (e) => {
    if (e.target.closest("#cropCanvasBtn")) return;
    activateUpload();
  });
  placeholderText.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activateUpload();
    }
  });

  ["dragenter", "dragover"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      dropzone.classList.add("drag-over");
    }),
  );
  ["dragleave", "drop"].forEach((evt) =>
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      if (evt !== "drop" || e.relatedTarget) dropzone.classList.remove("drag-over");
    }),
  );
  dropzone.addEventListener("drop", (e) => {
    dropzone.classList.remove("drag-over");
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length) forwardFilesToImageUpload(files);
  });
}
setupCanvasDropzone();
updateScanSteps();

function renderDetectedSpines(options = {}) {
  const preserveScroll = Boolean(options.preserveScroll);
  const existingScroll = document.querySelector("#pendingContainer .spines-scroll");
  const savedScrollTop = preserveScroll && existingScroll ? existingScroll.scrollTop : 0;
  const renderConfirmedBookRow = (containerEl, spineData) => {
    if (!spineData.confirmed) return;

    const selectedRow = document.createElement("div");
    selectedRow.className = "spine-confirmed-row";

    if (spineData.thumbnail) {
      selectedRow.appendChild(createBookCoverImage(spineData.thumbnail));
    }

    const info = document.createElement("div");
    info.className = "book-result-info";

    const selectedTitle = document.createElement("strong");
    selectedTitle.className = "book-result-title";
    selectedTitle.textContent = spineData.title || "Untitled Book";
    info.appendChild(selectedTitle);

    if (spineData.author) {
      const selectedAuthor = document.createElement("span");
      selectedAuthor.className = "book-result-author";
      selectedAuthor.textContent = `By ${spineData.author}`;
      info.appendChild(selectedAuthor);
    }

    const badge = document.createElement("span");
    badge.className = "spine-confirmed-badge";
    badge.textContent = "Confirmed";
    info.appendChild(badge);

    selectedRow.appendChild(info);
    containerEl.appendChild(selectedRow);
  };

  revokeSpineCropUrls();

  const container = document.getElementById("pendingContainer");
  container.innerHTML = "";
  container.classList.remove("maximized");
  updateScanSteps();
  setShelfPhotoCollapsed(shelfPhotoCollapsed);

  if (currentDetectedSpines.length === 0) {
    container.innerHTML = "<p class='empty-state'>No spines detected.</p>";
    return;
  }

  redrawCanvasOverlays(null);

  // Toolbar
  const header = document.createElement("div");
  header.className = "spines-toolbar";

  const confirmedCount = currentDetectedSpines.filter((s) => s.confirmed).length;
  const titleEl = document.createElement("strong");
  titleEl.className = "spines-title";
  titleEl.textContent = `Matched ${confirmedCount} / ${currentDetectedSpines.length}`;

  const batchActions = document.createElement("div");
  batchActions.className = "spines-batch-actions";

  const shelfPhotoBtn = document.createElement("button");
  shelfPhotoBtn.className = "auth-btn secondary-btn maximize-spines-btn";
  shelfPhotoBtn.type = "button";
  shelfPhotoBtn.onclick = () => {
    setShelfPhotoCollapsed(!shelfPhotoCollapsed);
  };

  const searchAllBtn = document.createElement("button");
  searchAllBtn.textContent = "Match remaining";
  searchAllBtn.className = "auth-btn primary-btn spine-batch-btn";
  searchAllBtn.type = "button";
  searchAllBtn.setAttribute("aria-label", "Match remaining spines in Google Books");

  const skipUnlabeledBtn = document.createElement("button");
  skipUnlabeledBtn.textContent = "Skip Unlabeled";
  skipUnlabeledBtn.className = "auth-btn secondary-btn spine-batch-btn";
  skipUnlabeledBtn.type = "button";
  skipUnlabeledBtn.setAttribute("aria-label", "Remove unlabeled spines from the list");

  searchAllBtn.onclick = async () => {
    if (!requireOnline("Book search")) return;
    searchAllBtn.disabled = true;
    searchAllBtn.textContent = "Matching...";
    try {
      const { matched } = await autoMatchDetectedSpines({
        onlyUnconfirmed: true,
        notifyLimit: true,
      });
      if (matched > 0) {
        showToast(`Matched ${matched} book(s).`, "success");
      } else {
        showToast("No high-confidence matches found. Try editing titles.", "info");
      }
    } finally {
      // renderDetectedSpines rebuilds the button; no need to restore
    }
  };

  skipUnlabeledBtn.onclick = () => {
    currentDetectedSpines = currentDetectedSpines.filter((spine) => {
      const title = (spine.title || "").trim().toLowerCase();
      const keep = title !== "" && title !== "unlabeled spine";
      if (!keep) rememberDismissedTitle(spine.title);
      return keep;
    });
    activeEditingSpineIndex = null;
    renderDetectedSpines();
  };

  batchActions.appendChild(searchAllBtn);
  batchActions.appendChild(skipUnlabeledBtn);
  batchActions.appendChild(shelfPhotoBtn);

  header.appendChild(titleEl);
  header.appendChild(batchActions);
  container.appendChild(header);
  syncShelfPhotoToggleButtons();

  const spinesScroll = document.createElement("div");
  spinesScroll.className = "spines-scroll";
  container.appendChild(spinesScroll);

  currentDetectedSpines.forEach((spine, index) => {
    const div = document.createElement("div");
    div.className = "spine-card";
    if (spine.confirmed) div.classList.add("is-confirmed");

    const highlight = () => {
      activeEditingSpineIndex = index;
      div.classList.add("is-highlighted");
      redrawCanvasOverlays(index);
    };

    const unhighlight = () => {
      div.classList.remove("is-highlighted");
      redrawCanvasOverlays(null);
    };

    const cardMain = document.createElement("div");
    cardMain.className = "spine-card-main";

    const cropUrl = cropSpineThumbnail(currentLoadedImage, spine);
    if (cropUrl) {
      const thumb = document.createElement("img");
      thumb.className = "spine-crop-thumb";
      thumb.src = cropUrl;
      thumb.alt = "";
      thumb.draggable = false;
      thumb.addEventListener("click", (e) => {
        e.stopPropagation();
        highlight();
        if (!shelfPhotoCollapsed) zoomCanvasToSpine(spine);
        else {
          setShelfPhotoCollapsed(false);
          requestAnimationFrame(() => zoomCanvasToSpine(spine));
        }
      });
      cardMain.appendChild(thumb);
    }

    const cardContent = document.createElement("div");
    cardContent.className = "spine-card-content";

    const inputRow = document.createElement("div");
    inputRow.className = "spine-input-row";

    const numberBadge = document.createElement("div");
    numberBadge.className = "spine-number";
    numberBadge.textContent = index + 1;
    numberBadge.setAttribute("aria-hidden", "true");

    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.value = spine.title;
    titleInput.className = "auth-input spine-card-input";
    titleInput.setAttribute("aria-label", `Spine ${index + 1} title`);

    titleInput.addEventListener("input", (e) => {
      spine.title = e.target.value;
      if (spine.confirmed && spine.title !== spine.confirmedTitle) {
        spine.confirmed = false;
        delete spine.confirmedTitle;
        delete spine.author;
        delete spine.thumbnail;
        div.classList.remove("is-confirmed");
      }
    });

    titleInput.addEventListener("focus", highlight);
    titleInput.addEventListener("click", () => {
      highlight();
      if (!shelfPhotoCollapsed) zoomCanvasToSpine(spine);
    });
    titleInput.addEventListener("blur", unhighlight);
    div.addEventListener("mouseenter", highlight);
    div.addEventListener("mouseleave", unhighlight);

    inputRow.appendChild(numberBadge);
    inputRow.appendChild(titleInput);

    const actionRow = document.createElement("div");
    actionRow.className = "spine-actions";

    const searchResults = document.createElement("div");
    searchResults.className = "search-results-col";

    if (!spine.confirmed && spine.bestMatch) {
      const hint = document.createElement("span");
      hint.className = "search-status";
      hint.textContent = `Suggested: ${spine.bestMatch.title}`;
      searchResults.appendChild(hint);

      const useBestBtn = document.createElement("button");
      useBestBtn.textContent = "Use best match";
      useBestBtn.className = "auth-btn primary-btn spine-btn spine-btn-primary";
      useBestBtn.type = "button";
      useBestBtn.setAttribute(
        "aria-label",
        `Use best match ${spine.bestMatch.title} for spine ${index + 1}`,
      );
      useBestBtn.onclick = () => {
        applyCatalogMatchToSpine(
          spine,
          spine.bestMatch,
          titleInput,
          div,
          searchResults,
        );
        renderDetectedSpines({ preserveScroll: true });
      };
      actionRow.appendChild(useBestBtn);
    }

    const searchBtn = document.createElement("button");
    searchBtn.textContent = "Search Book";
    searchBtn.className = "auth-btn primary-btn spine-search-btn spine-btn spine-btn-primary";
    searchBtn.type = "button";
    searchBtn.setAttribute("aria-label", `Search book for spine ${index + 1}`);

    const skipBtn = document.createElement("button");
    skipBtn.textContent = "Skip";
    skipBtn.className = "auth-btn secondary-btn spine-btn spine-btn-skip";
    skipBtn.type = "button";
    skipBtn.setAttribute("aria-label", `Skip spine ${index + 1}`);

    skipBtn.onclick = () => {
      rememberDismissedTitle(currentDetectedSpines[index]?.title);
      currentDetectedSpines.splice(index, 1);
      activeEditingSpineIndex = null;
      renderDetectedSpines({ preserveScroll: true });
    };

    actionRow.appendChild(searchBtn);
    actionRow.appendChild(skipBtn);

    searchBtn.onclick = async () => {
      if (!requireOnline("Book search")) return;
      if (!isSearchableSpineTitle(titleInput.value)) {
        searchResults.innerHTML =
          "<span class='search-status-error'>Enter a title to search.</span>";
        return;
      }
      searchResults.innerHTML =
        "<span class='search-status'>Searching Google Books...</span>";
      try {
        const books = await searchBooksByQuery(
          titleInput.value,
          spine.author || "",
        );
        renderBookSearchCards(searchResults, books, {
          confirmLabel: "Use this book",
          onConfirm: (book) => {
            applyCatalogMatchToSpine(spine, book, titleInput, div, searchResults);
          },
        });
      } catch (err) {
        if (err?.code === "PLAN_LIMIT") {
          showUpgradeModal({
            reason: err.message || "Book search limit reached. Upgrade for higher limits.",
            featureCode: "books_rate_limit",
          });
        }
        searchResults.innerHTML =
          "<span class='search-status-error'>Search failed.</span>";
      }
    };

    cardContent.appendChild(inputRow);
    cardContent.appendChild(actionRow);
    renderConfirmedBookRow(searchResults, spine);
    cardContent.appendChild(searchResults);
    cardMain.appendChild(cardContent);
    div.appendChild(cardMain);
    spinesScroll.appendChild(div);
  });

  if (preserveScroll) spinesScroll.scrollTop = savedScrollTop;
}

// ==========================================
// CROP DIALOG ENGINE
// ==========================================
const cropModal = document.getElementById("cropModal");
const cropCanvas = document.getElementById("cropCanvas");
const cropCtx = cropCanvas?.getContext("2d");
const cancelCropBtn = document.getElementById("cancelCropBtn");
const applyCropBtn = document.getElementById("applyCropBtn");

let cropSelection = null; // { x, y, w, h } in image pixels
let isCropping = false;
let cropStart = { x: 0, y: 0 };
let cropShouldForceRescan = true;

async function handleOcrResponse(data) {
  if (data.duplicate) {
    showToast(
      "This image is already in your library! Navigating to its location on the map.",
      "info",
    );
    resetScanWorkspace();
    const mapNavBtn = document.querySelector(
      '.nav-btn[data-target="libraryView"]',
    );
    if (mapNavBtn) mapNavBtn.click();
    setTimeout(() => {
      zoomToShelfOnMap(data.shelf.id);
    }, 350);
    return true;
  }
  currentDetectedSpines = data.spines || [];
  currentUploadedImageHash = data.imageHash || null;
  renderDetectedSpines();
  if (currentDetectedSpines.some((s) => isSearchableSpineTitle(s.title))) {
    showToast("Matching titles in Google Books...", "info");
    const { matched } = await autoMatchDetectedSpines({ notifyLimit: false });
    if (matched > 0) {
      showToast(`Auto-matched ${matched} book(s).`, "success");
    }
  }
  return false;
}

async function runShelfOcr(file, { forceRescan = false } = {}) {
  if (!file) return;
  if (!requireOnline("Shelf scanning")) return;

  showLoadingOverlay("Scanning shelf...");
  const formData = new FormData();
  formData.append("image", file);
  if (forceRescan) formData.append("force_rescan", "true");

  try {
    const response = await authenticatedFetch("/api/ocr", {
      method: "POST",
      body: formData,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (data.code === "PLAN_LIMIT") {
        showUpgradeModal({
          reason: data.error || "OCR limit reached. Upgrade for more scans.",
          featureCode: "ocr_limit",
        });
      }
      throw new Error(data.error || "Scan failed");
    }
    await handleOcrResponse(data);
  } catch (err) {
    console.error("Shelf scan failed:", err);
    showToast(err.message || "Scan failed. Try again.", "error");
    document.getElementById("pendingContainer").innerHTML =
      "<p class='empty-state'>Scan failed. Crop &amp; re-scan, or upload another photo.</p>";
  } finally {
    hideLoadingOverlay();
    updateScanSteps();
  }
}

function isAlreadyExistsError(error) {
  if (!error) return false;
  const status = error.statusCode ?? error.status ?? error.code;
  const msg = String(error.message || error.error || "");
  return (
    status === 409 ||
    status === "409" ||
    status === "23505" ||
    /already exists|duplicate|unique/i.test(msg)
  );
}

function buildUserBookRows(spines, { userId, shelfId, imagePath }) {
  return (spines || []).map((spine) => ({
    user_id: userId,
    shelf_id: shelfId,
    title: spine.title?.trim() || "Untitled Book",
    author: spine.author || null,
    bounding_box: spine.box || spine.boundingBox || null,
    polygon: spine.polygon || null,
    cover: toHttpsUrl(spine.thumbnail) || null,
    shelf_image_url: imagePath,
  }));
}

async function insertUserBooks(payload) {
  let rows = payload;
  let { error } = await supabaseClient.from("user_books").insert(rows);
  if (error && /author/i.test(error.message)) {
    rows = rows.map(({ author, ...rest }) => rest);
    ({ error } = await supabaseClient.from("user_books").insert(rows));
  }
  if (error && /cover_url|'cover'/i.test(error.message)) {
    rows = rows.map(({ cover, ...rest }) => rest);
    ({ error } = await supabaseClient.from("user_books").insert(rows));
  }
  if (error && /polygon/i.test(error.message)) {
    rows = rows.map(({ polygon, ...rest }) => rest);
    ({ error } = await supabaseClient.from("user_books").insert(rows));
  }
  return error || null;
}

async function saveBooksForShelf(shelfId, imagePath) {
  const { data: existingBooks, error: existingError } = await supabaseClient
    .from("user_books")
    .select("id")
    .eq("shelf_id", shelfId)
    .eq("user_id", currentUser.id);
  if (existingError) return existingError;

  if ((existingBooks || []).length > 0) {
    const { error: deleteError } = await supabaseClient
      .from("user_books")
      .delete()
      .eq("shelf_id", shelfId)
      .eq("user_id", currentUser.id);
    if (deleteError) return deleteError;
  }

  return insertUserBooks(
    buildUserBookRows(currentDetectedSpines, {
      userId: currentUser.id,
      shelfId,
      imagePath,
    }),
  );
}

function resetScanWorkspace() {
  currentUploadedFile = null;
  currentLoadedImage = null;
  currentDetectedSpines = [];
  currentUploadedImageHash = null;
  pendingSavedShelfId = null;
  currentDismissedTitles = [];
  revokeSpineCropUrls();
  shelfPhotoCollapsed = true;

  if (ctx && shelfCanvas) ctx.clearRect(0, 0, shelfCanvas.width, shelfCanvas.height);
  if (shelfCanvas) shelfCanvas.style.display = "none";
  if (placeholderText) placeholderText.style.display = "flex";
  setCanvasChromeVisible(false);
  if (imageUpload) imageUpload.value = "";
  if (imageCapture) imageCapture.value = "";
  document.getElementById("pendingContainer").innerHTML =
    "<p class='empty-state'>Upload a new image to continue.</p>";
  updateScanSteps();
}

function openCropModalForCurrentImage({ forceRescan = true } = {}) {
  if (!currentLoadedImage) {
    showToast("Please upload an image first.", "info");
    return;
  }
  cropShouldForceRescan = forceRescan;
  if (applyCropBtn) {
    applyCropBtn.textContent = forceRescan ? "Crop & Re-scan" : "Crop & Scan";
  }

  cropCanvas.width = currentLoadedImage.naturalWidth || currentLoadedImage.width;
  cropCanvas.height = currentLoadedImage.naturalHeight || currentLoadedImage.height;

  // Default crop selection is the full image.
  cropSelection = {
    x: 0,
    y: 0,
    w: cropCanvas.width,
    h: cropCanvas.height,
  };

  drawCropOverlay();
  openModalWithFocus(cropModal, cancelCropBtn);
}

function drawCropOverlay() {
  if (!currentLoadedImage || !cropCtx) return;

  cropCtx.clearRect(0, 0, cropCanvas.width, cropCanvas.height);
  cropCtx.drawImage(currentLoadedImage, 0, 0);

  if (cropSelection && cropSelection.w > 0 && cropSelection.h > 0) {
    // Darken background
    cropCtx.fillStyle = "rgba(0, 0, 0, 0.5)";
    cropCtx.fillRect(0, 0, cropCanvas.width, cropCanvas.height);

    // Clear active crop selection region
    cropCtx.clearRect(
      cropSelection.x,
      cropSelection.y,
      cropSelection.w,
      cropSelection.h,
    );
    cropCtx.drawImage(
      currentLoadedImage,
      cropSelection.x,
      cropSelection.y,
      cropSelection.w,
      cropSelection.h,
      cropSelection.x,
      cropSelection.y,
      cropSelection.w,
      cropSelection.h,
    );

    // Draw selection stroke border
    cropCtx.strokeStyle = FOLIO_COLORS.primary;
    cropCtx.lineWidth = 3;
    cropCtx.setLineDash([6, 6]);
    cropCtx.strokeRect(
      cropSelection.x,
      cropSelection.y,
      cropSelection.w,
      cropSelection.h,
    );
    cropCtx.setLineDash([]);
  }
}

cropCanvasBtn?.addEventListener("click", () => {
  openCropModalForCurrentImage({ forceRescan: true });
});

function closeCropModal() {
  if (!cropModal) return;
  closeModalAndRestore(cropModal);
}

cropModal?.addEventListener("click", (e) => {
  if (e.target === cropModal) closeCropModal();
});

cropModal?.addEventListener("keydown", (e) => {
  trapFocusInModal(cropModal, e);
  if (e.key === "Escape") {
    e.stopPropagation();
    closeCropModal();
  }
});

const getCropMousePos = (e) => {
  const rect = cropCanvas.getBoundingClientRect();
  const scaleX = cropCanvas.width / rect.width;
  const scaleY = cropCanvas.height / rect.height;
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;

  return {
    x: Math.max(0, Math.min(cropCanvas.width, (clientX - rect.left) * scaleX)),
    y: Math.max(0, Math.min(cropCanvas.height, (clientY - rect.top) * scaleY)),
  };
};

cropCanvas?.addEventListener("mousedown", (e) => {
  isCropping = true;
  cropStart = getCropMousePos(e);
  cropSelection = { x: cropStart.x, y: cropStart.y, w: 0, h: 0 };
});

cropCanvas?.addEventListener(
  "touchstart",
  (e) => {
    isCropping = true;
    cropStart = getCropMousePos(e);
    cropSelection = { x: cropStart.x, y: cropStart.y, w: 0, h: 0 };
  },
  { passive: true },
);

window.addEventListener("mousemove", (e) => {
  if (!isCropping) return;
  const currentPos = getCropMousePos(e);
  cropSelection = {
    x: Math.min(cropStart.x, currentPos.x),
    y: Math.min(cropStart.y, currentPos.y),
    w: Math.abs(currentPos.x - cropStart.x),
    h: Math.abs(currentPos.y - cropStart.y),
  };
  drawCropOverlay();
});

window.addEventListener(
  "touchmove",
  (e) => {
    if (!isCropping) return;
    const currentPos = getCropMousePos(e);
    cropSelection = {
      x: Math.min(cropStart.x, currentPos.x),
      y: Math.min(cropStart.y, currentPos.y),
      w: Math.abs(currentPos.x - cropStart.x),
      h: Math.abs(currentPos.y - cropStart.y),
    };
    drawCropOverlay();
  },
  { passive: true },
);

const stopCrop = () => {
  isCropping = false;
};
window.addEventListener("mouseup", stopCrop);
window.addEventListener("touchend", stopCrop);

cancelCropBtn?.addEventListener("click", () => {
  closeCropModal();
});

applyCropBtn?.addEventListener("click", async () => {
  if (!cropSelection || cropSelection.w < 20 || cropSelection.h < 20) {
    showToast("Please select a valid crop region.", "error");
    return;
  }

  const offCanvas = document.createElement("canvas");
  offCanvas.width = cropSelection.w;
  offCanvas.height = cropSelection.h;
  const offCtx = offCanvas.getContext("2d");

  offCtx.drawImage(
    currentLoadedImage,
    cropSelection.x,
    cropSelection.y,
    cropSelection.w,
    cropSelection.h,
    0,
    0,
    cropSelection.w,
    cropSelection.h,
  );

  closeCropModal();

  offCanvas.toBlob(
    async (blob) => {
      if (!blob) {
        showToast("Could not crop image.", "error");
        return;
      }

      const croppedFile = new File([blob], "cropped_shelf.jpg", {
        type: "image/jpeg",
      });
      const shouldForceRescan = cropShouldForceRescan;
      cropShouldForceRescan = true;
      currentUploadedFile = croppedFile;
      currentDetectedSpines = [];

      const img = new Image();
      img.onload = () => {
        shelfCanvas.width = img.width;
        shelfCanvas.height = img.height;
        currentLoadedImage = img;
        redrawCanvasOverlays(null);
        updateScanSteps();
      };
      img.src = URL.createObjectURL(croppedFile);

      document.getElementById("pendingContainer").innerHTML =
        "<p class='scan-loading-text'>Scanning shelf...</p>";
      await runShelfOcr(croppedFile, { forceRescan: shouldForceRescan });
    },
    "image/jpeg",
    0.95,
  );
});

// ==========================================
// 6. DATABASE SAVING & LOADING
// ==========================================
async function navigateToShelfOnMap(shelfId) {
  const mapNavBtn = document.querySelector(
    '.nav-btn[data-target="libraryView"]',
  );
  if (mapNavBtn) mapNavBtn.click();
  await loadLibraryMap();
  if (shelfId) {
    setTimeout(() => zoomToShelfOnMap(shelfId), 350);
  }
}

async function saveShelfToDatabase() {
  if (!requireOnline("Saving shelves")) return;
  if (!currentUploadedFile || currentDetectedSpines.length === 0) {
    showToast("No image or detected books to save.", "error");
    return;
  }

  const shelfName = await promptDialog({
    title: "Name this shelf",
    hint: "Optional — leave blank for Untitled Shelf.",
    initialValue: "",
    label: "Shelf name",
    confirmLabel: "Save shelf",
    cancelLabel: "Cancel",
    allowEmpty: true,
  });
  const resolvedName = resolveShelfName(shelfName);
  if (resolvedName === null) return; // cancelled

  const saveBtns = document.querySelectorAll(".save-shelf-btn");
  saveBtns.forEach((btn) => {
    btn.disabled = true;
    btn.textContent = "Saving Shelf & Books...";
  });
  if (cropCanvasBtn) cropCanvasBtn.disabled = true;

  try {
    let existingShelf = null;
    if (pendingSavedShelfId) {
      const { data } = await supabaseClient
        .from("shelves")
        .select("id, user_id, image_url")
        .eq("id", pendingSavedShelfId)
        .eq("user_id", currentUser.id)
        .maybeSingle();
      existingShelf = data || null;
    }

    const fileName =
      existingShelf?.image_url ||
      (currentUploadedImageHash
        ? `${currentUser.id}/${currentUploadedImageHash}.jpg`
        : `${currentUser.id}/${Date.now()}.jpg`);
    const imagePath = fileName;

    const { error: uploadError } = await supabaseClient.storage
      .from("shelves")
      .upload(fileName, currentUploadedFile, {
        upsert: Boolean(
          currentUploadedImageHash || existingShelf || pendingSavedShelfId,
        ),
      });

    if (uploadError && !isAlreadyExistsError(uploadError)) {
      showToast("Failed to upload shelf image: " + uploadError.message, "error");
      return;
    }

    if (!existingShelf) {
      const { data } = await supabaseClient
        .from("shelves")
        .select("id, user_id, image_url")
        .eq("image_url", imagePath)
        .maybeSingle();
      existingShelf = data || null;
    }

    const spinePayload = {
      name: resolvedName,
      detected_spines: spinesForStorage(currentDetectedSpines),
      dismissed_titles: currentDismissedTitles,
    };

    let shelfId = null;

    if (existingShelf) {
      if (existingShelf.user_id !== currentUser.id) {
        showToast("This shelf image is already saved.", "error");
        return;
      }
      const { error: updateError } = await supabaseClient
        .from("shelves")
        .update(spinePayload)
        .eq("id", existingShelf.id)
        .eq("user_id", currentUser.id);
      if (updateError) {
        showToast("Failed to update shelf: " + updateError.message, "error");
        return;
      }
      shelfId = existingShelf.id;
    } else {
      const { data: shelfData, error: shelfError } = await supabaseClient
        .from("shelves")
        .insert({
          user_id: currentUser.id,
          image_url: imagePath,
          map_width: DEFAULT_SHELF_CARD_WIDTH,
          map_scale: 1,
          ...spinePayload,
        })
        .select()
        .single();

      if (shelfError) {
        if (isAlreadyExistsError(shelfError)) {
          const { data: raced } = await supabaseClient
            .from("shelves")
            .select("id, user_id")
            .eq("image_url", imagePath)
            .maybeSingle();
          if (raced && raced.user_id === currentUser.id) {
            const { error: updateError } = await supabaseClient
              .from("shelves")
              .update(spinePayload)
              .eq("id", raced.id)
              .eq("user_id", currentUser.id);
            if (updateError) {
              showToast("Failed to update shelf: " + updateError.message, "error");
              return;
            }
            shelfId = raced.id;
          } else {
            showToast("Failed to save shelf record: " + shelfError.message, "error");
            return;
          }
        } else {
          showToast("Failed to save shelf record: " + shelfError.message, "error");
          return;
        }
      } else {
        shelfId = shelfData.id;
      }
    }

    pendingSavedShelfId = shelfId;
    const booksError = await saveBooksForShelf(shelfId, imagePath);
    if (booksError) {
      console.error("Failed to insert user_books:", booksError);
      showToast(
        "Shelf saved, but books failed to save. Tap Save again to retry the books.",
        "error",
      );
      return;
    }

    const savedShelfId = shelfId;
    const bookCount = currentDetectedSpines.length;
    pendingSavedShelfId = null;
    showToast(`Saved "${resolvedName}" with ${bookCount} book(s).`, "success");

    const queueNext =
      isPremiumPlan() && scanQueue.length > 0 ? scanQueue.shift() : null;

    resetScanWorkspace();
    await loadLibraryData();

    if (queueNext) {
      showToast(
        `Saved. Loading next photo (${scanQueue.length + 1} left in queue).`,
        "info",
      );
      beginScanForFile(queueNext);
    } else {
      await navigateToShelfOnMap(savedShelfId);
    }
  } catch (err) {
    console.error("Save failed:", err);
    showToast("An unexpected error occurred while saving.", "error");
  } finally {
    updateScanSteps();
  }
}

function getLibraryFilterQuery() {
  return (document.getElementById("searchInput")?.value || "").trim().toLowerCase();
}

function getFilteredLibraryBooks() {
  const query = getLibraryFilterQuery();
  if (!query) return myLibrary;
  return myLibrary.filter((book) => {
    const title = (book.title || "").toLowerCase();
    const author = (book.author || "").toLowerCase();
    return title.includes(query) || author.includes(query);
  });
}

function refreshLibraryList() {
  renderLibraryList(getFilteredLibraryBooks());
}

async function applyCatalogMatchToLibraryBook(book, match) {
  if (!requireOnline("Book updates")) return false;
  const updates = { title: match.title };
  if (match.thumbnail) updates.cover = match.thumbnail;
  if (match.authors) updates.author = match.authors;

  let { error } = await supabaseClient
    .from("user_books")
    .update(updates)
    .eq("id", book.id)
    .eq("user_id", currentUser.id);

  if (error && /author/i.test(error.message)) {
    const { author, ...withoutAuthor } = updates;
    const retry = await supabaseClient
      .from("user_books")
      .update(withoutAuthor)
      .eq("id", book.id)
      .eq("user_id", currentUser.id);
    error = retry.error;
  }

  if (error && /cover_url|'cover'/i.test(error.message)) {
    const retry = await supabaseClient
      .from("user_books")
      .update({ title: match.title, ...(match.authors ? { author: match.authors } : {}) })
      .eq("id", book.id)
      .eq("user_id", currentUser.id);
    error = retry.error;
  }

  if (error) {
    showToast("Failed to update book: " + error.message, "error");
    return false;
  }

  book.title = match.title;
  if (match.thumbnail) book.cover = match.thumbnail;
  if (match.authors) book.author = match.authors;
  const stored = myLibrary.find((entry) => entry.id === book.id);
  if (stored) {
    stored.title = match.title;
    if (match.thumbnail) stored.cover = match.thumbnail;
    if (match.authors) stored.author = match.authors;
  }

  refreshLibraryList();
  await persistOfflineSnapshot();
  if (
    document.getElementById("libraryView")?.classList.contains("active-view")
  ) {
    loadLibraryMap();
  }
  showToast(`Updated to "${match.title}".`, "success");
  return true;
}

async function runBookLookupSearch() {
  if (!requireOnline("Book search")) return;
  const input = document.getElementById("bookLookupInput");
  const results = document.getElementById("bookLookupResults");
  const searchBtn = document.getElementById("bookLookupSearchBtn");
  if (!input || !results) return;

  const query = input.value.trim();
  if (!query) {
    results.innerHTML =
      "<span class='search-status-error'>Enter a title to search.</span>";
    return;
  }

  results.innerHTML =
    "<span class='search-status'>Searching Google Books...</span>";
  if (searchBtn) searchBtn.disabled = true;

  try {
    const books = await searchBooksByQuery(query);
    renderBookSearchCards(results, books, {
      confirmLabel: "Use this book",
      onConfirm: async (match) => {
        if (!bookLookupTarget) return;
        const updated = await applyCatalogMatchToLibraryBook(
          bookLookupTarget,
          match,
        );
        if (updated) closeBookLookupModal();
      },
    });
  } catch (err) {
    if (err?.code === "PLAN_LIMIT") {
      showUpgradeModal({
        reason: err.message || "Book search limit reached. Upgrade for more searches.",
        featureCode: "books_rate_limit",
      });
    }
    results.innerHTML =
      "<span class='search-status-error'>Search failed. Try again.</span>";
  } finally {
    if (searchBtn) searchBtn.disabled = false;
  }
}

function closeBookLookupModal() {
  const modal = document.getElementById("bookLookupModal");
  if (!modal) return;
  bookLookupTarget = null;
  closeModalAndRestore(modal);
}

function openBookLookupModal(book) {
  const modal = document.getElementById("bookLookupModal");
  const input = document.getElementById("bookLookupInput");
  const results = document.getElementById("bookLookupResults");
  const hint = document.getElementById("bookLookupHint");
  if (!modal || !input || !book) return;

  bookLookupTarget = book;
  input.value = book.title || "";
  if (results) results.innerHTML = "";
  if (hint) {
    hint.textContent = `Search again and apply a catalog match to "${book.title}".`;
  }
  openModalWithFocus(modal, input);
}

function setupBookLookupModal() {
  const modal = document.getElementById("bookLookupModal");
  const searchBtn = document.getElementById("bookLookupSearchBtn");
  const cancelBtn = document.getElementById("bookLookupCancel");
  const input = document.getElementById("bookLookupInput");
  if (!modal) return;

  searchBtn?.addEventListener("click", () => {
    runBookLookupSearch();
  });
  cancelBtn?.addEventListener("click", () => closeBookLookupModal());
  input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      runBookLookupSearch();
    }
  });
  modal.addEventListener("keydown", (e) => {
    trapFocusInModal(modal, e);
    if (e.key === "Escape") {
      e.stopPropagation();
      closeBookLookupModal();
    }
  });
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeBookLookupModal();
  });
}
setupBookLookupModal();

const SETTINGS_GEAR_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

function closeBookSettingsModal() {
  const modal = document.getElementById("bookSettingsModal");
  if (!modal) return;
  bookSettingsTarget = null;
  closeModalAndRestore(modal);
}

function openBookSettingsModal(book) {
  const modal = document.getElementById("bookSettingsModal");
  const input = document.getElementById("bookSettingsTitleInput");
  const hint = document.getElementById("bookSettingsHint");
  if (!modal || !input || !book) return;

  bookSettingsTarget = book;
  input.value = book.title || "";
  if (hint) {
    hint.textContent = `Edit title, search the catalog, or set a cover for “${book.title || "this book"}”.`;
  }
  openModalWithFocus(modal, input);
}

async function saveBookSettingsTitle() {
  if (!bookSettingsTarget) return;
  if (!requireOnline("Book updates")) return;
  const input = document.getElementById("bookSettingsTitleInput");
  const saveBtn = document.getElementById("bookSettingsSaveTitleBtn");
  const nextTitle = String(input?.value || "").trim();
  if (!nextTitle) {
    showToast("Enter a title before saving.", "error");
    input?.focus();
    return;
  }

  if (saveBtn) saveBtn.disabled = true;
  try {
    const { error } = await supabaseClient
      .from("user_books")
      .update({ title: nextTitle })
      .eq("id", bookSettingsTarget.id)
      .eq("user_id", currentUser.id);

    if (error) {
      showToast("Failed to update title: " + error.message, "error");
      return;
    }

    bookSettingsTarget.title = nextTitle;
    const stored = myLibrary.find((entry) => entry.id === bookSettingsTarget.id);
    if (stored) stored.title = nextTitle;

    refreshLibraryList();
    await persistOfflineSnapshot();
    if (
      document.getElementById("libraryView")?.classList.contains("active-view")
    ) {
      loadLibraryMap();
    }
    if (input) input.value = nextTitle;
    const hint = document.getElementById("bookSettingsHint");
    if (hint) {
      hint.textContent = `Edit title, search the catalog, or set a cover for “${nextTitle}”.`;
    }
    showToast(`Title updated to "${nextTitle}".`, "success");
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

function setupBookSettingsModal() {
  const modal = document.getElementById("bookSettingsModal");
  const closeBtn = document.getElementById("bookSettingsCloseBtn");
  const saveTitleBtn = document.getElementById("bookSettingsSaveTitleBtn");
  const searchBtn = document.getElementById("bookSettingsSearchBtn");
  const coverBtn = document.getElementById("bookSettingsCoverBtn");
  const input = document.getElementById("bookSettingsTitleInput");
  if (!modal) return;

  let pointerDownOnOverlay = false;

  closeBtn?.addEventListener("click", () => closeBookSettingsModal());
  saveTitleBtn?.addEventListener("click", () => {
    saveBookSettingsTitle();
  });
  input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveBookSettingsTitle();
    }
  });
  searchBtn?.addEventListener("click", () => {
    const book = bookSettingsTarget;
    if (!book) return;
    closeBookSettingsModal();
    openBookLookupModal(book);
  });
  coverBtn?.addEventListener("click", () => {
    const book = bookSettingsTarget;
    if (!book) return;
    if (!requirePremiumFeature("Custom cover is Premium-only.", "custom_cover")) {
      return;
    }
    closeBookSettingsModal();
    openCustomCoverModal(book);
  });

  modal.addEventListener("keydown", (e) => {
    trapFocusInModal(modal, e);
    if (e.key === "Escape") {
      e.stopPropagation();
      closeBookSettingsModal();
    }
  });

  // Close only when both press and release happen on the overlay (outside the dialog).
  modal.addEventListener("pointerdown", (e) => {
    pointerDownOnOverlay = e.target === modal;
  });
  modal.addEventListener("pointerup", (e) => {
    if (pointerDownOnOverlay && e.target === modal) {
      closeBookSettingsModal();
    }
    pointerDownOnOverlay = false;
  });
  modal.addEventListener("pointercancel", () => {
    pointerDownOnOverlay = false;
  });
}
setupBookSettingsModal();

function closeCustomCoverModal() {
  const modal = document.getElementById("customCoverModal");
  if (!modal) return;
  customCoverTarget = null;
  closeModalAndRestore(modal);
}

function openCustomCoverModal(book) {
  const modal = document.getElementById("customCoverModal");
  const urlInput = document.getElementById("customCoverUrlInput");
  const fileInput = document.getElementById("customCoverFileInput");
  if (!modal || !urlInput || !fileInput) return;
  customCoverTarget = book;
  urlInput.value = "";
  fileInput.value = "";
  openModalWithFocus(modal, urlInput);
}

async function saveCustomCoverForBook() {
  if (!customCoverTarget) return;
  const urlInput = document.getElementById("customCoverUrlInput");
  const fileInput = document.getElementById("customCoverFileInput");
  let coverValue = String(urlInput?.value || "").trim();

  if (!coverValue && fileInput?.files?.[0]) {
    const file = fileInput.files[0];
    const ext = (file.name.split(".").pop() || "jpg").replace(/[^\w]/g, "");
    const path = `${currentUser.id}/covers/${customCoverTarget.id}-${Date.now()}.${ext}`;
    const { error: uploadError } = await supabaseClient.storage
      .from("shelves")
      .upload(path, file, { upsert: true });
    if (uploadError) {
      showToast("Failed to upload cover image.", "error");
      return;
    }
    coverValue = path;
  }

  if (!coverValue) {
    showToast("Provide a URL or upload an image.", "error");
    return;
  }

  try {
    const response = await authenticatedFetch(`/api/books/${customCoverTarget.id}/cover`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cover: coverValue }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (data.code === "FEATURE_LOCKED") {
        showUpgradeModal({
          reason: data.error || "Custom covers require Premium.",
          featureCode: "custom_cover",
        });
      }
      throw new Error(data.error || "Cover update failed");
    }
    customCoverTarget.cover = coverValue;
    const inLibrary = myLibrary.find((item) => item.id === customCoverTarget.id);
    if (inLibrary) inLibrary.cover = coverValue;
    closeCustomCoverModal();
    refreshLibraryList();
    loadLibraryMap();
    showToast("Custom cover saved.", "success");
  } catch (error) {
    showToast(error.message || "Could not save cover.", "error");
  }
}

function setupCustomCoverModal() {
  const modal = document.getElementById("customCoverModal");
  document.getElementById("customCoverCancelBtn")?.addEventListener("click", closeCustomCoverModal);
  document.getElementById("customCoverSaveBtn")?.addEventListener("click", () => {
    saveCustomCoverForBook();
  });
  modal?.addEventListener("click", (e) => {
    if (e.target === modal) closeCustomCoverModal();
  });
  modal?.addEventListener("keydown", (e) => {
    trapFocusInModal(modal, e);
    if (e.key === "Escape") {
      e.stopPropagation();
      closeCustomCoverModal();
    }
  });
}
setupCustomCoverModal();

function closeShareModal() {
  const modal = document.getElementById("shareModal");
  if (!modal) return;
  closeModalAndRestore(modal);
}

async function loadShareLinks() {
  const list = document.getElementById("shareLinksList");
  if (!list) return;
  list.innerHTML = "<li class='manager-list-item'>Loading...</li>";
  try {
    const response = await authenticatedFetch("/api/shares");
    const data = await response.json().catch(() => []);
    if (!response.ok) {
      if (data.code === "FEATURE_LOCKED") {
        showUpgradeModal({
          reason: data.error || "Share links require Premium.",
          featureCode: "share_link",
        });
        closeShareModal();
      }
      throw new Error(data.error || "Failed to load share links");
    }
    list.innerHTML = "";
    (data || []).forEach((item) => {
      const li = document.createElement("li");
      li.className = "manager-list-item";
      const shareUrl = `${window.location.origin}/share/${item.token}`;
      li.innerHTML = `
        <span class="manager-shelf-name"></span>
        <div class="manager-shelf-actions">
          <button class="modal-edit-btn" type="button">Copy</button>
          <button class="modal-del-btn" type="button">Revoke</button>
        </div>
      `;
      li.querySelector(".manager-shelf-name").textContent = shareUrl;
      li.querySelector(".modal-edit-btn").addEventListener("click", async () => {
        await navigator.clipboard?.writeText(shareUrl);
        showToast("Share link copied.", "success");
      });
      li.querySelector(".modal-del-btn").addEventListener("click", async () => {
        const responseDelete = await authenticatedFetch(`/api/shares/${item.id}`, {
          method: "DELETE",
        });
        if (responseDelete.ok) {
          li.remove();
          showToast("Share link revoked.", "success");
        }
      });
      list.appendChild(li);
    });
    if (!list.children.length) {
      list.innerHTML = "<li class='manager-list-item'>No share links yet.</li>";
    }
  } catch (error) {
    list.innerHTML = "<li class='manager-list-item'>Could not load share links.</li>";
  }
}

function setupShareModal() {
  const openBtn = document.getElementById("shareLibraryBtn");
  const modal = document.getElementById("shareModal");
  const createBtn = document.getElementById("createShareBtn");
  const closeBtn = document.getElementById("shareModalCloseBtn");
  openBtn?.addEventListener("click", async () => {
    if (!requirePremiumFeature("Read-only share links are Premium.", "share_link")) return;
    openModalWithFocus(modal, createBtn);
    await loadShareLinks();
  });
  createBtn?.addEventListener("click", async () => {
    try {
      const response = await authenticatedFetch("/api/shares", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ libraryId: selectedRoomId ? Number(selectedRoomId) : null }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Failed to create share");
      await loadShareLinks();
      if (data.url) {
        await navigator.clipboard?.writeText(data.url);
        showToast("Share link created and copied.", "success");
      }
    } catch (error) {
      showToast(error.message || "Could not create share link.", "error");
    }
  });
  closeBtn?.addEventListener("click", closeShareModal);
  modal?.addEventListener("click", (e) => {
    if (e.target === modal) closeShareModal();
  });
  modal?.addEventListener("keydown", (e) => {
    trapFocusInModal(modal, e);
    if (e.key === "Escape") {
      e.stopPropagation();
      closeShareModal();
    }
  });
}
setupShareModal();

async function loadLibraryData() {
  if (!currentUser?.id) return;
  try {
    if (isOfflineActive()) throw new Error("offline");
    const { data, error } = await supabaseClient
      .from("user_books")
      .select("*")
      .eq("user_id", currentUser.id);
    if (error) throw error;
    myLibrary = data || [];
    setOfflineMode(false);
    if (offlineStore) {
      const coverEntries = listCoverPrefetchEntries().filter((entry) =>
        /^https?:\/\//i.test(entry.sourceUrl),
      );
      offlineStore.prefetchMedia(coverEntries).catch(() => {});
    }
    await persistOfflineSnapshot();
  } catch (error) {
    if (offlineStore) {
      const snapshot = await offlineStore.getSnapshot(currentUser.id);
      if (snapshot?.books) {
        myLibrary = snapshot.books;
        setOfflineMode(true);
      } else {
        myLibrary = [];
      }
    } else {
      myLibrary = [];
    }
  }
  refreshLibraryList();
}

function renderRoomFilter() {
  const roomFilter = document.getElementById("roomFilterSelect");
  if (!roomFilter) return;
  const previous = selectedRoomId;
  roomFilter.innerHTML = "";
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "All rooms";
  roomFilter.appendChild(all);
  if (!isPremiumPlan()) {
    const only = document.createElement("option");
    only.value = "default";
    only.textContent = "Default room";
    roomFilter.appendChild(only);
  } else {
    myRooms.forEach((room) => {
      const option = document.createElement("option");
      option.value = String(room.id);
      option.textContent = room.name || "Untitled room";
      roomFilter.appendChild(option);
    });
  }
  roomFilter.value = previous || "";
}

async function loadRooms() {
  if (!currentUser?.id || isOfflineActive()) {
    myRooms = [];
    renderRoomFilter();
    return;
  }
  try {
    const response = await authenticatedFetch("/api/rooms");
    const data = await response.json().catch(() => []);
    if (!response.ok) {
      throw new Error(data.error || "Failed to load rooms");
    }
    myRooms = Array.isArray(data) ? data : [];
  } catch {
    myRooms = [];
  }
  renderRoomFilter();
}

async function deleteBookFromLibrary(bookId) {
  if (!requireOnline("Deleting books")) return false;
  const { error } = await supabaseClient
    .from("user_books")
    .delete()
    .eq("id", bookId)
    .eq("user_id", currentUser.id);

  if (error) {
    showToast("Failed to delete book: " + error.message, "error");
    return false;
  }

  myLibrary = myLibrary.filter((b) => b.id !== bookId);
  refreshLibraryList();

  if (
    document.getElementById("libraryView")?.classList.contains("active-view")
  ) {
    loadLibraryMap();
  }
  await persistOfflineSnapshot();
  return true;
}

function renderLibraryList(books) {
  const list = document.getElementById("libraryList");
  if (!list) return;

  list.innerHTML = "";
  books.forEach((book) => {
    const li = document.createElement("li");
    li.className = "library-row";
    li.tabIndex = 0;
    li.setAttribute("role", "button");
    li.setAttribute("aria-label", `Locate ${book.title} on the map`);

    const titleSpan = document.createElement("span");
    titleSpan.className = "library-row-title";
    titleSpan.textContent = book.title;
    titleSpan.title = book.title || "";

    const actions = document.createElement("div");
    actions.className = "library-row-actions";

    const settingsBtn = document.createElement("button");
    settingsBtn.className = "library-settings-btn";
    settingsBtn.type = "button";
    settingsBtn.innerHTML = SETTINGS_GEAR_SVG;
    settingsBtn.title = `Book settings for ${book.title}`;
    settingsBtn.setAttribute("aria-label", `Book settings for ${book.title}`);
    settingsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openBookSettingsModal(book);
    });

    const delBtn = document.createElement("button");
    delBtn.className = "library-delete-btn";
    delBtn.type = "button";
    delBtn.innerHTML = "🗑️";
    delBtn.title = `Delete ${book.title}`;
    delBtn.setAttribute("aria-label", `Delete ${book.title} from library`);

    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const confirmed = await confirmDialog({
        title: "Delete book?",
        message: `Delete "${book.title}" from library?`,
        confirmLabel: "Delete",
      });
      if (!confirmed) return;
      const deleted = await deleteBookFromLibrary(book.id);
      if (deleted) showToast(`Deleted "${book.title}".`, "success");
    });

    const activate = () => {
      if (
        !document.getElementById("libraryView").classList.contains("active-view")
      ) {
        showToast(`Selected: ${book.title}`, "info");
        return;
      }
      // Collapse the mobile drawer so the book is visible when we zoom.
      if (window.innerWidth <= 768) setMobileSheetCollapsed(true);
      requestAnimationFrame(() => zoomToBookOnMap(book));
    };
    li.addEventListener("click", activate);
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activate();
      }
    });

    li.appendChild(titleSpan);
    actions.appendChild(settingsBtn);
    actions.appendChild(delBtn);
    li.appendChild(actions);
    list.appendChild(li);
  });
}

document.getElementById("searchInput")?.addEventListener("input", () => {
  refreshLibraryList();
});

document.getElementById("exportCsvBtn")?.addEventListener("click", () => {
  exportLibraryAsCsv();
  showToast("CSV export downloaded.", "success");
  closeLibraryExportMenu();
});

document.getElementById("exportJsonBtn")?.addEventListener("click", () => {
  exportLibraryAsJson();
  showToast("JSON export downloaded.", "success");
  closeLibraryExportMenu();
});

let libraryExportMenuHome = null;

function closeLibraryExportMenu() {
  const panel = document.getElementById("exportMenuPanel");
  const btn = document.getElementById("exportMenuBtn");
  panel?.classList.add("hidden-element");
  btn?.setAttribute("aria-expanded", "false");
  if (panel && libraryExportMenuHome && panel.parentElement !== libraryExportMenuHome) {
    libraryExportMenuHome.appendChild(panel);
  }
  if (panel) {
    panel.style.top = "";
    panel.style.left = "";
    panel.style.right = "";
  }
}

function positionLibraryExportMenu() {
  const panel = document.getElementById("exportMenuPanel");
  const btn = document.getElementById("exportMenuBtn");
  if (!panel || !btn) return;
  if (!libraryExportMenuHome) {
    libraryExportMenuHome = panel.parentElement;
  }
  // Portal to body so sidebar backdrop-filter / map transforms are not a fixed containing block.
  if (panel.parentElement !== document.body) {
    document.body.appendChild(panel);
  }
  const rect = btn.getBoundingClientRect();
  panel.style.position = "fixed";
  panel.style.top = `${Math.round(rect.bottom + 4)}px`;
  panel.style.right = "auto";
  // Measure after visible + in body; align panel's right edge with the button.
  const width = panel.offsetWidth || 140;
  panel.style.left = `${Math.round(rect.right - width)}px`;
}

function toggleLibraryExportMenu() {
  const panel = document.getElementById("exportMenuPanel");
  const btn = document.getElementById("exportMenuBtn");
  if (!panel || !btn) return;
  const open = panel.classList.contains("hidden-element");
  panel.classList.toggle("hidden-element", !open);
  btn.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) {
    positionLibraryExportMenu();
  } else {
    closeLibraryExportMenu();
  }
}

document.getElementById("exportMenuBtn")?.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleLibraryExportMenu();
});

document.addEventListener("click", (e) => {
  const menu = document.querySelector(".library-export-menu");
  const panel = document.getElementById("exportMenuPanel");
  const btn = document.getElementById("exportMenuBtn");
  if (panel?.contains(e.target) || btn?.contains(e.target) || menu?.contains(e.target)) {
    return;
  }
  closeLibraryExportMenu();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeLibraryExportMenu();
});

document.getElementById("roomFilterSelect")?.addEventListener("change", (e) => {
  selectedRoomId = e.target.value || "";
  loadLibraryMap();
});

document.getElementById("newRoomBtn")?.addEventListener("click", async () => {
  if (!requirePremiumFeature("Rooms are Premium only.", "rooms")) return;
  const name = await promptDialog({
    title: "Create room",
    hint: "Name your room (for example: Living room).",
    initialValue: "",
    label: "Room name",
  });
  if (!name) return;
  try {
    const response = await authenticatedFetch("/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Failed to create room");
    await loadRooms();
    selectedRoomId = String(data.id);
    renderRoomFilter();
    await loadLibraryMap();
    showToast("Room created.", "success");
  } catch (error) {
    showToast(error.message || "Could not create room.", "error");
  }
});

// ==========================================
// 7. INFINITE 2D LIBRARY MAP ENGINE
// ==========================================
const infiniteMap = document.getElementById("infiniteMap");
const mapViewport = document.getElementById("mapViewport");

let mapState = {
  x: 0,
  y: 0,
  scale: 1,
  isDragging: false,
  startX: 0,
  startY: 0,
  isPinching: false,
  pinchStartDist: 0,
  pinchStartScale: 1,
  pinchCenterX: 0,
  pinchCenterY: 0,
};
const MAP_VIEW_STORAGE_KEY = "hilibrary-map-view";
let mapViewSaveTimer = null;

function persistMapView(mode) {
  try {
    window.clearTimeout(mapViewSaveTimer);
    const payload =
      mode === "fit"
        ? { mode: "fit" }
        : { mode: "custom", x: mapState.x, y: mapState.y, scale: mapState.scale };
    window.localStorage?.setItem(MAP_VIEW_STORAGE_KEY, JSON.stringify(payload));
  } catch (err) {
    /* storage unavailable */
  }
}

function persistMapViewCustomSoon() {
  window.clearTimeout(mapViewSaveTimer);
  mapViewSaveTimer = window.setTimeout(() => persistMapView("custom"), 150);
}

function readSavedMapView() {
  try {
    const raw = window.localStorage?.getItem(MAP_VIEW_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.mode === "fit") return { mode: "fit" };
    const x = Number(parsed?.x);
    const y = Number(parsed?.y);
    const scale = Number(parsed?.scale);
    if (
      parsed?.mode === "custom" &&
      Number.isFinite(x) &&
      Number.isFinite(y) &&
      Number.isFinite(scale)
    ) {
      return { mode: "custom", x, y, scale };
    }
  } catch (err) {
    /* storage unavailable */
  }
  return null;
}
let activeShelfDrag = null;
let activeShelfResize = null;
let activeMapEditPoint = null;
let activeSelectedBookId = null;
let shelfImageObserver = null;

const getPos = (e) => ({
  x: e.touches ? e.touches[0].clientX : e.clientX,
  y: e.touches ? e.touches[0].clientY : e.clientY,
});

// Deselects active selection and restores default overlays without removing polygon paths
function deselectAllMapBooks() {
  activeSelectedBookId = null;
  document.querySelectorAll(".book-popover").forEach((el) => el.remove());

  document.querySelectorAll(".shelf-svg-overlay").forEach((svg) => {
    svg.querySelectorAll("circle").forEach((c) => c.remove());
    svg.querySelectorAll("polygon").forEach((poly) => {
      poly.setAttribute("fill", FOLIO_COLORS.mapDefaultFill);
      poly.setAttribute("stroke", FOLIO_COLORS.primary);
      poly.setAttribute("stroke-width", "2");
    });
  });
}

function redrawMapFocus(shelfWrapper, focusedEl) {
  if (!shelfWrapper) return;
  shelfWrapper.querySelectorAll("polygon").forEach((poly) => {
    if (poly === focusedEl) poly.setAttribute("stroke-width", "4");
    else if (poly.getAttribute("stroke") === FOLIO_COLORS.success) poly.setAttribute("stroke-width", "3");
    else poly.setAttribute("stroke-width", "2");
  });
}

function whenShelfImageReady(shelfWrapper, callback) {
  if (!shelfWrapper) return;
  const img = shelfWrapper.querySelector(".shelf-img");
  const run = () => requestAnimationFrame(() => callback());
  shelfWrapper._revealShelfImage?.();
  if (img?.complete && img.naturalWidth) {
    run();
    return;
  }
  img?.addEventListener("load", run, { once: true });
  img?.addEventListener("error", run, { once: true });
}

function zoomToShelfOnMap(shelfId) {
  const shelfWrapper = document.querySelector(`[data-shelf-id="${shelfId}"]`);
  if (!shelfWrapper) return;
  whenShelfImageReady(shelfWrapper, () => {

  const shelfLeft = parseFloat(shelfWrapper.style.left);
  const shelfTop = parseFloat(shelfWrapper.style.top);
  const shelfW = shelfWrapper.offsetWidth || 300;
  const shelfH = shelfWrapper.offsetHeight || 200;

  const rect = infiniteMap.getBoundingClientRect();
  const targetScale = Math.min(
    1.2,
    Math.max(0.15, (rect.width * 0.8) / Math.max(shelfW, 1)),
  );
  mapState.scale = targetScale;

  mapState.x = rect.width / 2 - (shelfLeft + shelfW / 2) * targetScale;
  mapState.y = rect.height / 2 - (shelfTop + shelfH / 2) * targetScale;

  mapViewport.style.transition = "transform 0.4s ease-in-out";
  mapViewport.style.transform = `translate(${mapState.x}px, ${mapState.y}px) scale(${mapState.scale})`;
  persistMapView("custom");

  shelfWrapper.style.border = `2px solid ${FOLIO_COLORS.success}`;
  setTimeout(() => {
    mapViewport.style.transition = "none";
    shelfWrapper.style.border = "1px solid #e4e4e7";
  }, 1200);
  });
}

async function loadLibraryMap() {
  if (!currentUser || !mapViewport) return;

  let shelves = [];
  try {
    if (isOfflineActive()) throw new Error("offline");
    const query = supabaseClient
      .from("shelves")
      .select("*, user_books(*)")
      .eq("user_id", currentUser.id);
    if (isPremiumPlan() && selectedRoomId) {
      query.eq("library_id", Number(selectedRoomId));
    }
    const response = await query;
    if (response.error) throw response.error;
    shelves = response.data || [];
    setOfflineMode(false);
  } catch (error) {
    if (offlineStore) {
      const snapshot = await offlineStore.getSnapshot(currentUser.id);
      shelves = snapshot?.shelves || [];
      if (isPremiumPlan() && selectedRoomId) {
        shelves = shelves.filter((shelf) => String(shelf.library_id || "") === selectedRoomId);
      }
      if (shelves.length > 0) setOfflineMode(true);
    }
  }

  mapViewport.innerHTML = "";

  if (shelfImageObserver) {
    shelfImageObserver.disconnect();
    shelfImageObserver = null;
  }
  if (typeof IntersectionObserver === "function" && infiniteMap) {
    shelfImageObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target._revealShelfImage?.();
          shelfImageObserver?.unobserve(entry.target);
        });
      },
      { root: infiniteMap, rootMargin: "400px", threshold: 0 },
    );
  }

  const shelfList = shelves || [];
  lastShelvesSnapshot = shelfList;
  const uniquePaths = Array.from(
    new Set(
      shelfList
        .map((shelf) => storagePathFromShelfImage(shelf.image_url))
        .filter(Boolean),
    ),
  );
  const signedUrlByPath = new Map();
  if (uniquePaths.length > 0 && !isOfflineActive()) {
    const { data: signedRows, error: signedError } = await supabaseClient.storage
      .from("shelves")
      .createSignedUrls(uniquePaths, 3600);
    if (signedError) {
      console.warn("Failed to sign shelf images:", signedError.message);
    } else {
      (signedRows || []).forEach((row) => {
        if (row?.path && row?.signedUrl) {
          signedUrlByPath.set(row.path, row.signedUrl);
        }
      });
    }
  }
  if (offlineStore && uniquePaths.length > 0) {
    const prefetchLimit = isPremiumPlan() ? uniquePaths.length : Math.min(uniquePaths.length, 2);
    const entries = uniquePaths
      .slice(0, prefetchLimit)
      .map((pathValue) => ({
        cacheKey: mediaCacheKeyForShelfPath(pathValue),
        sourceUrl: signedUrlByPath.get(pathValue) || "",
      }))
      .filter((entry) => entry.cacheKey && entry.sourceUrl);
    offlineStore.prefetchMedia(entries).catch(() => {});
  }

  await renderScanPastShelves(shelfList, signedUrlByPath);

  shelfList.forEach((shelf, index) => {
    const startX = shelf.map_x ?? index * 350 + 50;
    const startY = shelf.map_y ?? 50;

    const shelfWrapper = document.createElement("div");
    shelfWrapper.dataset.shelfId = shelf.id;
    shelfWrapper.className = "shelf-card";
    shelfWrapper.tabIndex = 0;
    shelfWrapper.setAttribute("role", "group");
    shelfWrapper.setAttribute(
      "aria-label",
      `Shelf ${shelf.name || "Untitled Shelf"}. Use arrow keys to move, Enter to rename.`,
    );
    shelfWrapper.style.left = `${startX}px`;
    shelfWrapper.style.top = `${startY}px`;

    shelfWrapper.innerHTML = `
      <div class="shelf-card-header">
        <span class="shelf-name shelf-card-name"></span>
        <div class="shelf-card-actions">
          <button class="rescan-shelf-btn shelf-icon-btn shelf-icon-btn-rescan" type="button" title="Re-run OCR Scan" aria-label="Re-run OCR scan for this shelf">🔄</button>
          <button class="edit-name-btn shelf-icon-btn shelf-icon-btn-rename" type="button" title="Rename shelf" aria-label="Rename this shelf">✏️</button>
          <button class="delete-shelf-btn shelf-icon-btn shelf-icon-btn-delete" type="button" title="Delete Shelf" aria-label="Delete this shelf and all its books">🗑️</button>
        </div>
      </div>
      <div class="shelf-room-row"></div>
      <div class="shelf-img-wrap">
        <img draggable="false" alt="" class="shelf-img" />
        <svg class="shelf-svg-overlay" aria-hidden="true"></svg>
        <button class="shelf-resize-handle" type="button" aria-label="Resize shelf image"></button>
      </div>
    `;
    shelfWrapper.querySelector(".shelf-name").textContent =
      shelf.name || "Untitled Shelf";
    const shelfRoomRow = shelfWrapper.querySelector(".shelf-room-row");
    if (isPremiumPlan() && shelfRoomRow) {
      const select = document.createElement("select");
      select.className = "auth-input modal-input";
      select.innerHTML = `<option value="">Unassigned</option>`;
      myRooms.forEach((room) => {
        const option = document.createElement("option");
        option.value = String(room.id);
        option.textContent = room.name || "Untitled room";
        if (String(shelf.library_id || "") === String(room.id)) {
          option.selected = true;
        }
        select.appendChild(option);
      });
      select.addEventListener("change", async () => {
        const roomId = select.value ? Number(select.value) : null;
        if (!roomId) return;
        try {
          const response = await authenticatedFetch("/api/rooms/assign", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ shelfId: shelf.id, roomId }),
          });
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || "Failed to assign room");
          shelf.library_id = roomId;
          showToast("Shelf moved to room.", "success");
          loadLibraryMap();
        } catch (error) {
          showToast(error.message || "Room assignment failed.", "error");
        }
      });
      shelfRoomRow.appendChild(select);
    }

    // Keyboard: arrows nudge the shelf; Enter renames.
    shelfWrapper.addEventListener("keydown", (e) => {
      if (e.target.closest("button")) return;
      const step = e.shiftKey ? 1 : 10;
      let handled = true;
      let left = parseFloat(shelfWrapper.style.left || "0");
      let top = parseFloat(shelfWrapper.style.top || "0");
      if (e.key === "ArrowLeft") left -= step;
      else if (e.key === "ArrowRight") left += step;
      else if (e.key === "ArrowUp") top -= step;
      else if (e.key === "ArrowDown") top += step;
      else if (e.key === "Enter") {
        shelfWrapper.querySelector(".edit-name-btn")?.click();
      } else handled = false;
      if (!handled) return;
      e.preventDefault();
      if (e.key.startsWith("Arrow")) {
        shelfWrapper.style.left = `${left}px`;
        shelfWrapper.style.top = `${top}px`;
        if (requireOnline("", false)) {
          supabaseClient
            .from("shelves")
            .update({ map_x: left, map_y: top })
            .eq("id", shelf.id)
            .eq("user_id", currentUser.id)
            .then();
        }
      }
    });

    shelfWrapper
      .querySelector(".rescan-shelf-btn")
      .addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!requireOnline("Shelf rescan")) return;
        const confirmed = await confirmDialog({
          title: "Re-run scan?",
          message:
            "Re-run scan on this shelf? This will open the scan workspace with fresh spine detections.",
          confirmLabel: "Re-scan",
          cancelLabel: "Cancel",
        });
        if (!confirmed) return;

        const scanNavBtn = document.querySelector(
          '.nav-btn[data-target="uploadView"]',
        );
        if (scanNavBtn) scanNavBtn.click();

        document.getElementById("pendingContainer").innerHTML =
          "<p class='scan-loading-text'>Fetching shelf image for re-scan...</p>";
        updateScanSteps();

        try {
          const shelfImagePath = storagePathFromShelfImage(shelf.image_url);
          const shelfMediaCacheKey = mediaCacheKeyForShelfPath(shelfImagePath);
          const signedShelfImageUrl =
            signedUrlByPath.get(shelfImagePath) ||
            (await createShelfSignedUrl(shelfImagePath));
          if (!signedShelfImageUrl) {
            showToast("Could not access shelf image for re-scan.", "error");
            return;
          }
          const sourceUrl = offlineStore
            ? await offlineStore.getOrCacheMediaBlobUrl(
                shelfMediaCacheKey,
                signedShelfImageUrl,
              )
            : signedShelfImageUrl;
          const response = await fetch(sourceUrl || signedShelfImageUrl);
          const blob = await response.blob();
          const file = new File([blob], "rescan_shelf.jpg", {
            type: "image/jpeg",
          });

          currentUploadedFile = file;
          pendingSavedShelfId = shelf.id;
          currentDismissedTitles = Array.isArray(shelf.dismissed_titles)
            ? shelf.dismissed_titles
                .map((title) => String(title || "").trim())
                .filter(Boolean)
            : [];
          placeholderText.style.display = "none";
          shelfCanvas.style.display = "block";
          setCanvasChromeVisible(true);
          updateScanSteps();

          await new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
              shelfCanvas.width = img.width;
              shelfCanvas.height = img.height;
              currentLoadedImage = img;
              redrawCanvasOverlays(null);
              updateScanSteps();
              resolve();
            };
            img.onerror = () => reject(new Error("Could not load shelf image"));
            img.src = URL.createObjectURL(file);
          });

          await runShelfOcr(file, { forceRescan: true });
          currentDetectedSpines = applyDismissedTitles(
            currentDetectedSpines,
            currentDismissedTitles,
          );
          renderDetectedSpines();
        } catch (err) {
          console.error("Rescan failed:", err);
          showToast(err.message || "Rescan failed. Try again.", "error");
          document.getElementById("pendingContainer").innerHTML =
            "<p class='empty-state'>Rescan failed. Try again from the map.</p>";
        }
      });

    shelfWrapper
      .querySelector(".edit-name-btn")
      .addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!requireOnline("Shelf rename")) return;
        const newName = await promptDialog({
          title: "Rename shelf",
          hint: "Enter a name for this shelf.",
          initialValue: shelf.name || "Untitled Shelf",
          label: "Shelf name",
        });
        if (newName)
          updateShelfName(
            shelf.id,
            newName,
            shelfWrapper.querySelector(".shelf-name"),
          );
      });

    shelfWrapper
      .querySelector(".delete-shelf-btn")
      .addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!requireOnline("Shelf deletion")) return;
        const confirmed = await confirmDialog({
          title: "Delete shelf?",
          message: "Delete this shelf and all its books?",
          confirmLabel: "Delete",
        });
        if (!confirmed) return;
        await supabaseClient
          .from("user_books")
          .delete()
          .eq("shelf_id", shelf.id)
          .eq("user_id", currentUser.id);
        await supabaseClient
          .from("shelves")
          .delete()
          .eq("id", shelf.id)
          .eq("user_id", currentUser.id);
        shelfWrapper.remove();
        showToast("Shelf deleted.", "success");
        loadLibraryData();
      });

    const imgElement = shelfWrapper.querySelector("img");
    const applyShelfWidth = (widthPx) => {
      const width = Math.max(MIN_SHELF_CARD_WIDTH, Math.round(widthPx));
      shelfWrapper.style.width = `${width}px`;
      return width;
    };
    applyShelfWidth(shelfDisplayWidth(shelf));

    imgElement.alt = shelf.name || "Shelf photo";
    imgElement.decoding = "async";
    imgElement.loading = "lazy";
    const shelfImagePath = storagePathFromShelfImage(shelf.image_url);
    const shelfMediaCacheKey = mediaCacheKeyForShelfPath(shelfImagePath);
    imgElement.dataset.path = shelfImagePath;
    imgElement.dataset.cacheKey = shelfMediaCacheKey;
    imgElement.dataset.src = signedUrlByPath.get(shelfImagePath) || "";

    const revealShelfImage = async () => {
      if (imgElement.dataset.loaded === "1") return;
      if (!imgElement.dataset.src && imgElement.dataset.path && !isOfflineActive()) {
        createShelfSignedUrl(imgElement.dataset.path).then((signedUrl) => {
          if (signedUrl) {
            imgElement.dataset.src = signedUrl;
            revealShelfImage().catch(() => {});
          }
        });
        return;
      }
      let resolvedSrc = imgElement.dataset.src;
      if (offlineStore && shelfMediaCacheKey) {
        if (isOfflineActive()) {
          resolvedSrc =
            (await offlineStore.getCachedMediaBlobUrl(shelfMediaCacheKey)) ||
            resolvedSrc;
        } else if (resolvedSrc) {
          resolvedSrc =
            (await offlineStore.getOrCacheMediaBlobUrl(
              shelfMediaCacheKey,
              resolvedSrc,
            )) || resolvedSrc;
        }
      }
      if (!resolvedSrc) return;
      imgElement.dataset.loaded = "1";
      imgElement.loading = "eager";
      imgElement.onload = () => {
        renderShelfSvgOverlays(
          shelfWrapper,
          shelf.user_books || [],
          activeSelectedBookId,
          false,
        );
      };
      imgElement.src = resolvedSrc;
    };
    shelfWrapper._revealShelfImage = () => {
      revealShelfImage().catch(() => {});
    };

    const resizeHandle = shelfWrapper.querySelector(".shelf-resize-handle");
    const initShelfResize = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const pos = getPos(e);
      activeShelfResize = {
        element: shelfWrapper,
        id: shelf.id,
        startX: pos.x,
        startWidth: shelfWrapper.offsetWidth,
        books: shelf.user_books || [],
      };
    };
    resizeHandle?.addEventListener("mousedown", initShelfResize);
    resizeHandle?.addEventListener("touchstart", initShelfResize, {
      passive: false,
    });

    const initShelfDrag = (e) => {
      if (
        e.target.closest("svg") ||
        e.target.closest("button") ||
        e.target.closest(".book-popover") ||
        e.target.closest(".shelf-resize-handle")
      )
        return;
      e.stopPropagation();
      const pos = getPos(e);
      activeShelfDrag = {
        element: shelfWrapper,
        id: shelf.id,
        startX: pos.x,
        startY: pos.y,
        initialLeft: parseFloat(shelfWrapper.style.left),
        initialTop: parseFloat(shelfWrapper.style.top),
      };
      shelfWrapper.classList.add("is-dragging");
    };
    shelfWrapper.addEventListener("mousedown", initShelfDrag);
    shelfWrapper.addEventListener("touchstart", initShelfDrag, {
      passive: false,
    });

    mapViewport.appendChild(shelfWrapper);

    if (shelfImageObserver) {
      shelfImageObserver.observe(shelfWrapper);
    } else {
      revealShelfImage().catch(() => {});
    }
  });

  updateMapEmptyState((shelves || []).length);
  await persistOfflineSnapshot();
  requestAnimationFrame(() => applyDefaultMapView());
}

function updateMapEmptyState(shelfCount) {
  const emptyState = document.getElementById("mapEmptyState");
  if (!emptyState) return;
  const isEmpty = !shelfCount || shelfCount === 0;
  emptyState.classList.toggle("hidden-element", !isEmpty);
  const fitBtn = document.getElementById("mapFitBtn");
  if (fitBtn) fitBtn.disabled = isEmpty;
}

function applyMapTransform() {
  if (!mapViewport) return;
  mapViewport.style.transform = `translate(${mapState.x}px, ${mapState.y}px) scale(${mapState.scale})`;
}

function applyDefaultMapView() {
  if (!infiniteMap || infiniteMap.offsetWidth === 0) return;
  const saved = readSavedMapView();
  if (saved?.mode === "custom") {
    mapState.x = saved.x;
    mapState.y = saved.y;
    mapState.scale = Math.min(Math.max(0.1, saved.scale), 5);
    applyMapTransform();
    return;
  }
  fitMapToShelves({ persist: false });
}

function zoomMapByFactor(factor) {
  if (!infiniteMap) return;
  const rect = infiniteMap.getBoundingClientRect();
  const centerX = rect.width / 2;
  const centerY = rect.height / 2;
  const newScale = Math.min(Math.max(0.1, mapState.scale * factor), 5);
  mapState.x = centerX - (centerX - mapState.x) * (newScale / mapState.scale);
  mapState.y = centerY - (centerY - mapState.y) * (newScale / mapState.scale);
  mapState.scale = newScale;
  applyMapTransform();
  persistMapViewCustomSoon();
}

function fitMapToShelves({ persist = true } = {}) {
  if (!infiniteMap) return;
  const shelves = Array.from(mapViewport?.querySelectorAll("[data-shelf-id]") || []);
  if (shelves.length === 0) return;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  shelves.forEach((el) => {
    const left = parseFloat(el.style.left || "0");
    const top = parseFloat(el.style.top || "0");
    const width = el.offsetWidth || 320;
    const height = el.offsetHeight || 260;
    minX = Math.min(minX, left);
    minY = Math.min(minY, top);
    maxX = Math.max(maxX, left + width);
    maxY = Math.max(maxY, top + height);
  });
  const rect = infiniteMap.getBoundingClientRect();
  const padding = 48;
  const contentWidth = Math.max(1, maxX - minX + padding * 2);
  const contentHeight = Math.max(1, maxY - minY + padding * 2);
  const fitScale = Math.min(Math.max(0.1, Math.min(rect.width / contentWidth, rect.height / contentHeight)), 2);
  mapState.scale = fitScale;
  mapState.x = rect.width / 2 - (minX + (maxX - minX) / 2) * fitScale;
  mapState.y = rect.height / 2 - (minY + (maxY - minY) / 2) * fitScale;
  applyMapTransform();
  if (persist) persistMapView("fit");
}

function setupMapDiscoverability() {
  const hint = document.getElementById("mapHint");
  const hintClose = document.getElementById("mapHintClose");
  try {
    if (window.localStorage?.getItem("hilibrary-map-hint-dismissed") === "1" && hint) {
      hint.style.display = "none";
    }
  } catch (err) {
    /* storage unavailable */
  }
  hintClose?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (hint) hint.style.display = "none";
    try {
      window.localStorage?.setItem("hilibrary-map-hint-dismissed", "1");
    } catch (err) {
      /* storage unavailable */
    }
  });

  document.getElementById("mapZoomIn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    zoomMapByFactor(1.25);
  });
  document.getElementById("mapZoomOut")?.addEventListener("click", (e) => {
    e.stopPropagation();
    zoomMapByFactor(1 / 1.25);
  });
  document.getElementById("mapFitBtn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    fitMapToShelves();
  });
  document.getElementById("emptyScanBtn")?.addEventListener("click", () => {
    const scanNavBtn = document.querySelector('.nav-btn[data-target="uploadView"]');
    if (scanNavBtn) scanNavBtn.click();
  });
  updateMapEmptyState(mapViewport?.querySelectorAll("[data-shelf-id]").length || 0);

  // Keyboard-accessible map pan/zoom (Step 8).
  infiniteMap?.addEventListener("keydown", (e) => {
    if (e.target.closest("button, input, [role='dialog'], .shelf-card")) return;
    const panStep = e.shiftKey ? 10 : 60;
    let handled = true;
    if (e.key === "ArrowLeft") mapState.x += panStep;
    else if (e.key === "ArrowRight") mapState.x -= panStep;
    else if (e.key === "ArrowUp") mapState.y += panStep;
    else if (e.key === "ArrowDown") mapState.y -= panStep;
    else if (e.key === "+" || e.key === "=") zoomMapByFactor(1.25);
    else if (e.key === "-" || e.key === "_") zoomMapByFactor(1 / 1.25);
    else if (e.key === "f" || e.key === "F" || e.key === "0") fitMapToShelves();
    else if (e.key === "Escape") deselectAllMapBooks();
    else handled = false;
    if (!handled) return;
    e.preventDefault();
    if (e.key.startsWith("Arrow")) {
      applyMapTransform();
      persistMapViewCustomSoon();
    }
  });
  infiniteMap?.addEventListener("focus", () => infiniteMap.classList.add("kb-focus"));
  infiniteMap?.addEventListener("blur", () => infiniteMap.classList.remove("kb-focus"));
}
setupMapDiscoverability();

function showBookActionPopover(shelfWrapper, book, books) {
  shelfWrapper.querySelectorAll(".book-popover").forEach((el) => el.remove());

  const popover = document.createElement("div");
  popover.className = "book-popover";
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", `Actions for ${book.title}`);

  const main = document.createElement("div");
  main.className = "book-popover-main";

  const meta = document.createElement("div");
  meta.className = "book-popover-meta";

  const titleEl = document.createElement("span");
  titleEl.className = "popover-title book-popover-title";
  titleEl.textContent = book.title;
  titleEl.title = book.title || "";

  const actions = document.createElement("div");
  actions.className = "book-popover-actions";
  actions.innerHTML = `
    <button class="popover-settings-btn book-popover-settings" type="button" aria-label="Book settings">${SETTINGS_GEAR_SVG}<span>Settings</span></button>
    <button class="popover-del-btn book-popover-delete" type="button">Delete</button>
    <button class="popover-close-btn book-popover-close" type="button" aria-label="Close book actions">✕</button>
  `;
  actions.querySelector(".popover-settings-btn").setAttribute("aria-label", `Book settings for ${book.title}`);
  actions.querySelector(".popover-del-btn").setAttribute("aria-label", `Delete ${book.title}`);

  meta.appendChild(titleEl);
  meta.appendChild(actions);
  main.appendChild(meta);
  popover.appendChild(main);

  const savedCover = bookCoverSrc(book);
  if (savedCover) {
    const img = createBookCoverImage(savedCover, { hideOnError: true });
    img.classList.add("book-popover-cover");
    img.alt = `Cover of ${book.title || "this book"}`;
    main.prepend(img);
  }

  actions.querySelector(".popover-settings-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    openBookSettingsModal(book);
  });

  popover
    .querySelector(".popover-del-btn")
    .addEventListener("click", async (e) => {
      e.stopPropagation();
      const confirmed = await confirmDialog({
        title: "Delete book?",
        message: `Delete "${book.title}"?`,
        confirmLabel: "Delete",
      });
      if (!confirmed) return;
      const deleted = await deleteBookFromLibrary(book.id);
      if (deleted) popover.remove();
    });

  popover.querySelector(".popover-close-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    deselectAllMapBooks();
  });

  const imgContainer = shelfWrapper.querySelector(".shelf-img-wrap");
  if (!imgContainer) return;

  // Anchor above the selected book (not shelf center).
  const img = shelfWrapper.querySelector(".shelf-img");
  const box = getBookBounds(book);
  if (box && img) {
    const w = img.clientWidth || img.naturalWidth || 280;
    const h =
      img.clientHeight ||
      w * (img.naturalHeight / (img.naturalWidth || 1)) ||
      200;
    const cx = ((box.minX + box.maxX) / 2) * w;
    const topY = box.minY * h;
    popover.style.left = `${cx}px`;
    popover.style.top = `${topY - 8}px`;
  }

  imgContainer.appendChild(popover);
}

function renderShelfSvgOverlays(
  shelfWrapper,
  books,
  activeBookId = null,
  showHandles = false,
) {
  const svg = shelfWrapper.querySelector(".shelf-svg-overlay");
  const img = shelfWrapper.querySelector("img");
  if (!svg || !img) return;

  svg.innerHTML = "";

  const renderedWidth = img.clientWidth || 280;
  const renderedHeight =
    img.clientHeight ||
    renderedWidth * (img.naturalHeight / (img.naturalWidth || 1)) ||
    200;

  books.forEach((book) => {
    let polygonPts = book.polygon;
    if ((!polygonPts || polygonPts.length < 3) && book.bounding_box) {
      const b = book.bounding_box;
      polygonPts = [
        { x: b.minX, y: b.minY },
        { x: b.maxX, y: b.minY },
        { x: b.maxX, y: b.maxY },
        { x: b.minX, y: b.maxY },
      ];
      book.polygon = polygonPts;
    }
    if (!polygonPts || polygonPts.length < 3) return;

    const isSelected = book.id === activeBookId;
    const pointsAttr = polygonPts
      .map((p) => `${p.x * renderedWidth},${p.y * renderedHeight}`)
      .join(" ");

    const polyEl = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "polygon",
    );
    polyEl.setAttribute("points", pointsAttr);
    polyEl.setAttribute(
      "fill",
      isSelected ? FOLIO_COLORS.mapSelectedFill : FOLIO_COLORS.mapDefaultFill,
    );
    polyEl.setAttribute("stroke", isSelected ? FOLIO_COLORS.success : FOLIO_COLORS.primary);
    polyEl.setAttribute("stroke-width", isSelected ? "3" : "2");
    polyEl.style.cursor = "pointer";
    polyEl.style.pointerEvents = "auto";
    polyEl.setAttribute("tabindex", "0");
    polyEl.setAttribute("role", "button");
    polyEl.setAttribute("aria-label", `Select book ${book.title || "untitled"}`);

    const selectBook = (e) => {
      e.stopPropagation();
      zoomToBookOnMap(book, { showHandles: true, books });
    };

    polyEl.addEventListener("mousedown", selectBook);
    polyEl.addEventListener("touchstart", selectBook, { passive: false });
    polyEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectBook(e);
      }
    });
    polyEl.addEventListener("focus", () => {
      redrawMapFocus(shelfWrapper, polyEl);
    });
    polyEl.addEventListener("blur", () => {
      redrawMapFocus(shelfWrapper, null);
    });

    svg.appendChild(polyEl);

    if (isSelected && showHandles) {
      polygonPts.forEach((pt, ptIdx) => {
        const circle = document.createElementNS(
          "http://www.w3.org/2000/svg",
          "circle",
        );
        circle.setAttribute("cx", pt.x * renderedWidth);
        circle.setAttribute("cy", pt.y * renderedHeight);
        circle.setAttribute("r", "8");
        circle.setAttribute("fill", "#ffffff");
        circle.setAttribute("stroke", FOLIO_COLORS.success);
        circle.setAttribute("stroke-width", "3");
        circle.style.cursor = "grab";
        circle.style.pointerEvents = "auto";

        const startPointDrag = (e) => {
          e.stopPropagation();
          activeMapEditPoint = {
            book,
            pointIndex: ptIdx,
            shelfWrapper,
            books,
            imgElement: img,
          };
        };

        circle.addEventListener("mousedown", startPointDrag);
        circle.addEventListener("touchstart", startPointDrag, {
          passive: false,
        });

        svg.appendChild(circle);
      });
    }
  });
}

async function updateShelfName(shelfId, newName, textNode) {
  if (!requireOnline("Shelf rename")) return;
  const { error } = await supabaseClient
    .from("shelves")
    .update({ name: newName })
    .eq("id", shelfId)
    .eq("user_id", currentUser.id);
  if (!error) {
    if (textNode) textNode.textContent = newName;
    const cachedShelf = lastShelvesSnapshot.find((entry) => entry.id === shelfId);
    if (cachedShelf) cachedShelf.name = newName;
    await persistOfflineSnapshot();
  }
}

const initMapDrag = (e) => {
  if (
    e.target.closest(".map-viewport > div") ||
    e.target.closest(".map-controls") ||
    e.target.closest(".map-hint") ||
    e.target.closest(".map-empty-state")
  )
    return;

  // Avoid selecting chrome text (e.g. Fit) while panning across the map.
  if (e.cancelable) e.preventDefault();
  window.getSelection?.()?.removeAllRanges?.();

  deselectAllMapBooks();

  // Pinch-to-zoom start
  if (e.touches && e.touches.length === 2) {
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    mapState.pinchStartDist = Math.hypot(dx, dy);
    mapState.pinchStartScale = mapState.scale;

    const rect = infiniteMap.getBoundingClientRect();
    mapState.pinchCenterX =
      (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
    mapState.pinchCenterY =
      (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;

    mapState.isPinching = true;
    mapState.isDragging = false;
    return;
  }

  // Standard pan start
  const pos = getPos(e);
  mapState.isDragging = true;
  mapState.isPinching = false;
  mapState.startX = pos.x - mapState.x;
  mapState.startY = pos.y - mapState.y;
  infiniteMap.style.cursor = "grabbing";
};
infiniteMap?.addEventListener("mousedown", initMapDrag);
infiniteMap?.addEventListener("touchstart", initMapDrag, { passive: false });
const handleMove = (e) => {
  // Existing active point edit block
  if (activeMapEditPoint) {
    if (e.touches) e.preventDefault();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;

    const imgRect = activeMapEditPoint.imgElement.getBoundingClientRect();
    const normX = Math.max(
      0,
      Math.min(1, (clientX - imgRect.left) / imgRect.width),
    );
    const normY = Math.max(
      0,
      Math.min(1, (clientY - imgRect.top) / imgRect.height),
    );

    const book = activeMapEditPoint.book;
    book.polygon[activeMapEditPoint.pointIndex] = { x: normX, y: normY };

    const xs = book.polygon.map((p) => p.x);
    const ys = book.polygon.map((p) => p.y);
    book.bounding_box = {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
    };

    renderShelfSvgOverlays(
      activeMapEditPoint.shelfWrapper,
      activeMapEditPoint.books,
      book.id,
      true,
    );
    return;
  }

  // Pinch-to-zoom move calculation
  if (mapState.isPinching && e.touches && e.touches.length === 2) {
    e.preventDefault();
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    const dist = Math.hypot(dx, dy);

    const newScale = Math.min(
      Math.max(
        0.1,
        mapState.pinchStartScale * (dist / mapState.pinchStartDist),
      ),
      5,
    );

    mapState.x =
      mapState.pinchCenterX -
      (mapState.pinchCenterX - mapState.x) * (newScale / mapState.scale);
    mapState.y =
      mapState.pinchCenterY -
      (mapState.pinchCenterY - mapState.y) * (newScale / mapState.scale);
    mapState.scale = newScale;

    mapViewport.style.transform = `translate(${mapState.x}px, ${mapState.y}px) scale(${mapState.scale})`;
    return;
  }

  if (activeShelfResize) {
    if (e.touches) e.preventDefault();
    const pos = getPos(e);
    const dx = (pos.x - activeShelfResize.startX) / mapState.scale;
    const width = Math.max(
      MIN_SHELF_CARD_WIDTH,
      activeShelfResize.startWidth + dx,
    );
    activeShelfResize.element.style.width = `${Math.round(width)}px`;
    renderShelfSvgOverlays(
      activeShelfResize.element,
      activeShelfResize.books,
      activeSelectedBookId,
      Boolean(activeSelectedBookId),
    );
    return;
  }

  if (!activeShelfDrag && !mapState.isDragging) return;
  if (e.touches) e.preventDefault();

  // Ignore single-finger dragging if two fingers are on the screen
  if (mapState.isDragging && e.touches && e.touches.length > 1) return;

  const pos = getPos(e);

  if (activeShelfDrag) {
    const dx = (pos.x - activeShelfDrag.startX) / mapState.scale;
    const dy = (pos.y - activeShelfDrag.startY) / mapState.scale;
    activeShelfDrag.element.style.left = `${activeShelfDrag.initialLeft + dx}px`;
    activeShelfDrag.element.style.top = `${activeShelfDrag.initialTop + dy}px`;
    return;
  }

  if (mapState.isDragging) {
    mapState.x = pos.x - mapState.startX;
    mapState.y = pos.y - mapState.startY;
    mapViewport.style.transform = `translate(${mapState.x}px, ${mapState.y}px) scale(${mapState.scale})`;
  }
};
window.addEventListener("mousemove", handleMove);
window.addEventListener("touchmove", handleMove, { passive: false });

const handleEnd = async () => {
  if (activeMapEditPoint) {
    const book = activeMapEditPoint.book;
    if (requireOnline("", false)) {
      await supabaseClient
        .from("user_books")
        .update({ polygon: book.polygon, bounding_box: book.bounding_box })
        .eq("id", book.id)
        .eq("user_id", currentUser.id);
    }

    activeMapEditPoint = null;
  }

  if (activeShelfResize) {
    const width = Math.round(activeShelfResize.element.offsetWidth);
    if (requireOnline("", false)) {
      supabaseClient
        .from("shelves")
        .update(shelfMapSizePayload(width))
        .eq("id", activeShelfResize.id)
        .eq("user_id", currentUser.id)
        .then(({ error }) => {
          if (error) {
            console.warn("Failed to save shelf size:", error.message);
          }
        });
    }
    activeShelfResize = null;
  }

  if (activeShelfDrag) {
    activeShelfDrag.element.classList.remove("is-dragging");

    const finalX = parseFloat(activeShelfDrag.element.style.left);
    const finalY = parseFloat(activeShelfDrag.element.style.top);
    if (requireOnline("", false)) {
      supabaseClient
        .from("shelves")
        .update({ map_x: finalX, map_y: finalY })
        .eq("id", activeShelfDrag.id)
        .eq("user_id", currentUser.id)
        .then();
    }
    activeShelfDrag = null;
  }

  if (mapState.isPinching) {
    mapState.isPinching = false;
    persistMapView("custom");
  }

  if (mapState.isDragging) {
    mapState.isDragging = false;
    infiniteMap.style.cursor = "grab";
    persistMapView("custom");
  }
};
window.addEventListener("mouseup", handleEnd);
window.addEventListener("touchend", handleEnd);

// Re-enabled Desktop Scroll Wheel Zooming
infiniteMap?.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const delta = -e.deltaY * 0.0015;
    const newScale = Math.min(Math.max(0.1, mapState.scale + delta), 5);

    const rect = infiniteMap.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    mapState.x = mouseX - (mouseX - mapState.x) * (newScale / mapState.scale);
    mapState.y = mouseY - (mouseY - mapState.y) * (newScale / mapState.scale);
    mapState.scale = newScale;

    mapViewport.style.transform = `translate(${mapState.x}px, ${mapState.y}px) scale(${mapState.scale})`;
    persistMapViewCustomSoon();
  },
  { passive: false },
);

function getBookBounds(book) {
  const box = book.bounding_box || book.boundingBox;
  if (box && Number.isFinite(box.minX) && Number.isFinite(box.maxX)) return box;
  if (book.polygon && book.polygon.length >= 3) {
    const xs = book.polygon.map((p) => p.x);
    const ys = book.polygon.map((p) => p.y);
    return {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
    };
  }
  return null;
}

/** Unscaled offset of `el` inside `ancestor` under the current map transform. */
function mapOffsetWithin(el, ancestor) {
  const scale = mapState.scale || 1;
  const a = ancestor.getBoundingClientRect();
  const e = el.getBoundingClientRect();
  return {
    x: (e.left - a.left) / scale,
    y: (e.top - a.top) / scale,
  };
}

/** Focus point in map viewport coords, avoiding the library sidebar/drawer. */
function getMapFocusCenter() {
  const rect = infiniteMap.getBoundingClientRect();
  let cx = rect.width / 2;
  let cy = rect.height / 2;

  const sidebar = document.querySelector("#libraryView .sidebar");
  if (!sidebar) return { cx, cy, rect };

  const side = sidebar.getBoundingClientRect();
  if (window.innerWidth > 768) {
    const visibleRight = Math.max(0, Math.min(rect.width, side.left - rect.left));
    if (visibleRight > 120) cx = visibleRight / 2;
  } else if (!mobileLibraryContent?.classList.contains("collapsed")) {
    const visibleBottom = Math.max(0, side.top - rect.top);
    if (visibleBottom > 120) cy = visibleBottom / 2;
  }

  return { cx, cy, rect };
}

function zoomToBookOnMap(book, { showHandles = false, books } = {}) {
  const box = getBookBounds(book);
  if (!box) return;

  const shelfWrapper = document.querySelector(
    `[data-shelf-id="${book.shelf_id}"]`,
  );
  if (!shelfWrapper) return;

  whenShelfImageReady(shelfWrapper, () => {
  const imgElement = shelfWrapper.querySelector("img");
  if (!imgElement) return;

  activeSelectedBookId = book.id;

  const renderedWidth = imgElement.clientWidth || imgElement.naturalWidth || 280;
  const renderedHeight =
    imgElement.clientHeight ||
    renderedWidth * (imgElement.naturalHeight / (imgElement.naturalWidth || 1));

  const bookW = Math.max(8, (box.maxX - box.minX) * renderedWidth);
  const bookH = Math.max(8, (box.maxY - box.minY) * renderedHeight);
  const bookCx = ((box.minX + box.maxX) / 2) * renderedWidth;
  const bookCy = ((box.minY + box.maxY) / 2) * renderedHeight;

  // img.offsetLeft/Top are relative to .shelf-img-wrap (position:relative),
  // not the shelf card — so header/room row were skipped. Use rects instead.
  const shelfLeft = parseFloat(shelfWrapper.style.left) || 0;
  const shelfTop = parseFloat(shelfWrapper.style.top) || 0;
  const imgOffset = mapOffsetWithin(imgElement, shelfWrapper);

  const targetX = shelfLeft + imgOffset.x + bookCx;
  const targetY = shelfTop + imgOffset.y + bookCy;

  const { cx, cy, rect } = getMapFocusCenter();
  const targetScale = Math.min(
    5,
    Math.max(
      0.4,
      Math.min((rect.width * 0.45) / bookW, (rect.height * 0.45) / bookH),
    ),
  );
  mapState.scale = targetScale;

  mapState.x = cx - targetX * targetScale;
  mapState.y = cy - targetY * targetScale;

  mapViewport.style.transition = "transform 0.4s ease-in-out";
  applyMapTransform();
  persistMapView("custom");

  setTimeout(() => {
    mapViewport.style.transition = "none";
  }, 400);

  const applySelection = (shelfBooks) => {
    const list = shelfBooks || [];
    renderShelfSvgOverlays(shelfWrapper, list, book.id, showHandles);
    const selectedBook = list.find((b) => b.id === book.id) || book;
    showBookActionPopover(shelfWrapper, selectedBook, list);
  };

  if (books) {
    applySelection(books);
    return;
  }
  if (isOfflineActive()) {
    const shelfBooks = myLibrary.filter((entry) => entry.shelf_id === book.shelf_id);
    applySelection(shelfBooks);
  } else {
    supabaseClient
      .from("user_books")
      .select("*")
      .eq("shelf_id", book.shelf_id)
      .then(({ data: shelfBooks }) => applySelection(shelfBooks));
  }
  });
}

// ==========================================
// 8. SHELF MANAGER MODAL
// ==========================================
const manageShelvesBtn = document.getElementById("manageShelvesBtn");
const shelfManagerModal = document.getElementById("shelfManagerModal");
const closeManagerBtn = document.getElementById("closeManagerBtn");
const shelfManagerList = document.getElementById("shelfManagerList");

manageShelvesBtn?.addEventListener("click", async () => {
  if (!requireOnline("Shelf manager")) return;
  openModalWithFocus(shelfManagerModal);
  shelfManagerList.innerHTML = "<p class='scan-loading-text'>Loading...</p>";

  const { data: shelves } = await supabaseClient
    .from("shelves")
    .select("*")
    .eq("user_id", currentUser.id);
  shelfManagerList.innerHTML = "";

  (shelves || []).forEach((shelf) => {
    const li = document.createElement("li");
    li.className = "manager-list-item";
    li.innerHTML = `
      <span class="manager-shelf-name"></span>
      <div class="manager-shelf-actions">
        <button class="modal-edit-btn" type="button">Rename</button>
        <button class="modal-del-btn" type="button">Delete</button>
      </div>
    `;
    li.querySelector(".manager-shelf-name").textContent =
      shelf.name || "Untitled Shelf";
    li.querySelector(".modal-edit-btn").setAttribute(
      "aria-label",
      `Rename ${shelf.name || "Untitled Shelf"}`,
    );
    li.querySelector(".modal-del-btn").setAttribute(
      "aria-label",
      `Delete ${shelf.name || "Untitled Shelf"}`,
    );

    li.querySelector(".modal-edit-btn").addEventListener("click", async () => {
      if (!requireOnline("Shelf rename")) return;
      const newName = await promptDialog({
        title: "Rename shelf",
        hint: "Enter a new name for this shelf.",
        initialValue: shelf.name || "Untitled Shelf",
        label: "Shelf name",
      });
      if (newName) {
        await updateShelfName(
          shelf.id,
          newName,
          li.querySelector(".manager-shelf-name"),
        );
        showToast("Shelf renamed.", "success");
        loadLibraryMap();
      }
    });

    li.querySelector(".modal-del-btn").addEventListener("click", async () => {
      if (!requireOnline("Shelf deletion")) return;
      const confirmed = await confirmDialog({
        title: "Delete shelf?",
        message: `Delete "${shelf.name || "Untitled Shelf"}"?`,
        confirmLabel: "Delete",
      });
      if (!confirmed) return;
      await supabaseClient
        .from("shelves")
        .delete()
        .eq("id", shelf.id)
        .eq("user_id", currentUser.id);
      li.remove();
      showToast("Shelf deleted.", "success");
      loadLibraryMap();
    });

    shelfManagerList.appendChild(li);
  });
});

function closeShelfManager() {
  if (!shelfManagerModal) return;
  closeModalAndRestore(shelfManagerModal);
}

closeManagerBtn?.addEventListener("click", closeShelfManager);

shelfManagerModal?.addEventListener("click", (e) => {
  if (e.target === shelfManagerModal) {
    closeShelfManager();
  }
});

shelfManagerModal?.addEventListener("keydown", (e) => {
  trapFocusInModal(shelfManagerModal, e);
  if (e.key === "Escape") {
    e.stopPropagation();
    closeShelfManager();
  }
});

// ==========================================
// 9. MOBILE UI INTERACTIONS
// ==========================================
const mobileLibraryToggle = document.getElementById("mobileLibraryToggle");
const mobileLibraryContent = document.getElementById("mobileLibraryContent");

function setMobileSheetCollapsed(collapsed) {
  if (!mobileLibraryContent || !mobileLibraryToggle) return;
  mobileLibraryContent.classList.toggle("collapsed", collapsed);
  mobileLibraryToggle.classList.toggle("collapsed", collapsed);
  mobileLibraryToggle.setAttribute("aria-expanded", String(!collapsed));
}

let wasMobileLibraryLayout = window.innerWidth <= 768;

function applyDefaultMobileSheetState() {
  const isMobile = window.innerWidth <= 768;
  // Only reset when crossing the breakpoint — mobile URL-bar / dvh resizes
  // must not collapse an expanded sheet.
  if (isMobile === wasMobileLibraryLayout) return;
  wasMobileLibraryLayout = isMobile;
  setMobileSheetCollapsed(isMobile);
}

function toggleMobileSheet(e) {
  if (!mobileLibraryContent) return;
  e?.preventDefault?.();
  e?.stopPropagation?.();
  setMobileSheetCollapsed(!mobileLibraryContent.classList.contains("collapsed"));
}

mobileLibraryToggle?.addEventListener("click", toggleMobileSheet);
mobileLibraryToggle?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    toggleMobileSheet(e);
  }
});
window.addEventListener("resize", applyDefaultMobileSheetState);
setMobileSheetCollapsed(wasMobileLibraryLayout);
