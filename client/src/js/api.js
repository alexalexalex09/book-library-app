async function authenticatedFetch(input, init = {}) {
  const {
    data: { session },
    error,
  } = await supabaseClient.auth.getSession();

  if (error || !session?.access_token) {
    throw new Error("Authentication required");
  }

  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${session.access_token}`);

  return fetch(input, { ...init, headers });
}

async function fetchBookMetadata(query) {
  try {
    const response = await authenticatedFetch(
      `/api/books?q=${encodeURIComponent(query)}`,
    );

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
