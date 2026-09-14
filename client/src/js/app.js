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
let bookLookupTarget = null;
let currentDismissedTitles = [];

const SEARCH_RESULT_LIMIT = 3;
const DEFAULT_SHELF_CARD_WIDTH = 300;
const MIN_SHELF_CARD_WIDTH = 160;
const BOOK_COVER_PLACEHOLDER =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="70"><rect width="100%" height="100%" fill="#e5e7eb"/><text x="50%" y="52%" text-anchor="middle" font-size="9" fill="#71717a">No cover</text></svg>',
  );

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
  img.src = httpsSrc || BOOK_COVER_PLACEHOLDER;
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
  return toHttpsUrl(book?.cover || "");
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

function spinesForStorage(spines) {
  return (spines || []).map((spine) => ({
    title: spine.title || "",
    box: spine.box || spine.boundingBox || null,
    polygon: spine.polygon || null,
    confirmed: Boolean(spine.confirmed),
    confirmedTitle: spine.confirmedTitle || null,
    author: spine.author || null,
    thumbnail: toHttpsUrl(spine.thumbnail) || null,
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
    return {
      title: vol.title || "Unknown Title",
      authors: vol.authors ? vol.authors.join(", ") : "Unknown Author",
      thumbnail: coverUrlFromVolume(vol),
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

    const confirmBtn = document.createElement("button");
    confirmBtn.textContent = confirmLabel;
    confirmBtn.className = "book-confirm-btn";
    confirmBtn.type = "button";
    confirmBtn.setAttribute("aria-label", `${confirmLabel} ${book.title}`);
    confirmBtn.addEventListener("click", () => onConfirm(book));

    infoCol.appendChild(titleEl);
    infoCol.appendChild(authorEl);
    infoCol.appendChild(confirmBtn);

    card.appendChild(createBookCoverImage(book.thumbnail));
    card.appendChild(infoCol);
    container.appendChild(card);
  });
}

async function searchBooksByQuery(query) {
  const res = await authenticatedFetch(
    `/api/books?q=${encodeURIComponent(query)}`,
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Search failed (${res.status})`);
  }
  return parseBookSearchItems(data);
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

function promptDialog({ title = "Rename", hint = "", initialValue = "", confirmLabel = "Save", cancelLabel = "Cancel", label = "Name" } = {}) {
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
      if (typeof result === "string") {
        const trimmed = result.trim();
        resolve(trimmed === "" ? null : trimmed);
      } else {
        resolve(result);
      }
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

  const highResUrl = "../img/anna-hunko-ajE5goOGzZc-unsplash.jpg";
  const imgLoader = new Image();

  imgLoader.onload = () => {
    bgElement.style.backgroundImage = `url('${highResUrl}')`;
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

  if (isSignUpMode) {
    confirmPasswordInput.classList.remove("hidden-element");
    confirmPasswordInput.setAttribute("required", "true");
    passwordInput.setAttribute("minlength", "8");
    passwordInput.setAttribute("autocomplete", "new-password");
    authActionBtn.textContent = "Create Account";
    authToggleText.textContent = "Already have an account?";
    authToggleBtn.textContent = "Log in here";
  } else {
    confirmPasswordInput.classList.add("hidden-element");
    confirmPasswordInput.removeAttribute("required");
    passwordInput.removeAttribute("minlength");
    passwordInput.setAttribute("autocomplete", "current-password");
    authActionBtn.textContent = "Log In";
    authToggleText.textContent = "Don't have an account?";
    authToggleBtn.textContent = "Sign up here";
  }
});

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

      const { error } = await supabaseClient.auth.signUp({ email, password });
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
  const originalText = googleAuthBtnText.textContent;
  googleAuthBtn.disabled = true;
  googleAuthBtnText.textContent = "Connecting...";
  authProviderError.classList.add("hidden-element");
  authProviderError.textContent = "";

  try {
    const redirectTo = `${window.location.origin}${window.location.pathname}`;
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
supabaseClient.auth.onAuthStateChange((event, session) => {
  currentUser = session?.user || null;
  const loggedOutView = document.getElementById("loggedOutView");
  const loggedInView = document.getElementById("loggedInView");

  if (currentUser) {
    loggedOutView.classList.add("hidden-element");
    loggedInView.classList.remove("hidden-element");
    document.getElementById("userEmailDisplay").textContent = currentUser.email;
    loadLibraryData();
    loadLibraryMap();
    updateScanSteps();
  } else {
    loggedOutView.classList.remove("hidden-element");
    loggedInView.classList.add("hidden-element");
  }
});

document.getElementById("logoutBtn")?.addEventListener("click", () => {
  supabaseClient.auth.signOut();
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

// Scan progress: 1 Upload -> 2 Review spines -> 3 Save shelf
function updateScanSteps() {
  const stepsEl = document.getElementById("scanSteps");
  if (!stepsEl) return;
  const hasImage = Boolean(currentLoadedImage || currentUploadedFile);
  const hasSpines = hasImage && currentDetectedSpines.length > 0;
  const states = {
    upload: hasImage ? "done" : "active",
    review: !hasImage ? "todo" : hasSpines ? "done" : "active",
    save: hasSpines ? "active" : "todo",
  };
  stepsEl.querySelectorAll(".scan-step").forEach((step) => {
    const key = step.getAttribute("data-step");
    step.classList.remove("is-active", "is-done");
    if (states[key] === "active") step.classList.add("is-active");
    if (states[key] === "done") step.classList.add("is-done");
    if (states[key] === "active") step.setAttribute("aria-current", "step");
    else step.removeAttribute("aria-current");
  });
}

function showLoadingOverlay(message = "Analyzing bookshelf image with AI...") {
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

// ==========================================
// 5. UPLOAD & SCANNING LOGIC (CANVAS)
// ==========================================
const imageUpload = document.getElementById("imageUpload");
const shelfCanvas = document.getElementById("shelfCanvas");
const ctx = shelfCanvas?.getContext("2d");
const placeholderText = document.getElementById("placeholderText");
const canvasControls = document.getElementById("canvasControls");
const zoomSlider = document.getElementById("zoomSlider");
const resetZoomBtn = document.getElementById("resetZoomBtn");

let currentUploadedFile = null;
let currentLoadedImage = null;
let currentDetectedSpines = [];
let currentUploadedImageHash = null;

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
      ? "#10b981"
      : isHighlighted
        ? "#f59e0b"
        : "#3b82f6";
    const fillColor = isHighlighted
      ? isSelected
        ? "rgba(16, 185, 129, 0.25)"
        : "rgba(245, 158, 11, 0.35)"
      : null;
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
          ctx.strokeStyle = "#10b981";
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

imageUpload?.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  currentUploadedFile = file;
  currentDismissedTitles = [];
  placeholderText.style.display = "none";
  shelfCanvas.style.display = "block";
  canvasControls.classList.remove("hidden-element");
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

  const img = new Image();
  img.onload = () => {
    shelfCanvas.width = img.width;
    shelfCanvas.height = img.height;
    currentLoadedImage = img;
    redrawCanvasOverlays(null);
    updateScanSteps();
  };
  img.src = URL.createObjectURL(file);

  const formData = new FormData();
  formData.append("image", file);

  document.getElementById("pendingContainer").innerHTML =
    "<p class='scan-loading-text'>Scanning shelf...</p>";

  showLoadingOverlay("Scanning shelf image & detecting spines...");

  try {
    const response = await authenticatedFetch("/api/ocr", {
      method: "POST",
      body: formData,
    });
    const data = await response.json();

    if (data.duplicate) {
      showToast(
        "This image is already in your library! Navigating to its location on the map.",
        "info",
      );

      if (ctx && shelfCanvas)
        ctx.clearRect(0, 0, shelfCanvas.width, shelfCanvas.height);
      shelfCanvas.style.display = "none";
      if (placeholderText) placeholderText.style.display = "flex";
      if (canvasControls) canvasControls.classList.add("hidden-element");
      document.getElementById("pendingContainer").innerHTML =
        "<p class='empty-state'>Upload a new image to continue.</p>";
      updateScanSteps();

      const mapNavBtn = document.querySelector(
        '.nav-btn[data-target="libraryView"]',
      );
      if (mapNavBtn) mapNavBtn.click();

      setTimeout(() => {
        zoomToShelfOnMap(data.shelf.id);
      }, 350);
      return;
    }

    currentDetectedSpines = data.spines || [];
    currentUploadedImageHash = data.imageHash || null;
    renderDetectedSpines();
  } catch (err) {
    console.error("Scan failed:", err);
    document.getElementById("pendingContainer").innerHTML =
      "<p class='scan-error'>Scan failed. Check console.</p>";
    updateScanSteps();
  } finally {
    hideLoadingOverlay();
  }
});

// Empty canvas is the upload target: click, keyboard, and drag & drop.
function forwardFileToImageUpload(file) {
  if (!file || !imageUpload) return;
  if (file.type && !file.type.startsWith("image/")) return;
  const transfer = new DataTransfer();
  transfer.items.add(file);
  imageUpload.files = transfer.files;
  imageUpload.dispatchEvent(new Event("change", { bubbles: true }));
}

function setupCanvasDropzone() {
  const dropzone = document.getElementById("canvasDropzone");
  if (!dropzone || !placeholderText || !imageUpload) return;

  const activateUpload = () => imageUpload.click();

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
    const file = e.dataTransfer?.files?.[0];
    if (file) forwardFileToImageUpload(file);
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

  const container = document.getElementById("pendingContainer");
  container.innerHTML = "";
  updateScanSteps();

  if (currentDetectedSpines.length === 0) {
    container.innerHTML = "<p class='empty-state'>No spines detected.</p>";
    return;
  }

  redrawCanvasOverlays(null);

  // Step 2 header: review progress within the 1-2-3 flow
  const stepHint = document.createElement("p");
  stepHint.textContent = "Step 2 of 3 — review each spine, then save the shelf once.";
  stepHint.className = "spines-step-hint";
  container.appendChild(stepHint);

  // Toolbar
  const header = document.createElement("div");
  header.className = "spines-toolbar";

  const titleEl = document.createElement("strong");
  titleEl.className = "spines-title";
  titleEl.textContent = `Detected Spines (${currentDetectedSpines.length})`;

  const batchActions = document.createElement("div");
  batchActions.className = "spines-batch-actions";

  // Mobile Maximize / Minimize Toggle Button (Styled as 32x32px icon button)
  const maximizeBtn = document.createElement("button");
  maximizeBtn.className = "auth-btn secondary-btn maximize-spines-btn spine-icon-btn";
  maximizeBtn.type = "button";

  const updateMaximizeBtn = () => {
    const isMax = container.classList.contains("maximized");
    maximizeBtn.textContent = isMax ? "▼" : "▲";
    maximizeBtn.title = isMax ? "Minimize" : "Maximize";
    maximizeBtn.setAttribute("aria-label", isMax ? "Minimize detected spines" : "Maximize detected spines");
    maximizeBtn.setAttribute("aria-expanded", String(isMax));
  };

  updateMaximizeBtn();

  maximizeBtn.onclick = () => {
    container.classList.toggle("maximized");
    updateMaximizeBtn();
  };

  const searchAllBtn = document.createElement("button");
  searchAllBtn.textContent = "Search All";
  searchAllBtn.className = "auth-btn primary-btn spine-batch-btn";
  searchAllBtn.type = "button";
  searchAllBtn.setAttribute("aria-label", "Search all detected spines in Google Books");

  const skipUnlabeledBtn = document.createElement("button");
  skipUnlabeledBtn.textContent = "Skip Unlabeled";
  skipUnlabeledBtn.className = "auth-btn secondary-btn spine-batch-btn";
  skipUnlabeledBtn.type = "button";
  skipUnlabeledBtn.setAttribute("aria-label", "Remove unlabeled spines from the list");

  searchAllBtn.onclick = () => {
    const searchBtns = container.querySelectorAll(".spine-search-btn");
    searchBtns.forEach((btn) => btn.click());
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
  batchActions.appendChild(maximizeBtn);

  header.appendChild(titleEl);
  header.appendChild(batchActions);
  container.appendChild(header);

  const spinesScroll = document.createElement("div");
  spinesScroll.className = "spines-scroll";
  container.appendChild(spinesScroll);

  currentDetectedSpines.forEach((spine, index) => {
    const div = document.createElement("div");
    div.className = "spine-card";
    if (spine.confirmed) div.classList.add("is-confirmed");

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

    const highlight = () => {
      activeEditingSpineIndex = index;
      div.classList.add("is-highlighted");
      redrawCanvasOverlays(index);
    };

    const unhighlight = () => {
      div.classList.remove("is-highlighted");
      redrawCanvasOverlays(null);
    };

    titleInput.addEventListener("focus", highlight);
    titleInput.addEventListener("click", () => {
      highlight();
      zoomCanvasToSpine(spine);
    });
    titleInput.addEventListener("blur", unhighlight);
    div.addEventListener("mouseenter", highlight);
    div.addEventListener("mouseleave", unhighlight);

    inputRow.appendChild(numberBadge);
    inputRow.appendChild(titleInput);

    const actionRow = document.createElement("div");
    actionRow.className = "spine-actions";

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

    const searchResults = document.createElement("div");
    searchResults.className = "search-results-col";

    searchBtn.onclick = async () => {
      searchResults.innerHTML =
        "<span class='search-status'>Searching Google Books...</span>";
      try {
        const books = await searchBooksByQuery(titleInput.value);
        renderBookSearchCards(searchResults, books, {
          confirmLabel: "Use this book",
          onConfirm: (book) => {
            titleInput.value = book.title;
            spine.title = book.title;
            spine.confirmed = true;
            spine.confirmedTitle = book.title;
            spine.author = book.authors;
            spine.thumbnail = book.thumbnail;
            div.classList.add("is-confirmed");
            searchResults.innerHTML = "";
            renderConfirmedBookRow(searchResults, spine);
            showToast(`"${book.title}" confirmed.`, "success");
          },
        });
      } catch (err) {
        searchResults.innerHTML =
          "<span class='search-status-error'>Search failed.</span>";
      }
    };

    div.appendChild(inputRow);
    div.appendChild(actionRow);
    renderConfirmedBookRow(searchResults, spine);
    div.appendChild(searchResults);
    spinesScroll.appendChild(div);
  });

  // Step 3: one sticky save action for the whole shelf.
  const stickySave = document.createElement("div");
  stickySave.className = "spines-sticky-save";
  const saveBtn = document.createElement("button");
  saveBtn.textContent = `Save Shelf to Library (${currentDetectedSpines.length})`;
  saveBtn.className = "auth-btn primary-btn save-shelf-btn";
  saveBtn.type = "button";
  saveBtn.onclick = saveShelfToDatabase;
  const saveCount = document.createElement("span");
  saveCount.className = "spines-save-count";
  saveCount.textContent = "Step 3 of 3 — all spines above will be saved together.";
  stickySave.appendChild(saveBtn);
  stickySave.appendChild(saveCount);
  container.appendChild(stickySave);
  if (preserveScroll) spinesScroll.scrollTop = savedScrollTop;
}

// ==========================================
// CROP DIALOG ENGINE
// ==========================================
const cropCanvasBtn = document.getElementById("cropCanvasBtn");
const cropModal = document.getElementById("cropModal");
const cropCanvas = document.getElementById("cropCanvas");
const cropCtx = cropCanvas?.getContext("2d");
const cancelCropBtn = document.getElementById("cancelCropBtn");
const applyCropBtn = document.getElementById("applyCropBtn");

let cropSelection = null; // { x, y, w, h } in image pixels
let isCropping = false;
let cropStart = { x: 0, y: 0 };

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
    cropCtx.strokeStyle = "#3b82f6";
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
  if (!currentLoadedImage) {
    showToast("Please upload an image first.", "info");
    return;
  }
  cropCanvas.width =
    currentLoadedImage.naturalWidth || currentLoadedImage.width;
  cropCanvas.height =
    currentLoadedImage.naturalHeight || currentLoadedImage.height;

  // Default crop selection box (center 80%)
  cropSelection = {
    x: Math.round(cropCanvas.width * 0.1),
    y: Math.round(cropCanvas.height * 0.1),
    w: Math.round(cropCanvas.width * 0.8),
    h: Math.round(cropCanvas.height * 0.8),
  };

  drawCropOverlay();
  openModalWithFocus(cropModal, cancelCropBtn);
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

  // Draw cropped image region to offscreen canvas
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
  showLoadingOverlay("Cropping image & re-running AI scan...");

  offCanvas.toBlob(
    async (blob) => {
      if (!blob) return hideLoadingOverlay();

      const croppedFile = new File([blob], "cropped_shelf.jpg", {
        type: "image/jpeg",
      });
      currentUploadedFile = croppedFile;

      // Load cropped preview onto workspace canvas
      const img = new Image();
      img.onload = () => {
        shelfCanvas.width = img.width;
        shelfCanvas.height = img.height;
        currentLoadedImage = img;
        redrawCanvasOverlays(null);
        updateScanSteps();
      };
      img.src = URL.createObjectURL(croppedFile);

      // Trigger API OCR on cropped image
      const formData = new FormData();
      formData.append("image", croppedFile);
      formData.append("force_rescan", "true");

      try {
        const response = await authenticatedFetch("/api/ocr", {
          method: "POST",
          body: formData,
        });
        const data = await response.json();
        currentDetectedSpines = data.spines || [];
        currentUploadedImageHash = data.imageHash || null;
        renderDetectedSpines();
      } catch (err) {
        console.error("Cropped scan failed:", err);
        showToast("Scan failed on cropped image.", "error");
      } finally {
        hideLoadingOverlay();
      }
    },
    "image/jpeg",
    0.95,
  );
});

// ==========================================
// 6. DATABASE SAVING & LOADING
// ==========================================
async function saveShelfToDatabase() {
  if (!currentUploadedFile || currentDetectedSpines.length === 0) {
    showToast("No image or detected books to save.", "error");
    return;
  }

  // Update all save buttons to loading state
  const saveBtns = document.querySelectorAll(".save-shelf-btn");
  saveBtns.forEach(btn => {
    btn.disabled = true;
    btn.textContent = "Saving Shelf & Books...";
  });

  try {
    const fileName = currentUploadedImageHash
      ? `${currentUser.id}/${currentUploadedImageHash}.jpg`
      : `${currentUser.id}/${Date.now()}.jpg`;
    const imagePath = fileName;

    const { data: uploadData, error: uploadError } =
      await supabaseClient.storage
        .from("shelves")
        .upload(fileName, currentUploadedFile, {
          upsert: Boolean(currentUploadedImageHash),
        });

    if (uploadError) {
      showToast("Failed to upload shelf image: " + uploadError.message, "error");
      return;
    }

    const { data: existingShelf } = await supabaseClient
      .from("shelves")
      .select("id, user_id")
      .eq("image_url", imagePath)
      .maybeSingle();

    if (existingShelf) {
      if (existingShelf.user_id !== currentUser.id) {
        showToast("This shelf image is already saved.", "error");
        return;
      }
      const { error: updateError } = await supabaseClient
        .from("shelves")
        .update({
          detected_spines: spinesForStorage(currentDetectedSpines),
          dismissed_titles: currentDismissedTitles,
        })
        .eq("id", existingShelf.id)
        .eq("user_id", currentUser.id);
      if (updateError) {
        showToast("Failed to update shelf: " + updateError.message, "error");
        return;
      }
      showToast("This image is already in your library.", "info");
      currentDetectedSpines = [];
      currentDismissedTitles = [];
      currentUploadedFile = null;
      currentLoadedImage = null;
      currentUploadedImageHash = null;
      document.getElementById("pendingContainer").innerHTML =
        "<p class='empty-state'>Upload a new image to continue.</p>";
      if (ctx && shelfCanvas) {
        ctx.clearRect(0, 0, shelfCanvas.width, shelfCanvas.height);
        shelfCanvas.style.display = "none";
      }
      if (placeholderText) placeholderText.style.display = "flex";
      if (canvasControls) canvasControls.classList.add("hidden-element");
      loadLibraryData();
      return;
    }

    const { data: shelfData, error: shelfError } = await supabaseClient
      .from("shelves")
      .insert({
        user_id: currentUser.id,
        image_url: imagePath,
        detected_spines: spinesForStorage(currentDetectedSpines),
        dismissed_titles: currentDismissedTitles,
        map_width: DEFAULT_SHELF_CARD_WIDTH,
        map_scale: 1,
      })
      .select()
      .single();

    if (shelfError) {
      showToast("Failed to save shelf record: " + shelfError.message, "error");
      return;
    }

    const booksToInsert = currentDetectedSpines.map((spine) => ({
      user_id: currentUser.id,
      shelf_id: shelfData.id,
      title: spine.title?.trim() || "Untitled Book",
      bounding_box: spine.box || spine.boundingBox || null,
      polygon: spine.polygon || null,
      cover: toHttpsUrl(spine.thumbnail) || null,
      shelf_image_url: imagePath,
    }));

    let payload = booksToInsert;
    let { error: booksError } = await supabaseClient
      .from("user_books")
      .insert(payload);

    if (booksError && /cover_url|'cover'/i.test(booksError.message)) {
      payload = payload.map(({ cover, ...rest }) => rest);
      const retry = await supabaseClient.from("user_books").insert(payload);
      booksError = retry.error;
    }

    if (booksError && /polygon/i.test(booksError.message)) {
      payload = payload.map(({ polygon, ...rest }) => rest);
      const retry = await supabaseClient.from("user_books").insert(payload);
      booksError = retry.error;
    }

    if (booksError) {
      console.error("Failed to insert user_books:", booksError);
      showToast("Shelf created, but books failed to save: " + booksError.message, "error");
      return;
    }

    showToast(
      `Successfully saved shelf and ${booksToInsert.length} book(s) to your library!`,
      "success",
    );

    currentDetectedSpines = [];
    currentDismissedTitles = [];
    currentUploadedFile = null;
    currentLoadedImage = null;
    currentUploadedImageHash = null;

    document.getElementById("pendingContainer").innerHTML =
      "<p class='empty-state'>Upload a new image to continue.</p>";

    if (ctx && shelfCanvas) {
      ctx.clearRect(0, 0, shelfCanvas.width, shelfCanvas.height);
      shelfCanvas.style.display = "none";
    }
    if (placeholderText) placeholderText.style.display = "flex";
    if (canvasControls) canvasControls.classList.add("hidden-element");

    loadLibraryData();
 } catch (err) {
    console.error("Save failed:", err);
    showToast("An unexpected error occurred while saving.", "error");
  } finally {
    // Restore the single sticky save button
    const saveBtns = document.querySelectorAll(".save-shelf-btn");
    saveBtns.forEach(btn => {
      btn.disabled = false;
      btn.textContent = currentDetectedSpines.length > 0
        ? `Save Shelf to Library (${currentDetectedSpines.length})`
        : "Save Shelf to Library";
    });
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
  const updates = { title: match.title };
  if (match.thumbnail) updates.cover = match.thumbnail;

  let { error } = await supabaseClient
    .from("user_books")
    .update(updates)
    .eq("id", book.id)
    .eq("user_id", currentUser.id);

  if (error && /cover_url|'cover'/i.test(error.message)) {
    const retry = await supabaseClient
      .from("user_books")
      .update({ title: match.title })
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
  const stored = myLibrary.find((entry) => entry.id === book.id);
  if (stored) {
    stored.title = match.title;
    if (match.thumbnail) stored.cover = match.thumbnail;
  }

  refreshLibraryList();
  if (
    document.getElementById("libraryView")?.classList.contains("active-view")
  ) {
    loadLibraryMap();
  }
  showToast(`Updated to "${match.title}".`, "success");
  return true;
}

async function runBookLookupSearch() {
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

async function loadLibraryData() {
  const { data } = await supabaseClient
    .from("user_books")
    .select("*")
    .eq("user_id", currentUser.id);
  myLibrary = data || [];
  refreshLibraryList();
}

async function deleteBookFromLibrary(bookId) {
  const { error } = await supabaseClient
    .from("user_books")
    .delete()
    .eq("id", bookId)
    .eq("user_id", currentUser.id);

  if (error) {
    showToast("Failed to delete book: " + error.message, "error");
    return;
  }

  myLibrary = myLibrary.filter((b) => b.id !== bookId);
  refreshLibraryList();

  if (
    document.getElementById("libraryView")?.classList.contains("active-view")
  ) {
    loadLibraryMap();
  }
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

    const actions = document.createElement("div");
    actions.className = "library-row-actions";

    const lookupBtn = document.createElement("button");
    lookupBtn.className = "library-lookup-btn";
    lookupBtn.type = "button";
    lookupBtn.textContent = "Search";
    lookupBtn.title = `Search Google Books for ${book.title}`;
    lookupBtn.setAttribute(
      "aria-label",
      `Search Google Books for ${book.title}`,
    );
    lookupBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openBookLookupModal(book);
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
      await deleteBookFromLibrary(book.id);
      showToast(`Deleted "${book.title}".`, "success");
    });

    const activate = () => {
      if (
        document.getElementById("libraryView").classList.contains("active-view")
      ) {
        zoomToBookOnMap(book);
      } else {
        showToast(`Selected: ${book.title}`, "info");
      }
    };
    li.addEventListener("click", activate);
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        activate();
      }
    });

    li.appendChild(titleSpan);
    actions.appendChild(lookupBtn);
    actions.appendChild(delBtn);
    li.appendChild(actions);
    list.appendChild(li);
  });
}

document.getElementById("searchInput")?.addEventListener("input", () => {
  refreshLibraryList();
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
      poly.setAttribute("fill", "rgba(59, 130, 246, 0.2)");
      poly.setAttribute("stroke", "#3b82f6");
      poly.setAttribute("stroke-width", "2");
    });
  });
}

function redrawMapFocus(shelfWrapper, focusedEl) {
  if (!shelfWrapper) return;
  shelfWrapper.querySelectorAll("polygon").forEach((poly) => {
    if (poly === focusedEl) poly.setAttribute("stroke-width", "4");
    else if (poly.getAttribute("stroke") === "#10b981") poly.setAttribute("stroke-width", "3");
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

  shelfWrapper.style.border = "2px solid #10b981";
  setTimeout(() => {
    mapViewport.style.transition = "none";
    shelfWrapper.style.border = "1px solid #e4e4e7";
  }, 1200);
  });
}

async function loadLibraryMap() {
  if (!currentUser || !mapViewport) return;

  const { data: shelves, error } = await supabaseClient
    .from("shelves")
    .select("*, user_books(*)")
    .eq("user_id", currentUser.id);
  if (error) return console.error("Error loading map:", error);

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
  const uniquePaths = Array.from(
    new Set(
      shelfList
        .map((shelf) => storagePathFromShelfImage(shelf.image_url))
        .filter(Boolean),
    ),
  );
  const signedUrlByPath = new Map();
  if (uniquePaths.length > 0) {
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
      <div class="shelf-img-wrap">
        <img draggable="false" alt="" class="shelf-img" />
        <svg class="shelf-svg-overlay" aria-hidden="true"></svg>
        <button class="shelf-resize-handle" type="button" aria-label="Resize shelf image"></button>
      </div>
    `;
    shelfWrapper.querySelector(".shelf-name").textContent =
      shelf.name || "Untitled Shelf";

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
        supabaseClient
          .from("shelves")
          .update({ map_x: left, map_y: top })
          .eq("id", shelf.id)
          .eq("user_id", currentUser.id)
          .then();
      }
    });

    shelfWrapper
      .querySelector(".rescan-shelf-btn")
      .addEventListener("click", async (e) => {
        e.stopPropagation();
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

        const shelfImagePath = storagePathFromShelfImage(shelf.image_url);
        const signedShelfImageUrl =
          signedUrlByPath.get(shelfImagePath) ||
          (await createShelfSignedUrl(shelfImagePath));
        if (!signedShelfImageUrl) {
          showToast("Could not access shelf image for re-scan.", "error");
          return;
        }
        const response = await fetch(signedShelfImageUrl);
        const blob = await response.blob();
        const file = new File([blob], "rescan_shelf.jpg", {
          type: "image/jpeg",
        });

        currentUploadedFile = file;
        placeholderText.style.display = "none";
        shelfCanvas.style.display = "block";
        canvasControls.classList.remove("hidden-element");
        updateScanSteps();

        const img = new Image();
        img.onload = () => {
          shelfCanvas.width = img.width;
          shelfCanvas.height = img.height;
          currentLoadedImage = img;
          redrawCanvasOverlays(null);
          updateScanSteps();
        };
        img.src = URL.createObjectURL(file);

        const formData = new FormData();
        formData.append("image", file);
        formData.append("force_rescan", "true");

        const scanRes = await authenticatedFetch("/api/ocr", {
          method: "POST",
          body: formData,
        });
        const scanData = await scanRes.json();

        currentDismissedTitles = Array.isArray(shelf.dismissed_titles)
          ? shelf.dismissed_titles
              .map((title) => String(title || "").trim())
              .filter(Boolean)
          : [];
        currentDetectedSpines = applyDismissedTitles(
          scanData.spines || [],
          currentDismissedTitles,
        );
        currentUploadedImageHash = scanData.imageHash || null;
        renderDetectedSpines();
      });

    shelfWrapper
      .querySelector(".edit-name-btn")
      .addEventListener("click", async (e) => {
        e.stopPropagation();
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
    imgElement.dataset.path = shelfImagePath;
    imgElement.dataset.src = signedUrlByPath.get(shelfImagePath) || "";

    const revealShelfImage = () => {
      if (imgElement.dataset.loaded === "1") return;
      if (!imgElement.dataset.src && imgElement.dataset.path) {
        createShelfSignedUrl(imgElement.dataset.path).then((signedUrl) => {
          if (signedUrl) {
            imgElement.dataset.src = signedUrl;
            revealShelfImage();
          }
        });
        return;
      }
      if (!imgElement.dataset.src) return;
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
      imgElement.src = imgElement.dataset.src;
    };
    shelfWrapper._revealShelfImage = revealShelfImage;

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
      revealShelfImage();
    }
  });

  updateMapEmptyState((shelves || []).length);
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
}

function fitMapToShelves() {
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
    if (e.key.startsWith("Arrow")) applyMapTransform();
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

  const actions = document.createElement("div");
  actions.className = "book-popover-actions";
  actions.innerHTML = `
    <button class="popover-search-btn book-popover-search" type="button">Search</button>
    <button class="popover-del-btn book-popover-delete" type="button">Delete</button>
    <button class="popover-close-btn book-popover-close" type="button" aria-label="Close book actions">✕</button>
  `;
  actions.querySelector(".popover-search-btn").setAttribute("aria-label", `Search Google Books for ${book.title}`);
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

  actions.querySelector(".popover-search-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    openBookLookupModal(book);
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
      await deleteBookFromLibrary(book.id);
      popover.remove();
    });

  popover.querySelector(".popover-close-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    deselectAllMapBooks();
  });

  const imgContainer = shelfWrapper.querySelector(".shelf-img-wrap");
  if (imgContainer) imgContainer.appendChild(popover);
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
      isSelected ? "rgba(16, 185, 129, 0.35)" : "rgba(59, 130, 246, 0.2)",
    );
    polyEl.setAttribute("stroke", isSelected ? "#10b981" : "#3b82f6");
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
        circle.setAttribute("stroke", "#10b981");
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
  const { error } = await supabaseClient
    .from("shelves")
    .update({ name: newName })
    .eq("id", shelfId)
    .eq("user_id", currentUser.id);
  if (!error && textNode) textNode.textContent = newName;
}

const initMapDrag = (e) => {
  if (
    e.target.closest(".map-viewport > div") ||
    e.target.closest(".map-controls")
  )
    return;

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
    await supabaseClient
      .from("user_books")
      .update({ polygon: book.polygon, bounding_box: book.bounding_box })
      .eq("id", book.id)
      .eq("user_id", currentUser.id);

    activeMapEditPoint = null;
  }

  if (activeShelfResize) {
    const width = Math.round(activeShelfResize.element.offsetWidth);
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
    activeShelfResize = null;
  }

  if (activeShelfDrag) {
    activeShelfDrag.element.classList.remove("is-dragging");

    const finalX = parseFloat(activeShelfDrag.element.style.left);
    const finalY = parseFloat(activeShelfDrag.element.style.top);
    supabaseClient
      .from("shelves")
      .update({ map_x: finalX, map_y: finalY })
      .eq("id", activeShelfDrag.id)
      .eq("user_id", currentUser.id)
      .then();
    activeShelfDrag = null;
  }

  if (mapState.isPinching) {
    mapState.isPinching = false;
  }

  if (mapState.isDragging) {
    mapState.isDragging = false;
    infiniteMap.style.cursor = "grab";
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

  const shelfLeft = parseFloat(shelfWrapper.style.left) || 0;
  const shelfTop = parseFloat(shelfWrapper.style.top) || 0;
  const imgLeft = imgElement.offsetLeft || 0;
  const imgTop = imgElement.offsetTop || 0;

  const targetX = shelfLeft + imgLeft + bookCx;
  const targetY = shelfTop + imgTop + bookCy;

  const rect = infiniteMap.getBoundingClientRect();
  const targetScale = Math.min(
    5,
    Math.max(
      0.4,
      Math.min((rect.width * 0.45) / bookW, (rect.height * 0.45) / bookH),
    ),
  );
  mapState.scale = targetScale;

  mapState.x = rect.width / 2 - targetX * targetScale;
  mapState.y = rect.height / 2 - targetY * targetScale;

  mapViewport.style.transition = "transform 0.4s ease-in-out";
  mapViewport.style.transform = `translate(${mapState.x}px, ${mapState.y}px) scale(${mapState.scale})`;

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

  supabaseClient
    .from("user_books")
    .select("*")
    .eq("shelf_id", book.shelf_id)
    .then(({ data: shelfBooks }) => applySelection(shelfBooks));
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

function applyDefaultMobileSheetState() {
  if (window.innerWidth <= 768) setMobileSheetCollapsed(true);
  else setMobileSheetCollapsed(false);
}

function toggleMobileSheet() {
  if (window.innerWidth > 768 || !mobileLibraryContent) return;
  setMobileSheetCollapsed(!mobileLibraryContent.classList.contains("collapsed"));
}

mobileLibraryToggle?.addEventListener("click", toggleMobileSheet);
mobileLibraryToggle?.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    toggleMobileSheet();
  }
});
window.addEventListener("resize", applyDefaultMobileSheetState);
applyDefaultMobileSheetState();
