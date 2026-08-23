import { CanvasTexture, ClampToEdgeWrapping, LinearFilter } from "three";
import { fetchTile } from "./mosaic.js";

const TILE = 256;

export function createTileGrid({
  concurrency = 6,
  anisotropy = 1,
  onUpdate,
  onProgress,
  onPaint,
}) {
  let canvas = null;
  let context = null;
  let texture = null;

  let provider = null;
  let source = null;
  let cacheKey = "";
  let block = null;

  // `present` only fills on resolve, so without `loading` a window change
  // requeues everything still in flight.
  const present = new Set();
  const loading = new Set();
  let queue = [];
  let inFlight = 0;
  let field = 0;
  let total = 0;
  let era = new AbortController();

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

  function open(width, height) {
    const previous = canvas;
    canvas = document.createElement("canvas");
    canvas.width = width * TILE;
    canvas.height = height * TILE;
    context = canvas.getContext("2d");

    texture?.dispose();
    texture = new CanvasTexture(canvas);
    texture.flipY = false;
    texture.premultiplyAlpha = false;
    texture.wrapS = ClampToEdgeWrapping;
    texture.wrapT = ClampToEdgeWrapping;
    texture.minFilter = LinearFilter;
    texture.magFilter = LinearFilter;
    // No mipmaps: regenerated per tile, and a half-filled canvas mips
    // transparency into the areas already done.
    texture.generateMipmaps = false;
    texture.anisotropy = anisotropy;

    return previous;
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

  function report() {
    const left = queue.length + inFlight;
    if (left === 0) onProgress?.(0, 0);
    else onProgress?.(total - left, total);
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
          context.drawImage(bitmap, slot[0] * TILE, slot[1] * TILE, TILE, TILE);
          present.add(key);
          texture.needsUpdate = true;
          onPaint?.();
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
  }

  function clear() {
    newField();
    queue = [];
    present.clear();
    loading.clear();
    block = null;
    provider = null;
    source = null;
    report();
    onUpdate?.(null);
  }

  function update(target) {
    if (!target) {
      if (block) clear();
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

    let moved = false;

    if (!sameField) {
      newField();
      present.clear();
      loading.clear();
      open(next.width, next.height);
    } else if (
      block.x0 !== next.x0 ||
      block.y0 !== next.y0 ||
      block.width !== next.width ||
      block.height !== next.height
    ) {
      const side = 2 ** next.zoom;
      let dx = block.x0 - next.x0;
      if (dx > side / 2) dx -= side;
      if (dx < -side / 2) dx += side;
      const dy = block.y0 - next.y0;

      // Whole tiles of overlap, so it carries across in one blit.
      const previous = open(next.width, next.height);
      context.drawImage(previous, dx * TILE, dy * TILE);
      moved = true;
    }

    provider = target.provider;
    source = target.source;
    cacheKey = target.cacheKey;
    block = next;

    if (moved) {
      for (const key of [...present]) {
        const [x, y] = key.split("/").map(Number);
        if (!slotOf(x, y)) present.delete(key);
      }
    }

    enqueue();
    onUpdate?.({ texture, block, provider });
    pump();
  }

  return { update, get block() { return block; } };
}
