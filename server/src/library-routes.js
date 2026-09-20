const express = require("express");
const { randomBytes } = require("crypto");

/**
 * Rooms, shares, and custom-cover API routes.
 * Public share lookup is returned separately for mounting at /api/share/:token.
 */
function createLibraryRouter({
  supabase,
  requireAuth,
  requirePremium,
  getUserPlan,
  createToken = () => randomBytes(24).toString("base64url"),
}) {
  const router = express.Router();

  router.get("/rooms", requireAuth, async (req, res) => {
    try {
      if (getUserPlan(req.user) !== "premium") {
        return res.json([{ id: "default", name: "My Library", isDefault: true }]);
      }
      const { data, error } = await supabase
        .from("libraries")
        .select("*")
        .eq("user_id", req.user.id)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return res.json(data || []);
    } catch (error) {
      return res.status(500).json({ error: "Failed to load rooms" });
    }
  });

  router.post("/rooms", requireAuth, requirePremium, async (req, res) => {
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "Room name is required" });
    try {
      const { data, error } = await supabase
        .from("libraries")
        .insert({ user_id: req.user.id, name })
        .select("*")
        .single();
      if (error) throw error;
      return res.json(data);
    } catch (error) {
      return res.status(500).json({ error: "Failed to create room" });
    }
  });

  router.patch("/rooms/:id", requireAuth, requirePremium, async (req, res) => {
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "Room name is required" });
    try {
      const { data, error } = await supabase
        .from("libraries")
        .update({ name })
        .eq("id", req.params.id)
        .eq("user_id", req.user.id)
        .select("*")
        .single();
      if (error) throw error;
      return res.json(data);
    } catch (error) {
      return res.status(500).json({ error: "Failed to rename room" });
    }
  });

  router.post("/rooms/assign", requireAuth, requirePremium, async (req, res) => {
    const shelfId = Number(req.body?.shelfId);
    const roomId = Number(req.body?.roomId);
    if (!Number.isFinite(shelfId) || !Number.isFinite(roomId)) {
      return res.status(400).json({ error: "shelfId and roomId are required" });
    }
    try {
      const { data, error } = await supabase
        .from("shelves")
        .update({ library_id: roomId })
        .eq("id", shelfId)
        .eq("user_id", req.user.id)
        .select("*")
        .single();
      if (error) throw error;
      return res.json(data);
    } catch (error) {
      return res.status(500).json({ error: "Failed to assign shelf to room" });
    }
  });

  router.post("/books/:id/cover", requireAuth, requirePremium, async (req, res) => {
    const cover = String(req.body?.cover || "").trim();
    if (!cover) return res.status(400).json({ error: "cover is required" });
    try {
      const { data, error } = await supabase
        .from("user_books")
        .update({ cover })
        .eq("id", req.params.id)
        .eq("user_id", req.user.id)
        .select("*")
        .single();
      if (error) throw error;
      return res.json(data);
    } catch (error) {
      return res.status(500).json({ error: "Failed to update cover" });
    }
  });

  router.get("/shares", requireAuth, requirePremium, async (req, res) => {
    try {
      const { data, error } = await supabase
        .from("library_shares")
        .select("*")
        .eq("user_id", req.user.id)
        .is("revoked_at", null)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return res.json(data || []);
    } catch (error) {
      return res.status(500).json({ error: "Failed to load shares" });
    }
  });

  router.post("/shares", requireAuth, requirePremium, async (req, res) => {
    const libraryIdValue = req.body?.libraryId;
    const libraryId =
      libraryIdValue === null || libraryIdValue === undefined
        ? null
        : Number(libraryIdValue);
    if (
      libraryIdValue !== null &&
      libraryIdValue !== undefined &&
      !Number.isFinite(libraryId)
    ) {
      return res.status(400).json({ error: "libraryId must be a number or null" });
    }
    try {
      const token = createToken();
      const { data, error } = await supabase
        .from("library_shares")
        .insert({
          user_id: req.user.id,
          token,
          library_id: libraryId,
        })
        .select("*")
        .single();
      if (error) throw error;
      return res.json({
        ...data,
        url: `${req.protocol}://${req.get("host")}/share/${token}`,
      });
    } catch (error) {
      return res.status(500).json({ error: "Failed to create share link" });
    }
  });

  router.delete("/shares/:id", requireAuth, requirePremium, async (req, res) => {
    try {
      const { error } = await supabase
        .from("library_shares")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", req.params.id)
        .eq("user_id", req.user.id);
      if (error) throw error;
      return res.json({ ok: true });
    } catch (error) {
      return res.status(500).json({ error: "Failed to revoke share link" });
    }
  });

  return router;
}

async function handlePublicShare(req, res, supabase) {
  try {
    const token = String(req.params.token || "").trim();
    if (!token) return res.status(404).json({ error: "Share not found" });

    const { data: share, error: shareError } = await supabase
      .from("library_shares")
      .select("*")
      .eq("token", token)
      .is("revoked_at", null)
      .maybeSingle();
    if (shareError) throw shareError;
    if (!share) return res.status(404).json({ error: "Share not found" });

    let shelvesQuery = supabase
      .from("shelves")
      .select("*")
      .eq("user_id", share.user_id);
    if (share.library_id) shelvesQuery = shelvesQuery.eq("library_id", share.library_id);
    const { data: shelves, error: shelvesError } = await shelvesQuery;
    if (shelvesError) throw shelvesError;

    const shelfIds = (shelves || []).map((s) => s.id);
    let booksQuery = supabase
      .from("user_books")
      .select("id,shelf_id,title,author,cover,bounding_box,polygon,created_at")
      .eq("user_id", share.user_id);
    if (shelfIds.length > 0) booksQuery = booksQuery.in("shelf_id", shelfIds);
    const { data: books, error: booksError } = await booksQuery;
    if (booksError) throw booksError;
    return res.json({ shelves: shelves || [], books: books || [] });
  } catch (error) {
    return res.status(500).json({ error: "Failed to load shared library" });
  }
}

module.exports = {
  createLibraryRouter,
  handlePublicShare,
};
