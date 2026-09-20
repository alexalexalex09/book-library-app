(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.ShelfMapperShelfSave = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function buildUserBooksRows({
    userId,
    shelfId,
    imagePath,
    spines,
    toHttpsUrl,
  }) {
    const httpsUrl =
      typeof toHttpsUrl === "function"
        ? toHttpsUrl
        : (value) =>
            typeof value === "string" && value.trim()
              ? value.trim().replace(/^http:\/\//i, "https://")
              : "";

    return (spines || []).map((spine) => ({
      user_id: userId,
      shelf_id: shelfId,
      title: String(spine?.title || "").trim() || "Untitled Book",
      bounding_box: spine?.box || spine?.boundingBox || null,
      polygon: spine?.polygon || null,
      cover: httpsUrl(spine?.thumbnail) || null,
      shelf_image_url: imagePath,
    }));
  }

  // Never delete existing books unless the replacement insert succeeded.
  function bookIdsToDeleteAfterInsert(previousBooks, insertSucceeded) {
    if (!insertSucceeded) return [];
    return (previousBooks || [])
      .map((row) => row?.id)
      .filter((id) => id != null);
  }

  return { buildUserBooksRows, bookIdsToDeleteAfterInsert };
});
