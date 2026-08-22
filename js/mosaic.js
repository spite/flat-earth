
import {
  CanvasTexture,
  ClampToEdgeWrapping,
  DataTexture,
  NearestFilter,
  NearestMipmapNearestFilter,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  RedFormat,
  RepeatWrapping,
} from "three";

const TILE_SIZE = 256;

function toHalfArray(values) {
  const out = new Uint16Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = DataUtils.toHalfFloat(values[i]);
  return out;
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    }, { once: true });
  });
}

// A throttled response often has no CORS header, so no status.
function createThrottle() {
  let openAt = 0;
  let penalty = 0;

  return {
    wait(signal) {
      const waitFor = openAt - Date.now();
      return waitFor > 0 ? delay(waitFor, signal) : Promise.resolve();
    },
    trip() {
      penalty = penalty ? Math.min(penalty * 2, 8000) : 500;
      openAt = Math.max(openAt, Date.now() + penalty + Math.random() * 250);
    },
    settle() {
      penalty = penalty > 250 ? penalty / 2 : 0;
    },
  };
}

async function loadTile(url, signal, retries, throttle) {
  for (let attempt = 0; ; attempt++) {
    await throttle.wait(signal);
    try {
      const response = await fetch(url, { mode: "cors", signal });
      if (!response.ok) {
        const failure = new Error(`HTTP ${response.status}`);
        failure.permanent =
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 429;
        throw failure;
      }
      const bitmap = await createImageBitmap(await response.blob(), {
        colorSpaceConversion: "none",
      });
      throttle.settle();
      return bitmap;
    } catch (error) {
      if (error.name === "AbortError" || error.permanent) throw error;
      if (attempt >= retries) throw error;
      throttle.trip();
    }
  }
}

async function pool(items, limit, task) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await task(items[next++]);
  });
  await Promise.all(workers);
}

// Keyed per source: layers collide on bare z/x/y.
const TILE_CACHE_LIMIT = 128;
const tileCache = new Map();

function cacheGet(key) {
  const bitmap = tileCache.get(key);
  if (!bitmap) return null;
  tileCache.delete(key);
  tileCache.set(key, bitmap);
  return bitmap;
}

function cachePut(key, bitmap) {
  tileCache.set(key, bitmap);
  while (tileCache.size > TILE_CACHE_LIMIT) {
    const [oldest, evicted] = tileCache.entries().next().value;
    tileCache.delete(oldest);
    evicted.close();
  }
}

async function compositeTiles(provider, zoom, options) {
  const {
    signal,
    onProgress,
    concurrency = 6,
    retries = 3,
    background,
    cache = false,
    cacheKey = "",
  } = options;

  const side = 2 ** zoom;
  const block = options.window ?? { x0: 0, y0: 0, width: side, height: side };
  const originX = ((block.x0 % side) + side) % side;

  const canvas = document.createElement("canvas");
  canvas.width = block.width * TILE_SIZE;
  canvas.height = block.height * TILE_SIZE;
  const context = canvas.getContext("2d", { willReadFrequently: true });

  if (background) {
    context.fillStyle = background;
    context.fillRect(0, 0, canvas.width, canvas.height);
  }

  const tiles = [];
  for (let row = 0; row < block.height; row++) {
    const y = block.y0 + row;
    if (y < 0 || y >= side) continue;
    for (let column = 0; column < block.width; column++) {
      tiles.push([(((block.x0 + column) % side) + side) % side, y, column, row]);
    }
  }

  let done = 0;
  let failed = 0;
  const throttle = createThrottle();

  await pool(tiles, concurrency, async ([x, y, column, row]) => {
    try {
      const key = `${cacheKey}|${zoom}/${x}/${y}`;
      let bitmap = cache ? cacheGet(key) : null;
      const cached = bitmap !== null;

      if (!bitmap) {
        bitmap = await loadTile(provider(x, y, zoom), signal, retries, throttle);
      }

      context.drawImage(bitmap, column * TILE_SIZE, row * TILE_SIZE, TILE_SIZE, TILE_SIZE);

      if (cache) {
        if (!cached) cachePut(key, bitmap);
      } else {
        bitmap.close();
      }
    } catch (error) {
      if (error.name === "AbortError") throw error;
      failed++;
    }
    onProgress?.(++done, tiles.length);
  });

  return {
    canvas,
    context,
    width: canvas.width,
    height: canvas.height,
    tiles: tiles.length,
    failed,
    originX,
  };
}

export async function buildColorMosaic(provider, zoom, options = {}) {
  const { canvas, tiles, failed } = await compositeTiles(provider, zoom, options);

  const texture = new CanvasTexture(canvas);
  texture.flipY = false;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = true;

  return { texture, tiles, failed };
}

// Maxima, not averages, so a ray can never pass a peak.
function buildMaxPyramid(heights, width, height) {
  const levels = [{ data: heights, width, height }];

  let source = heights;
  let w = width;
  let h = height;

  while (w > 1 || h > 1) {
    const nw = Math.max(1, w >> 1);
    const nh = Math.max(1, h >> 1);
    const next = new Float32Array(nw * nh);

    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        const x0 = Math.min(2 * x, w - 1);
        const x1 = Math.min(2 * x + 1, w - 1);
        const y0 = Math.min(2 * y, h - 1);
        const y1 = Math.min(2 * y + 1, h - 1);
        next[y * nw + x] = Math.max(
          source[y0 * w + x0],
          source[y0 * w + x1],
          source[y1 * w + x0],
          source[y1 * w + x1]
        );
      }
    }

    levels.push({ data: next, width: nw, height: nh });
    source = next;
    w = nw;
    h = nh;
  }

  return levels;
}

export async function buildElevationMosaic(provider, zoom, options = {}) {
  // Primed at sea level: an untouched pixel decodes to -32768m.
  const { context, width, height, tiles, failed } = await compositeTiles(
    provider,
    zoom,
    { retries: 5, background: "rgb(128, 0, 0)", ...options }
  );
  const { data } = context.getImageData(0, 0, width, height);

  // Half float: bilinear on raw terrarium spikes where g wraps.
  const heights = new Uint16Array(width * height);
  const metresPerTexel = new Float32Array(width * height);

  let maxHeight = -Infinity;

  for (let i = 0; i < heights.length; i++) {
    const p = i * 4;
    const metres = data[p] * 256 + data[p + 1] + data[p + 2] / 256 - 32768;
    if (metres > maxHeight) maxHeight = metres;
    metresPerTexel[i] = metres;
    heights[i] = DataUtils.toHalfFloat(metres);
  }

  const texture = new DataTexture(heights, width, height, RedFormat, HalfFloatType);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;

  const pyramidLevels = buildMaxPyramid(metresPerTexel, width, height).map(
    (level) => ({
      data: toHalfArray(level.data),
      width: level.width,
      height: level.height,
    })
  );

  const pyramid = new DataTexture(
    pyramidLevels[0].data,
    width,
    height,
    RedFormat,
    HalfFloatType
  );
  pyramid.mipmaps = pyramidLevels;
  pyramid.generateMipmaps = false;
  pyramid.wrapS = ClampToEdgeWrapping;
  pyramid.wrapT = ClampToEdgeWrapping;
  pyramid.minFilter = NearestMipmapNearestFilter;
  pyramid.magFilter = NearestFilter;
  pyramid.needsUpdate = true;

  return {
    texture,
    pyramid,
    pyramidLevels: pyramidLevels.length,
    width,
    height,
    tiles,
    failed,
    maxHeight,
  };
}

export async function buildWindowMosaic(provider, block, options = {}) {
  const { canvas, tiles, failed } = await compositeTiles(provider, block.zoom, {
    ...options,
    cache: true,
    window: block,
  });

  const texture = new CanvasTexture(canvas);
  texture.flipY = false;
  texture.premultiplyAlpha = false;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = true;

  return { texture, tiles, failed };
}
