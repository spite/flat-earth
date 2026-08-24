import {
  ClampToEdgeWrapping,
  DataTexture,
  HalfFloatType,
  LinearFilter,
  NearestFilter,
  NearestMipmapNearestFilter,
  RedFormat,
  RepeatWrapping,
} from "three";
import { buildPyramid, fetchTile } from "./mosaic.js";
import { decodeElevation } from "./elevation-decode.js";

const TILE = 256;

// The pyramid needs the whole field, so the screen keeps the last complete
// window: a part-filled one reads as sea level, a stale pyramid as wrong maxima.
export function createElevationGrid({
  concurrency = 6,
  onUpdate,
  onProgress,
  onPaint,
  onShadowField,
  onBuild,
}) {
  let heights = null;
  let texture = null;
  let pyramid = null;
  let width = 0;
  let height = 0;

  let shown = null;

  let provider = null;
  let source = null;
  let cacheKey = "";
  let block = null;
  let maxHeight = 0;

  const present = new Set();
  const loading = new Set();
  let queue = [];
  let inFlight = 0;
  let field = 0;
  let total = 0;
  let era = new AbortController();
  let pyramidFor = null;
  let pyramidLevels = 1;

  const scratch = document.createElement("canvas");
  scratch.width = TILE;
  scratch.height = TILE;
  const scratchContext = scratch.getContext("2d", { willReadFrequently: true });

  const keyOf = (x, y) => `${x}/${y}`;
  const wrap = (x, side) => ((x % side) + side) % side;

  function slotOf(x, y) {
    if (!block) return null;
    const side = 2 ** block.zoom;
    const row = y - block.y0;
    if (row < 0 || row >= block.height) return null;

    for (let column = 0; column < block.width; column++) {
      if (wrap(block.x0 + column, side) === x) return [column, row];
    }
    return null;
  }

  function open(nextBlock) {
    const previous = { heights, width, height, block };
    width = nextBlock.width * TILE;
    height = nextBlock.height * TILE;
    heights = new Uint16Array(width * height);

    if (texture && texture !== shown?.texture) texture.dispose();
    texture = new DataTexture(heights, width, height, RedFormat, HalfFloatType);
    texture.wrapS = RepeatWrapping;
    texture.wrapT = ClampToEdgeWrapping;
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    texture.needsUpdate = true;

    return previous;
  }

  function carryOver(previous, nextBlock) {
    const side = 2 ** nextBlock.zoom;
    let dx = previous.block.x0 - nextBlock.x0;
    if (dx > side / 2) dx -= side;
    if (dx < -side / 2) dx += side;
    const dy = previous.block.y0 - nextBlock.y0;

    const sx = Math.max(0, -dx) * TILE;
    const sy = Math.max(0, -dy) * TILE;
    const tx = Math.max(0, dx) * TILE;
    const ty = Math.max(0, dy) * TILE;
    const runWidth = Math.min(previous.width - sx, width - tx);
    const runHeight = Math.min(previous.height - sy, height - ty);
    if (runWidth <= 0 || runHeight <= 0) return;

    for (let row = 0; row < runHeight; row++) {
      const from = (sy + row) * previous.width + sx;
      heights.set(
        previous.heights.subarray(from, from + runWidth),
        (ty + row) * width + tx
      );
    }
  }

  function writeTile(pixels, column, row) {
    const { heights: tile, maxHeight: peak } = decodeElevation({
      pixels,
      width: TILE,
      height: TILE,
      wantPyramid: false,
    });

    for (let y = 0; y < TILE; y++) {
      heights.set(
        tile.subarray(y * TILE, (y + 1) * TILE),
        (row * TILE + y) * width + column * TILE
      );
    }

    if (peak > maxHeight) maxHeight = peak;
    texture.needsUpdate = true;
  }

  function publish() {
    if (queue.length > 0 || inFlight > 0 || pyramidFor !== block) return;

    if (shown) {
      if (shown.texture !== texture) shown.texture.dispose();
      if (shown.pyramid && shown.pyramid !== pyramid) shown.pyramid.dispose();
    }

    shown = { texture, pyramid, block, levels: pyramidLevels, maxHeight };
    onUpdate?.({ texture, block, provider, maxHeight });
    onShadowField?.({ pyramid, levels: pyramidLevels, maxHeight });
    onPaint?.();
  }

  let buildingPyramid = false;

  function refreshPyramid() {
    if (!block || pyramidFor === block || buildingPyramid) return;

    buildingPyramid = true;
    const built = block;
    const startedAt = performance.now();
    buildPyramid(heights, width, height)
      .then((levels) => {
        if (block !== built) return;
        const buildMs = performance.now() - startedAt;

        if (pyramid && pyramid !== shown?.pyramid) pyramid.dispose();
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

        pyramidFor = built;
        pyramidLevels = levels.length;
        onBuild?.(buildMs);
        publish();
      })
      .catch(() => {})
      .finally(() => {
        buildingPyramid = false;
        if (block === built) report();
      });
  }

  function report() {
    const left = queue.length + inFlight;
    if (left > 0) {
      onProgress?.(total - left, total);
      return;
    }
    if (block && pyramidFor !== block) {
      onProgress?.(0, 1);
      refreshPyramid();
      return;
    }
    onProgress?.(0, 0);
  }

  function enqueue() {
    const side = 2 ** block.zoom;
    const centreX = block.width / 2;
    const centreY = block.height / 2;
    const wanted = [];

    for (let row = 0; row < block.height; row++) {
      const y = block.y0 + row;
      if (y < 0 || y >= side) continue;

      for (let column = 0; column < block.width; column++) {
        const x = wrap(block.x0 + column, side);
        const key = keyOf(x, y);
        if (present.has(key) || loading.has(key)) continue;
        wanted.push({
          x,
          y,
          distance: Math.hypot(column + 0.5 - centreX, row + 0.5 - centreY),
        });
      }
    }

    wanted.sort((a, b) => a.distance - b.distance);
    queue = wanted;
    total = wanted.length + inFlight;
    report();
  }

  function pump() {
    while (inFlight < concurrency && queue.length > 0) {
      const { x, y } = queue.shift();
      const key = keyOf(x, y);
      const generation = field;
      inFlight += 1;
      loading.add(key);

      fetchTile(provider, x, y, block.zoom, { cacheKey, signal: era.signal })
        .then((bitmap) => {
          if (generation !== field) return;
          const slot = slotOf(x, y);
          if (!slot) return;

          scratchContext.drawImage(bitmap, 0, 0, TILE, TILE);
          const { data } = scratchContext.getImageData(0, 0, TILE, TILE);
          writeTile(data, slot[0], slot[1]);
          present.add(key);
        })
        .catch(() => {})
        .finally(() => {
          if (generation === field) loading.delete(key);
          inFlight -= 1;
          report();
          pump();
        });
    }
  }

  function newField() {
    field += 1;
    era.abort();
    era = new AbortController();
    present.clear();
    loading.clear();
    pyramidFor = null;
  }

  function update(target) {
    if (!target) {
      if (!block) return;
      newField();
      queue = [];
      block = null;
      provider = null;
      source = null;
      maxHeight = 0;
      shown = null;
      report();
      onShadowField?.(null);
      onUpdate?.(null);
      return;
    }

    const next = target.block;
    const sameField = source === target.source && block?.zoom === next.zoom;

    if (
      sameField &&
      block.x0 === next.x0 &&
      block.y0 === next.y0 &&
      block.width === next.width &&
      block.height === next.height
    ) {
      return;
    }

    if (!sameField) {
      newField();
      maxHeight = 0;
      open(next);
    } else {
      const previous = open(next);
      pyramidFor = null;
      block = next;
      carryOver(previous, next);
      for (const key of [...present]) {
        const [x, y] = key.split("/").map(Number);
        if (!slotOf(x, y)) present.delete(key);
      }
    }

    provider = target.provider;
    source = target.source;
    cacheKey = target.cacheKey;
    block = next;

    enqueue();
    pump();
    publish();
  }

  return { update };
}
