function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function resolveNormalizationSize({
  storedWidth,
  storedHeight,
  orientedWidth,
  orientedHeight,
}) {
  const width =
    Number.isFinite(orientedWidth) && orientedWidth > 0
      ? orientedWidth
      : storedWidth;
  const height =
    Number.isFinite(orientedHeight) && orientedHeight > 0
      ? orientedHeight
      : storedHeight;
  return {
    width: Math.max(1, Number(width) || 1),
    height: Math.max(1, Number(height) || 1),
  };
}

function mapContainPixelToImageNormalized({
  pixelX,
  pixelY,
  inferenceWidth,
  inferenceHeight,
  imageWidth,
  imageHeight,
}) {
  if (
    !Number.isFinite(pixelX) ||
    !Number.isFinite(pixelY) ||
    !Number.isFinite(inferenceWidth) ||
    !Number.isFinite(inferenceHeight) ||
    !Number.isFinite(imageWidth) ||
    !Number.isFinite(imageHeight) ||
    inferenceWidth <= 0 ||
    inferenceHeight <= 0 ||
    imageWidth <= 0 ||
    imageHeight <= 0
  ) {
    return { x: 0, y: 0 };
  }

  const scale = Math.min(inferenceWidth / imageWidth, inferenceHeight / imageHeight);
  if (!Number.isFinite(scale) || scale <= 0) {
    return {
      x: clamp01(pixelX / imageWidth),
      y: clamp01(pixelY / imageHeight),
    };
  }

  const fittedWidth = imageWidth * scale;
  const fittedHeight = imageHeight * scale;
  const padX = (inferenceWidth - fittedWidth) / 2;
  const padY = (inferenceHeight - fittedHeight) / 2;

  const imageX = (pixelX - padX) / scale;
  const imageY = (pixelY - padY) / scale;

  return {
    x: clamp01(imageX / imageWidth),
    y: clamp01(imageY / imageHeight),
  };
}

function normalizePointFromInferenceSpace(point, dims) {
  if (!point) return { x: 0, y: 0 };
  const x = Number(point.x);
  const y = Number(point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { x: 0, y: 0 };

  if (x <= 1 && y <= 1) {
    return { x: clamp01(x), y: clamp01(y) };
  }

  return mapContainPixelToImageNormalized({
    pixelX: x,
    pixelY: y,
    ...dims,
  });
}

function mapPolygonFromInferencePoints(points, dims) {
  return (points || [])
    .map((point) => normalizePointFromInferenceSpace(point, dims))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
}

function mapPolygonFromRleMaskSpace(maskPolygon, { maskWidth, maskHeight, imageWidth, imageHeight }) {
  const dims = {
    inferenceWidth: Number(maskWidth) || Number(imageWidth) || 1,
    inferenceHeight: Number(maskHeight) || Number(imageHeight) || 1,
    imageWidth: Number(imageWidth) || 1,
    imageHeight: Number(imageHeight) || 1,
  };

  return (maskPolygon || [])
    .map((point) => {
      const pixelX = (Number(point.x) || 0) * dims.inferenceWidth;
      const pixelY = (Number(point.y) || 0) * dims.inferenceHeight;
      return mapContainPixelToImageNormalized({
        pixelX,
        pixelY,
        ...dims,
      });
    })
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
}

function normalizeBoxFromInference({ x, y, width, height }, dims) {
  const cx = Number(x);
  const cy = Number(y);
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(w) || !Number.isFinite(h)) {
    return null;
  }

  if (cx <= 1 && cy <= 1 && w <= 1 && h <= 1) {
    const minX = clamp01(cx - w / 2);
    const maxX = clamp01(cx + w / 2);
    const minY = clamp01(cy - h / 2);
    const maxY = clamp01(cy + h / 2);
    return { minX, maxX, minY, maxY };
  }

  const minPoint = mapContainPixelToImageNormalized({
    pixelX: cx - w / 2,
    pixelY: cy - h / 2,
    ...dims,
  });
  const maxPoint = mapContainPixelToImageNormalized({
    pixelX: cx + w / 2,
    pixelY: cy + h / 2,
    ...dims,
  });

  return {
    minX: Math.min(minPoint.x, maxPoint.x),
    maxX: Math.max(minPoint.x, maxPoint.x),
    minY: Math.min(minPoint.y, maxPoint.y),
    maxY: Math.max(minPoint.y, maxPoint.y),
  };
}

module.exports = {
  resolveNormalizationSize,
  mapContainPixelToImageNormalized,
  mapPolygonFromInferencePoints,
  mapPolygonFromRleMaskSpace,
  normalizeBoxFromInference,
};
