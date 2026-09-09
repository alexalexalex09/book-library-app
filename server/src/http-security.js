const multer = require("multer");

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

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

function setSecurityHeaders(req, res, next) {
  res.set({
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' https://*.supabase.co; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
    "Cross-Origin-Opener-Policy": "same-origin",
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
  MAX_IMAGE_BYTES,
  createImageUpload,
  createRequireAuth,
  getBearerToken,
  handleUploadError,
  setSecurityHeaders,
};
