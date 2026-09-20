/**
 * Public app origin used for OAuth redirects and injected client config.
 * Reads CANONICAL_ORIGIN, then APP_BASE_URL.
 */
function getPublicAppOrigin(env = process.env) {
  const raw = String(env.CANONICAL_ORIGIN || env.APP_BASE_URL || "")
    .trim()
    .replace(/\/$/, "");
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
  return "";
}

function mountPublicConfigRoutes(app, { getOrigin = getPublicAppOrigin } = {}) {
  app.get("/api/public-config.js", (req, res) => {
    const payload = JSON.stringify({
      appOrigin: getOrigin() || null,
    });
    res.setHeader("Cache-Control", "no-cache");
    res.type("application/javascript").send(`window.__SHELFMAPPER_PUBLIC__=${payload};`);
  });

  app.get("/api/public-config", (req, res) => {
    res.json({
      appOrigin: getOrigin() || null,
    });
  });
}

module.exports = {
  getPublicAppOrigin,
  mountPublicConfigRoutes,
};
