// Relative, not the bare specifier: import maps do not reach worker scope.
import { DataUtils } from "../third_party/three.module.js";

function toHalfArray(values) {
  const out = new Uint16Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = DataUtils.toHalfFloat(values[i]);
  return out;
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

export function decodeElevation({ pixels, width, height, wantPyramid }) {
  const count = width * height;

  // Half float: bilinear on raw terrarium spikes where g wraps.
  const heights = new Uint16Array(count);
  const metresPerTexel = wantPyramid ? new Float32Array(count) : null;

  let maxHeight = -Infinity;

  for (let i = 0; i < count; i++) {
    const p = i * 4;
    const metres = pixels[p] * 256 + pixels[p + 1] + pixels[p + 2] / 256 - 32768;
    if (metres > maxHeight) maxHeight = metres;
    if (metresPerTexel) metresPerTexel[i] = metres;
    heights[i] = DataUtils.toHalfFloat(metres);
  }

  const levels = metresPerTexel
    ? buildMaxPyramid(metresPerTexel, width, height).map((level) => ({
        data: toHalfArray(level.data),
        width: level.width,
        height: level.height,
      }))
    : null;

  return { heights, maxHeight, levels };
}

export function buildPyramidFrom(halfHeights, width, height) {
  const metres = new Float32Array(halfHeights.length);
  for (let i = 0; i < halfHeights.length; i++) {
    metres[i] = DataUtils.fromHalfFloat(halfHeights[i]);
  }

  return buildMaxPyramid(metres, width, height).map((level) => ({
    data: toHalfArray(level.data),
    width: level.width,
    height: level.height,
  }));
}

export function decodedBuffers({ heights, levels }) {
  const buffers = [heights.buffer];
  if (levels) for (const level of levels) buffers.push(level.data.buffer);
  return buffers;
}
