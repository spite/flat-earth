import {
  buildPyramidFrom,
  decodeElevation,
  decodedBuffers,
} from "./elevation-decode.js";

const JOBS = {
  decode(job) {
    const decoded = decodeElevation(job);
    return [{ decoded }, decodedBuffers(decoded)];
  },
  pyramid({ heights, width, height }) {
    const levels = buildPyramidFrom(heights, width, height);
    return [{ levels }, levels.map((level) => level.data.buffer)];
  },
};

self.onmessage = (event) => {
  const { id, kind = "decode", ...job } = event.data;
  try {
    const [result, transfer] = JOBS[kind](job);
    self.postMessage({ id, ...result }, transfer);
  } catch (error) {
    self.postMessage({ id, error: error.message });
  }
};
