/**
 * Decide how public share links should load books.
 *
 * Room-scoped shares (library_id set) must never fall back to the owner's
 * entire catalog. The previous handler skipped `.in("shelf_id", ids)` when
 * `ids` was empty, which leaked every user_books row for that owner.
 */
function resolveSharedLibraryBookScope(share, shelves) {
  const shelfIds = (Array.isArray(shelves) ? shelves : [])
    .map((shelf) => shelf?.id)
    .filter((id) => id !== undefined && id !== null);

  if (share?.library_id) {
    return {
      restrictToShelfIds: true,
      shelfIds,
    };
  }

  return {
    restrictToShelfIds: shelfIds.length > 0,
    shelfIds,
  };
}

function filterBooksForShare(share, shelves, books) {
  const { restrictToShelfIds, shelfIds } = resolveSharedLibraryBookScope(
    share,
    shelves,
  );
  if (!restrictToShelfIds) return Array.isArray(books) ? books : [];
  const allowed = new Set(shelfIds.map((id) => String(id)));
  return (Array.isArray(books) ? books : []).filter((book) =>
    allowed.has(String(book?.shelf_id)),
  );
}

module.exports = {
  resolveSharedLibraryBookScope,
  filterBooksForShare,
};
