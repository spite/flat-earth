import { lonLatToMosaicUV, planeToLonLat, uncenter } from "./projection.js";

const TILE_SIZE = 256;

const PADDING = 0;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
}

function unwrap(delta) {
  if (delta > 0.5) return delta - 1;
  if (delta < -0.5) return delta + 1;
  return delta;
}

export function probeSamples(options) {
  const {
    unproject,
    projection,
    center,
    pixelWidth,
    pixelHeight,
    grid = 24,
  } = options;

  const samples = new Array(grid * grid).fill(null);

  for (let row = 0; row < grid; row++) {
    for (let column = 0; column < grid; column++) {
      const ndcX = (column / (grid - 1)) * 2 - 1;
      const ndcY = (row / (grid - 1)) * 2 - 1;
      const [planeX, planeY] = unproject(ndcX, ndcY);

      const [rotatedLon, rotatedLat] = planeToLonLat(planeX, planeY, projection);
      if (!Number.isFinite(rotatedLat) || Math.abs(rotatedLat) > 90) continue;

      const [lon, lat] = uncenter(rotatedLon, rotatedLat, center);
      samples[row * grid + column] = lonLatToMosaicUV(lon, lat);
    }
  }

  // Median: scale varies by orders of magnitude across the frame.
  const scales = [];
  const stepX = pixelWidth / (grid - 1);
  const stepY = pixelHeight / (grid - 1);

  for (let row = 0; row < grid; row++) {
    for (let column = 0; column < grid; column++) {
      const here = samples[row * grid + column];
      if (!here) continue;

      const right = column + 1 < grid ? samples[row * grid + column + 1] : null;
      if (right) {
        const du = unwrap(right[0] - here[0]);
        const dv = right[1] - here[1];
        scales.push(Math.hypot(du, dv) / stepX);
      }

      const below = row + 1 < grid ? samples[(row + 1) * grid + column] : null;
      if (below) {
        const du = unwrap(below[0] - here[0]);
        const dv = below[1] - here[1];
        scales.push(Math.hypot(du, dv) / stepY);
      }
    }
  }

  const usable = scales.filter((s) => Number.isFinite(s) && s > 0);
  if (usable.length === 0) return null;

  return { samples, scale: median(usable), pixelWidth, pixelHeight };
}

export function windowFor(probe, options) {
  const { minZoom, maxZoom, budget, pad = PADDING } = options;
  const { samples, scale } = probe;

  const ideal = Math.round(Math.log2(1 / (TILE_SIZE * scale)));

  if (ideal <= minZoom) return null;

  // Step down rather than give up, so zoom rises monotonically.
  for (let level = Math.min(ideal, maxZoom); level > minZoom; level--) {
    const block = blockAt(samples, level, budget, pad);
    if (block) return { zoom: level, scale, ...block };
  }

  return null;
}

function blockAt(samples, level, budget, pad = PADDING) {
  const side = 2 ** level;
  const xs = [];
  const ys = [];
  for (const sample of samples) {
    if (!sample) continue;
    xs.push(sample[0] * side);
    ys.push(sample[1] * side);
  }
  if (xs.length === 0) return null;

  let minX = Math.min(...xs);
  let maxX = Math.max(...xs);

  const lifted = xs.map((x) => (x < side / 2 ? x + side : x));
  const liftedMin = Math.min(...lifted);
  const liftedMax = Math.max(...lifted);
  if (liftedMax - liftedMin < maxX - minX) {
    minX = liftedMin;
    maxX = liftedMax;
  }

  if (maxX - minX >= side * 0.999) {
    minX = 0;
    maxX = side;
  }

  const x0 = Math.floor(minX) - pad;
  const y0 = Math.max(0, Math.floor(Math.min(...ys)) - pad);
  const y1 = Math.min(side, Math.ceil(Math.max(...ys)) + pad);

  const width = Math.max(1, Math.min(Math.ceil(maxX) + pad - x0, side));
  const height = Math.max(1, y1 - y0);
  if (width <= 0 || height <= 0) return null;
  if (width > budget || height > budget) return null;

  return { x0, y0, width, height };
}

export function covers(loaded, target) {
  if (!loaded || !target || loaded.zoom !== target.zoom) return false;
  const side = 2 ** loaded.zoom;
  const offset = (((target.x0 - loaded.x0) % side) + side) % side;
  if (offset + target.width > loaded.width) return false;
  return (
    target.y0 >= loaded.y0 &&
    target.y0 + target.height <= loaded.y0 + loaded.height
  );
}
