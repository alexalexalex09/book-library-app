// --- 1. GLOBAL STATE & DOM ELEMENTS ---
const imageUpload = document.getElementById("imageUpload");
const canvas = document.getElementById("shelfCanvas");
const ctx = canvas.getContext("2d");
const placeholderText = document.getElementById("placeholderText");

let currentShelfImageUrl = "";
let detectedWords = [];
let isDragging = false;
let dragPath = [];
let selectedWords = new Set(); // Set prevents duplicate word selection

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
    const response = await fetch("http://localhost:3000/api/ocr", {
      method: "POST",
      body: formData,
    });

    const result = await response.json();

    if (result.words && result.words.length > 1) {
      console.log("OCR Data Received! Drawing word boxes...");

      // Slice(1) skips the giant combined text block (index 0)
      detectedWords = result.words.slice(1);

      ctx.drawImage(canvas.imgObj, 0, 0, canvas.width, canvas.height);
      drawWordBoxes();

      currentShelfImageUrl = result.imageUrl;

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
  });
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

canvas.addEventListener("mousedown", (e) => {
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
});

// --- 6. UI CONFIRMATION & DATABASE ---
function renderConfirmationCard(ocrText, bookData, unifiedBox) {
  // 1. Target the pending container instead of the main library list
  const pendingContainer = document.getElementById("pendingContainer");

  const div = document.createElement("div");
  div.style.border = "2px solid #3b82f6"; // Blue border for pending
  div.style.padding = "10px";
  div.style.marginBottom = "10px";
  div.style.borderRadius = "8px";
  div.style.display = "flex";
  div.style.gap = "10px";
  div.style.background = "#eff6ff"; // Light blue background

  const coverImg =
    bookData.thumbnail || "https://via.placeholder.com/50x75?text=No+Cover";

  div.innerHTML = `
    <img src="${coverImg}" style="width: 50px; height: 75px; object-fit: cover; border-radius: 4px;">
    <div style="flex: 1;">
      <h3 style="font-size: 1rem; margin-bottom: 4px;">${bookData.title}</h3>
      <p style="font-size: 0.8rem; color: #71717a; margin-bottom: 8px;">By ${bookData.author}</p>
      <button class="confirm-btn" style="background: #22c55e; color: white; border: none; padding: 4px 8px; border-radius: 4px; cursor: pointer;">Confirm & Save</button>
    </div>
  `;

  // 2. Prepend to the pending container so it sits at the top
  pendingContainer.prepend(div);

  const confirmBtn = div.querySelector(".confirm-btn");
  confirmBtn.addEventListener("click", async () => {
    // Make sure they are logged in first!
    if (!currentUser) {
      alert("Please log in to save books!");
      return;
    }

    const finalBook = {
      user_id: currentUser.id, // Tie the book to the logged-in user
      title: bookData.title,
      author: bookData.author,
      cover: coverImg,
      bounding_box: unifiedBox,
      shelf_image_url: currentShelfImageUrl,
    };

    // Save directly to Postgres!
    const { data, error } = await supabaseClient
      .from("user_books")
      .insert([finalBook])
      .select(); // Ask Supabase to return the newly created row

    if (error) {
      console.error("Error saving book:", error);
      alert("Failed to save book.");
      return;
    }

    // Add the new row to our local array and refresh the UI
    myLibrary.unshift(data[0]);
    populateShelfDropdown();
    shelfSelect.value = currentShelfImageUrl;
    div.remove();
    renderSavedLibrary(searchInput.value);
  });
}

function highlightBookOnCanvas(box) {
  // Make sure we actually have an image loaded on the canvas
  if (!canvas.imgObj) return;

  // 1. Clear the canvas and redraw the pristine, original photo
  ctx.drawImage(canvas.imgObj, 0, 0, canvas.width, canvas.height);

  // 2. Redraw the faint gray word boxes so the user can still swipe other books
  drawWordBoxes();

  // 3. Draw the glowing highlight box over our saved book coordinates
  ctx.beginPath();

  // ctx.rect takes (x, y, width, height)
  const width = box.maxX - box.minX;
  const height = box.maxY - box.minY;
  ctx.rect(box.minX, box.minY, width, height);

  // Style it like a bright yellow highlighter
  ctx.strokeStyle = "#eab308"; // Bright yellow border
  ctx.lineWidth = 5;
  ctx.fillStyle = "rgba(234, 179, 8, 0.4)"; // Semi-transparent yellow fill

  ctx.stroke();
  ctx.fill();
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
      .select("detected_words")
      .eq("image_url", imageUrl)
      .maybeSingle();

    if (error) {
      console.error("Error fetching shelf OCR data:", error);
    }

    if (data && data.detected_words) {
      detectedWords = data.detected_words;
      console.log(`Loaded ${detectedWords.length} words for shelf.`);
    } else {
      console.warn("No OCR words found in database for this shelf URL.");
      detectedWords = [];
    }

    // Render word boxes and cataloged book highlights
    drawWordBoxes();
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

  // Clear previous pending card and display new one
  pendingContainer.innerHTML = "";
  pendingContainer.appendChild(card);

  // Focus the input immediately so the user can edit right away
  const input = card.querySelector("#titleConfirmInput");
  input.focus();
  input.select();

  // Search button click
  card.querySelector("#searchBookBtn").addEventListener("click", async () => {
    const editedTitle = input.value.trim();
    if (!editedTitle) return alert("Please enter a title.");

    card.innerHTML = `<p style="font-size: 0.9rem; color: #71717a; margin: 0;">Searching Google Books for "<strong>${editedTitle}</strong>"...</p>`;

    // Pass the confirmed/edited title to your Google Books lookup function
    await fetchAndDisplayBookData(editedTitle, boundingBox, card);
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

    const width = box.maxX - box.minX;
    const height = box.maxY - box.minY;

    // Draw a subtle green box over cataloged books
    ctx.fillStyle = "rgba(34, 197, 94, 0.25)";
    ctx.strokeStyle = "#22c55e";
    ctx.lineWidth = 2;

    ctx.fillRect(box.minX, box.minY, width, height);
    ctx.strokeRect(box.minX, box.minY, width, height);
  });
}

// Highlights a specific selected book in bright gold
function highlightBookOnCanvas(box) {
  if (!box || !canvas.imgObj) return;

  // 1. Redraw base shelf image
  ctx.drawImage(canvas.imgObj, 0, 0, canvas.width, canvas.height);

  // 2. Redraw all saved green boxes for context
  drawAllSavedBoxesForActiveShelf();

  // 3. Highlight the selected book
  const width = box.maxX - box.minX;
  const height = box.maxY - box.minY;

  ctx.fillStyle = "rgba(245, 158, 11, 0.45)"; // Gold fill
  ctx.strokeStyle = "#f59e0b"; // Gold border
  ctx.lineWidth = 4;

  ctx.fillRect(box.minX, box.minY, width, height);
  ctx.strokeRect(box.minX, box.minY, width, height);
}
