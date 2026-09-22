const multer = require("multer");
const rateLimit = require("express-rate-limit");

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 25_000_000;
const MAX_IMAGE_DIMENSION = 8192;
const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const PLAN_QUOTAS = {
  free: { ocr: 10, books: 60 },
  premium: { ocr: 60, books: 300 },
};

const LOCAL_DEV_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
];

function normalizePlan(plan) {
  return String(plan || "")
    .trim()
    .toLowerCase() === "premium"
    ? "premium"
    : "free";
}

function normalizeEmail(email) {
  return String(email || "")
    .trim()
    .toLowerCase();
}

function normalizeOrigin(origin) {
  return String(origin || "")
    .trim()
    .replace(/\/$/, "");
}

function parseCsvList(raw) {
  return String(raw || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseAdminEmails(env = process.env) {
  return new Set(parseCsvList(env.ADMIN_EMAILS).map(normalizeEmail).filter(Boolean));
}

/** Exact CORS allowlist from CORS_ORIGINS (or legacy CORS_ORIGIN). */
function getAllowedCorsOrigins(env = process.env) {
  const listed = parseCsvList(env.CORS_ORIGINS || env.CORS_ORIGIN).map(
    normalizeOrigin,
  );
  if (env.NODE_ENV !== "production") {
    for (const origin of LOCAL_DEV_ORIGINS) {
      if (!listed.includes(origin)) listed.push(origin);
    }
  }
  return new Set(listed);
}

/** Origins allowed to call mutating /api/admin routes. */
function getAdminOrigins(env = process.env) {
  const explicit = parseCsvList(env.ADMIN_ORIGINS).map(normalizeOrigin);
  if (explicit.length > 0) {
    const set = new Set(explicit);
    if (env.NODE_ENV !== "production") {
      for (const origin of LOCAL_DEV_ORIGINS) set.add(origin);
    }
    return set;
  }
  const fromCors = [...getAllowedCorsOrigins(env)].filter(
    (origin) =>
      /\/\/admin\./i.test(origin) ||
      (env.NODE_ENV !== "production" &&
        /localhost|127\.0\.0\.1/i.test(origin)),
  );
  return new Set(fromCors);
}

function createCorsOriginDelegate(env = process.env) {
  const allowed = getAllowedCorsOrigins(env);
  return function corsOrigin(origin, callback) {
    // Non-browser tooling may omit Origin — allow without reflecting ACAO.
    if (!origin) return callback(null, false);
    if (allowed.has(normalizeOrigin(origin))) return callback(null, true);
    return callback(null, false);
  };
}

function getBearerToken(authorizationHeader) {
  if (typeof authorizationHeader !== "string") return null;

  const match = authorizationHeader.match(/^Bearer ([^\s]+)$/i);
  return match?.[1] || null;
}

function createRequireAuth(supabase) {
  return async function requireAuth(req, res, next) {
    const token = getBearerToken(req.get("authorization"));
    if (!token) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: "Invalid or expired access token" });
    }

    req.user = user;
    return next();
  };
}

function isAdminUser(user, env = process.env) {
  const role = String(user?.app_metadata?.role || "")
    .trim()
    .toLowerCase();
  if (role !== "admin") return false;
  const email = normalizeEmail(user?.email);
  if (!email) return false;
  const allowlist = parseAdminEmails(env);
  if (allowlist.size === 0) return false;
  return allowlist.has(email);
}

function requireAdmin(req, res, next) {
  if (isAdminUser(req.user)) return next();
  return res.status(403).json({
    error: "Admin access required.",
    code: "ADMIN_REQUIRED",
  });
}

function extractRequestOrigin(req) {
  const origin = normalizeOrigin(req.get("origin"));
  if (origin) return origin;
  const referer = String(req.get("referer") || "").trim();
  if (!referer) return null;
  try {
    const url = new URL(referer);
    return normalizeOrigin(url.origin);
  } catch {
    return null;
  }
}

/** Block mutating admin calls that do not come from an allowlisted admin Origin. */
function requireAdminOrigin(req, res, next) {
  const method = String(req.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return next();
  }
  const origin = extractRequestOrigin(req);
  const allowed = getAdminOrigins();
  if (origin && allowed.has(origin)) return next();
  return res.status(403).json({
    error: "Admin requests must originate from the admin site.",
    code: "ADMIN_ORIGIN_REQUIRED",
  });
}

function createAdminRateLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const userId = req.user?.id;
      if (userId) return `admin-user:${userId}`;
      return `admin-ip:${rateLimit.ipKeyGenerator(req.ip)}`;
    },
    handler: (req, res) => {
      res.status(429).json({
        error: "Too many admin requests. Please try again later.",
        code: "ADMIN_RATE_LIMIT",
      });
    },
  });
}

function createImageUpload() {
  return multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: MAX_IMAGE_BYTES,
      files: 1,
      fields: 2,
    },
    fileFilter(req, file, callback) {
      if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
        return callback(
          new multer.MulterError("LIMIT_UNEXPECTED_FILE", file.fieldname),
        );
      }
      return callback(null, true);
    },
  });
}

function getUserPlan(user) {
  return normalizePlan(user?.app_metadata?.plan);
}

function requirePremium(req, res, next) {
  const plan = getUserPlan(req.user);
  if (plan === "premium") return next();
  return res.status(403).json({
    error: "This feature requires Premium.",
    code: "FEATURE_LOCKED",
    plan,
  });
}

function createPlanRateLimiter({
  action,
  windowMs,
  message = "Too many requests. Please try again later.",
}) {
  return rateLimit({
    windowMs,
    limit: (req) => {
      const plan = getUserPlan(req.user);
      const quota = PLAN_QUOTAS[plan] || PLAN_QUOTAS.free;
      return quota[action] || PLAN_QUOTAS.free[action] || 10;
    },
    keyGenerator: (req) => req.user?.id || rateLimit.ipKeyGenerator(req.ip),
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      const plan = getUserPlan(req.user);
      res.status(429).json({ error: message, code: "PLAN_LIMIT", plan });
    },
  });
}

function sniffImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

function setSecurityHeaders(req, res, next) {
  res.set({
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' https://fonts.googleapis.com; img-src 'self' data: blob: https://*.supabase.co https://*.google.com https://*.googleusercontent.com https://*.gstatic.com; connect-src 'self' https://*.supabase.co https://api.stripe.com; frame-src https://checkout.stripe.com https://billing.stripe.com; worker-src 'self'; font-src 'self' https://fonts.gstatic.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self' https://checkout.stripe.com https://billing.stripe.com",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  next();
}

function handleUploadError(error, req, res, next) {
  if (!(error instanceof multer.MulterError)) return next(error);

  if (error.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({
      error: `Image exceeds the ${MAX_IMAGE_BYTES / 1024 / 1024} MB limit`,
    });
  }

  return res.status(400).json({
    error: "Upload must be one JPEG, PNG, or WebP image",
  });
}

module.exports = {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_DIMENSION,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_PIXELS,
  PLAN_QUOTAS,
  LOCAL_DEV_ORIGINS,
  normalizePlan,
  normalizeEmail,
  normalizeOrigin,
  parseAdminEmails,
  getAllowedCorsOrigins,
  getAdminOrigins,
  createCorsOriginDelegate,
  createPlanRateLimiter,
  createAdminRateLimiter,
  createImageUpload,
  createRequireAuth,
  requirePremium,
  requireAdmin,
  requireAdminOrigin,
  isAdminUser,
  getUserPlan,
  getBearerToken,
  extractRequestOrigin,
  handleUploadError,
  sniffImageMime,
  setSecurityHeaders,
};
