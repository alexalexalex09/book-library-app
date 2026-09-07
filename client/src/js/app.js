// --- 1. GLOBAL STATE & DOM ELEMENTS ---
const imageUpload = document.getElementById("imageUpload");
const canvas = document.getElementById("shelfCanvas");
const ctx = canvas.getContext("2d");
const placeholderText = document.getElementById("placeholderText");

let detectedSpines = [];
let currentShelfImageUrl = "";
let myLibrary = [];
let dismissedSpines = new Set();

// --- VIEW ROUTING ---
const navUploadBtn = document.getElementById("navUploadBtn");
const navLibraryBtn = document.getElementById("navLibraryBtn");
const uploadView = document.getElementById("uploadView");
const libraryView = document.getElementById("libraryView");

function switchView(view) {
  if (view === "upload") {
    uploadView.classList.remove("hidden-view");
    uploadView.classList.add("active-view");
    libraryView.classList.remove("active-view");
    libraryView.classList.add("hidden-view");

    navUploadBtn.classList.add("active");
    navLibraryBtn.classList.remove("active");
  } else if (view === "library") {
    libraryView.classList.remove("hidden-view");
    libraryView.classList.add("active-view");
    uploadView.classList.remove("active-view");
    uploadView.classList.add("hidden-view");

    navLibraryBtn.classList.add("active");
    navUploadBtn.classList.remove("active");

    // Fetch and draw map elements
    loadLibraryMap();
  }
}

navUploadBtn?.addEventListener("click", () => switchView("upload"));
navLibraryBtn?.addEventListener("click", () => switchView("library"));

// --- PROGRESSIVE BACKGROUND LOADING ---
function loadHighResBackground() {
  const bgElement = document.querySelector(".auth-background");
  if (!bgElement) return;

  const highResUrl = "../img/anna-hunko-ajE5goOGzZc-unsplash.jpg";

  // Create an invisible image in memory to trigger the network download
  const imgLoader = new Image();

  imgLoader.onload = () => {
    // Once fully downloaded, swap the CSS background to the high-res version
    bgElement.style.backgroundImage = `url('${highResUrl}')`;
  };

  imgLoader.src = highResUrl;
}

// Trigger the progressive load immediately
loadHighResBackground();

// 1. Initialize Supabase Client
const SUPABASE_URL = "https://wqxvahmiblqgsjyywxpa.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_Oth3p_I48nLfY8tLkOcSvA_uegZywJY";
const supabaseClient = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
);

let currentUser = null;

// 2. DOM Elements for Auth
const loggedOutView = document.getElementById("loggedOutView");
const loggedInView = document.getElementById("loggedInView");
const emailInput = document.getElementById("emailInput");
const passwordInput = document.getElementById("passwordInput");
const userEmailDisplay = document.getElementById("userEmailDisplay");

// 3. UI Toggle Helper
async function updateAuthUI(user) {
  currentUser = user;

  if (user) {
    loggedOutView.style.display = "none";
    loggedInView.style.display = "block";
    userEmailDisplay.textContent = user.email;

    const { data, error } = await supabaseClient
      .from("user_books")
      .select("*")
      .order("created_at", { ascending: false });

    if (!error && data) {
      myLibrary = data;
      renderSavedLibrary(searchInput?.value);
      populateShelfDropdown();
    }
  } else {
    loggedOutView.style.display = "block";
    loggedInView.style.display = "none";
    emailInput.value = "";
    passwordInput.value = "";
    myLibrary = [];
    renderSavedLibrary();
  }
}

// 4. Check for existing session on page load
async function checkUserSession() {
  const {
    data: { session },
  } = await supabaseClient.auth.getSession();
  updateAuthUI(session?.user || null);
}
checkUserSession();

// 5. Auth Event Listeners
document.getElementById("signupBtn")?.addEventListener("click", async () => {
  const { data, error } = await supabaseClient.auth.signUp({
    email: emailInput.value,
    password: passwordInput.value,
  });
  if (error) alert("Sign up error: " + error.message);
  else updateAuthUI(data.user);
});

document.getElementById("loginBtn")?.addEventListener("click", async () => {
  const { data, error } = await supabaseClient.auth.signInWithPassword({
    email: emailInput.value,
    password: passwordInput.value,
  });
  if (error) alert("Login error: " + error.message);
  else updateAuthUI(data.user);
});

document.getElementById("logoutBtn")?.addEventListener("click", async () => {
  await supabaseClient.auth.signOut();
  updateAuthUI(null);
});

// --- 2. IMAGE UPLOAD HANDLING ---
imageUpload?.addEventListener("change", function (event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function (e) {
    const img = new Image();
    img.onload = function () {
      if (placeholderText) placeholderText.style.display = "none";
      canvas.style.display = "block";

      canvas.width = img.width;
      canvas.height = img.height;
      canvas.imgObj = img;

      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      processImageForOCR(file);
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
});

// --- 3. VLM PROCESSING ---
async function processImageForOCR(file) {
  showLoadingOverlay("Analyzing shelf & recognizing titles with Vision AI...");
  const formData = new FormData();
  formData.append("image", file);

  try {
    const response = await fetch("/api/ocr", {
      method: "POST",
      body: formData,
    });
    const result = await response.json();

    if (result.spines) {
      dismissedSpines.clear();
      currentShelfImageUrl = result.imageUrl;

      detectedSpines = result.spines.map((spine) => ({
        ...spine,
        box: {
          minX: spine.box.minX * canvas.width,
          maxX: spine.box.maxX * canvas.width,
          minY: spine.box.minY * canvas.height,
          maxY: spine.box.maxY * canvas.height,
        },
        polygon: spine.polygon.map((pt) => ({
          x: pt.x * canvas.width,
          y: pt.y * canvas.height,
        })),
      }));

      detectedSpines = sortSpines(detectedSpines);
      populateBatchSpinePrompts(detectedSpines);

      ctx.drawImage(canvas.imgObj, 0, 0, canvas.width, canvas.height);
      drawAutoSpines();
      drawAllSavedBoxesForActiveShelf();

      if (currentUser) {
        const { error } = await supabaseClient.from("shelves").upsert(
          [
            {
              user_id: currentUser.id,
              image_url: currentShelfImageUrl,
              detected_spines: detectedSpines,
            },
          ],
          { onConflict: "image_url" },
        );
        if (error) console.error("Error saving shelf VLM data:", error);
      }
    }
  } catch (error) {
    console.error("Error communicating with VLM server:", error);
    alert("Failed to process shelf image. Please try again.");
  } finally {
    hideLoadingOverlay();
  }
}

// --- 4. MOUSE INTERACTION & CANVAS UTILS ---
function getMousePos(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (canvas.width / rect.width),
    y: (e.clientY - rect.top) * (canvas.height / rect.height),
  };
}

canvas.addEventListener("click", async (e) => {
  const pos = getMousePos(e);
  const clickedSpine = detectedSpines.find((spine) => {
    if (spine.polygon) return isPointInPolygon(pos, spine.polygon);
    const { minX, minY, maxX, maxY } = spine.box;
    return pos.x >= minX && pos.x <= maxX && pos.y >= minY && pos.y <= maxY;
  });

  if (clickedSpine) {
    const boxToPass = clickedSpine.polygon
      ? { ...clickedSpine.box, polygon: clickedSpine.polygon }
      : clickedSpine.box;
    promptTitleConfirmation(clickedSpine.title, boxToPass);
  }
});

function isPointInPolygon(point, polygon) {
  let isInside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x,
      yi = polygon[i].y;
    const xj = polygon[j].x,
      yj = polygon[j].y;
    const intersect =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi;
    if (intersect) isInside = !isInside;
  }
  return isInside;
}

// --- 5. UI CONFIRMATION & DATABASE ---
function renderConfirmationCard(ocrText, bookData, unifiedBox) {
  const pendingContainer = document.getElementById("pendingContainer");
  const div = document.createElement("div");
  div.style.cssText =
    "border: 2px solid #3b82f6; padding: 10px; margin-bottom: 10px; border-radius: 8px; display: flex; gap: 10px; background: #eff6ff;";

  const rawSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="50" height="75" viewBox="0 0 50 75"><rect width="100%" height="100%" fill="#e4e4e7"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-size="9" fill="#71717a">No Cover</text></svg>`;
  const fallbackCover = `data:image/svg+xml;utf8,${encodeURIComponent(rawSvg)}`;
  const coverImg = bookData.thumbnail || fallbackCover;

  div.innerHTML = `
    <img src="${coverImg}" style="width: 50px; height: 75px; object-fit: cover; border-radius: 4px;">
    <div style="flex: 1;">
      <h3 style="font-size: 1rem; margin-bottom: 4px;">${bookData.title}</h3>
      <p style="font-size: 0.8rem; color: #71717a; margin-bottom: 8px;">By ${bookData.author}</p>
      <button class="confirm-btn" style="background: #22c55e; color: white; border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer;">Confirm & Save</button>
    </div>
  `;

  pendingContainer.prepend(div);
  highlightPendingSpineOnCanvas(unifiedBox);

  div.addEventListener("mouseenter", () =>
    highlightPendingSpineOnCanvas(unifiedBox),
  );
  div.addEventListener("mouseleave", () => redrawCanvas());

  div.querySelector(".confirm-btn").addEventListener("click", async () => {
    if (!currentUser) return alert("Please log in to save books!");

    const finalBook = {
      user_id: currentUser.id,
      title: bookData.title,
      author: bookData.author,
      cover: coverImg,
      bounding_box: unifiedBox,
      shelf_image_url: currentShelfImageUrl,
    };

    const { data, error } = await supabaseClient
      .from("user_books")
      .insert([finalBook])
      .select();
    if (error) return alert("Failed to save book.");

    myLibrary.unshift(data[0]);
    populateShelfDropdown();
    if (shelfSelect) shelfSelect.value = currentShelfImageUrl;
    div.remove();
    renderSavedLibrary(searchInput?.value);
    redrawCanvas();
  });
}

function promptTitleConfirmation(detectedText, boundingBox) {
  const pendingContainer = document.getElementById("pendingContainer");
  const card = document.createElement("div");
  card.style.cssText =
    "padding: 12px; border: 1px solid #d4d4d8; border-radius: 8px; margin-bottom: 12px; background: #fafafa;";

  card.innerHTML = `
    <label style="display: block; font-weight: bold; font-size: 0.85rem; margin-bottom: 6px;">Recognized Title:</label>
    <input type="text" id="titleConfirmInput" class="search-input" value="${detectedText.replace(/"/g, "&quot;")}" style="margin-bottom: 10px; width: 100%; font-size: 0.95rem; padding: 6px 8px;">
    <div style="display: flex; gap: 8px;">
      <button id="searchBookBtn" style="flex: 1; padding: 6px; cursor: pointer; background: #2563eb; color: white; border: none; border-radius: 4px; font-weight: 500;">Search Book</button>
      <button id="cancelSearchBtn" style="padding: 6px 10px; cursor: pointer; background: #e4e4e7; border: none; border-radius: 4px;">Cancel</button>
    </div>
  `;

  pendingContainer.innerHTML = "";
  pendingContainer.appendChild(card);

  const input = card.querySelector("#titleConfirmInput");
  input.focus();
  input.select();

  card.querySelector("#searchBookBtn").addEventListener("click", async () => {
    const editedTitle = input.value.trim();
    if (!editedTitle) return alert("Please enter a title.");

    const bookData = await fetchBookMetadata(editedTitle);
    card.remove();

    if (bookData) renderConfirmationCard(editedTitle, bookData, boundingBox);
    else alert(`No book details found for "${editedTitle}".`);
  });

  card
    .querySelector("#cancelSearchBtn")
    .addEventListener("click", () => card.remove());
}

// --- 6. LIBRARY & SHELF MANAGEMENT ---
const libraryList = document.getElementById("libraryList");
if (libraryList) {
  libraryList.addEventListener("click", async (e) => {
    const deleteBtn = e.target.closest(".delete-btn");
    if (deleteBtn) {
      e.stopPropagation();
      const bookId = parseInt(deleteBtn.dataset.bookId);
      if (!bookId || !confirm("Remove this book from your library?")) return;

      const { error } = await supabaseClient
        .from("user_books")
        .delete()
        .eq("id", bookId);
      if (error) return alert("Failed to delete book.");

      myLibrary = myLibrary.filter((book) => book.id !== bookId);
      renderSavedLibrary(searchInput?.value || "");
      populateShelfDropdown();
      return;
    }

    const li = e.target.closest("li");
    if (!li || !li.dataset.bookId) return;

    const bookId = parseInt(li.dataset.bookId);
    const book = myLibrary.find((b) => b.id === bookId);
    if (!book) return;

    // Check which view is currently active
    if (
      document.getElementById("libraryView").classList.contains("active-view")
    ) {
      zoomToBookOnMap(book);
      return;
    }

    const box = book.bounding_box || book.boundingBox;
    const shelfUrl = book.shelf_image_url || book.shelfImageUrl;

    if (shelfUrl && shelfUrl !== currentShelfImageUrl) {
      loadShelfImageOnCanvas(shelfUrl, () => {
        if (box) highlightBookOnCanvas(box);
        if (shelfSelect) shelfSelect.value = shelfUrl;
      });
    } else if (box) highlightBookOnCanvas(box);
  });
}

const searchInput = document.getElementById("searchInput");
function renderSavedLibrary(searchTerm = "") {
  if (!libraryList) return;
  libraryList.innerHTML = "";

  const lowerSearch = searchTerm.toLowerCase();
  const filteredBooks = myLibrary.filter(
    (book) =>
      book.title.toLowerCase().includes(lowerSearch) ||
      (book.author && book.author.toLowerCase().includes(lowerSearch)),
  );

  if (filteredBooks.length === 0) {
    libraryList.innerHTML =
      '<li class="empty-state">No matching books found.</li>';
    return;
  }

  filteredBooks.forEach((book) => {
    const li = document.createElement("li");
    li.style.cssText =
      "border: 1px solid #e4e4e7; padding: 10px; margin-bottom: 10px; border-radius: 8px; display: flex; gap: 10px; background: white; cursor: pointer;";
    li.dataset.bookId = book.id;

    li.innerHTML = `
      <div style="display: flex; align-items: center; justify-content: space-between; width: 100%; gap: 10px;">
        <div style="display: flex; align-items: center; gap: 10px;">
          ${book.cover ? `<img src="${book.cover}" alt="${book.title}" style="width: 40px; height: 58px; object-fit: cover; border-radius: 4px; flex-shrink: 0;">` : ""}
          <div>
            <strong style="display: block; font-size: 0.95rem; line-height: 1.2;">${book.title}</strong>
            ${book.author ? `<small style="color: #71717a;">${book.author}</small>` : ""}
          </div>
        </div>
        <button class="delete-btn" data-book-id="${book.id}" style="background: none; border: none; color: #ef4444; cursor: pointer; font-size: 1.2rem; padding: 2px 8px; font-weight: bold;" title="Delete book">&times;</button>
      </div>
    `;
    libraryList.appendChild(li);
  });
}

async function loadShelfImageOnCanvas(imageUrl, callback) {
  if (!imageUrl) return;

  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = async () => {
    if (placeholderText) placeholderText.style.display = "none";
    canvas.style.display = "block";

    canvas.width = img.width;
    canvas.height = img.height;
    ctx.drawImage(img, 0, 0);
    canvas.imgObj = img;
    currentShelfImageUrl = imageUrl;

    const { data, error } = await supabaseClient
      .from("shelves")
      .select("detected_spines, dismissed_titles")
      .eq("image_url", imageUrl)
      .maybeSingle();

    if (error) console.error("Error fetching shelf data:", error);

    if (data) {
      dismissedSpines = new Set(
        (data.dismissed_titles || []).map((t) => t.trim()),
      );
      detectedSpines = sortSpines(data.detected_spines || []);
      populateBatchSpinePrompts(detectedSpines);
    } else {
      detectedSpines = [];
      dismissedSpines.clear();
      populateBatchSpinePrompts([]);
    }

    drawAutoSpines();
    drawAllSavedBoxesForActiveShelf();
    if (callback) callback();
  };
  img.src = imageUrl;
}

const shelfSelect = document.getElementById("shelfSelect");
function populateShelfDropdown() {
  if (!shelfSelect) return;
  const uniqueShelves = [
    ...new Set(myLibrary.map((b) => b.shelf_image_url).filter(Boolean)),
  ];
  shelfSelect.innerHTML =
    '<option value="">-- Select a Saved Shelf --</option>';

  uniqueShelves.forEach((url, index) => {
    const option = document.createElement("option");
    option.value = url;
    option.textContent = `Shelf #${index + 1}`;
    shelfSelect.appendChild(option);
  });
}

if (shelfSelect) {
  shelfSelect.addEventListener("change", (e) => {
    if (e.target.value) loadShelfImageOnCanvas(e.target.value);
  });
}

if (searchInput) {
  searchInput.addEventListener("input", (e) =>
    renderSavedLibrary(e.target.value),
  );
}

// --- 7. CANVAS DRAWING HELPERS ---
function redrawCanvas() {
  if (!canvas.imgObj) return;
  ctx.drawImage(canvas.imgObj, 0, 0, canvas.width, canvas.height);
  drawAutoSpines();
  drawAllSavedBoxesForActiveShelf();
}

function drawPolygon(poly) {
  if (!poly || poly.length < 3) return;
  ctx.beginPath();
  ctx.moveTo(poly[0].x, poly[0].y);
  for (let i = 1; i < poly.length; i++) ctx.lineTo(poly[i].x, poly[i].y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

function drawAutoSpines() {
  if (!detectedSpines || detectedSpines.length === 0) return;
  detectedSpines.forEach((spine) => {
    if (spine.polygon && spine.polygon.length >= 3) {
      ctx.strokeStyle = "#2563eb";
      ctx.fillStyle = "rgba(59, 130, 246, 0.22)";
      ctx.lineWidth = 3;
      drawPolygon(spine.polygon);
    }
  });
}

function drawAllSavedBoxesForActiveShelf() {
  if (!currentShelfImageUrl || !canvas.imgObj) return;
  const shelfBooks = myLibrary.filter(
    (b) => (b.shelf_image_url || b.shelfImageUrl) === currentShelfImageUrl,
  );

  shelfBooks.forEach((book) => {
    const box = book.bounding_box || book.boundingBox;
    if (!box) return;

    ctx.fillStyle = "rgba(34, 197, 94, 0.25)";
    ctx.strokeStyle = "#22c55e";
    ctx.lineWidth = 2;

    if (box.polygon && box.polygon.length >= 3) drawPolygon(box.polygon);
    else {
      ctx.fillRect(
        box.minX,
        box.minY,
        box.maxX - box.minX,
        box.maxY - box.minY,
      );
      ctx.strokeRect(
        box.minX,
        box.minY,
        box.maxX - box.minX,
        box.maxY - box.minY,
      );
    }
  });
}

function highlightBookOnCanvas(box) {
  if (!box || !canvas.imgObj) return;
  redrawCanvas();
  ctx.fillStyle = "rgba(245, 158, 11, 0.45)";
  ctx.strokeStyle = "#f59e0b";
  ctx.lineWidth = 4;

  if (box.polygon && box.polygon.length >= 3) drawPolygon(box.polygon);
  else {
    ctx.fillRect(box.minX, box.minY, box.maxX - box.minX, box.maxY - box.minY);
    ctx.strokeRect(
      box.minX,
      box.minY,
      box.maxX - box.minX,
      box.maxY - box.minY,
    );
  }
}

function highlightSpineOnCanvas(spine) {
  redrawCanvas();
  if (!spine) return;
  ctx.strokeStyle = "#f59e0b";
  ctx.fillStyle = "rgba(245, 158, 11, 0.5)";
  ctx.lineWidth = 4;

  if (spine.polygon && spine.polygon.length >= 3) drawPolygon(spine.polygon);
  else if (spine.box) {
    ctx.fillRect(
      spine.box.minX,
      spine.box.minY,
      spine.box.maxX - spine.box.minX,
      spine.box.maxY - spine.box.minY,
    );
    ctx.strokeRect(
      spine.box.minX,
      spine.box.minY,
      spine.box.maxX - spine.box.minX,
      spine.box.maxY - spine.box.minY,
    );
  }
}

function highlightPendingSpineOnCanvas(box) {
  redrawCanvas();
  if (!box || !canvas.imgObj) return;
  ctx.fillStyle = "rgba(59, 130, 246, 0.35)";
  ctx.strokeStyle = "#3b82f6";
  ctx.lineWidth = 3;

  if (box.polygon && box.polygon.length >= 3) drawPolygon(box.polygon);
  else {
    ctx.fillRect(box.minX, box.minY, box.maxX - box.minX, box.maxY - box.minY);
    ctx.strokeRect(
      box.minX,
      box.minY,
      box.maxX - box.minX,
      box.maxY - box.minY,
    );
  }
}

// --- 8. BATCH PROMPTS & DISMISSAL ---
function populateBatchSpinePrompts(spines) {
  const pendingContainer = document.getElementById("pendingContainer");
  if (!pendingContainer) return;

  pendingContainer.innerHTML = "";
  if (!spines || spines.length === 0) return;

  const activeShelfSavedBooks = myLibrary.filter(
    (b) => (b.shelf_image_url || b.shelfImageUrl) === currentShelfImageUrl,
  );

  const availableSpines = spines.filter((spine) => {
    const cleanTitle = spine.title.trim();
    if (dismissedSpines.has(cleanTitle)) return false;
    if (!spine.box) return true;

    const sCx = (spine.box.minX + spine.box.maxX) / 2;
    const sCy = (spine.box.minY + spine.box.maxY) / 2;

    return !activeShelfSavedBooks.some((savedBook) => {
      const bBox = savedBook.bounding_box || savedBook.boundingBox;
      if (!bBox) return false;
      if (bBox.polygon && bBox.polygon.length >= 4)
        return isPointInPolygon({ x: sCx, y: sCy }, bBox.polygon);
      return (
        sCx >= bBox.minX &&
        sCx <= bBox.maxX &&
        sCy >= bBox.minY &&
        sCy <= bBox.maxY
      );
    });
  });

  if (availableSpines.length === 0) return;

  const header = document.createElement("div");
  header.style.cssText =
    "font-size: 0.9rem; font-weight: bold; margin-bottom: 10px; color: #3f3f46; display: flex; justify-content: space-between; align-items: center;";
  header.innerHTML = `<span>Detected Spines (${availableSpines.length})</span>`;

  const cardsWrapper = document.createElement("div");
  cardsWrapper.style.cssText =
    "max-height: 420px; overflow-y: auto; padding-right: 4px;";

  if (availableSpines.length > 1) {
    const searchAllBtn = document.createElement("button");
    searchAllBtn.textContent = "Search All";
    searchAllBtn.style.cssText =
      "background: #2563eb; color: white; border: none; padding: 4px 10px; border-radius: 4px; font-size: 0.8rem; cursor: pointer; font-weight: 500;";

    searchAllBtn.addEventListener("click", async () => {
      searchAllBtn.disabled = true;
      searchAllBtn.textContent = "Searching...";

      for (const card of Array.from(
        cardsWrapper.querySelectorAll(".spine-card"),
      )) {
        const input = card.querySelector(".spine-input");
        const spine = availableSpines[parseInt(card.dataset.spineIndex)];
        const editedTitle = input.value.trim();

        if (editedTitle && spine) {
          card.innerHTML = `<p style="font-size: 0.85rem; color: #71717a; margin: 0;">Searching for "<strong>${editedTitle}</strong>"...</p>`;
          const bookData = await fetchBookMetadata(editedTitle);
          card.remove();

          if (bookData) {
            renderConfirmationCard(
              editedTitle,
              bookData,
              spine.polygon
                ? { ...spine.box, polygon: spine.polygon }
                : spine.box,
            );
          } else {
            dismissedSpines.add(spine.title.trim());
            await saveDismissedSpines();
          }
        } else card.remove();
      }
      header.remove();
      redrawCanvas();
    });
    header.appendChild(searchAllBtn);
  }

  pendingContainer.appendChild(header);
  pendingContainer.appendChild(cardsWrapper);

  availableSpines.forEach((spine, index) => {
    const card = document.createElement("div");
    card.className = "spine-card";
    card.dataset.spineIndex = index;
    card.style.cssText =
      "padding: 10px; border: 1px solid #e4e4e7; border-radius: 6px; margin-bottom: 8px; background: #fafafa; transition: border-color 0.2s;";

    card.innerHTML = `
      <div style="display: flex; gap: 8px; align-items: center; margin-bottom: 8px;">
        <span style="background: #8b5cf6; color: white; border-radius: 50%; width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center; font-size: 0.75rem; font-weight: bold; flex-shrink: 0;">${index + 1}</span>
        <input type="text" class="spine-input search-input" value="${spine.title.replace(/"/g, "&quot;")}" style="margin: 0; width: 100%; font-size: 0.9rem; padding: 5px 8px;">
      </div>
      <div style="display: flex; gap: 6px;">
        <button class="search-spine-btn" style="flex: 1; padding: 5px; cursor: pointer; background: #2563eb; color: white; border: none; border-radius: 4px; font-weight: 500; font-size: 0.8rem;">Search Book</button>
        <button class="dismiss-spine-btn" style="padding: 5px 10px; cursor: pointer; background: #e4e4e7; border: none; border-radius: 4px; font-size: 0.8rem;">Skip</button>
      </div>
    `;

    const input = card.querySelector(".spine-input");
    const highlight = () => {
      card.style.borderColor = "#f59e0b";
      highlightSpineOnCanvas(spine);
    };
    const unhighlight = () => {
      card.style.borderColor = "#e4e4e7";
      redrawCanvas();
    };

    card.addEventListener("mouseenter", highlight);
    card.addEventListener("mouseleave", unhighlight);
    input.addEventListener("focus", highlight);
    input.addEventListener("blur", unhighlight);

    card
      .querySelector(".search-spine-btn")
      .addEventListener("click", async () => {
        const editedTitle = input.value.trim();
        if (!editedTitle) return alert("Please enter a title.");

        card.innerHTML = `<p style="font-size: 0.85rem; color: #71717a; margin: 0;">Searching for "<strong>${editedTitle}</strong>"...</p>`;
        const bookData = await fetchBookMetadata(editedTitle);
        card.remove();
        redrawCanvas();

        if (bookData)
          renderConfirmationCard(
            editedTitle,
            bookData,
            spine.polygon
              ? { ...spine.box, polygon: spine.polygon }
              : spine.box,
          );
        else alert(`No book details found for "${editedTitle}".`);
      });

    card
      .querySelector(".dismiss-spine-btn")
      .addEventListener("click", async () => {
        dismissedSpines.add(spine.title.trim());
        card.remove();
        redrawCanvas();
        await saveDismissedSpines();
      });

    cardsWrapper.appendChild(card);
  });
}

async function saveDismissedSpines() {
  if (!currentUser || !currentShelfImageUrl) return;
  const { error } = await supabaseClient.from("shelves").upsert(
    [
      {
        user_id: currentUser.id,
        image_url: currentShelfImageUrl,
        detected_spines: detectedSpines,
        dismissed_titles: Array.from(dismissedSpines),
      },
    ],
    { onConflict: "image_url" },
  );
  if (error) console.error("Error saving skipped spines:", error);
}

function sortSpines(spines) {
  if (!spines || spines.length === 0) return [];
  return spines.sort((a, b) => {
    const polyA = a.rawPolygon || a.polygon;
    const polyB = b.rawPolygon || b.polygon;

    const cxA = polyA
      ? polyA.reduce((sum, p) => sum + p.x, 0) / polyA.length
      : (a.box.minX + a.box.maxX) / 2;
    const cxB = polyB
      ? polyB.reduce((sum, p) => sum + p.x, 0) / polyB.length
      : (b.box.minX + b.box.maxX) / 2;
    const cyA = polyA
      ? polyA.reduce((sum, p) => sum + p.y, 0) / polyA.length
      : (a.box.minY + a.box.maxY) / 2;
    const cyB = polyB
      ? polyB.reduce((sum, p) => sum + p.y, 0) / polyB.length
      : (b.box.minY + b.box.maxY) / 2;

    const boxA = a.box || { minX: 0, maxX: 0, minY: 0, maxY: 0 };
    const boxB = b.box || { minX: 0, maxX: 0, minY: 0, maxY: 0 };

    const heightA = boxA.maxY - boxA.minY;
    const heightB = boxB.maxY - boxB.minY;

    if (
      (boxA.maxY <= boxB.minY + heightB * 0.35 &&
        boxA.minX < boxB.maxX &&
        boxA.maxX > boxB.minX) ||
      (boxB.maxY <= boxA.minY + heightA * 0.35 &&
        boxB.minX < boxA.maxX &&
        boxB.maxX > boxA.minX)
    ) {
      return cyA - cyB;
    }
    return cxA - cxB;
  });
}

// --- 9. UI LOADING OVERLAY HELPERS ---
function showLoadingOverlay(message = "Scanning shelf with Vision AI...") {
  let overlay = document.getElementById("loadingOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "loadingOverlay";
    overlay.style.cssText = `position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(15, 23, 42, 0.75); backdrop-filter: blur(4px); display: flex; flex-direction: column; align-items: center; justify-content: center; z-index: 9999; color: white; font-family: sans-serif;`;
    overlay.innerHTML = `<div class="spinner" style="width: 48px; height: 48px; border: 5px solid rgba(255, 255, 255, 0.2); border-top-color: #3b82f6; border-radius: 50%; animation: spin 0.8s linear infinite; margin-bottom: 16px;"></div><style>@keyframes spin { to { transform: rotate(360deg); } }</style><div id="loadingMessage" style="font-weight: 600; font-size: 1.1rem;">${message}</div>`;
    document.body.appendChild(overlay);
  } else {
    document.getElementById("loadingMessage").textContent = message;
    overlay.style.display = "flex";
  }
}

function hideLoadingOverlay() {
  const overlay = document.getElementById("loadingOverlay");
  if (overlay) overlay.style.display = "none";
}

// --- 10. INFINITE 2D LIBRARY MAP ENGINE ---
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

// Render shelves onto the map
async function loadLibraryMap() {
  if (!currentUser) return;

  const { data: shelves, error } = await supabaseClient
    .from("shelves")
    .select("*")
    .eq("user_id", currentUser.id);
  if (error) return console.error("Error loading map:", error);

  mapViewport.innerHTML = "";

  shelves.forEach((shelf, index) => {
    const startX = shelf.map_x ?? index * 350 + 50;
    const startY = shelf.map_y ?? 50;

    const shelfWrapper = document.createElement("div");
    shelfWrapper.style.cssText = `
      position: absolute; left: ${startX}px; top: ${startY}px;
      width: 300px; background: white; padding: 10px; border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15); border: 1px solid #e4e4e7;
      cursor: grab; user-select: none; transition: box-shadow 0.2s;
    `;

    // Added Delete Button next to Edit
    shelfWrapper.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; pointer-events: none;">
        <span style="font-weight: 600; font-size: 0.95rem; color: #3f3f46;">${shelf.name || "Untitled Shelf"}</span>
        <div style="pointer-events: auto; display: flex; gap: 6px;">
          <button class="edit-name-btn" title="Rename" style="background:none; border:none; cursor:pointer; color:#71717a; font-size:1rem;">✏️</button>
          <button class="delete-shelf-btn" title="Delete" style="background:none; border:none; cursor:pointer; color:#ef4444; font-size:1rem;">🗑️</button>
        </div>
      </div>
      <img src="${shelf.image_url}" draggable="false" style="width: 100%; border-radius: 4px; pointer-events: none; border: 1px solid #f4f4f5;">
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
        if (!confirm("Delete this shelf?")) return;
        await supabaseClient.from("shelves").delete().eq("id", shelf.id);
        shelfWrapper.remove();
      });

    shelfWrapper.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      activeShelfDrag = {
        element: shelfWrapper,
        id: shelf.id,
        startX: e.clientX,
        startY: e.clientY,
        initialLeft: parseFloat(shelfWrapper.style.left),
        initialTop: parseFloat(shelfWrapper.style.top),
      };
      shelfWrapper.style.cursor = "grabbing";
      shelfWrapper.style.zIndex = 1000;
      shelfWrapper.style.boxShadow = "0 8px 24px rgba(0,0,0,0.25)";
    });

    mapViewport.appendChild(shelfWrapper);
  });
}

async function updateShelfName(shelfId, newName, textNode) {
  const { error } = await supabaseClient
    .from("shelves")
    .update({ name: newName })
    .eq("id", shelfId);
  if (!error && textNode) textNode.textContent = newName;
}

// 1. Shelf Manager Modal Logic
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
        loadLibraryMap(); // Refresh map wrappers
      }
    });

    li.querySelector(".modal-del-btn").addEventListener("click", async () => {
      if (!confirm("Delete this shelf?")) return;
      await supabaseClient.from("shelves").delete().eq("id", shelf.id);
      li.remove();
      loadLibraryMap(); // Refresh map wrappers
    });

    shelfManagerList.appendChild(li);
  });
});

closeManagerBtn?.addEventListener("click", () =>
  shelfManagerModal.classList.add("hidden-view"),
);

// 2. Map Panning & Dragging
infiniteMap.addEventListener("mousedown", (e) => {
  if (
    e.target.closest(".map-viewport > div") ||
    e.target.closest(".map-controls")
  )
    return;
  mapState.isDragging = true;
  mapState.startX = e.clientX - mapState.x;
  mapState.startY = e.clientY - mapState.y;
  infiniteMap.style.cursor = "grabbing";
});

window.addEventListener("mousemove", (e) => {
  if (activeShelfDrag) {
    const dx = (e.clientX - activeShelfDrag.startX) / mapState.scale;
    const dy = (e.clientY - activeShelfDrag.startY) / mapState.scale;
    activeShelfDrag.element.style.left = `${activeShelfDrag.initialLeft + dx}px`;
    activeShelfDrag.element.style.top = `${activeShelfDrag.initialTop + dy}px`;
    return;
  }
  if (mapState.isDragging) {
    mapState.x = e.clientX - mapState.startX;
    mapState.y = e.clientY - mapState.startY;
    mapViewport.style.transform = `translate(${mapState.x}px, ${mapState.y}px) scale(${mapState.scale})`;
  }
});

window.addEventListener("mouseup", () => {
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
});

infiniteMap.addEventListener(
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

// 3. Zoom & Highlight Target Book
function zoomToBookOnMap(book) {
  const shelfUrl = book.shelf_image_url || book.shelfImageUrl;
  const box = book.bounding_box || book.boundingBox;
  if (!shelfUrl || !box) return;

  const imgElement = Array.from(mapViewport.querySelectorAll("img")).find(
    (img) => img.src === shelfUrl,
  );
  if (!imgElement) return;

  const shelfWrapper = imgElement.parentElement;

  // Calculate relative position based on the 300px DOM image width vs original coordinates
  const scaleX = 300 / (imgElement.naturalWidth || 1);
  const scaleY = scaleX; // Preserve aspect ratio

  const bookCx = ((box.minX + box.maxX) / 2) * scaleX;
  const bookCy = ((box.minY + box.maxY) / 2) * scaleY;

  const shelfLeft = parseFloat(shelfWrapper.style.left);
  const shelfTop = parseFloat(shelfWrapper.style.top);

  // Absolute point on the map where the book center lies
  const targetX = shelfLeft + bookCx;
  const targetY = shelfTop + bookCy;

  // Animate map transformation
  const rect = infiniteMap.getBoundingClientRect();
  const targetScale = 1.2; // Reduced from 3 to keep the whole 300px shelf card visible
  mapState.scale = targetScale;

  mapState.x = rect.width / 2 - targetX * targetScale;
  mapState.y = rect.height / 2 - targetY * targetScale;

  mapViewport.style.transition = "transform 0.4s ease-in-out";
  mapViewport.style.transform = `translate(${mapState.x}px, ${mapState.y}px) scale(${mapState.scale})`;

  setTimeout(() => {
    mapViewport.style.transition = "none";
  }, 400);

  // Apply Highlight Box over the image wrapper
  document.querySelectorAll(".map-book-highlight").forEach((el) => el.remove());
  const hl = document.createElement("div");
  hl.className = "map-book-highlight";
  hl.style.cssText = `
    position: absolute;
    left: ${box.minX * scaleX + 10}px; /* Account for 10px wrapper padding */
    top: ${box.minY * scaleY + 36}px; /* Account for 10px padding + 26px header */
    width: ${(box.maxX - box.minX) * scaleX}px;
    height: ${(box.maxY - box.minY) * scaleY}px;
    background: rgba(245, 158, 11, 0.4);
    border: 3px solid #f59e0b;
    box-shadow: 0 0 16px rgba(245, 158, 11, 0.8);
    pointer-events: none;
    z-index: 10;
  `;
  shelfWrapper.appendChild(hl);
}
