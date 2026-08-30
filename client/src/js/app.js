// --- 1. GLOBAL STATE & DOM ELEMENTS ---
const imageUpload = document.getElementById("imageUpload");
const canvas = document.getElementById("shelfCanvas");
const ctx = canvas.getContext("2d");
const placeholderText = document.getElementById("placeholderText");

let detectedSpines = [];
let currentShelfImageUrl = "";
let detectedWords = [];
let myLibrary = [];
//let isDragging = false;
//let dragPath = [];
//let selectedWords = new Set(); // Set prevents duplicate word selection
let dismissedSpines = new Set(); // Tracks 'shelfUrl::title' pairs dismissed by the user

// 1. Initialize Supabase Client
const SUPABASE_URL = "https://cyrdpxukqtruheigcdps.supabase.co"; // Paste your URL
const SUPABASE_ANON_KEY = "sb_publishable_6F6iP44Rw9T-OJSRBwOX5w_e0rMWYdP"; // Paste your Publishable Key
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

    // FETCH DATA FROM SUPABASE
    const { data, error } = await supabaseClient
      .from("user_books")
      .select("*")
      .order("created_at", { ascending: false });

    if (!error && data) {
      myLibrary = data; // Replace local array with real database data
      console.log("Fetched library from Supabase:", myLibrary);
      renderSavedLibrary(searchInput.value);
      populateShelfDropdown();
    }
  } else {
    loggedOutView.style.display = "block";
    loggedInView.style.display = "none";
    emailInput.value = "";
    passwordInput.value = "";

    // WIPE THE SCREEN ON LOGOUT
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
  // We will also clear the screen later when users log out!
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

      // Store the image object on the canvas so we can redraw it easily during swiping
      canvas.imgObj = img;

      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      console.log("Image loaded. Sending to OCR...");

      processImageForOCR(file);
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
});

// --- 3. OCR PROCESSING ---
async function processImageForOCR(file) {
  const formData = new FormData();
  formData.append("image", file);

  try {
    const response = await fetch("/api/ocr", {
      method: "POST",
      body: formData,
    });

    const result = await response.json();

    if (result.spines) {
      console.log("Server Spines Received!", result.spines);

      detectedWords = result.words ? result.words.slice(1) : [];
      dismissedSpines.clear();
      currentShelfImageUrl = result.imageUrl;

      // Use the ONNX spines constructed by the server directly
      detectedSpines = result.spines;

      populateBatchSpinePrompts(detectedSpines);

      ctx.drawImage(canvas.imgObj, 0, 0, canvas.width, canvas.height);
      drawWordBoxes();
      drawAutoSpines();
      drawAllSavedBoxesForActiveShelf();

      if (currentUser) {
        const { error } = await supabaseClient.from("shelves").upsert(
          [
            {
              user_id: currentUser.id,
              image_url: currentShelfImageUrl,
              detected_words: detectedWords,
            },
          ],
          { onConflict: "image_url" },
        );

        if (error) console.error("Error saving shelf OCR data:", error);
      }
    }
  } catch (error) {
    console.error("Error communicating with OCR server:", error);
  }
}

// --- 4. DRAWING FUNCTIONS ---
function drawWordBoxes() {
  /* Deprecated in favor of auto Spines
  if (!detectedWords || detectedWords.length === 0 || !canvas.imgObj) return;

  // Redraw base image first
  ctx.drawImage(canvas.imgObj, 0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = "rgba(59, 130, 246, 0.6)";
  ctx.fillStyle = "rgba(59, 130, 246, 0.15)";
  ctx.lineWidth = 1;

  // Skip index 0 (Google Vision's full-page text block)
  const wordsToDraw =
    detectedWords.length > 1 ? detectedWords.slice(1) : detectedWords;

  wordsToDraw.forEach((word) => {
    const v = word.boundingPoly?.vertices;
    if (!v || v.length < 4) return;

    const minX = Math.min(v[0].x || 0, v[1].x || 0, v[2].x || 0, v[3].x || 0);
    const maxX = Math.max(v[0].x || 0, v[1].x || 0, v[2].x || 0, v[3].x || 0);
    const minY = Math.min(v[0].y || 0, v[1].y || 0, v[2].y || 0, v[3].y || 0);
    const maxY = Math.max(v[0].y || 0, v[1].y || 0, v[2].y || 0, v[3].y || 0);

    ctx.fillRect(minX, minY, maxX - minX, maxY - minY);
    ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
  }); */
}

// --- 5. MOUSE INTERACTION (SWIPE-TO-SELECT) ---
// Helper to get scaled mouse coordinates relative to original image size
function getMousePos(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (canvas.width / rect.width),
    y: (e.clientY - rect.top) * (canvas.height / rect.height),
  };
}

/*canvas.addEventListener("mousedown", (e) => {
  if (detectedWords.length === 0) return;
  isDragging = true;
  dragPath = [getMousePos(e)];
  const pos = getMousePos(e);
  selectedWords.clear();
  ctx.beginPath();
  ctx.moveTo(pos.x, pos.y);
});

canvas.addEventListener("mousemove", (e) => {
  if (!isDragging) return;

  const pos = getMousePos(e);
  dragPath.push(pos);

  // Draw the red swipe line
  ctx.lineTo(pos.x, pos.y);
  ctx.strokeStyle = "#ef4444";
  ctx.lineWidth = 3;
  ctx.stroke();

  // Find words that intersect our current mouse position
  detectedWords.forEach((word) => {
    const v = word.boundingPoly.vertices;
    if (!v || v.length < 4) return;

    const minX = Math.min(v[0].x || 0, v[1].x || 0, v[2].x || 0, v[3].x || 0);
    const maxX = Math.max(v[0].x || 0, v[1].x || 0, v[2].x || 0, v[3].x || 0);
    const minY = Math.min(v[0].y || 0, v[1].y || 0, v[2].y || 0, v[3].y || 0);
    const maxY = Math.max(v[0].y || 0, v[1].y || 0, v[2].y || 0, v[3].y || 0);

    if (pos.x >= minX && pos.x <= maxX && pos.y >= minY && pos.y <= maxY) {
      selectedWords.add(word);
    }
  });
});

canvas.addEventListener("mouseup", async () => {
  if (!isDragging) return;
  isDragging = false;

  if (selectedWords.size > 0) {
    // Sort selected words top-to-bottom based on their Y coordinate
    const sortedWords = Array.from(selectedWords).sort(
      (a, b) =>
        (a.boundingPoly.vertices[0].y || 0) -
        (b.boundingPoly.vertices[0].y || 0),
    );

    const stitchedText = sortedWords.map((w) => w.description).join(" ");
    console.log("Searching Google Books for:", stitchedText);

    // Calculate the outer boundary mapping the whole book spine
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    sortedWords.forEach((word) => {
      word.boundingPoly.vertices.forEach((v) => {
        if (v.x < minX) minX = v.x;
        if (v.y < minY) minY = v.y;
        if (v.x > maxX) maxX = v.x;
        if (v.y > maxY) maxY = v.y;
      });
    });

    const unifiedBox = { minX, minY, maxX, maxY };

    const confirmedText = prompt(
      "Confirm or edit the extracted book title before searching:",
      stitchedText,
    );

    // Only proceed if user clicked OK and didn't leave it blank
    if (confirmedText !== null && confirmedText.trim() !== "") {
      const searchTitle = confirmedText.trim();
      console.log("Searching Google Books for:", searchTitle);

      // Call out to API helper using the confirmed text
      const bookData = await fetchBookMetadata(searchTitle);
      if (bookData) {
        renderConfirmationCard(searchTitle, bookData, unifiedBox);
      } else {
        console.log("No metadata found for:", searchTitle);
        alert(`No book details found for "${searchTitle}".`);
      }
    }
  }

  // Clean up the red swipe line by redrawing the image and boxes
  ctx.drawImage(canvas.imgObj, 0, 0, canvas.width, canvas.height);
  drawWordBoxes();
  drawAutoSpines();
  drawAllSavedBoxesForActiveShelf();
});
*/
// --- 6. UI CONFIRMATION & DATABASE ---
function renderConfirmationCard(ocrText, bookData, unifiedBox) {
  const pendingContainer = document.getElementById("pendingContainer");

  const div = document.createElement("div");
  div.style.border = "2px solid #3b82f6"; // Blue border for pending
  div.style.padding = "10px";
  div.style.marginBottom = "10px";
  div.style.borderRadius = "8px";
  div.style.display = "flex";
  div.style.gap = "10px";
  div.style.background = "#eff6ff"; // Light blue background

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

  // Prepend card to pending queue
  pendingContainer.prepend(div);

  // Highlight spine in blue on canvas while pending search result
  highlightPendingSpineOnCanvas(unifiedBox);

  // Hover & focus event listeners to highlight pending spine
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
    div.remove(); // Removes only THIS specific card
    renderSavedLibrary(searchInput.value);

    // Redraw canvas so this book shifts from blue highlight to saved green box
    redrawCanvas();
  });
}

function highlightBookOnCanvas(box) {
  if (!box || !canvas.imgObj) return;

  // 1. Redraw base shelf image
  ctx.drawImage(canvas.imgObj, 0, 0, canvas.width, canvas.height);

  // 2. Redraw all saved green boxes for context
  drawAllSavedBoxesForActiveShelf();

  // 3. Highlight the selected book in bright gold
  ctx.fillStyle = "rgba(245, 158, 11, 0.45)"; // Gold fill
  ctx.strokeStyle = "#f59e0b"; // Gold border
  ctx.lineWidth = 4;

  // 🛑 Draw rotated polygon if available
  if (box.polygon && box.polygon.length >= 4) {
    ctx.beginPath();
    ctx.moveTo(box.polygon[0].x, box.polygon[0].y);
    ctx.lineTo(box.polygon[1].x, box.polygon[1].y);
    ctx.lineTo(box.polygon[2].x, box.polygon[2].y);
    ctx.lineTo(box.polygon[3].x, box.polygon[3].y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else {
    // Fallback rectangle
    const width = box.maxX - box.minX;
    const height = box.maxY - box.minY;
    ctx.fillRect(box.minX, box.minY, width, height);
    ctx.strokeRect(box.minX, box.minY, width, height);
  }
}

const libraryList = document.getElementById("libraryList");
if (libraryList) {
  libraryList.addEventListener("click", async (e) => {
    const deleteBtn = e.target.closest(".delete-btn");
    // Handle Delete Click
    if (deleteBtn) {
      e.stopPropagation(); // Prevents row click from triggering canvas re-loads

      const bookId = parseInt(deleteBtn.dataset.bookId);
      if (!bookId) return;

      if (
        !confirm("Are you sure you want to remove this book from your library?")
      )
        return;

      // 1. Delete row from Supabase Postgres
      const { error } = await supabaseClient
        .from("user_books")
        .delete()
        .eq("id", bookId);

      if (error) {
        console.error("Error deleting book:", error);
        alert("Failed to delete book.");
        return;
      }

      // 2. Remove item from local array state
      myLibrary = myLibrary.filter((book) => book.id !== bookId);

      // 3. Refresh list and dropdowns
      renderSavedLibrary(searchInput ? searchInput.value : "");
      populateShelfDropdown();
      return;
    }
    const li = e.target.closest("li");
    if (!li || !li.dataset.bookId) return;

    const bookId = parseInt(li.dataset.bookId);
    const book = myLibrary.find((b) => b.id === bookId);

    if (!book) return;

    // Support both Supabase column syntax and local variable syntax
    const box = book.bounding_box || book.boundingBox;
    const shelfUrl = book.shelf_image_url || book.shelfImageUrl;

    if (shelfUrl && shelfUrl !== currentShelfImageUrl) {
      // Load shelf photo first, then highlight
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
  libraryList.innerHTML = ""; // Clear the list before redrawing

  // Filter the myLibrary array based on what the user typed
  const lowerSearch = searchTerm.toLowerCase();
  const filteredBooks = myLibrary.filter(
    (book) =>
      book.title.toLowerCase().includes(lowerSearch) ||
      book.author.toLowerCase().includes(lowerSearch),
  );

  if (filteredBooks.length === 0) {
    libraryList.innerHTML =
      '<li class="empty-state">No matching books found.</li>';
    return;
  }

  // Draw the filtered books
  filteredBooks.forEach((book) => {
    const li = document.createElement("li");
    li.style.border = "1px solid #e4e4e7";
    li.style.padding = "10px";
    li.style.marginBottom = "10px";
    li.style.borderRadius = "8px";
    li.style.display = "flex";
    li.style.gap = "10px";
    li.style.background = "white";

    // Make it clickable for our next feature!
    li.style.cursor = "pointer";
    li.dataset.bookId = book.id;

    // The HTML string that was hiding!
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

  const canvas = document.getElementById("shelfCanvas");
  const ctx = canvas.getContext("2d");
  const placeholderText = document.getElementById("placeholderText");

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

    // Fetch saved OCR words from Supabase
    const { data, error } = await supabaseClient
      .from("shelves")
      .select("detected_words, dismissed_titles")
      .eq("image_url", imageUrl)
      .maybeSingle();

    if (error) {
      console.error("Error fetching shelf OCR data:", error);
    }

    if (data) {
      detectedWords = data.detected_words || [];
      const rawDismissed = data.dismissed_titles || [];

      // Clean up legacy "url::title" strings into just "title"
      dismissedSpines = new Set(
        rawDismissed.map((item) =>
          item.includes("::") ? item.split("::").pop().trim() : item.trim(),
        ),
      );

      detectedSpines = processAutoSpines(null, detectedWords);
      populateBatchSpinePrompts(detectedSpines);
    } else {
      console.warn("No OCR words found in database for this shelf URL.");
      detectedWords = [];
      detectedSpines = [];
      dismissedSpines.clear();
      populateBatchSpinePrompts([]);
    }

    // Render word boxes and cataloged book highlights
    drawWordBoxes();
    drawAutoSpines();
    drawAllSavedBoxesForActiveShelf();

    if (callback) callback();
  };
  img.src = imageUrl;
}

const shelfSelect = document.getElementById("shelfSelect");

function populateShelfDropdown() {
  // Extract unique image URLs from myLibrary
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

// Reload canvas when selecting a shelf from the dropdown
if (shelfSelect) {
  shelfSelect.addEventListener("change", (e) => {
    const selectedUrl = e.target.value;
    if (selectedUrl) {
      loadShelfImageOnCanvas(selectedUrl);
    }
  });
} else {
  console.log("shelfSelect element not found in the DOM.");
}

// Listen for typing in the search box
searchInput.addEventListener("input", (e) => {
  renderSavedLibrary(e.target.value);
});

function promptTitleConfirmation(detectedText, boundingBox) {
  const pendingContainer = document.getElementById("pendingContainer");

  const card = document.createElement("div");
  card.style.cssText =
    "padding: 12px; border: 1px solid #d4d4d8; border-radius: 8px; margin-bottom: 12px; background: #fafafa;";

  card.innerHTML = `
    <label style="display: block; font-weight: bold; font-size: 0.85rem; margin-bottom: 6px;">
      Recognized Text:
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

  // Clear previous pending prompt and display new one
  pendingContainer.innerHTML = "";
  pendingContainer.appendChild(card);

  const input = card.querySelector("#titleConfirmInput");
  input.focus();
  input.select();

  // Search button click
  card.querySelector("#searchBookBtn").addEventListener("click", async () => {
    const editedTitle = input.value.trim();
    if (!editedTitle) return alert("Please enter a title.");

    // Fetch book metadata from Google Books via api.js
    const bookData = await fetchBookMetadata(editedTitle);
    card.remove();

    if (bookData) {
      renderConfirmationCard(editedTitle, bookData, boundingBox);
    } else {
      alert(`No book details found for "${editedTitle}".`);
    }
  });

  // Cancel button click
  card.querySelector("#cancelSearchBtn").addEventListener("click", () => {
    card.remove();
  });
}

// Draws green bounding boxes for ALL saved books on the current shelf
function drawAllSavedBoxesForActiveShelf() {
  if (!currentShelfImageUrl || !canvas.imgObj) return;

  const shelfBooks = myLibrary.filter((b) => {
    const url = b.shelf_image_url || b.shelfImageUrl;
    return url === currentShelfImageUrl;
  });

  shelfBooks.forEach((book) => {
    const box = book.bounding_box || book.boundingBox;
    if (!box) return;

    ctx.fillStyle = "rgba(34, 197, 94, 0.25)"; // Green fill
    ctx.strokeStyle = "#22c55e"; // Green border
    ctx.lineWidth = 2;

    // 🛑 Draw rotated polygon if available
    if (box.polygon && box.polygon.length >= 4) {
      ctx.beginPath();
      ctx.moveTo(box.polygon[0].x, box.polygon[0].y);
      ctx.lineTo(box.polygon[1].x, box.polygon[1].y);
      ctx.lineTo(box.polygon[2].x, box.polygon[2].y);
      ctx.lineTo(box.polygon[3].x, box.polygon[3].y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else {
      // Fallback rectangle
      const width = box.maxX - box.minX;
      const height = box.maxY - box.minY;
      ctx.fillRect(box.minX, box.minY, width, height);
      ctx.strokeRect(box.minX, box.minY, width, height);
    }
  });
}

function drawAutoSpines() {
  if (!detectedSpines || detectedSpines.length === 0) return;

  detectedSpines.forEach((spine) => {
    const poly = spine.rawPolygon || spine.polygon;

    if (poly && poly.length >= 4) {
      // Bold 5px Blue Outline + Blue Tint Fill
      ctx.strokeStyle = "#2563eb";
      ctx.fillStyle = "rgba(59, 130, 246, 0.25)";
      ctx.lineWidth = 7;

      ctx.beginPath();
      ctx.moveTo(poly[0].x, poly[0].y);
      ctx.lineTo(poly[1].x, poly[1].y);
      ctx.lineTo(poly[2].x, poly[2].y);
      ctx.lineTo(poly[3].x, poly[3].y);
      ctx.closePath();

      ctx.fill();
      ctx.stroke();
    }
  });
}

function processAutoSpines(rawBooks, words) {
  if (!words || words.length === 0) return [];

  const wordList = words;

  // 1. Build geometric items with ray direction vectors
  const items = wordList
    .map((w, idx) => {
      const v = w.boundingPoly?.vertices || [];
      if (v.length < 4) return null;

      const cx =
        ((v[0].x || 0) + (v[1].x || 0) + (v[2].x || 0) + (v[3].x || 0)) / 4;
      const cy =
        ((v[0].y || 0) + (v[1].y || 0) + (v[2].y || 0) + (v[3].y || 0)) / 4;

      const dx = (v[1].x || 0) - (v[0].x || 0);
      const dy = (v[1].y || 0) - (v[0].y || 0);
      const len = Math.hypot(dx, dy);

      const px = (v[3].x || 0) - (v[0].x || 0);
      const py = (v[3].y || 0) - (v[0].y || 0);
      const thickness = Math.hypot(px, py);

      const ux = len > 0 ? dx / len : 0;
      const uy = len > 0 ? dy / len : 1;

      const nx = -uy;
      const ny = ux;

      return {
        id: idx,
        word: w,
        cx,
        cy,
        ux,
        uy,
        nx,
        ny,
        length: len,
        thickness: Math.max(thickness, 12),
        v,
      };
    })
    .filter(Boolean);

  const visited = new Set();
  const spines = [];

  items.forEach((itemA) => {
    if (visited.has(itemA.id)) return;

    let cluster = [itemA];
    visited.add(itemA.id);

    let addedNew = true;
    while (addedNew) {
      addedNew = false;

      for (const itemB of items) {
        if (visited.has(itemB.id)) continue;

        for (const member of cluster) {
          const dx = itemB.cx - member.cx;
          const dy = itemB.cy - member.cy;

          const distPerp = Math.abs(dx * member.nx + dy * member.ny);
          const distParallel = Math.abs(dx * member.ux + dy * member.uy);
          const alignment = Math.abs(
            itemB.ux * member.ux + itemB.uy * member.uy,
          );

          const maxPerpOffset =
            Math.min(member.thickness, itemB.thickness) * 0.85;
          const maxParallelDist = Math.max(member.length, itemB.length) * 4.5;
          const minAlignment = 0.9;

          if (
            distPerp <= maxPerpOffset &&
            distParallel <= maxParallelDist &&
            alignment >= minAlignment
          ) {
            cluster.push(itemB);
            visited.add(itemB.id);
            addedNew = true;
            break;
          }
        }
      }
    }

    // CALCULATE TIGHT ORIENTED BOUNDING BOX (OBB) POLYGON
    const clusterUx = itemA.ux;
    const clusterUy = itemA.uy;
    const clusterNx = itemA.nx;
    const clusterNy = itemA.ny;

    let minU = Infinity,
      maxU = -Infinity;
    let minN = Infinity,
      maxN = -Infinity;

    cluster.forEach((item) => {
      item.v.forEach((v) => {
        const vx = v.x || 0;
        const vy = v.y || 0;
        const projU = vx * clusterUx + vy * clusterUy;
        const projN = vx * clusterNx + vy * clusterNy;

        if (projU < minU) minU = projU;
        if (projU > maxU) maxU = projU;
        if (projN < minN) minN = projN;
        if (projN > maxN) maxN = projN;
      });
    });

    // Reconstruct rotated corner coordinates in pixel space
    const polygon = [
      {
        x: minU * clusterUx + minN * clusterNx,
        y: minU * clusterUy + minN * clusterNy,
      },
      {
        x: maxU * clusterUx + minN * clusterNx,
        y: maxU * clusterUy + minN * clusterNy,
      },
      {
        x: maxU * clusterUx + maxN * clusterNx,
        y: maxU * clusterUy + maxN * clusterNy,
      },
      {
        x: minU * clusterUx + maxN * clusterNx,
        y: minU * clusterUy + maxN * clusterNy,
      },
    ];

    // Compute standard outer bounds for fallback calculations
    let minX = Math.min(...polygon.map((p) => p.x));
    let maxX = Math.max(...polygon.map((p) => p.x));
    let minY = Math.min(...polygon.map((p) => p.y));
    let maxY = Math.max(...polygon.map((p) => p.y));

    cluster.sort((a, b) => {
      const projA = a.cx * itemA.ux + a.cy * itemA.uy;
      const projB = b.cx * itemA.ux + b.cy * itemA.uy;
      return projA - projB;
    });

    const title = cluster.map((i) => i.word.description).join(" ");

    if (title.trim().length > 0) {
      spines.push({
        box: { minX, minY, maxX, maxY },
        polygon: polygon, // Store rotated 4-point polygon
        title: title,
      });
    }
  });

  return spines;
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

function populateBatchSpinePrompts(spines) {
  const pendingContainer = document.getElementById("pendingContainer");
  if (!pendingContainer) return;

  pendingContainer.innerHTML = "";

  if (!spines || spines.length === 0) return;

  const activeShelfSavedBooks = myLibrary.filter(
    (b) => (b.shelf_image_url || b.shelfImageUrl) === currentShelfImageUrl,
  );

  // Filter out skipped spines AND spines overlapping saved book polygons
  const availableSpines = spines.filter((spine) => {
    const cleanTitle = spine.title.trim();

    // 1. Skip if user manually dismissed this clean title
    if (dismissedSpines.has(cleanTitle)) return false;

    const sBox = spine.box;
    if (!sBox) return true;

    const sCx = (sBox.minX + sBox.maxX) / 2;
    const sCy = (sBox.minY + sBox.maxY) / 2;
    const centerPoint = { x: sCx, y: sCy };

    // 2. Check if center point lies inside any SAVED book's rotated polygon
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

  // Header Container
  const header = document.createElement("div");
  header.className = "batch-header";
  header.style.cssText =
    "font-size: 0.9rem; font-weight: bold; margin-bottom: 10px; color: #3f3f46; display: flex; justify-content: space-between; align-items: center;";

  const titleSpan = document.createElement("span");
  titleSpan.textContent = `Detected Spines (${availableSpines.length})`;
  header.appendChild(titleSpan);

  // Scrollable Cards Container
  const cardsWrapper = document.createElement("div");
  cardsWrapper.className = "spine-cards-scroll-wrapper";
  cardsWrapper.style.cssText =
    "max-height: 420px; overflow-y: auto; padding-right: 4px;";

  // "Search All" Button
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
            // Dismiss failed searches using clean title
            const cleanTitle = spine.title.trim();
            dismissedSpines.add(cleanTitle);
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

  // Render individual spine cards into scrollable wrapper
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

    // Save clean title on skip
    card
      .querySelector(".dismiss-spine-btn")
      .addEventListener("click", async () => {
        const cleanTitle = spine.title.trim();
        dismissedSpines.add(cleanTitle);
        card.remove();
        redrawCanvas();
        await saveDismissedSpines();
      });

    cardsWrapper.appendChild(card);
  });
}

// Base redraw function to reset canvas state
function redrawCanvas() {
  if (!canvas.imgObj) return;
  ctx.drawImage(canvas.imgObj, 0, 0, canvas.width, canvas.height);
  drawWordBoxes();
  drawAutoSpines();
  drawAllSavedBoxesForActiveShelf();
}

// Highlights a specific spine in bright gold on hover or focus
function highlightSpineOnCanvas(spine) {
  redrawCanvas();
  if (!spine) return;

  ctx.strokeStyle = "#f59e0b"; // Gold border
  ctx.fillStyle = "rgba(245, 158, 11, 0.5)"; // Gold fill
  ctx.lineWidth = 4;

  if (spine.polygon && spine.polygon.length >= 4) {
    ctx.beginPath();
    ctx.moveTo(spine.polygon[0].x, spine.polygon[0].y);
    ctx.lineTo(spine.polygon[1].x, spine.polygon[1].y);
    ctx.lineTo(spine.polygon[2].x, spine.polygon[2].y);
    ctx.lineTo(spine.polygon[3].x, spine.polygon[3].y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  } else if (spine.box) {
    const { minX, minY, maxX, maxY } = spine.box;
    ctx.fillRect(minX, minY, maxX - minX, maxY - minY);
    ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
  }
}

// Highlights a pending/staged book spine in blue on the canvas
function highlightPendingSpineOnCanvas(box) {
  redrawCanvas();
  if (!box || !canvas.imgObj) return;

  ctx.fillStyle = "rgba(59, 130, 246, 0.35)"; // Blue fill
  ctx.strokeStyle = "#3b82f6"; // Blue border
  ctx.lineWidth = 3;

  if (box.polygon && box.polygon.length >= 4) {
    ctx.beginPath();
    ctx.moveTo(box.polygon[0].x, box.polygon[0].y);
    ctx.lineTo(box.polygon[1].x, box.polygon[1].y);
    ctx.lineTo(box.polygon[2].x, box.polygon[2].y);
    ctx.lineTo(box.polygon[3].x, box.polygon[3].y);
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

// Helper to save skipped spines for the active shelf in Supabase
async function saveDismissedSpines() {
  if (!currentUser || !currentShelfImageUrl) return;

  const titlesArray = Array.from(dismissedSpines);
  const { error } = await supabaseClient.from("shelves").upsert(
    [
      {
        user_id: currentUser.id,
        image_url: currentShelfImageUrl,
        detected_words: detectedWords,
        dismissed_titles: titlesArray, // Saves clean ['BP', 'BROCK'] array
      },
    ],
    { onConflict: "image_url" },
  );

  if (error) console.error("Error saving skipped spines:", error);
}
