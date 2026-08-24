import {
  CanvasTexture,
  ClampToEdgeWrapping,
  DataTexture,
  NearestFilter,
  NearestMipmapNearestFilter,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  RedFormat,
  RepeatWrapping,
} from "three";
import { buildPyramidFrom, decodeElevation } from "./elevation-decode.js";

const TILE_SIZE = 256;

let decoder = null;
let decoderRetired = false;
let nextJob = 0;
const pending = new Map();

try {
// Eager: the worker parses three, which would delay the first decode.
  decoder = new Worker(new URL("./elevation-worker.js", import.meta.url), {
    type: "module",
  });
  decoder.onmessage = ({ data: { id, error, ...result } }) => {
    const job = pending.get(id);
    if (!job) return;
    pending.delete(id);
    if (error) job.reject(new Error(error));
    else job.resolve(result);
  };
  decoder.onerror = () => {
    decoderRetired = true;
    for (const job of pending.values()) {
      job.reject(new Error("elevation worker failed"));
    }
    pending.clear();
  };
} catch {
  decoder = null;
}

function runJob(kind, job, transfer) {
  const id = ++nextJob;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    decoder.postMessage({ id, kind, ...job }, transfer);
  });
}

function decode(job) {
  if (!decoder || decoderRetired) return Promise.resolve(decodeElevation(job));
  return runJob("decode", job, [job.pixels.buffer]).then((r) => r.decoded);
}

export function buildPyramid(heights, width, height) {
  if (!decoder || decoderRetired) {
    return Promise.resolve(buildPyramidFrom(heights, width, height));
  }

  const copy = heights.slice();
  return runJob("pyramid", { heights: copy, width, height }, [copy.buffer]).then(
    (r) => r.levels
  );
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

// One for the module: per-build back-off left other layers hammering away.
const throttle = createThrottle();

async function loadTile(url, signal, retries) {
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
// Really a memory budget: a decoded tile is a quarter of a megabyte, and one
// screenful across three layers is ~280 of them.
const TILE_BYTES = TILE_SIZE * TILE_SIZE * 4;
const TILE_CACHE_BUDGET = 192 * 1024 * 1024;
const TILE_CACHE_CEILING = Math.floor(TILE_CACHE_BUDGET / TILE_BYTES);
const TILE_CACHE_FLOOR = 128;
let tileCacheLimit = TILE_CACHE_FLOOR;

export function setTileCacheLimit(wanted) {
  tileCacheLimit = Math.max(
    TILE_CACHE_FLOOR,
    Math.min(TILE_CACHE_CEILING, Math.ceil(wanted))
  );
  evict();
}
const tileCache = new Map();

function cacheGet(key) {
  const bitmap = tileCache.get(key);
  if (!bitmap) return null;
  tileCache.delete(key);
  tileCache.set(key, bitmap);
  return bitmap;
}

function evict() {
  while (tileCache.size > tileCacheLimit) {
    const [oldest, evicted] = tileCache.entries().next().value;
    tileCache.delete(oldest);
    evicted.close();
  }
}

function cachePut(key, bitmap) {
  tileCache.set(key, bitmap);
  evict();
}

export async function fetchTile(provider, x, y, zoom, options = {}) {
  const { signal, retries = 3, cacheKey = "" } = options;
  const key = `${cacheKey}|${zoom}/${x}/${y}`;

  const cached = cacheGet(key);
  if (cached) return cached;

  const bitmap = await loadTile(provider(x, y, zoom), signal, retries);
  cachePut(key, bitmap);
  return bitmap;
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
    readback = false,
  } = options;

  const side = 2 ** zoom;
  const block = options.window ?? { x0: 0, y0: 0, width: side, height: side };

  const canvas = document.createElement("canvas");
  canvas.width = block.width * TILE_SIZE;
  canvas.height = block.height * TILE_SIZE;
  // Only the heightfield is read back; elsewhere this just forces a slower,
  // CPU-backed canvas.
  const context = canvas.getContext("2d", { willReadFrequently: readback });

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

  await pool(tiles, concurrency, async ([x, y, column, row]) => {
    try {
      const key = `${cacheKey}|${zoom}/${x}/${y}`;
      let bitmap = cache ? cacheGet(key) : null;
      const cached = bitmap !== null;

      if (!bitmap) {
        bitmap = await loadTile(provider(x, y, zoom), signal, retries);
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

export async function buildElevationMosaic(provider, zoom, options = {}) {
  const { pyramid: wantPyramid = true } = options;
  // Primed at sea level: an untouched pixel decodes to -32768m.
  const { context, width, height, tiles, failed } = await compositeTiles(
    provider,
    zoom,
    { retries: 5, background: "rgb(128, 0, 0)", readback: true, ...options }
  );
  const { data: pixels } = context.getImageData(0, 0, width, height);
  const startedAt = performance.now();
  const { heights, maxHeight, levels } = await decode({
    pixels,
    width,
    height,
    wantPyramid,
  });
  const decodeMs = performance.now() - startedAt;

  const texture = new DataTexture(heights, width, height, RedFormat, HalfFloatType);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;

  let pyramid = null;
  if (levels) {
    pyramid = new DataTexture(
      levels[0].data,
      width,
      height,
      RedFormat,
      HalfFloatType
    );
    pyramid.mipmaps = levels;
    pyramid.generateMipmaps = false;
    pyramid.wrapS = ClampToEdgeWrapping;
    pyramid.wrapT = ClampToEdgeWrapping;
    pyramid.minFilter = NearestMipmapNearestFilter;
    pyramid.magFilter = NearestFilter;
    pyramid.needsUpdate = true;
  }

  return {
    texture,
    pyramid,
    pyramidLevels: levels ? levels.length : 0,
    width,
    height,
    tiles,
    failed,
    maxHeight,
    decodeMs,
  };
}
