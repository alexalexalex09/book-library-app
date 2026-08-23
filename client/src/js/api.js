async function fetchBookMetadata(query) {
  try {
    // 🛑 Use relative URL path so it calls your live Render backend
    const response = await fetch(`/api/books?q=${encodeURIComponent(query)}`);

    if (!response.ok) {
      throw new Error(`Server returned status ${response.status}`);
    }

    const data = await response.json();

    if (data.items && data.items.length > 0) {
      const book = data.items[0].volumeInfo;
      return {
        title: book.title || query,
        author: book.authors ? book.authors.join(", ") : "Unknown Author",
        thumbnail:
          book.imageLinks?.thumbnail || book.imageLinks?.smallThumbnail || "",
      };
    }
    return null;
  } catch (error) {
    console.error("Error fetching book metadata:", error);
    return null;
  }
}
