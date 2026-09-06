// --- 1. GLOBAL STATE & DOM ELEMENTS ---
const imageUpload = document.getElementById("imageUpload");
const canvas = document.getElementById("shelfCanvas");
const ctx = canvas.getContext("2d");
const placeholderText = document.getElementById("placeholderText");

let detectedSpines = [];
let currentShelfImageUrl = "";
let myLibrary = [];
let dismissedSpines = new Set(); // Tracks titles dismissed by the user

// 1. Initialize Supabase Client
const SUPABASE_URL = "https://cyrdpxukqtruheigcdps.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_6F6iP44Rw9T-OJSRBwOX5w_e0rMWYdP";
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
      console.log("Fetched library from Supabase:", myLibrary);
      renderSavedLibrary(searchInput.value);
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
  console.log("Checking user session...");
  const {
    data: { session },
  } = await supabaseClient.auth.getSession();
  updateAuthUI(session?.user || null);
}
checkUserSession();

// 5. Auth Event Listeners
document.getElementById("signupBtn").addEventListener("click", async () => {
  const { data, error } = await supabaseClient.auth.signUp({
    email: emailInput.value,
    password: passwordInput.value,
  });
  if (error) alert("Sign up error: " + error.message);
  else updateAuthUI(data.user);
});

document.getElementById("loginBtn").addEventListener("click", async () => {
  const { data, error } = await supabaseClient.auth.signInWithPassword({
    email: emailInput.value,
    password: passwordInput.value,
  });
  if (error) alert("Login error: " + error.message);
  else updateAuthUI(data.user);
});

document.getElementById("logoutBtn").addEventListener("click", async () => {
  await supabaseClient.auth.signOut();
  updateAuthUI(null);
});

// --- 2. IMAGE UPLOAD HANDLING ---
imageUpload.addEventListener("change", function (event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function (e) {
    const img = new Image();
    img.onload = function () {
      placeholderText.style.display = "none";
      canvas.style.display = "block";

      canvas.width = img.width;
      canvas.height = img.height;
      canvas.imgObj = img;

      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      console.log("Image loaded. Sending to VLM server...");

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
      console.log("VLM Spines Received!", result.spines);

      dismissedSpines.clear();
      currentShelfImageUrl = result.imageUrl;

      // Scale normalized 0.0-1.0 coordinates into canvas pixel dimensions
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
    if (spine.polygon) {
      return isPointInPolygon(pos, spine.polygon);
    }
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

  const confirmBtn = div.querySelector(".confirm-btn");
  confirmBtn.addEventListener("click", async () => {
    if (!currentUser) {
      alert("Please log in to save books!");
      return;
    }

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

    if (error) {
      console.error("Error saving book:", error);
      alert("Failed to save book.");
      return;
    }

    myLibrary.unshift(data[0]);
    populateShelfDropdown();
    shelfSelect.value = currentShelfImageUrl;
    div.remove();
    renderSavedLibrary(searchInput.value);
    redrawCanvas();
  });
}

function promptTitleConfirmation(detectedText, boundingBox) {
  const pendingContainer = document.getElementById("pendingContainer");

  const card = document.createElement("div");
  card.style.cssText =
    "padding: 12px; border: 1px solid #d4d4d8; border-radius: 8px; margin-bottom: 12px; background: #fafafa;";

  card.innerHTML = `
    <label style="display: block; font-weight: bold; font-size: 0.85rem; margin-bottom: 6px;">
      Recognized Title:
    </label>
    <input 
      type="text" 
      id="titleConfirmInput" 
      class="search-input" 
      value="${detectedText.replace(/"/g, "&quot;")}" 
      style="margin-bottom: 10px; width: 100%; font-size: 0.95rem; padding: 6px 8px;"
    >
    <div style="display: flex; gap: 8px;">
      <button 
        id="searchBookBtn" 
        style="flex: 1; padding: 6px; cursor: pointer; background: #2563eb; color: white; border: none; border-radius: 4px; font-weight: 500;"
      >Search Book</button>
      <button 
        id="cancelSearchBtn" 
        style="padding: 6px 10px; cursor: pointer; background: #e4e4e7; border: none; border-radius: 4px;"
      >Cancel</button>
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

    if (bookData) {
      renderConfirmationCard(editedTitle, bookData, boundingBox);
    } else {
      alert(`No book details found for "${editedTitle}".`);
    }
  });

  card.querySelector("#cancelSearchBtn").addEventListener("click", () => {
    card.remove();
  });
}

// --- 6. LIBRARY & SHELF MANAGEMENT ---
const libraryList = document.getElementById("libraryList");
if (libraryList) {
  libraryList.addEventListener("click", async (e) => {
    const deleteBtn = e.target.closest(".delete-btn");
    if (deleteBtn) {
      e.stopPropagation();

      const bookId = parseInt(deleteBtn.dataset.bookId);
      if (!bookId) return;

      if (!confirm("Remove this book from your library?")) return;

      const { error } = await supabaseClient
        .from("user_books")
        .delete()
        .eq("id", bookId);

      if (error) {
        console.error("Error deleting book:", error);
        alert("Failed to delete book.");
        return;
      }

      myLibrary = myLibrary.filter((book) => book.id !== bookId);
      renderSavedLibrary(searchInput ? searchInput.value : "");
      populateShelfDropdown();
      return;
    }

    const li = e.target.closest("li");
    if (!li || !li.dataset.bookId) return;

    const bookId = parseInt(li.dataset.bookId);
    const book = myLibrary.find((b) => b.id === bookId);

    if (!book) return;

    const box = book.bounding_box || book.boundingBox;
    const shelfUrl = book.shelf_image_url || book.shelfImageUrl;

    if (shelfUrl && shelfUrl !== currentShelfImageUrl) {
      loadShelfImageOnCanvas(shelfUrl, () => {
        if (box) highlightBookOnCanvas(box);
        if (shelfSelect) shelfSelect.value = shelfUrl;
      });
    } else if (box) {
      highlightBookOnCanvas(box);
    }
  });
}

const searchInput = document.getElementById("searchInput");

function renderSavedLibrary(searchTerm = "") {
  const libraryList = document.getElementById("libraryList");
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
        <button 
          class="delete-btn" 
          data-book-id="${book.id}" 
          style="background: none; border: none; color: #ef4444; cursor: pointer; font-size: 1.2rem; padding: 2px 8px; font-weight: bold;" 
          title="Delete book"
        >&times;</button>
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
      const rawSpines = data.detected_spines || [];
      const rawDismissed = data.dismissed_titles || [];

      dismissedSpines = new Set(rawDismissed.map((t) => t.trim()));

      detectedSpines = sortSpines(rawSpines);
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
    const selectedUrl = e.target.value;
    if (selectedUrl) loadShelfImageOnCanvas(selectedUrl);
  });
}

if (searchInput) {
  searchInput.addEventListener("input", (e) => {
    renderSavedLibrary(e.target.value);
  });
}

// --- 7. CANVAS DRAWING HELPERS ---
function redrawCanvas() {
  if (!canvas.imgObj) return;
  ctx.drawImage(canvas.imgObj, 0, 0, canvas.width, canvas.height);
  drawAutoSpines();
  drawAllSavedBoxesForActiveShelf();
}

function drawAutoSpines() {
  if (!detectedSpines || detectedSpines.length === 0) return;

  detectedSpines.forEach((spine) => {
    const poly = spine.polygon;

    if (poly && poly.length >= 3) {
      ctx.strokeStyle = "#2563eb";
      ctx.fillStyle = "rgba(59, 130, 246, 0.22)";
      ctx.lineWidth = 3;

      ctx.beginPath();
      ctx.moveTo(poly[0].x, poly[0].y);
      for (let i = 1; i < poly.length; i++) {
        ctx.lineTo(poly[i].x, poly[i].y);
      }
      ctx.closePath();

      ctx.fill();
      ctx.stroke();
    }
  });
}

function drawAllSavedBoxesForActiveShelf() {
  if (!currentShelfImageUrl || !canvas.imgObj) return;

  const shelfBooks = myLibrary.filter((b) => {
    const url = b.shelf_image_url || b.shelfImageUrl;
    return url === currentShelfImageUrl;
  });

  shelfBooks.forEach((book) => {
    const box = book.bounding_box || book.boundingBox;
    if (!box) return;

    ctx.fillStyle = "rgba(34, 197, 94, 0.25)";
    ctx.strokeStyle = "#22c55e";
    ctx.lineWidth = 2;

    if (box.polygon && box.polygon.length >= 3) {
      ctx.beginPath();
      ctx.moveTo(box.polygon[0].x, box.polygon[0].y);
      for (let i = 1; i < box.polygon.length; i++) {
        ctx.lineTo(box.polygon[i].x, box.polygon[i].y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else {
      const width = box.maxX - box.minX;
      const height = box.maxY - box.minY;
      ctx.fillRect(box.minX, box.minY, width, height);
      ctx.strokeRect(box.minX, box.minY, width, height);
    }
  });
}

function highlightBookOnCanvas(box) {
  if (!box || !canvas.imgObj) return;

  redrawCanvas();

  ctx.fillStyle = "rgba(245, 158, 11, 0.45)";
  ctx.strokeStyle = "#f59e0b";
  ctx.lineWidth = 4;

  if (box.polygon && box.polygon.length >= 3) {
    ctx.beginPath();
    ctx.moveTo(box.polygon[0].x, box.polygon[0].y);
    for (let i = 1; i < box.polygon.length; i++) {
      ctx.lineTo(box.polygon[i].x, box.polygon[i].y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else {
    const width = box.maxX - box.minX;
    const height = box.maxY - box.minY;
    ctx.fillRect(box.minX, box.minY, width, height);
    ctx.strokeRect(box.minX, box.minY, width, height);
  }
}

function highlightSpineOnCanvas(spine) {
  redrawCanvas();
  if (!spine) return;

  ctx.strokeStyle = "#f59e0b";
  ctx.fillStyle = "rgba(245, 158, 11, 0.5)";
  ctx.lineWidth = 4;

  if (spine.polygon && spine.polygon.length >= 3) {
    ctx.beginPath();
    ctx.moveTo(spine.polygon[0].x, spine.polygon[0].y);
    for (let i = 1; i < spine.polygon.length; i++) {
      ctx.lineTo(spine.polygon[i].x, spine.polygon[i].y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else if (spine.box) {
    const { minX, minY, maxX, maxY } = spine.box;
    ctx.fillRect(minX, minY, maxX - minX, maxY - minY);
    ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
  }
}

function highlightPendingSpineOnCanvas(box) {
  redrawCanvas();
  if (!box || !canvas.imgObj) return;

  ctx.fillStyle = "rgba(59, 130, 246, 0.35)";
  ctx.strokeStyle = "#3b82f6";
  ctx.lineWidth = 3;

  if (box.polygon && box.polygon.length >= 3) {
    ctx.beginPath();
    ctx.moveTo(box.polygon[0].x, box.polygon[0].y);
    for (let i = 1; i < box.polygon.length; i++) {
      ctx.lineTo(box.polygon[i].x, box.polygon[i].y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else {
    const width = box.maxX - box.minX;
    const height = box.maxY - box.minY;
    ctx.fillRect(box.minX, box.minY, width, height);
    ctx.strokeRect(box.minX, box.minY, width, height);
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

    const sBox = spine.box;
    if (!sBox) return true;

    const sCx = (sBox.minX + sBox.maxX) / 2;
    const sCy = (sBox.minY + sBox.maxY) / 2;
    const centerPoint = { x: sCx, y: sCy };

    return !activeShelfSavedBooks.some((savedBook) => {
      const bBox = savedBook.bounding_box || savedBook.boundingBox;
      if (!bBox) return false;

      if (bBox.polygon && bBox.polygon.length >= 4) {
        return isPointInPolygon(centerPoint, bBox.polygon);
      }

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
  header.className = "batch-header";
  header.style.cssText =
    "font-size: 0.9rem; font-weight: bold; margin-bottom: 10px; color: #3f3f46; display: flex; justify-content: space-between; align-items: center;";

  const titleSpan = document.createElement("span");
  titleSpan.textContent = `Detected Spines (${availableSpines.length})`;
  header.appendChild(titleSpan);

  const cardsWrapper = document.createElement("div");
  cardsWrapper.className = "spine-cards-scroll-wrapper";
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

      const cards = Array.from(cardsWrapper.querySelectorAll(".spine-card"));

      for (const card of cards) {
        const input = card.querySelector(".spine-input");
        const spineIndex = parseInt(card.dataset.spineIndex);
        const spine = availableSpines[spineIndex];
        const editedTitle = input.value.trim();

        if (editedTitle && spine) {
          card.innerHTML = `<p style="font-size: 0.85rem; color: #71717a; margin: 0;">Searching for "<strong>${editedTitle}</strong>"...</p>`;

          const bookData = await fetchBookMetadata(editedTitle);
          card.remove();

          if (bookData) {
            const boxToSave = spine.polygon
              ? { ...spine.box, polygon: spine.polygon }
              : spine.box;
            renderConfirmationCard(editedTitle, bookData, boxToSave);
          } else {
            dismissedSpines.add(spine.title.trim());
            await saveDismissedSpines();
          }
        } else {
          card.remove();
        }
      }

      if (header) header.remove();
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
        <span style="background: #8b5cf6; color: white; border-radius: 50%; width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center; font-size: 0.75rem; font-weight: bold; flex-shrink: 0;">
          ${index + 1}
        </span>
        <input 
          type="text" 
          class="spine-input search-input" 
          value="${spine.title.replace(/"/g, "&quot;")}" 
          style="margin: 0; width: 100%; font-size: 0.9rem; padding: 5px 8px;"
        >
      </div>
      <div style="display: flex; gap: 6px;">
        <button class="search-spine-btn" style="flex: 1; padding: 5px; cursor: pointer; background: #2563eb; color: white; border: none; border-radius: 4px; font-weight: 500; font-size: 0.8rem;">
          Search Book
        </button>
        <button class="dismiss-spine-btn" style="padding: 5px 10px; cursor: pointer; background: #e4e4e7; border: none; border-radius: 4px; font-size: 0.8rem;">
          Skip
        </button>
      </div>
    `;

    const input = card.querySelector(".spine-input");

    card.addEventListener("mouseenter", () => {
      card.style.borderColor = "#f59e0b";
      highlightSpineOnCanvas(spine);
    });

    card.addEventListener("mouseleave", () => {
      card.style.borderColor = "#e4e4e7";
      redrawCanvas();
    });

    input.addEventListener("focus", () => {
      card.style.borderColor = "#f59e0b";
      highlightSpineOnCanvas(spine);
    });

    input.addEventListener("blur", () => {
      card.style.borderColor = "#e4e4e7";
      redrawCanvas();
    });

    card
      .querySelector(".search-spine-btn")
      .addEventListener("click", async () => {
        const editedTitle = input.value.trim();
        if (!editedTitle) return alert("Please enter a title.");

        card.innerHTML = `<p style="font-size: 0.85rem; color: #71717a; margin: 0;">Searching for "<strong>${editedTitle}</strong>"...</p>`;

        const bookData = await fetchBookMetadata(editedTitle);
        card.remove();
        redrawCanvas();

        if (bookData) {
          const boxToSave = spine.polygon
            ? { ...spine.box, polygon: spine.polygon }
            : spine.box;
          renderConfirmationCard(editedTitle, bookData, boxToSave);
        } else {
          alert(`No book details found for "${editedTitle}".`);
        }
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

  const titlesArray = Array.from(dismissedSpines);
  const { error } = await supabaseClient.from("shelves").upsert(
    [
      {
        user_id: currentUser.id,
        image_url: currentShelfImageUrl,
        detected_spines: detectedSpines,
        dismissed_titles: titlesArray,
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

    const isAAboveB =
      boxA.maxY <= boxB.minY + heightB * 0.35 &&
      boxA.minX < boxB.maxX &&
      boxA.maxX > boxB.minX;
    const isBAboveA =
      boxB.maxY <= boxA.minY + heightA * 0.35 &&
      boxB.minX < boxA.maxX &&
      boxB.maxX > boxA.minX;

    if (isAAboveB || isBAboveA) {
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
    overlay.style.cssText = `
      position: fixed;
      top: 0; left: 0; width: 100vw; height: 100vh;
      background: rgba(15, 23, 42, 0.75);
      backdrop-filter: blur(4px);
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      z-index: 9999; color: white; font-family: sans-serif;
    `;
    overlay.innerHTML = `
      <div class="spinner" style="
        width: 48px; height: 48px;
        border: 5px solid rgba(255, 255, 255, 0.2);
        border-top-color: #3b82f6; border-radius: 50%;
        animation: spin 0.8s linear infinite; margin-bottom: 16px;
      "></div>
      <style>@keyframes spin { to { transform: rotate(360deg); } }</style>
      <div id="loadingMessage" style="font-weight: 600; font-size: 1.1rem;">${message}</div>
    `;
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
