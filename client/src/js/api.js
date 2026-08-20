async function fetchBookMetadata(rawText) {
  if (!rawText) return null;

  try {
    // Query the Google Books API, asking for only the top 1 result
    const response = await fetch(
      `http://localhost:3000/api/books?q=${encodeURIComponent(rawText)}`,
    );
    const data = await response.json();

    if (data.items && data.items.length > 0) {
      const info = data.items[0].volumeInfo;
      return {
        title: info.title || "Unknown Title",
        author: info.authors ? info.authors.join(", ") : "Unknown Author",
        publishedDate: info.publishedDate || "Unknown Year",
        thumbnail: info.imageLinks ? info.imageLinks.thumbnail : null,
      };
    }
    return null;
  } catch (error) {
    console.error("Error fetching from Google Books:", error);
    return null;
  }
}
