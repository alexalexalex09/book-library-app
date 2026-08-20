// --- 1. GLOBAL STATE & DOM ELEMENTS ---
const imageUpload = document.getElementById("imageUpload");
const canvas = document.getElementById("shelfCanvas");
const ctx = canvas.getContext("2d");
const placeholderText = document.getElementById("placeholderText");

let detectedWords = [];
let isDragging = false;
let dragPath = [];
let selectedWords = new Set(); // Set prevents duplicate word selection
let myLibrary = JSON.parse(localStorage.getItem("myLibrary")) || []; // Load from storage

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
    }
  } catch (error) {
    console.error("Error communicating with OCR server:", error);
  }
}

// --- 4. DRAWING FUNCTIONS ---
function drawWordBoxes() {
  ctx.strokeStyle = "rgba(200, 200, 200, 0.5)"; // Faint gray for inactive words
  ctx.lineWidth = 2;

  detectedWords.forEach((word) => {
    const v = word.boundingPoly.vertices;
    if (v && v.length === 4) {
      ctx.beginPath();
      ctx.moveTo(v[0].x || 0, v[0].y || 0);
      ctx.lineTo(v[1].x || 0, v[1].y || 0);
      ctx.lineTo(v[2].x || 0, v[2].y || 0);
      ctx.lineTo(v[3].x || 0, v[3].y || 0);
      ctx.closePath();
      ctx.stroke();
    }
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

    // Call out to our API helper (from api.js)
    const bookData = await fetchBookMetadata(stitchedText);
    if (bookData) {
      renderConfirmationCard(stitchedText, bookData, unifiedBox);
    } else {
      console.log("No metadata found for:", stitchedText);
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
  confirmBtn.addEventListener("click", () => {
    const finalBook = {
      id: Date.now(),
      title: bookData.title,
      author: bookData.author,
      cover: coverImg,
      boundingBox: unifiedBox, // This is exactly what we need for the highlighter!
    };

    myLibrary.push(finalBook);
    localStorage.setItem("myLibrary", JSON.stringify(myLibrary));

    // 3. Remove the pending card and immediately refresh the permanent library list
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

libraryList.addEventListener("click", (e) => {
  // Check if the click happened on or inside an <li> element
  const li = e.target.closest("li");

  // If we didn't click an <li>, or if it's the "empty state" message, ignore it
  if (!li || !li.dataset.bookId) return;

  // Grab the ID we attached to the HTML in the previous step
  const bookId = parseInt(li.dataset.bookId);

  // Find the matching book in our saved database
  const book = myLibrary.find((b) => b.id === bookId);

  if (book && book.boundingBox) {
    console.log(`Highlighting physical location for: ${book.title}`);
    highlightBookOnCanvas(book.boundingBox);
  }
});

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
      <img src="${book.cover}" style="width: 40px; height: 60px; object-fit: cover; border-radius: 4px;">
      <div style="flex: 1;">
        <h3 style="font-size: 0.95rem; margin-bottom: 2px;">${book.title}</h3>
        <p style="font-size: 0.75rem; color: #71717a;">${book.author}</p>
      </div>
    `;

    libraryList.appendChild(li);
  });
}

// Listen for typing in the search box
searchInput.addEventListener("input", (e) => {
  renderSavedLibrary(e.target.value);
});

// Draw the library immediately when the page loads!
renderSavedLibrary();
