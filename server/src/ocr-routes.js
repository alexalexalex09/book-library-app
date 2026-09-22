const express = require("express");
const {
  ALLOWED_IMAGE_TYPES,
  createImageUpload,
  sniffImageMime,
  handleUploadError,
} = require("./http-security");

/**
 * OCR entry validation shared by production and tests.
 * Full Vision pipeline stays in server.js; tests inject processImage.
 */
function createOcrRouter({
  requireAuth,
  rateLimit,
  upload = createImageUpload(),
  processImage,
  usageAnalytics,
}) {
  const router = express.Router();

  router.post(
    "/",
    requireAuth,
    rateLimit || ((req, res, next) => next()),
    upload.single("image"),
    async (req, res) => {
      try {
        if (!req.file) return res.status(400).json({ error: "No image uploaded" });

        const detectedMime = sniffImageMime(req.file.buffer);
        if (!detectedMime || !ALLOWED_IMAGE_TYPES.has(detectedMime)) {
          return res.status(400).json({
            error: "Upload must be one JPEG, PNG, or WebP image",
          });
        }
        if (detectedMime !== req.file.mimetype) {
          return res.status(400).json({
            error: "Image content type does not match uploaded file type",
          });
        }

        if (typeof processImage === "function") {
          const result = await processImage(req);
          if (usageAnalytics) {
            usageAnalytics.recordEvent(req.user?.id, "ocr_ok", {});
          }
          return res.json(result);
        }

        return res.status(501).json({ error: "OCR processor not configured" });
      } catch (error) {
        if (usageAnalytics) {
          usageAnalytics.recordEvent(req.user?.id, "ocr_error", {
            message: error?.message || "ocr_failed",
          });
        }
        return res.status(500).json({ error: "OCR failed" });
      }
    },
  );

  router.use(handleUploadError);
  return router;
}

module.exports = {
  createOcrRouter,
};
