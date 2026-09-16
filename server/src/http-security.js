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

function normalizePlan(plan) {
  return String(plan || "")
    .trim()
    .toLowerCase() === "premium"
    ? "premium"
    : "free";
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
      "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self'; img-src 'self' data: blob: https://*.supabase.co https://*.google.com https://*.googleusercontent.com https://*.gstatic.com; connect-src 'self' https://*.supabase.co https://api.stripe.com; frame-src https://checkout.stripe.com https://billing.stripe.com; worker-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self' https://checkout.stripe.com https://billing.stripe.com",
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
  normalizePlan,
  createPlanRateLimiter,
  createImageUpload,
  createRequireAuth,
  requirePremium,
  getUserPlan,
  getBearerToken,
  handleUploadError,
  sniffImageMime,
  setSecurityHeaders,
};
