import {
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  GLSL3,
  LineSegments,
  MOUSE,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  RawShaderMaterial,
  RepeatWrapping,
  Scene,
  TOUCH,
  TextureLoader,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "orbitcontrols";
import {
  batch,
  createStats,
  effect,
  signal,
} from "../third_party/guspira/guspira.min.js";
import {
  buildColorMosaic,
  buildElevationMosaic,
  setTileCacheLimit,
} from "./mosaic.js";
import { createElevationGrid } from "./elevation-grid.js";
import {
  colorProviders,
  elevationProviders,
  waterProviders,
} from "./tile-providers.js";
import { probeSamples, windowFor } from "./visibility.js";
import {
  fragmentShader,
  rasterFragmentShader,
  rasterVertexShader,
  vertexShader,
} from "./shaders.js";
import { createTileLayer } from "./layer.js";
import { createTileGrid } from "./tile-grid.js";
import { buildGui } from "./gui.js";
import { createViewState } from "./view-state.js";
import {
  NONE,
  autoDetail,
  castShadows,
  centreLat,
  centreLon,
  elevationSource,
  exaggeration,
  hillshade,
  imagerySource,
  paper,
  paperBump,
  paperScale,
  projectionName,
  selected,
  shadowSoftness,
  shadowSteps,
  shadowStrength,
  showGraticule,
  showMosaic,
  showOutlines,
  showTiles,
  sunAltitude,
  sunAzimuth,
  terrain,
  tileTint,
  uiVisible,
  waterFill,
  waterLevel,
  waterSource,
  waterTint,
  worldError,
} from "./signals.js";
import {
  MERCATOR_MAX_LAT,
  PROJECTION,
  planeHalfHeight,
  planeToLonLat,
  uncenter,
} from "./projection.js";

const BACKSTOP_ZOOM = 2;
const TERRAIN_MAX_ZOOM = 13;

const ELEVATION_BACKSTOP_ZOOM = 3;

const center = { value: new Vector2(0, 0) };
const projection = { value: PROJECTION.mercator };

// Shared by every material: the running average's weight for this sample.
const blendWeight = { value: 1 };

function makeMaterial(color, opacity = 1) {
  return new RawShaderMaterial({
    uniforms: {
      center,
      projection,
      color: { value: new Color(color) },
      opacity: { value: opacity },
      blendWeight,
    },
    vertexShader,
    fragmentShader,
    glslVersion: GLSL3,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
}

function buildSegments(coords, ringOffsets, ringIndices) {
  let segmentCount = 0;
  for (const r of ringIndices) {
    segmentCount += ringOffsets[r + 1] - ringOffsets[r] - 1;
  }

  const position = new Float32Array(segmentCount * 2 * 3);
  const neighbor = new Float32Array(segmentCount * 2 * 2);
  let p = 0;
  let n = 0;

  for (const r of ringIndices) {
    for (let i = ringOffsets[r]; i < ringOffsets[r + 1] - 1; i++) {
      const ax = coords[i * 2];
      const ay = coords[i * 2 + 1];
      const bx = coords[i * 2 + 2];
      const by = coords[i * 2 + 3];

      position[p++] = ax;
      position[p++] = ay;
      position[p++] = 0;
      position[p++] = bx;
      position[p++] = by;
      position[p++] = 0;

      neighbor[n++] = bx;
      neighbor[n++] = by;
      neighbor[n++] = ax;
      neighbor[n++] = ay;
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(position, 3));
  geometry.setAttribute("neighbor", new Float32BufferAttribute(neighbor, 2));
  return geometry;
}

function makeGraticule(step = 15, sample = 1) {
  const coords = [];
  const ringOffsets = [0];
  const maxLat = MERCATOR_MAX_LAT;

  for (let lon = -180; lon < 180; lon += step) {
    for (let lat = -maxLat; lat < maxLat; lat += sample) coords.push(lon, lat);
    coords.push(lon, maxLat);
    ringOffsets.push(coords.length / 2);
  }

  for (let lat = -75; lat <= 75; lat += step) {
    for (let lon = -180; lon <= 180; lon += sample) coords.push(lon, lat);
    ringOffsets.push(coords.length / 2);
  }

  const rings = ringOffsets.slice(0, -1).map((_, i) => i);
  return buildSegments(coords, ringOffsets, rings);
}

const scene = new Scene();
const camera = new OrthographicCamera(-180, 180, 90, -90, 0.1, 100);
camera.position.set(0, 0, 10);

const renderer = new WebGLRenderer({
  antialias: true,
  preserveDrawingBuffer: true,
});
renderer.setClearColor(0x11151c);
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
const view = createViewState({ camera, controls, setCenter });
controls.enableRotate = false;
controls.screenSpacePanning = true;
controls.mouseButtons = { LEFT: MOUSE.PAN, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN };
controls.touches = { ONE: TOUCH.PAN, TWO: TOUCH.DOLLY_PAN };

const rasterUniforms = {
  center,
  projection,
  planeMin: { value: new Vector2(-180, -180) },
  planeMax: { value: new Vector2(180, 180) },
  map: { value: null },
  detailMap: { value: null },
  detailWindow: { value: new Vector4(0, 0, 1, 1) },
  detailZoom: { value: 0 },
  hasDetail: { value: 0 },
  hasImagery: { value: 0 },
  baseZoom: { value: 0 },
  tileDebug: { value: 0 },
  rawMosaic: { value: 0 },
  resolution: { value: new Vector2(1, 1) },
  elevation: { value: null },
  hasElevation: { value: 0 },
  elevBackstop: { value: null },
  hasElevBackstop: { value: 0 },
  elevBackstopZoom: { value: ELEVATION_BACKSTOP_ZOOM },
  elevWindow: { value: new Vector4(0, 0, 1, 1) },
  elevationZoom: { value: 0 },
  hillshade: { value: hillshade() },
  shadows: { value: 0 },
  shadowStrength: { value: shadowStrength() },
  shadowSteps: { value: shadowSteps() },
  shadowSoftness: { value: shadowSoftness() },
  frameSeed: { value: 0 },
  blendWeight,
  maxPyramid: { value: null },
  pyramidLevels: { value: 1 },
  terrainMax: { value: 3000 },
  paper: { value: 0 },
  paperTexture: { value: null },
  paperBump: { value: paperBump() },
  paperScale: { value: paperScale() },
  waterFill: { value: 0 },
  waterColor: { value: new Color(0xffffff) },
  waterMap: { value: null },
  waterWindow: { value: new Vector4(0, 0, 1, 1) },
  waterZoom: { value: 0 },
  hasWaterMap: { value: 0 },
  waterLevel: { value: waterLevel() },
  exaggeration: { value: exaggeration() },
  sun: { value: new Vector2(sunAzimuth(), sunAltitude()) },
};

const raster = new Mesh(
  new PlaneGeometry(2, 2),
  new RawShaderMaterial({
    uniforms: rasterUniforms,
    vertexShader: rasterVertexShader,
    fragmentShader: rasterFragmentShader,
    glslVersion: GLSL3,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  })
);
raster.frustumCulled = false;
raster.renderOrder = 0;
raster.visible = false;
scene.add(raster);

const graticule = new LineSegments(makeGraticule(), makeMaterial(0x3d5a80, 0.55));
graticule.frustumCulled = false;
graticule.renderOrder = 1;
scene.add(graticule);

const status = document.querySelector("#status");

const progress = document.querySelector("#progress");
const progressFill = document.querySelector("#progress-fill");
const progressText = document.querySelector("#progress-text");
const jobs = new Map();

function renderProgress() {
  let done = 0;
  let total = 0;
  for (const job of jobs.values()) {
    done += job.done;
    total += job.total;
  }

  const pending = total - done;
  if (pending <= 0) {
    progress.classList.remove("busy");
    progressText.textContent = "";
    return;
  }

  progress.classList.add("busy");
  progressFill.style.width = `${(100 * done) / total}%`;
  const names = [...jobs.keys()].join(", ");
  progressText.textContent = `${pending} tile${pending === 1 ? "" : "s"} pending — ${names}`;
}

const JOB_BAND = {
  backstop: "imagery",
  imagery: "imagery",
  "world relief": "terrain",
  terrain: "terrain",
  water: "water",
};

function pendingByBand() {
  const bands = { imagery: 0, terrain: 0, water: 0 };
  for (const [name, job] of jobs) {
    const band = JOB_BAND[name];
    if (band) bands[band] += job.total - job.done;
  }
  return bands;
}

const shadowsReady = signal(false);

const paperReady = signal(false);
new TextureLoader().load("assets/Watercolor_ColdPress.webp", (texture) => {
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  rasterUniforms.paperTexture.value = texture;
  paperReady.set(true);
});

// Soft shadows are sampled, so one frame is noisy: a change is re-rendered
// this many times, each with a fresh seed, averaged, and then it stops.
const ACCUMULATE = 32;

let dirty = true;
let sample = 0;
const invalidate = () => {
  dirty = true;
  sample = 0;
};

const stats = createStats();
const fps = stats.fps();
const submitTime = stats.counter("submit");
const otherTime = stats.counter("other");
const cpuSubmit = stats.counter("cpu", { average: 500 });
const drawCalls = stats.counter("draws");
const textureCount = stats.counter("textures");
const pyramidTime = stats.counter("pyramid");
const imageryPending = stats.counter("imagery");
const terrainPending = stats.counter("terrain");
const waterPending = stats.counter("water");
let lastFrameAt = performance.now();

function setJob(name, done, total) {
  jobs.set(name, { done, total });
  renderProgress();
}

function clearJob(name) {
  jobs.delete(name);
  if (jobs.size === 0) progressFill.style.width = "100%";
  renderProgress();
}
status.textContent = "loading world…";

setJob("outlines", 0, 1);
const world = await (async () => {
  try {
    const response = await fetch("data/world.json");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    worldError.set(` — no country outlines (${error.message})`);
    return { coords: [], ringOffsets: [0], countries: [] };
  }
})();
clearJob("outlines");
const { coords, ringOffsets, countries } = world;

const allRings = ringOffsets.slice(0, -1).map((_, i) => i);
const outlines = new LineSegments(
  buildSegments(coords, ringOffsets, allRings),
  makeMaterial(0xe8e6e3)
);
outlines.frustumCulled = false;
outlines.renderOrder = 2;
scene.add(outlines);

const highlight = new LineSegments(new BufferGeometry(), makeMaterial(0xffb703));
highlight.frustumCulled = false;
highlight.renderOrder = 3;
highlight.visible = false;
scene.add(highlight);

const byName = new Map(countries.map((c) => [c.name, c]));

let highlighted = null;

function selectCountry(name) {
  if (highlighted === name) return;
  highlighted = name;
  highlight.geometry.dispose();

  const country = byName.get(name);
  if (!country) {
    highlight.geometry = new BufferGeometry();
    return;
  }

  const rings = [];
  for (let i = 0; i < country.ringCount; i++) rings.push(country.firstRing + i);
  highlight.geometry = buildSegments(coords, ringOffsets, rings);
}

function setCenter(lon, lat) {
  batch(() => {
    centreLon.set(lon);
    centreLat.set(lat);
  });
}

const imageryStatus = document.querySelector("#imagery-status");
const terrainStatus = document.querySelector("#terrain-status");
const detailStatus = document.querySelector("#detail-status");
const waterStatus = document.querySelector("#water-status");
const reliefStatus = document.querySelector("#relief-status");
const jobHandlers = { beginJob: setJob, endJob: clearJob };

const disposeTexture = (mosaic) => mosaic.texture.dispose();

function detailBudget(pixelWidth, pixelHeight) {
  return Math.min(16, Math.ceil(Math.max(pixelWidth, pixelHeight) / 256) + 3);
}

// Shared by the three layers on a settle; rebuilt when the view moves.
let probe = { key: null, value: null };

function viewProbe() {
  const pixelRatio = renderer.getPixelRatio();
  const pixelWidth = window.innerWidth * pixelRatio;
  const pixelHeight = window.innerHeight * pixelRatio;

  const key = [
    camera.position.x,
    camera.position.y,
    camera.zoom,
    camera.left,
    camera.top,
    projection.value,
    center.value.x,
    center.value.y,
    pixelWidth,
    pixelHeight,
  ].join();

  if (probe.key !== key) {
    probe = {
      key,
      value: probeSamples({
        unproject: ndcToPlane,
        projection: projection.value,
        center: { lon: center.value.x, lat: center.value.y },
        pixelWidth,
        pixelHeight,
      }),
    };
  }

  return probe.value;
}

function neededWindow(maxZoom, pad = 0, minZoom = 1) {
  const sampled = viewProbe();
  if (!sampled) return null;

  return windowFor(sampled, {
    minZoom,
    maxZoom,
    pad,
    budget: detailBudget(sampled.pixelWidth, sampled.pixelHeight) + 2 * pad,
  });
}

const backstop = createTileLayer({
  name: "backstop",
  status: imageryStatus,
  ...jobHandlers,
  reuse: (loaded, target) => loaded.key === target.key,
  async build(target, options) {
    const built = await buildColorMosaic(target.provider, target.level, options);
    built.texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    return built;
  },
  dispose: disposeTexture,
  show(mosaic) {
    invalidate();
    rasterUniforms.map.value = mosaic.texture;
    rasterUniforms.hasImagery.value = 1;
    rasterUniforms.baseZoom.value = mosaic.level;
    raster.visible = true;
    imageryStatus.textContent =
      `${mosaic.provider.attribution} — base z${mosaic.level}, ` +
      `${4 ** mosaic.level} tiles` +
      `${mosaic.failed ? `, ${mosaic.failed} missing` : ""}`;
  },
  hide() {
    invalidate();
    rasterUniforms.hasImagery.value = 0;
    raster.visible = true;
    imageryStatus.textContent = "no imagery — shaded relief only";
  },
});

const detail = createTileGrid({
  concurrency: 6,
  anisotropy: renderer.capabilities.getMaxAnisotropy(),
  onPaint: invalidate,
  onProgress(done, total) {
    if (total) setJob("imagery", done, total);
    else clearJob("imagery");
  },
  onUpdate(state) {
    invalidate();
    if (!state) {
      rasterUniforms.hasDetail.value = 0;
      detailStatus.textContent = "";
      return;
    }

    const { x0, y0, width, height, zoom } = state.block;
    rasterUniforms.detailMap.value = state.texture;
    rasterUniforms.detailWindow.value.set(x0, y0, width, height);
    rasterUniforms.detailZoom.value = zoom;
    rasterUniforms.hasDetail.value = 1;
    detailStatus.textContent =
      `detail z${zoom} · ${width}×${height} tiles · ` +
      `${window.innerWidth}×${window.innerHeight} @${window.devicePixelRatio}x` +
      `${state.failed ? `, ${state.failed} failed` : ""}`;
  },
});

const reliefBackstop = createTileLayer({
  name: "world relief",
  status: reliefStatus,
  ...jobHandlers,
  reuse: (loaded, target) => loaded.key === target.key,
  build: (target, options) =>
    buildElevationMosaic(target.provider, target.level, {
      ...options,
      concurrency: 6,
      pyramid: false,
    }),
  dispose: disposeTexture,
  show(mosaic) {
    invalidate();
    rasterUniforms.elevBackstop.value = mosaic.texture;
    rasterUniforms.elevBackstopZoom.value = mosaic.level;
    rasterUniforms.hasElevBackstop.value = 1;
    reliefStatus.textContent =
      `world relief z${mosaic.level}, ${4 ** mosaic.level} tiles` +
      `${mosaic.failed ? `, ${mosaic.failed} missing` : ""}`;
  },
  hide() {
    invalidate();
    rasterUniforms.hasElevBackstop.value = 0;
    reliefStatus.textContent = "";
  },
});

const elevation = createElevationGrid({
  concurrency: 6,
  onPaint: invalidate,
  onProgress(done, total) {
    if (total) setJob("terrain", done, total);
    else clearJob("terrain");
  },
  onBuild: (ms) => pyramidTime.sample(ms),
  onShadowField(state) {
    shadowsReady.set(!!state);
    if (!state) return;
    rasterUniforms.maxPyramid.value = state.pyramid;
    rasterUniforms.pyramidLevels.value = state.levels;
    rasterUniforms.terrainMax.value = state.maxHeight || 3000;
  },
  onUpdate(state) {
    invalidate();
    if (!state) {
      rasterUniforms.hasElevation.value = 0;
      terrainStatus.textContent = "";
      return;
    }

    const { x0, y0, width, height, zoom } = state.block;
    rasterUniforms.elevation.value = state.texture;
    rasterUniforms.elevWindow.value.set(x0, y0, width, height);
    rasterUniforms.elevationZoom.value = zoom;
    rasterUniforms.hasElevation.value = 1;
    rasterUniforms.terrainMax.value = state.maxHeight || 3000;
    terrainStatus.textContent =
      `${state.provider.attribution} — terrain z${zoom}, ` +
      `${width}×${height} tiles${state.failed ? `, ${state.failed} failed` : ""}`;
  },
});

const water = createTileGrid({
  concurrency: 4,
  onPaint: invalidate,
  onProgress(done, total) {
    if (total) setJob("water", done, total);
    else clearJob("water");
  },
  onUpdate(state) {
    invalidate();
    if (!state) {
      rasterUniforms.hasWaterMap.value = 0;
      waterStatus.textContent = "";
      return;
    }

    const { x0, y0, width, height, zoom } = state.block;
    rasterUniforms.waterMap.value = state.texture;
    rasterUniforms.waterWindow.value.set(x0, y0, width, height);
    rasterUniforms.waterZoom.value = zoom;
    rasterUniforms.hasWaterMap.value = 1;
    waterStatus.textContent =
      `${state.provider.attribution} — water z${zoom}, ` +
      `${width}×${height} tiles${state.failed ? `, ${state.failed} failed` : ""}`;
  },
});

function windowTarget(providers, source, maxZoom, pad = 0, minZoom = 1) {
  const provider = providers[source];
  if (!provider) return null;
  const block = neededWindow(Math.min(provider.maxZoom, maxZoom), pad, minZoom);
  return block ? { provider, source, block } : null;
}

function refreshBackstop() {
  const source = imagerySource();
  const provider = colorProviders[source];
  if (!provider) return backstop.update(null);

  const level = Math.min(BACKSTOP_ZOOM, provider.maxZoom);
  backstop.update({ provider, source, level, key: `${source}@${level}` });
}

function refreshDetail() {
  if (!view.isReady()) return;
  const source = imagerySource();
  const provider = colorProviders[source];
  const target =
    provider && autoDetail()
      ? windowTarget(colorProviders, source, provider.maxZoom)
      : null;
  detail.update(target && { ...target, cacheKey: `colour:${source}` });
}

function refreshReliefBackstop() {
  const source = elevationSource();
  const provider = elevationProviders[source];
  if (!terrain() || !provider) return reliefBackstop.update(null);

  const level = Math.min(ELEVATION_BACKSTOP_ZOOM, provider.maxZoom);
  reliefBackstop.update({ provider, source, level, key: `${source}@${level}` });
}

function refreshElevation() {
  if (!view.isReady()) return;

  const source = elevationSource();
  const target = terrain()
    ? windowTarget(
        elevationProviders,
        source,
        TERRAIN_MAX_ZOOM,
        castShadows() ? 1 : 0
      )
    : null;

  elevation.update(target && { ...target, cacheKey: `terrain:${source}` });
}

function refreshWater() {
  if (!view.isReady()) return;
  const source = waterSource();
  const target = windowTarget(waterProviders, source, 24, 0, 0);
  water.update(target && { ...target, cacheKey: `water:${source}` });
}

function scheduleLoads() {
  refreshDetail();
  refreshWater();
  refreshElevation();
}

controls.addEventListener("change", () => {
  const { x, y } = camera.position;
  if (x === 0 && y === 0) return;

  const [rotatedLon, rotatedLat] = planeToLonLat(x, y, projection.value);
  const [lon, lat] = uncenter(rotatedLon, rotatedLat, {
    lon: center.value.x,
    lat: center.value.y,
  });

  selected.set(NONE);
  setCenter(lon, lat);
});

controls.addEventListener("change", () => {
  invalidate();
  scheduleLoads();
});
controls.minZoom = 1;

const gui = buildGui({
  countries,
  byName,
  setCenter,
  counters: {
    fps,
    submitTime,
    otherTime,
    cpuSubmit,
    pyramidTime,
    drawCalls,
    textureCount,
    imageryPending,
    terrainPending,
    waterPending,
  },
});

// A table, so no uniform goes unbound and no binding forgets to invalidate.
const UNIFORM_BINDINGS = [
  ["hillshade", hillshade],
  ["exaggeration", exaggeration],
  ["shadowStrength", shadowStrength],
  ["shadowSteps", shadowSteps],
  ["shadowSoftness", shadowSoftness],
  ["waterLevel", waterLevel],
  ["paper", () => (paperReady() ? paper() : 0)],
  ["paperBump", paperBump],
  ["paperScale", paperScale],
  ["shadows", () => (castShadows() && shadowsReady() ? 1 : 0)],
  ["rawMosaic", () => (showMosaic() ? 1 : 0)],
  ["tileDebug", () => (showTiles() ? tileTint() : 0)],
];

for (const [name, read] of UNIFORM_BINDINGS) {
  effect(() => {
    rasterUniforms[name].value = read();
    invalidate();
  });
}

effect(() => {
  rasterUniforms.sun.value.set(sunAzimuth(), sunAltitude());
  invalidate();
});

effect(() => {
  rasterUniforms.waterFill.value = waterFill() ? 1 : 0;
  rasterUniforms.waterColor.value.set(waterTint());
  invalidate();
});

effect(() => {
  castShadows();
  refreshElevation();
});

effect(() => {
  graticule.visible = showGraticule();
  outlines.visible = showOutlines();
  invalidate();
});

effect(() =>
  document.querySelector("#gui").classList.toggle("hidden", !uiVisible())
);

effect(() => {
  projection.value = PROJECTION[projectionName()];
  resize();
  invalidate();
  scheduleLoads();
});

effect(() => {
  center.value.set(centreLon(), centreLat());

  controls.target.set(0, 0, 0);
  camera.position.set(0, 0, 10);
  controls.update();

  invalidate();
  scheduleLoads();
});

effect(() => {
  const name = selected();
  status.textContent =
    `centred on ${centreLon().toFixed(2)}°, ${centreLat().toFixed(2)}°` +
    (name === NONE ? "" : ` — ${name}`) +
    worldError();
});

effect(() => {
  selectCountry(selected());
  highlight.visible = showOutlines() && byName.has(selected());
  invalidate();
});

effect(() => {
  refreshBackstop();
  scheduleLoads();
});

effect(() => {
  autoDetail();
  scheduleLoads();
});
effect(() => {
  refreshReliefBackstop();
  refreshElevation();
});
effect(() => refreshWater());

function updatePlaneExtent() {
  const halfWidth = (camera.right - camera.left) / (2 * camera.zoom);
  const halfHeight = (camera.top - camera.bottom) / (2 * camera.zoom);
  const limit = planeHalfHeight(projection.value);

  const minX = Math.max(-180, camera.position.x - halfWidth);
  const maxX = Math.min(180, camera.position.x + halfWidth);
  const minY = Math.max(-limit, camera.position.y - halfHeight);
  const maxY = Math.min(limit, camera.position.y + halfHeight);

  rasterUniforms.planeMin.value.set(minX, minY);
  rasterUniforms.planeMax.value.set(Math.max(minX, maxX), Math.max(minY, maxY));
}

function ndcToPlane(ndcX, ndcY) {
  const point = new Vector3(ndcX, ndcY, 0).unproject(camera);
  return [point.x, point.y];
}

window.addEventListener("keydown", (event) => {
  if (event.key !== "Tab") return;
  if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.target instanceof Element && event.target.closest("#gui")) return;

  event.preventDefault();
  uiVisible.set(!uiVisible());
});

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  const aspect = width / height;

  let halfHeight = planeHalfHeight(projection.value);
  let halfWidth = halfHeight * aspect;
  if (halfWidth < 180) {
    halfWidth = 180;
    halfHeight = halfWidth / aspect;
  }

  camera.left = -halfWidth;
  camera.right = halfWidth;
  camera.top = halfHeight;
  camera.bottom = -halfHeight;
  camera.updateProjectionMatrix();

  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(width, height);

  const ratio = renderer.getPixelRatio();
  const budget = detailBudget(width * ratio, height * ratio);
  // Three windowed layers, so a screenful is three budgets squared.
  setTileCacheLimit(3 * budget * budget);
  rasterUniforms.resolution.value.set(
    width * renderer.getPixelRatio(),
    height * renderer.getPixelRatio()
  );
}

window.addEventListener("resize", () => {
  resize();
  invalidate();
  scheduleLoads();
});
resize();

view.readView();
view.markReady();
scheduleLoads();

controls.addEventListener("change", view.writeViewSoon);
effect(() => {
  centreLon();
  centreLat();
  for (const { value } of view.params) value();
  view.writeViewSoon();
});

renderer.setAnimationLoop((now) => {
  const stamp = now ?? performance.now();
  const frameMs = Math.min(stamp - lastFrameAt, 1000);
  lastFrameAt = stamp;

  // Soft shadows need averaging; everything else converges on the first frame.
  const wanted = shadowsReady() && castShadows() && shadowSoftness() > 0 ? ACCUMULATE : 1;

  let submit = 0;
  if (dirty || sample < wanted) {
    dirty = false;
    updatePlaneExtent();

    rasterUniforms.frameSeed.value = sample;
    blendWeight.value = 1 / (sample + 1);
    renderer.autoClear = sample === 0;

    const startedAt = performance.now();
    renderer.render(scene, camera);
    submit = performance.now() - startedAt;
    sample += 1;

    drawCalls.sample(renderer.info.render.calls);
    textureCount.sample(renderer.info.memory.textures);
  }

  fps.tick();
  submitTime.sample(submit);
  cpuSubmit.sample(submit);
  otherTime.sample(Math.max(0, frameMs - submit));

  const pending = pendingByBand();
  imageryPending.sample(pending.imagery);
  terrainPending.sample(pending.terrain);
  waterPending.sample(pending.water);

  stats.flush();
});
