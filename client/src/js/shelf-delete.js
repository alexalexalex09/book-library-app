/**
 * Delete a shelf row. user_books cascade via user_books_shelf_id_fkey.
 * Do not delete books first — a later shelf-delete failure would wipe the
 * catalog and leave an empty shelf.
 * Loaded in the browser before app.js; also require()-able for Node tests.
 */

async function deleteShelfById(client, { shelfId, userId } = {}) {
  if (!client || typeof client.from !== "function") {
    return { error: new Error("Database client is not available") };
  }
  if (shelfId == null || shelfId === "" || !userId) {
    return { error: new Error("Shelf and user are required") };
  }

  const { error } = await client
    .from("shelves")
    .delete()
    .eq("id", shelfId)
    .eq("user_id", userId);
  return { error: error || null };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { deleteShelfById };
}
