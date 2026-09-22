const USAGE_ACTIONS = new Set([
  "ocr_ok",
  "ocr_error",
  "ocr_rate_limit",
  "books_ok",
  "books_rate_limit",
]);

function createUsageAnalytics(supabase) {
  async function recordEvent(userId, action, meta = {}) {
    if (!USAGE_ACTIONS.has(action)) return;
    try {
      const { error } = await supabase.from("api_usage_events").insert({
        user_id: userId || null,
        action,
        meta: meta && typeof meta === "object" ? meta : {},
      });
      if (error) {
        console.error("usage-analytics: record failed", error.message || error);
      }
    } catch (error) {
      console.error("usage-analytics: record failed", error?.message || error);
    }
  }

  async function touchEngagement(userId) {
    if (!userId) return;
    try {
      const now = new Date().toISOString();
      const { data: existing, error: readError } = await supabase
        .from("user_engagement")
        .select("user_id,request_count")
        .eq("user_id", userId)
        .maybeSingle();
      if (readError) {
        console.error(
          "usage-analytics: engagement read failed",
          readError.message || readError,
        );
        return;
      }
      if (existing) {
        const { error } = await supabase
          .from("user_engagement")
          .update({
            last_seen_at: now,
            request_count: Number(existing.request_count || 0) + 1,
          })
          .eq("user_id", userId);
        if (error) {
          console.error(
            "usage-analytics: engagement update failed",
            error.message || error,
          );
        }
        return;
      }
      const { error } = await supabase.from("user_engagement").insert({
        user_id: userId,
        first_seen_at: now,
        last_seen_at: now,
        request_count: 1,
      });
      if (error && !/duplicate|unique/i.test(String(error.message || ""))) {
        console.error(
          "usage-analytics: engagement insert failed",
          error.message || error,
        );
      }
    } catch (error) {
      console.error(
        "usage-analytics: engagement failed",
        error?.message || error,
      );
    }
  }

  return { recordEvent, touchEngagement };
}

module.exports = {
  createUsageAnalytics,
  USAGE_ACTIONS,
};
