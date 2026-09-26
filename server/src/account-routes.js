const express = require("express");

const DELETE_CONFIRMATION = "DELETE";

async function countForUser(supabase, table, userId) {
  const { data, error } = await supabase
    .from(table)
    .select("id")
    .eq("user_id", userId);
  if (error) {
    console.error(`account count ${table}:`, error.message || error);
    return null;
  }
  return Array.isArray(data) ? data.length : 0;
}

async function listStoragePaths(bucket, prefix) {
  const paths = [];
  let offset = 0;
  const limit = 100;
  for (;;) {
    const { data, error } = await bucket.list(prefix, { limit, offset });
    if (error) {
      console.error("account storage list failed:", error.message || error);
      break;
    }
    const items = Array.isArray(data) ? data : [];
    for (const item of items) {
      if (!item?.name) continue;
      const path = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.id) paths.push(path);
      else {
        const nested = await listStoragePaths(bucket, path);
        paths.push(...nested);
      }
    }
    if (items.length < limit) break;
    offset += items.length;
  }
  return paths;
}

async function removeUserStorage(supabase, userId) {
  if (!supabase?.storage?.from || !userId) return;
  try {
    const bucket = supabase.storage.from("shelves");
    const paths = await listStoragePaths(bucket, userId);
    for (let i = 0; i < paths.length; i += 100) {
      const slice = paths.slice(i, i + 100);
      const { error } = await bucket.remove(slice);
      if (error) console.error("account storage remove failed:", error.message || error);
    }
  } catch (error) {
    console.error("account storage cleanup failed:", error?.message || error);
  }
}

async function purgeSupportTickets(supabase, userId) {
  const deleted = await supabase.from("support_tickets").delete().eq("user_id", userId);
  if (!deleted.error) return;
  console.error("support ticket delete failed:", deleted.error.message || deleted.error);
  const redacted = await supabase
    .from("support_tickets")
    .update({
      email: "deleted@example.com",
      subject: "[account deleted]",
      body: "[account deleted]",
    })
    .eq("user_id", userId);
  if (redacted.error) {
    throw new Error(redacted.error.message || "Failed to remove support history");
  }
}

function signInProviders(user) {
  const identities = Array.isArray(user?.identities) ? user.identities : [];
  return [...new Set(identities.map((identity) => identity?.provider).filter(Boolean))];
}

function createAccountRouter({ supabase, requireAuth, cancelBillingForUser }) {
  const router = express.Router();

  router.get("/", requireAuth, async (req, res) => {
    try {
      const user = req.user;
      const [books, shelves, libraries] = await Promise.all([
        countForUser(supabase, "user_books", user.id),
        countForUser(supabase, "shelves", user.id),
        countForUser(supabase, "libraries", user.id),
      ]);
      return res.json({
        email: user.email || null,
        emailConfirmedAt: user.email_confirmed_at || null,
        newEmail: user.new_email || null,
        createdAt: user.created_at || null,
        providers: signInProviders(user),
        counts: { books, shelves, libraries },
      });
    } catch (error) {
      console.error("Account summary failed:", error?.message || error);
      return res.status(500).json({ error: "Failed to load account" });
    }
  });

  router.post("/delete", requireAuth, async (req, res) => {
    const confirm = String(req.body?.confirm || "").trim();
    if (confirm !== DELETE_CONFIRMATION) {
      return res.status(400).json({ error: "Type DELETE to confirm account deletion." });
    }

    const user = req.user;
    try {
      if (typeof cancelBillingForUser === "function") {
        await cancelBillingForUser(user);
      }
    } catch (error) {
      console.error("Account delete billing cancel failed:", error?.message || error);
      return res.status(502).json({
        error: "Could not cancel billing. Your account was not deleted.",
      });
    }

    try {
      await removeUserStorage(supabase, user.id);
      await purgeSupportTickets(supabase, user.id);
      const { error } = await supabase.auth.admin.deleteUser(user.id);
      if (error) throw new Error(error.message || "Failed to delete account");
      return res.json({ ok: true });
    } catch (error) {
      console.error("Account delete failed:", error?.message || error);
      return res.status(500).json({ error: "Failed to delete account" });
    }
  });

  return router;
}

module.exports = {
  createAccountRouter,
};
