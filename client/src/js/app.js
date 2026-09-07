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

passwordInput.addEventListener("input", checkPasswordMatch);
confirmPasswordInput.addEventListener("input", checkPasswordMatch);

authToggleBtn?.addEventListener("click", () => {
  isSignUpMode = !isSignUpMode;

  passwordError.classList.add("hidden-element");
  confirmPasswordInput.value = "";
  passwordInput.value = "";

  if (isSignUpMode) {
    confirmPasswordInput.classList.remove("hidden-element");
    confirmPasswordInput.setAttribute("required", "true");
    authActionBtn.textContent = "Create Account";
    authToggleText.textContent = "Already have an account?";
    authToggleBtn.textContent = "Log in here";
  } else {
    confirmPasswordInput.classList.add("hidden-element");
    confirmPasswordInput.removeAttribute("required");
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
      if (password !== confirmPassword) return;

      const { error } = await supabaseClient.auth.signUp({ email, password });
      if (error) {
        alert("Sign up error: " + error.message);
      } else {
        alert("Account created successfully! You can now log in.");
        authToggleBtn.click();
      }
    } else {
      const { error } = await supabaseClient.auth.signInWithPassword({
        email,
        password,
      });
      if (error) {
        alert("Login error: " + error.message);
      }
    }
  } finally {
    authActionBtn.textContent = originalText;
    authActionBtn.disabled = false;
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
    // FIX: Use currentTarget to ensure we target the button, not the SVG path inside it
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

// Canvas Viewport & Editing State
let canvasState = {
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  isDragging: false,
  startX: 0,
  startY: 0,
};

let activeEditingSpineIndex = null;
let activeControlPoint = null; // { spineIndex, pointIndex }

// Helper to convert screen clicks to normalized (0-1) canvas image coordinates
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

// Ray-casting point-in-polygon algorithm for hit detection
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

// Re-computes spine bounding box after vertex dragging
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

// Base canvas redraw helper with polygon editing handles
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
        : "#3b82f6"; // Green for active editing, Gold for focus, Blue for default
    const fillColor = isHighlighted
      ? isSelected
        ? "rgba(16, 185, 129, 0.25)"
        : "rgba(245, 158, 11, 0.35)"
      : null;
    const lineWidth =
      (isHighlighted ? baseThickness * 2 : baseThickness) / canvasState.scale;

    // Draw polygon boundary
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

      // Render draggable control circles for the active spine
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

// Zoom Controls
zoomSlider?.addEventListener("input", (e) => {
  canvasState.scale = parseFloat(e.target.value);
  redrawCanvasOverlays(null);
});

resetZoomBtn?.addEventListener("click", () => {
  canvasState.scale = 1;
  canvasState.offsetX = 0;
  canvasState.offsetY = 0;
  if (zoomSlider) zoomSlider.value = "1";
  redrawCanvasOverlays(null);
});

// Canvas Interaction: Point Editing & Panning Handlers
const startCanvasDrag = (e) => {
  const norm = getNormalizedCanvasCoords(e);

  // 1. Check if user clicked a control handle on the currently active spine
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
        return; // Lock drag to control point
      }
    }
  }

  // 2. Check if user clicked inside any spine polygon to select it
  const clickedSpineIdx = currentDetectedSpines.findIndex((spine) => {
    // Auto-convert box to polygon if needed
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

    // Scroll sidebar item into view
    const sidebarCards = document.querySelectorAll("#pendingContainer > div");
    sidebarCards[clickedSpineIdx + 1]?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
    });
    return;
  }

  // 3. Clicked background space -> Deselect & initiate image panning
  activeEditingSpineIndex = null;
  redrawCanvasOverlays(null);

  const pos = e.touches
    ? { x: e.touches[0].clientX, y: e.touches[0].clientY }
    : { x: e.clientX, y: e.clientY };
  const factor = shelfCanvas.width / shelfCanvas.getBoundingClientRect().width;
  canvasState.isDragging = true;
  canvasState.startX = pos.x - canvasState.offsetX / factor;
  canvasState.startY = pos.y - canvasState.offsetY / factor;
};

const moveCanvasDrag = (e) => {
  // A. Dragging a Polygon Vertex Control Point
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

  // B. Panning Canvas Viewport
  if (canvasState.isDragging) {
    if (e.touches) e.preventDefault();
    const pos = e.touches
      ? { x: e.touches[0].clientX, y: e.touches[0].clientY }
      : { x: e.clientX, y: e.clientY };
    const factor =
      shelfCanvas.width / shelfCanvas.getBoundingClientRect().width;

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

// File Upload Handler
imageUpload?.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  currentUploadedFile = file;
  placeholderText.style.display = "none";
  shelfCanvas.style.display = "block";
  canvasControls.classList.remove("hidden-element");

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
  };
  img.src = URL.createObjectURL(file);

  const formData = new FormData();
  formData.append("image", file);

  document.getElementById("pendingContainer").innerHTML =
    "<p style='text-align:center;'>Scanning shelf...</p>";

  try {
    const response = await fetch("/api/ocr", {
      method: "POST",
      body: formData,
    });
    const data = await response.json();
    currentDetectedSpines = data.spines || [];
    renderDetectedSpines();
  } catch (err) {
    console.error("Scan failed:", err);
    document.getElementById("pendingContainer").innerHTML =
      "<p style='color:red;'>Scan failed. Check console.</p>";
  }
});

function renderDetectedSpines() {
  const container = document.getElementById("pendingContainer");
  container.innerHTML = "";

  if (currentDetectedSpines.length === 0) {
    container.innerHTML = "<p class='empty-state'>No spines detected.</p>";
    return;
  }

  redrawCanvasOverlays(null);

  const header = document.createElement("div");
  header.innerHTML = `<strong>Detected Spines (${currentDetectedSpines.length})</strong>`;
  header.style.marginBottom = "12px";
  header.style.color = "#3f3f46";
  container.appendChild(header);

  currentDetectedSpines.forEach((spine, index) => {
    const div = document.createElement("div");
    div.style.padding = "12px";
    div.style.marginBottom = "8px";
    div.style.border = "1px solid #e4e4e7";
    div.style.borderRadius = "8px";
    div.style.backgroundColor = "white";
    div.style.transition = "border-color 0.2s, box-shadow 0.2s";

    const inputRow = document.createElement("div");
    inputRow.style.display = "flex";
    inputRow.style.alignItems = "center";
    inputRow.style.gap = "8px";
    inputRow.style.marginBottom = "8px";

    const numberBadge = document.createElement("div");
    numberBadge.textContent = index + 1;
    numberBadge.style.background = "#8b5cf6";
    numberBadge.style.color = "white";
    numberBadge.style.width = "24px";
    numberBadge.style.height = "24px";
    numberBadge.style.borderRadius = "50%";
    numberBadge.style.display = "flex";
    numberBadge.style.alignItems = "center";
    numberBadge.style.justifyContent = "center";
    numberBadge.style.fontSize = "0.8rem";
    numberBadge.style.fontWeight = "bold";
    numberBadge.style.flexShrink = "0";

    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.value = spine.title;
    titleInput.className = "auth-input";
    titleInput.style.padding = "8px";
    titleInput.style.flex = "1";

    titleInput.addEventListener("input", (e) => {
      spine.title = e.target.value;
    });

    const highlight = () => {
      activeEditingSpineIndex = index;
      div.style.borderColor = "#10b981";
      div.style.boxShadow = "0 0 0 2px rgba(16, 185, 129, 0.2)";
      redrawCanvasOverlays(index);
    };

    const unhighlight = () => {
      div.style.borderColor = "#e4e4e7";
      div.style.boxShadow = "none";
      redrawCanvasOverlays(null);
    };

    titleInput.addEventListener("focus", highlight);
    titleInput.addEventListener("blur", unhighlight);
    div.addEventListener("mouseenter", highlight);
    div.addEventListener("mouseleave", unhighlight);

    inputRow.appendChild(numberBadge);
    inputRow.appendChild(titleInput);

    const actionRow = document.createElement("div");
    actionRow.style.display = "flex";
    actionRow.style.gap = "8px";
    actionRow.style.paddingLeft = "32px";

    const searchBtn = document.createElement("button");
    searchBtn.textContent = "Search Book";
    searchBtn.className = "auth-btn primary-btn";
    searchBtn.style.padding = "6px 12px";
    searchBtn.style.fontSize = "0.85rem";
    searchBtn.style.flex = "1";

    const skipBtn = document.createElement("button");
    skipBtn.textContent = "Skip";
    skipBtn.className = "auth-btn secondary-btn";
    skipBtn.style.padding = "6px 12px";
    skipBtn.style.fontSize = "0.85rem";
    skipBtn.style.width = "auto";
    skipBtn.style.backgroundColor = "#e5e7eb";
    skipBtn.style.borderColor = "#d1d5db";

    skipBtn.onclick = () => {
      currentDetectedSpines.splice(index, 1);
      activeEditingSpineIndex = null;
      renderDetectedSpines();
    };

    actionRow.appendChild(searchBtn);
    actionRow.appendChild(skipBtn);

    const searchResults = document.createElement("div");
    searchResults.style.paddingLeft = "32px";
    searchResults.style.marginTop = "12px";
    searchResults.style.display = "flex";
    searchResults.style.flexDirection = "column";
    searchResults.style.gap = "8px";

    searchBtn.onclick = async () => {
      searchResults.innerHTML =
        "<span style='font-size:0.85rem; color:#71717a;'>Searching Google Books...</span>";
      try {
        const query = encodeURIComponent(titleInput.value);
        const res = await fetch(`/api/books?q=${query}`);
        const data = await res.json();

        searchResults.innerHTML = "";

        if (!data.items || data.items.length === 0) {
          searchResults.innerHTML =
            "<span style='font-size:0.85rem; color:#ef4444;'>No results found.</span>";
          return;
        }

        data.items.slice(0, 3).forEach((item) => {
          const vol = item.volumeInfo;
          const title = vol.title || "Unknown Title";
          const authors = vol.authors
            ? vol.authors.join(", ")
            : "Unknown Author";
          const thumbUrl =
            vol.imageLinks?.thumbnail ||
            "https://via.placeholder.com/50x70?text=No+Cover";

          const card = document.createElement("div");
          card.style.display = "flex";
          card.style.gap = "12px";
          card.style.padding = "12px";
          card.style.border = "2px solid #3b82f6";
          card.style.borderRadius = "8px";
          card.style.backgroundColor = "#eff6ff";

          const img = document.createElement("img");
          img.src = thumbUrl;
          img.style.width = "50px";
          img.style.height = "70px";
          img.style.objectFit = "cover";
          img.style.borderRadius = "4px";

          const infoCol = document.createElement("div");
          infoCol.style.display = "flex";
          infoCol.style.flexDirection = "column";
          infoCol.style.flex = "1";
          infoCol.style.justifyContent = "center";
          infoCol.style.gap = "4px";

          const titleEl = document.createElement("strong");
          titleEl.textContent = title;
          titleEl.style.fontSize = "0.95rem";
          titleEl.style.color = "#1e3a8a";

          const authorEl = document.createElement("span");
          authorEl.textContent = `By ${authors}`;
          authorEl.style.fontSize = "0.8rem";
          authorEl.style.color = "#64748b";

          const confirmBtn = document.createElement("button");
          confirmBtn.textContent = "Confirm & Save";
          confirmBtn.style.backgroundColor = "#10b981";
          confirmBtn.style.color = "white";
          confirmBtn.style.border = "none";
          confirmBtn.style.padding = "6px 12px";
          confirmBtn.style.borderRadius = "4px";
          confirmBtn.style.fontSize = "0.85rem";
          confirmBtn.style.fontWeight = "bold";
          confirmBtn.style.cursor = "pointer";
          confirmBtn.style.alignSelf = "flex-start";

          confirmBtn.onclick = () => {
            titleInput.value = title;
            spine.title = title;
            div.style.borderColor = "#10b981";
            searchResults.innerHTML = "";
          };

          infoCol.appendChild(titleEl);
          infoCol.appendChild(authorEl);
          infoCol.appendChild(confirmBtn);

          card.appendChild(img);
          card.appendChild(infoCol);

          searchResults.appendChild(card);
        });
      } catch (err) {
        searchResults.innerHTML =
          "<span style='font-size:0.85rem; color:#ef4444;'>Search failed.</span>";
      }
    };

    div.appendChild(inputRow);
    div.appendChild(actionRow);
    div.appendChild(searchResults);
    container.appendChild(div);
  });

  const saveBtn = document.createElement("button");
  saveBtn.textContent = "Save Shelf to Library";
  saveBtn.className = "auth-btn primary-btn";
  saveBtn.style.marginTop = "16px";
  saveBtn.onclick = saveShelfToDatabase;
  container.appendChild(saveBtn);
}

// ==========================================
// 6. DATABASE SAVING & LOADING
// ==========================================
async function saveShelfToDatabase() {
  if (!currentUploadedFile || currentDetectedSpines.length === 0) {
    alert("No image or detected books to save.");
    return;
  }

  const saveBtn = document.querySelector("#pendingContainer > .primary-btn");
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving Shelf & Books...";
  }

  try {
    const fileName = `${currentUser.id}/${Date.now()}.jpg`;

    // 1. Upload Image to Storage Bucket
    const { data: uploadData, error: uploadError } =
      await supabaseClient.storage
        .from("shelves")
        .upload(fileName, currentUploadedFile);

    if (uploadError) {
      alert("Failed to upload shelf image: " + uploadError.message);
      return;
    }

    const { data: publicUrlData } = supabaseClient.storage
      .from("shelves")
      .getPublicUrl(fileName);
    const imageUrl = publicUrlData.publicUrl;

    // 2. Create Shelf Record
    const { data: shelfData, error: shelfError } = await supabaseClient
      .from("shelves")
      .insert({ user_id: currentUser.id, image_url: imageUrl })
      .select()
      .single();

    if (shelfError) {
      alert("Failed to save shelf record: " + shelfError.message);
      return;
    }

    // 3. Format Books Payload
    const booksToInsert = currentDetectedSpines.map((spine) => ({
      user_id: currentUser.id,
      shelf_id: shelfData.id,
      title: spine.title?.trim() || "Untitled Book",
      bounding_box: spine.box || spine.boundingBox || null,
      polygon: spine.polygon || null,
      shelf_image_url: imageUrl,
    }));

    // 4. Insert Books to Database
    let { error: booksError } = await supabaseClient
      .from("user_books")
      .insert(booksToInsert);

    // Fallback: If 'polygon' column is missing in DB, retry without polygon data
    if (booksError && booksError.message.includes("polygon")) {
      const fallbackBooks = booksToInsert.map(({ polygon, ...rest }) => rest);
      const fallbackResult = await supabaseClient
        .from("user_books")
        .insert(fallbackBooks);
      booksError = fallbackResult.error;
    }

    if (booksError) {
      console.error("Failed to insert user_books:", booksError);
      alert("Shelf created, but books failed to save: " + booksError.message);
      return;
    }

    alert(
      `Successfully saved shelf and ${booksToInsert.length} book(s) to your library!`,
    );

    // Reset Workspace State
    currentDetectedSpines = [];
    currentUploadedFile = null;
    currentLoadedImage = null;

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
    alert("An unexpected error occurred while saving.");
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save Shelf to Library";
    }
  }
}

async function loadLibraryData() {
  const { data } = await supabaseClient
    .from("user_books")
    .select("*")
    .eq("user_id", currentUser.id);
  myLibrary = data || [];
  renderLibraryList(myLibrary);
}

async function deleteBookFromLibrary(bookId) {
  const { error } = await supabaseClient
    .from("user_books")
    .delete()
    .eq("id", bookId);

  if (error) return alert("Failed to delete book: " + error.message);

  // Update local state and refresh sidebar/map
  myLibrary = myLibrary.filter((b) => b.id !== bookId);
  renderLibraryList(myLibrary);

  // Re-render map if active
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
    li.style.cssText =
      "padding: 8px; border-bottom: 1px solid #e4e4e7; cursor: pointer; display: flex; justify-content: space-between; align-items: center;";

    const titleSpan = document.createElement("span");
    titleSpan.textContent = book.title;
    titleSpan.style.flex = "1";

    const delBtn = document.createElement("button");
    delBtn.innerHTML = "🗑️";
    delBtn.title = "Delete Book";
    delBtn.style.cssText =
      "background: none; border: none; cursor: pointer; font-size: 0.9rem; padding: 2px 6px; margin-left: 8px;";

    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${book.title}" from library?`)) return;
      await deleteBookFromLibrary(book.id);
    });

    li.addEventListener("click", () => {
      if (
        document.getElementById("libraryView").classList.contains("active-view")
      ) {
        zoomToBookOnMap(book);
      } else {
        alert(`Selected: ${book.title}`);
      }
    });

    li.appendChild(titleSpan);
    li.appendChild(delBtn);
    list.appendChild(li);
  });
}

// Add filter listener for search input
document.getElementById("searchInput")?.addEventListener("input", (e) => {
  const query = e.target.value.toLowerCase();
  const filteredBooks = myLibrary.filter((book) =>
    book.title.toLowerCase().includes(query),
  );
  renderLibraryList(filteredBooks);
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
};
let activeShelfDrag = null;
let activeMapEditPoint = null;
let activeSelectedBookId = null;

const getPos = (e) => ({
  x: e.touches ? e.touches[0].clientX : e.clientX,
  y: e.touches ? e.touches[0].clientY : e.clientY,
});

// Refresh all shelf SVG overlays to ensure only the selected book shows handles
function refreshAllShelfOverlays() {
  document.querySelectorAll("[data-shelf-id]").forEach((shelfWrapper) => {
    const books = shelfWrapper._books || [];
    renderShelfSvgOverlays(shelfWrapper, books, activeSelectedBookId);
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

  shelves.forEach((shelf, index) => {
    const startX = shelf.map_x ?? index * 350 + 50;
    const startY = shelf.map_y ?? 50;

    const shelfWrapper = document.createElement("div");
    shelfWrapper.dataset.shelfId = shelf.id;
    shelfWrapper._books = shelf.user_books || []; // Attach books array to shelf DOM node
    shelfWrapper.style.cssText = `
      position: absolute; left: ${startX}px; top: ${startY}px;
      width: 300px; background: white; padding: 10px; border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15); border: 1px solid #e4e4e7;
      cursor: grab; user-select: none; transition: box-shadow 0.2s;
    `;

    shelfWrapper.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; pointer-events: none;">
        <span style="font-weight: 600; font-size: 0.95rem; color: #3f3f46;">${shelf.name || "Untitled Shelf"}</span>
        <div style="pointer-events: auto; display: flex; gap: 6px;">
          <button class="edit-name-btn" title="Rename" style="background:none; border:none; cursor:pointer; color:#71717a; font-size:1rem;">✏️</button>
          <button class="delete-shelf-btn" title="Delete Shelf" style="background:none; border:none; cursor:pointer; color:#ef4444; font-size:1rem;">🗑️</button>
        </div>
      </div>
      <div style="position: relative; width: 100%;">
        <img src="${shelf.image_url}" draggable="false" style="width: 100%; display: block; border-radius: 4px; pointer-events: none; border: 1px solid #f4f4f5;">
        <svg class="shelf-svg-overlay" style="position: absolute; top: 0; left: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none;"></svg>
      </div>
    `;

    shelfWrapper
      .querySelector(".edit-name-btn")
      .addEventListener("click", (e) => {
        e.stopPropagation();
        const newName = prompt(
          "Enter new shelf name:",
          shelf.name || "Untitled Shelf",
        );
        if (newName)
          updateShelfName(
            shelf.id,
            newName,
            shelfWrapper.querySelector("span"),
          );
      });

    shelfWrapper
      .querySelector(".delete-shelf-btn")
      .addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm("Delete this shelf and all its books?")) return;
        await supabaseClient
          .from("user_books")
          .delete()
          .eq("shelf_id", shelf.id);
        await supabaseClient.from("shelves").delete().eq("id", shelf.id);
        shelfWrapper.remove();
        loadLibraryData();
      });

    const imgElement = shelfWrapper.querySelector("img");
    imgElement.onload = () => {
      renderShelfSvgOverlays(
        shelfWrapper,
        shelfWrapper._books,
        activeSelectedBookId,
      );
    };
    if (imgElement.complete) {
      renderShelfSvgOverlays(
        shelfWrapper,
        shelfWrapper._books,
        activeSelectedBookId,
      );
    }

    const initShelfDrag = (e) => {
      if (
        e.target.closest("svg") ||
        e.target.closest("button") ||
        e.target.closest(".book-popover")
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
      shelfWrapper.style.cursor = "grabbing";
      shelfWrapper.style.zIndex = 1000;
      shelfWrapper.style.boxShadow = "0 8px 24px rgba(0,0,0,0.25)";
    };
    shelfWrapper.addEventListener("mousedown", initShelfDrag);
    shelfWrapper.addEventListener("touchstart", initShelfDrag, {
      passive: false,
    });

    mapViewport.appendChild(shelfWrapper);
  });
}

// Floating Action Popover for Book Operations
function showBookActionPopover(shelfWrapper, book, books) {
  document.querySelectorAll(".book-popover").forEach((el) => el.remove());

  const popover = document.createElement("div");
  popover.className = "book-popover";
  popover.style.cssText = `
    position: absolute;
    top: -45px;
    left: 50%;
    transform: translateX(-50%);
    background: #1e293b;
    color: white;
    padding: 6px 12px;
    border-radius: 6px;
    font-size: 0.8rem;
    display: flex;
    align-items: center;
    gap: 8px;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    z-index: 100;
    pointer-events: auto;
    white-space: nowrap;
  `;

  popover.innerHTML = `
    <span style="font-weight: 600; max-width: 140px; overflow: hidden; text-overflow: ellipsis;">${book.title}</span>
    <button class="popover-del-btn" style="background: #ef4444; color: white; border: none; border-radius: 4px; padding: 2px 6px; cursor: pointer; font-weight: bold; font-size: 0.75rem;">Delete</button>
    <button class="popover-close-btn" style="background: none; border: none; color: #94a3b8; cursor: pointer; font-size: 0.9rem;">✕</button>
  `;

  popover
    .querySelector(".popover-del-btn")
    .addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${book.title}"?`)) return;
      await deleteBookFromLibrary(book.id);
      popover.remove();
    });

  popover.querySelector(".popover-close-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    popover.remove();
    activeSelectedBookId = null;
    refreshAllShelfOverlays();
  });

  const imgContainer = shelfWrapper.querySelector(
    "div[style*='position: relative']",
  );
  if (imgContainer) imgContainer.appendChild(popover);
}

// Render SVG overlays & control handles for map shelf books
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

    const selectBook = (e) => {
      e.stopPropagation();
      activeSelectedBookId = book.id;
      // Direct click on book image -> show handles (true)
      renderShelfSvgOverlays(shelfWrapper, books, book.id, true);
      showBookActionPopover(shelfWrapper, book, books);
    };

    polyEl.addEventListener("mousedown", selectBook);
    polyEl.addEventListener("touchstart", selectBook, { passive: false });

    svg.appendChild(polyEl);

    // Draggable handles render ONLY if selected AND showHandles is explicitly true
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
    .eq("id", shelfId);
  if (!error && textNode) textNode.textContent = newName;
}

// Map Panning & Background Click Handling
const initMapDrag = (e) => {
  if (e.target.closest(".map-controls") || e.target.closest(".book-popover"))
    return;

  // Clicking empty space or a shelf background deselects any active book handles
  activeSelectedBookId = null;
  document.querySelectorAll(".book-popover").forEach((el) => el.remove());
  refreshAllShelfOverlays();

  if (e.target.closest(".map-viewport > div")) return;

  const pos = getPos(e);
  mapState.isDragging = true;
  mapState.startX = pos.x - mapState.x;
  mapState.startY = pos.y - mapState.y;
  infiniteMap.style.cursor = "grabbing";
};
infiniteMap?.addEventListener("mousedown", initMapDrag);
infiniteMap?.addEventListener("touchstart", initMapDrag, { passive: false });

// Global Move Handler
const handleMove = (e) => {
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
      true, // Keep handles visible during active drag
    );
    return;
  }

  if (!activeShelfDrag && !mapState.isDragging) return;
  if (e.touches) e.preventDefault();
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

// Global End Handler
const handleEnd = async () => {
  if (activeMapEditPoint) {
    const book = activeMapEditPoint.book;
    await supabaseClient
      .from("user_books")
      .update({ polygon: book.polygon, bounding_box: book.bounding_box })
      .eq("id", book.id);

    activeMapEditPoint = null;
  }

  if (activeShelfDrag) {
    activeShelfDrag.element.style.cursor = "grab";
    activeShelfDrag.element.style.zIndex = "";
    activeShelfDrag.element.style.boxShadow = "0 4px 12px rgba(0,0,0,0.15)";

    const finalX = parseFloat(activeShelfDrag.element.style.left);
    const finalY = parseFloat(activeShelfDrag.element.style.top);
    supabaseClient
      .from("shelves")
      .update({ map_x: finalX, map_y: finalY })
      .eq("id", activeShelfDrag.id)
      .then();
    activeShelfDrag = null;
  }

  if (mapState.isDragging) {
    mapState.isDragging = false;
    infiniteMap.style.cursor = "grab";
  }
};
window.addEventListener("mouseup", handleEnd);
window.addEventListener("touchend", handleEnd);

// Zoom & Highlight Target Book from Sidebar Click
function zoomToBookOnMap(book) {
  const box = book.bounding_box || book.boundingBox;
  if (!box) return;

  const shelfWrapper = document.querySelector(
    `[data-shelf-id="${book.shelf_id}"]`,
  );
  if (!shelfWrapper) return;

  const imgElement = shelfWrapper.querySelector("img");
  if (!imgElement) return;

  activeSelectedBookId = book.id;

  const renderedWidth = imgElement.clientWidth || 280;
  const renderedHeight =
    imgElement.clientHeight ||
    renderedWidth * (imgElement.naturalHeight / (imgElement.naturalWidth || 1));

  const bookCx = ((box.minX + box.maxX) / 2) * renderedWidth;
  const bookCy = ((box.minY + box.maxY) / 2) * renderedHeight;

  const shelfLeft = parseFloat(shelfWrapper.style.left);
  const shelfTop = parseFloat(shelfWrapper.style.top);

  const targetX = shelfLeft + bookCx;
  const targetY = shelfTop + bookCy;

  const rect = infiniteMap.getBoundingClientRect();
  const targetScale = 1.2;
  mapState.scale = targetScale;

  mapState.x = rect.width / 2 - targetX * targetScale;
  mapState.y = rect.height / 2 - targetY * targetScale;

  mapViewport.style.transition = "transform 0.4s ease-in-out";
  mapViewport.style.transform = `translate(${mapState.x}px, ${mapState.y}px) scale(${mapState.scale})`;

  setTimeout(() => {
    mapViewport.style.transition = "none";
  }, 400);

  supabaseClient
    .from("user_books")
    .select("*")
    .eq("shelf_id", book.shelf_id)
    .then(({ data: shelfBooks }) => {
      const books = shelfBooks || [];
      // Pass false so handles stay hidden when zoomed from title click
      renderShelfSvgOverlays(shelfWrapper, books, book.id, false);
      const selectedBook = books.find((b) => b.id === book.id) || book;
      showBookActionPopover(shelfWrapper, selectedBook, books);
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
  shelfManagerModal.classList.remove("hidden-view");
  shelfManagerList.innerHTML = "<p style='text-align:center;'>Loading...</p>";

  const { data: shelves } = await supabaseClient
    .from("shelves")
    .select("*")
    .eq("user_id", currentUser.id);
  shelfManagerList.innerHTML = "";

  (shelves || []).forEach((shelf) => {
    const li = document.createElement("li");
    li.className = "manager-list-item";
    li.innerHTML = `
      <span style="font-weight: 500;">${shelf.name || "Untitled Shelf"}</span>
      <div>
        <button class="modal-edit-btn" style="background:#f4f4f5; border:none; padding:4px 8px; border-radius:4px; cursor:pointer; margin-right:4px;">Rename</button>
        <button class="modal-del-btn" style="background:#fee2e2; color:#ef4444; border:none; padding:4px 8px; border-radius:4px; cursor:pointer;">Delete</button>
      </div>
    `;

    li.querySelector(".modal-edit-btn").addEventListener("click", async () => {
      const newName = prompt("Rename shelf:", shelf.name || "Untitled");
      if (newName) {
        await updateShelfName(shelf.id, newName, li.querySelector("span"));
        loadLibraryMap();
      }
    });

    li.querySelector(".modal-del-btn").addEventListener("click", async () => {
      if (!confirm("Delete this shelf?")) return;
      await supabaseClient.from("shelves").delete().eq("id", shelf.id);
      li.remove();
      loadLibraryMap();
    });

    shelfManagerList.appendChild(li);
  });
});

closeManagerBtn?.addEventListener("click", () =>
  shelfManagerModal.classList.add("hidden-view"),
);

// Close modal when clicking/tapping outside the modal content
shelfManagerModal?.addEventListener("click", (e) => {
  // Check if the click was directly on the dark overlay, not inside the white card
  if (e.target === shelfManagerModal) {
    shelfManagerModal.classList.add("hidden-view");
  }
});

// ==========================================
// 9. MOBILE UI INTERACTIONS
// ==========================================
const mobileLibraryToggle = document.getElementById("mobileLibraryToggle");
const mobileLibraryContent = document.getElementById("mobileLibraryContent");

mobileLibraryToggle?.addEventListener("click", () => {
  if (window.innerWidth <= 768) {
    mobileLibraryContent.classList.toggle("collapsed");
    mobileLibraryToggle.classList.toggle("collapsed");
  }
});
