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
  Scene,
  TOUCH,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "orbitcontrols";
import {
  GUI,
  batch,
  effect,
  signal,
} from "../third_party/guspira/guspira.min.js";
import {
  buildColorMosaic,
  buildElevationMosaic,
  buildWindowMosaic,
} from "./mosaic.js";
import {
  colorProviders,
  elevationProviders,
  waterProviders,
} from "./tile-providers.js";
import { covers, probeVisibleWindow } from "./visibility.js";
import {
  MERCATOR_MAX_LAT,
  PROJECTION,
  lonLatToMosaicUV,
  planeHalfHeight,
  planeToLonLat,
  projectionGLSL,
  uncenter,
} from "./projection.js";

const NONE = "—";

const imagerySource = signal("Esri satellite");
const BACKSTOP_ZOOM = 2;

const TERRAIN_MAX_ZOOM = 13;

// The shader keeps its own copy as a #define.
const EQUATOR_METRES_PER_PIXEL = 156543.03392804097;
const imageryOpacity = signal(1);
const autoDetail = signal(true);
const showTiles = signal(false);
const showMosaic = signal(false);
const castShadows = signal(false);
const shadowStrength = signal(0.8);
const shadowSteps = signal(64);
const wobble = signal(0);
const uiVisible = signal(true);
const waves = signal(0);
const waveScale = signal(300);
const glint = signal(0.6);
const showWater = signal(false);
const waterSource = signal("JRC surface water");
const waterLevel = signal(0.35);
const wobbleBounce = signal(0.75);
const wobbleSpeed = signal(0.75);

// Spring anchored at zero; movement injects momentum.
const lean = { x: 0, y: 0, vx: 0, vy: 0 };
let lastFrame = performance.now();
let lastAnchor = null;

function viewAnchor() {
  const [rotatedLon, rotatedLat] = planeToLonLat(
    camera.position.x,
    camera.position.y,
    projection.value
  );
  const [lon, lat] = uncenter(rotatedLon, rotatedLat, {
    lon: center.value.x,
    lat: center.value.y,
  });
  return lonLatToMosaicUV(lon, lat);
}

function resetWobble() {
  lastAnchor = null;
}
const tileTint = signal(0.5);
const terrain = signal(true);
const elevationSource = signal("AWS terrain");

const hillshade = signal(0.7);
const exaggeration = signal(1.5);
const sunAzimuth = signal(315);
const sunAltitude = signal(45);
const projectionName = signal("mercator");
const centreLon = signal(0);
const centreLat = signal(0);
const selected = signal(NONE);
const showGraticule = signal(true);
const showOutlines = signal(true);

const vertexShader = /* glsl */ `
in vec3 position;
in vec2 neighbor;

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform vec2 center;
uniform float projection;

${projectionGLSL}

void main() {
  vec2 a = recenter(position.xy, center);
  vec2 b = recenter(neighbor, center);

  if (abs(a.x - b.x) > 180.) {
    gl_Position = vec4(0., 0., -2., 1.);
    return;
  }

  gl_Position = projectionMatrix * modelViewMatrix
    * vec4(projectToPlane(a, projection), 0., 1.);
}
`;

const fragmentShader = /* glsl */ `
precision highp float;

uniform vec3 color;
uniform float opacity;

out vec4 fragColor;

void main() {
  fragColor = vec4(color, opacity);
}
`;

const rasterVertexShader = /* glsl */ `
in vec3 position;

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform vec2 planeMin;
uniform vec2 planeMax;

out vec2 vPlane;

void main() {
  // Quad fits the view: a world-spanning primitive loses precision.
  vPlane = mix(planeMin, planeMax, position.xy * .5 + .5);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(vPlane, 0., 1.);
}
`;

const rasterFragmentShader = /* glsl */ `
precision highp float;

uniform sampler2D map;
uniform sampler2D detailMap;
uniform sampler2D elevation;
uniform vec4 detailWindow;
uniform float detailZoom;
uniform float hasDetail;
uniform float hasImagery;
uniform float baseZoom;
uniform float tileDebug;
uniform float rawMosaic;
uniform float detailLod;
uniform vec2 resolution;
uniform vec2 center;
uniform float projection;
uniform float opacity;
uniform float hasElevation;
uniform vec4 elevWindow;
uniform float elevationZoom;
uniform float hillshade;
uniform float exaggeration;
uniform float shadows;
uniform float shadowStrength;
uniform float shadowSteps;
uniform sampler2D maxPyramid;
uniform float pyramidLevels;
uniform float terrainMax;
uniform float waves;
uniform float waveScale;
uniform float glint;
uniform float time;
uniform float showWater;
uniform sampler2D waterMap;
uniform vec4 waterWindow;
uniform float waterZoom;
uniform float hasWaterMap;
uniform float waterLevel;
uniform vec2 wobbleShift;
uniform vec2 sun;



in vec2 vPlane;
out vec4 fragColor;

${projectionGLSL}

#define EQUATOR_METRES_PER_PIXEL 156543.03392804097

float leanedHeight(in vec2 p, in vec2 leanPerMetre) {
  float resting = texture(elevation, p).r;
  return texture(elevation, p - leanPerMetre * resting).r;
}

void addWave(
  inout vec2 slope, in vec2 p, in vec2 dir,
  in float freq, in float amp, in float speed
) {
  slope += dir * (amp * freq * cos(dot(p, dir) * freq + time * speed));
}

vec3 waterNormal(in vec2 p) {
  vec2 slope = vec2(0.);
  addWave(slope, p, normalize(vec2( 1.0,  0.35)), 1.0, 1.00, 1.6);
  addWave(slope, p, normalize(vec2( 0.7, -0.75)), 1.7, 0.55, 2.1);
  addWave(slope, p, normalize(vec2(-0.4,  0.95)), 2.9, 0.28, 2.7);
  addWave(slope, p, normalize(vec2(-0.9, -0.25)), 4.6, 0.14, 3.3);
  return normalize(vec3(-slope * waves, 1.));
}

float castShadow(in vec2 local, in float here, in float metres, in vec2 leanPerMetre) {
  vec2 texel = 1. / (elevWindow.zw * 256.);
  float azimuth = sun.x * DEG;
  vec2 stride = vec2(sin(azimuth), -cos(azimuth)) * texel;
  float rise = tan(sun.y * DEG);

  // Per-pixel jitter, so misses read as noise not banding.
  float dither = fract(
    52.9829189 * fract(dot(gl_FragCoord.xy, vec2(.06711056, .00583715)))
  );

  float blocked = 0.;
  float t = 1. + dither;
  float level = 0.;

  for (int i = 0; i < int(shadowSteps); i++) {
    vec2 p = local + stride * t;
    // Outside the window there is nothing to consult.
    if (any(lessThan(p, vec2(0.))) || any(greaterThan(p, vec2(1.)))) break;

    float ray = here + t * metres * rise;
    if (ray > terrainMax) break;

    // Maxima, not averages: an averaged peak bounds nothing.
    float highest = textureLod(maxPyramid, p, level).r;
    float span = exp2(level);

    if (ray > highest) {
      // Half a footprint: the region is grid-aligned, the ray is not.
      t += max(span * .5, 1.);
      level = min(level + 1., pyramidLevels - 1.);
    } else if (level > 0.) {
      level -= 1.;
    } else {
      float h = leanedHeight(p, leanPerMetre);
      blocked = max(blocked, (h - here) / (t * metres) - rise);
      t += 1.;
    }
  }

  return smoothstep(0., .12, blocked);
}

float terrainShade(in vec2 local, in float lat) {
  vec2 texel = 1. / (elevWindow.zw * 256.);
  float metres =
    EQUATOR_METRES_PER_PIXEL * cos(lat * DEG) / exp2(elevationZoom) / exaggeration;

  float west = texture(elevation, local - vec2(texel.x, 0.)).r;
  float east = texture(elevation, local + vec2(texel.x, 0.)).r;
  float north = texture(elevation, local - vec2(0., texel.y)).r;
  float south = texture(elevation, local + vec2(0., texel.y)).r;

  vec3 normal = normalize(vec3(
    (west - east) / (2. * metres),
    (south - north) / (2. * metres),
    1.
  ));

  float azimuth = sun.x * DEG;
  float altitude = sun.y * DEG;
  vec3 toSun = vec3(
    cos(altitude) * sin(azimuth),
    cos(altitude) * cos(azimuth),
    sin(altitude)
  );

  // Divided by the flat response, so level ground returns 1.0.
  float lambert = max(dot(normal, toSun), 0.);
  return min(lambert / max(sin(altitude), .001), 1.8);
}

vec3 tileOverlay(in vec2 uv, in float zoom, in vec2 dx, in vec2 dy) {
  float side = exp2(zoom);
  vec2 tile = uv * side;

  vec2 cell = floor(tile);
  uvec3 key = uvec3(ivec2(cell) + 1048576, int(zoom));
  uint bits = key.x * 73856093u ^ key.y * 19349663u ^ key.z * 83492791u;
  float h = float(bits % 65536u) / 65536.;
  vec3 tint = clamp(abs(mod(h * 6. + vec3(0., 4., 2.), 6.) - 3.) - 1., 0., 1.);

  vec2 width = (abs(dx) + abs(dy)) * side;
  vec2 edge = min(fract(tile), 1. - fract(tile)) / max(width, vec2(1e-8));
  float border = 1. - smoothstep(.5, 1.5, min(edge.x, edge.y));

  return mix(tint, vec3(1.), border);
}

void main() {
  if (rawMosaic > .5) {
    vec2 t = gl_FragCoord.xy / resolution;
    fragColor = vec4(texture(detailMap, vec2(t.x, 1. - t.y)).rgb, 1.);
    return;
  }

  vec2 rotated = planeToLonLat(vPlane, projection);
  if (abs(rotated.y) > 90.) discard;

  vec2 lonLat = uncenter(rotated, center);

  vec2 uv = lonLatToMosaicUV(lonLat);

  float eside = exp2(elevationZoom);
  vec2 elocal = vec2(-1.);
  bool onElevation = false;
  float height = 0.;

  if (hasElevation > .5) {
    vec2 etile = uv * eside;
    if (etile.x < elevWindow.x) etile.x += eside;
    elocal = (etile - elevWindow.xy) / elevWindow.zw;
    onElevation =
      all(greaterThanEqual(elocal, vec2(0.))) && all(lessThanEqual(elocal, vec2(1.)));
    if (onElevation) {
      // Blurred height: per-texel weighting shears the image.
      vec2 spread = 10. / (elevWindow.zw * 256.);
      height = max(0., .2 * (
        texture(elevation, elocal).r +
        texture(elevation, elocal + vec2(spread.x, 0.)).r +
        texture(elevation, elocal - vec2(spread.x, 0.)).r +
        texture(elevation, elocal + vec2(0., spread.y)).r +
        texture(elevation, elocal - vec2(0., spread.y)).r));
    }
  }

  vec2 lean = wobbleShift * (height / 3000.);
  uv += lean;

  if (onElevation) {
    elocal += lean * eside / elevWindow.zw;
    onElevation =
      all(greaterThanEqual(elocal, vec2(0.))) && all(lessThanEqual(elocal, vec2(1.)));
  }

  // Unwrap the gradient: u jumps a texture width at the antimeridian.
  vec2 dx = dFdx(uv);
  vec2 dy = dFdy(uv);
  if (abs(dx.x) > .5) dx.x -= sign(dx.x);
  if (abs(dy.x) > .5) dy.x -= sign(dy.x);

  vec3 color = hasImagery > .5
    ? textureGrad(map, uv, dx, dy).rgb
    : vec3(1.);

  float shownZoom = baseZoom;

  if (hasDetail > .5) {
    float side = exp2(detailZoom);
    vec2 tile = uv * side;
    if (tile.x < detailWindow.x) tile.x += side;

    vec2 local = (tile - detailWindow.xy) / detailWindow.zw;

    if (all(greaterThanEqual(local, vec2(0.))) && all(lessThanEqual(local, vec2(1.)))) {
      vec3 detail = textureLod(detailMap, local, detailLod).rgb;

      vec2 edge = min(local, 1. - local);
      float blend = smoothstep(0., .02, min(edge.x, edge.y));
      color = mix(color, detail, blend);
      if (blend > .5) shownZoom = detailZoom;
    }
  }

  float wetness = 0.;
  vec2 seaMetres = vec2(0.);

  if (hasWaterMap > .5) {
    float wside = exp2(waterZoom);
    vec2 wtile = uv * wside;
    if (wtile.x < waterWindow.x) wtile.x += wside;
    vec2 wlocal = (wtile - waterWindow.xy) / waterWindow.zw;

    if (all(greaterThanEqual(wlocal, vec2(0.)))
     && all(lessThanEqual(wlocal, vec2(1.)))) {
      // Observed mask: flat land and water are alike by height.
      wetness = texture(waterMap, wlocal).a;
      seaMetres = wlocal * waterWindow.zw * 256.
        * (EQUATOR_METRES_PER_PIXEL * cos(lonLat.y * DEG) / wside);
    }
  }

  // dFdx/dFdy are undefined in non-uniform control flow.
  float metresPerPixel = max(length(dFdx(seaMetres)), length(dFdy(seaMetres)));
  float legible = smoothstep(6., 20., waveScale / max(metresPerPixel, .001));

  float surf = smoothstep(waterLevel, min(waterLevel + .25, 1.), wetness);

  if (surf > 0. && showWater > .5) {
    color = mix(color, vec3(.1, .85, 1.), .85 * surf);
  } else if (surf > 0. && waves > 0. && legible > 0.) {
    vec2 p = seaMetres * (6.2831853 / waveScale);
    vec3 normal = waterNormal(p);

    float azimuth = sun.x * DEG;
    float altitude = sun.y * DEG;
    vec3 toSun = vec3(
      cos(altitude) * sin(azimuth),
      cos(altitude) * cos(azimuth),
      sin(altitude)
    );

    vec3 halfway = normalize(toSun + vec3(0., 0., 1.));
    float sheen = pow(max(dot(normal, halfway), 0.), mix(10., 64., legible));
    float lit = max(dot(normal, toSun), 0.);

    color = mix(color, color * (.75 + .6 * lit) + sheen * glint, legible * surf);
  }

  if (hasElevation > .5 && onElevation) {
    if (hillshade > 0. && surf <= 0.) {
      color *= mix(1., terrainShade(elocal, lonLat.y), hillshade);
    }

    if (shadows > .5 && shadowStrength > 0.) {
      float metres =
        EQUATOR_METRES_PER_PIXEL * cos(lonLat.y * DEG) / exp2(elevationZoom) /
        exaggeration;
      vec2 leanPerMetre = wobbleShift * eside / elevWindow.zw / 3000.;
      float dark = castShadow(
        elocal, leanedHeight(elocal, leanPerMetre), metres, leanPerMetre
      );
      // Shadowed ground keeps some skylight.
      color *= mix(1., .28, dark * shadowStrength);
    }
  }

  if (tileDebug > 0.) {
    color = mix(color, tileOverlay(uv, shownZoom, dx, dy), tileDebug);
  }

  fragColor = vec4(color, opacity);
}
`;

const center = { value: new Vector2(0, 0) };
const projection = { value: PROJECTION.mercator };

function makeMaterial(color, opacity = 1) {
  return new RawShaderMaterial({
    uniforms: {
      center,
      projection,
      color: { value: new Color(color) },
      opacity: { value: opacity },
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
  detailLod: { value: 0 },
  resolution: { value: new Vector2(1, 1) },
  opacity: { value: 1 },
  elevation: { value: null },
  hasElevation: { value: 0 },
  elevWindow: { value: new Vector4(0, 0, 1, 1) },
  elevationZoom: { value: 0 },
  hillshade: { value: hillshade() },
  shadows: { value: 0 },
  shadowStrength: { value: shadowStrength() },
  shadowSteps: { value: shadowSteps() },
  maxPyramid: { value: null },
  pyramidLevels: { value: 1 },
  terrainMax: { value: 3000 },
  waves: { value: waves() },
  waveScale: { value: waveScale() },
  glint: { value: glint() },
  time: { value: 0 },
  showWater: { value: 0 },
  waterMap: { value: null },
  waterWindow: { value: new Vector4(0, 0, 1, 1) },
  waterZoom: { value: 0 },
  hasWaterMap: { value: 0 },
  waterLevel: { value: waterLevel() },
  wobbleShift: { value: new Vector2(0, 0) },
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
const world = await (await fetch("data/world.json")).json();
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
    highlight.visible = false;
    return;
  }

  const rings = [];
  for (let i = 0; i < country.ringCount; i++) rings.push(country.firstRing + i);
  highlight.geometry = buildSegments(coords, ringOffsets, rings);
  highlight.visible = true;
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
let mosaicRequest = null;

let colorMosaic = null;
let elevationMosaic = null;

function showImagery(mosaic) {
  rasterUniforms.map.value = mosaic.texture;
  rasterUniforms.hasImagery.value = 1;
  rasterUniforms.baseZoom.value = mosaic.level;
  raster.visible = true;
  imageryStatus.textContent =
    `${mosaic.attribution} — base z${mosaic.level}, ${4 ** mosaic.level} tiles` +
    `${mosaic.failed ? `, ${mosaic.failed} missing` : ""}`;
}

function showElevation(mosaic) {
  const { x0, y0, width, height, zoom } = mosaic.block;
  rasterUniforms.elevation.value = mosaic.texture;
  rasterUniforms.elevWindow.value.set(x0, y0, width, height);
  rasterUniforms.elevationZoom.value = zoom;
  rasterUniforms.hasElevation.value = 1;
  rasterUniforms.terrainMax.value = mosaic.maxHeight ?? 3000;
  rasterUniforms.maxPyramid.value = mosaic.pyramid;
  rasterUniforms.pyramidLevels.value = mosaic.pyramidLevels ?? 1;
  updateShadowMarch();
  terrainStatus.textContent =
    `${mosaic.attribution} — terrain z${zoom}, ${width}×${height} tiles` +
    `${mosaic.failed ? `, ${mosaic.failed} missing` : ""}`;
}

async function loadImagery(name = imagerySource(), zoom = BACKSTOP_ZOOM) {
  mosaicRequest?.abort();
  mosaicRequest = null;

  const provider = colorProviders[name];
  if (!provider) {
    rasterUniforms.hasImagery.value = 0;
    raster.visible = true;
    imageryStatus.textContent = "no imagery — shaded relief only";
    return;
  }

  const level = Math.min(zoom, provider.maxZoom);
  const key = `${name}@${level}`;

  if (colorMosaic?.key === key) {
    showImagery(colorMosaic);
    return;
  }

  const controller = new AbortController();
  mosaicRequest = controller;

  try {
    const { texture, failed } = await buildColorMosaic(provider, level, {
      signal: controller.signal,
      onProgress: (done, total) => {
        if (controller.signal.aborted) return;
        imageryStatus.textContent = `${name} — ${done}/${total} tiles`;
        setJob("backstop", done, total);
      },
    });

    if (controller.signal.aborted) {
      texture.dispose();
      return;
    }

    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    colorMosaic?.texture.dispose();
    colorMosaic = { key, texture, level, attribution: provider.attribution, failed };
    showImagery(colorMosaic);
  } catch (error) {
    if (error.name === "AbortError") return;
    imageryStatus.textContent = `${name} failed: ${error.message}`;
    rasterUniforms.hasImagery.value = 0;
  } finally {
    clearJob("backstop");
    if (mosaicRequest === controller) mosaicRequest = null;
  }
}

let waterMosaic = null;
let waterRequest = null;

function showWaterMosaic(mosaic) {
  const { x0, y0, width, height, zoom } = mosaic.block;
  rasterUniforms.waterMap.value = mosaic.texture;
  rasterUniforms.waterWindow.value.set(x0, y0, width, height);
  rasterUniforms.waterZoom.value = zoom;
  rasterUniforms.hasWaterMap.value = 1;
  waterStatus.textContent =
    `${mosaic.attribution} — water z${zoom}, ${width}×${height} tiles`;
}

async function loadWater(source = waterSource()) {
  const provider = waterProviders[source];
  const target = provider ? neededWindow(provider.maxZoom) : null;

  if (!target) {
    waterRequest?.abort();
    waterRequest = null;
    rasterUniforms.hasWaterMap.value = 0;
    waterStatus.textContent = "";
    return;
  }

  if (waterMosaic?.source === source && covers(waterMosaic.block, target)) {
    showWaterMosaic(waterMosaic);
    return;
  }

  waterRequest?.abort();
  const controller = new AbortController();
  waterRequest = controller;

  try {
    const { texture } = await buildWindowMosaic(provider, target, {
      signal: controller.signal,
      cacheKey: `water:${source}`,
      onProgress: (done, total) => {
        if (controller.signal.aborted) return;
        setJob("water", done, total);
      },
    });

    if (controller.signal.aborted) {
      texture.dispose();
      return;
    }

    waterMosaic?.texture.dispose();
    waterMosaic = {
      texture,
      block: target,
      source,
      attribution: provider.attribution,
    };
    showWaterMosaic(waterMosaic);
  } catch (error) {
    if (error.name === "AbortError") return;
    waterStatus.textContent = `water failed: ${error.message}`;
    rasterUniforms.hasWaterMap.value = 0;
  } finally {
    clearJob("water");
    if (waterRequest === controller) waterRequest = null;
  }
}

let elevationRequest = null;

async function loadElevation(
  enabled = terrain(),
  cap = TERRAIN_MAX_ZOOM,
  source = elevationSource()
) {
  const provider = elevationProviders[source];

  const target =
    enabled && provider
      ? neededWindow(Math.min(provider.maxZoom, cap), castShadows() ? 1 : 0)
      : null;

  if (!target) {
    elevationRequest?.abort();
    elevationRequest = null;
    rasterUniforms.hasElevation.value = 0;
    terrainStatus.textContent = "";
    return;
  }

  if (elevationMosaic?.source === source && covers(elevationMosaic.block, target)) {
    showElevation(elevationMosaic);
    return;
  }

  elevationRequest?.abort();
  const controller = new AbortController();
  elevationRequest = controller;

  try {
    const {
      texture,
      pyramid,
      pyramidLevels,
      failed,
      maxHeight,
    } = await buildElevationMosaic(provider, target.zoom, {
      signal: controller.signal,
      concurrency: 6,
      window: target,
      cache: true,
      cacheKey: `terrain:${source}`,
      onProgress: (done, total) => {
        if (controller.signal.aborted) return;
        terrainStatus.textContent = `terrain — ${done}/${total} tiles`;
        setJob("terrain", done, total);
      },
    });

    if (controller.signal.aborted) {
      texture.dispose();
      pyramid.dispose();
      return;
    }

    elevationMosaic?.texture.dispose();
    elevationMosaic?.pyramid?.dispose();
    elevationMosaic = {
      texture,
      pyramid,
      pyramidLevels,
      block: target,
      source,
      attribution: provider.attribution,
      failed,
      maxHeight,
    };
    showElevation(elevationMosaic);
  } catch (error) {
    if (error.name === "AbortError") return;
    terrainStatus.textContent = `terrain failed: ${error.message}`;
    rasterUniforms.hasElevation.value = 0;
  } finally {
    clearJob("terrain");
    if (elevationRequest === controller) elevationRequest = null;
  }
}

function detailBudget(pixelWidth, pixelHeight) {
  return Math.min(16, Math.ceil(Math.max(pixelWidth, pixelHeight) / 256) + 3);
}

let detailMosaic = null;
let detailRequest = null;
let detailTimer = null;

function showDetail(mosaic) {
  const { x0, y0, width, height, zoom } = mosaic.block;
  rasterUniforms.detailMap.value = mosaic.texture;
  rasterUniforms.detailWindow.value.set(x0, y0, width, height);
  rasterUniforms.detailZoom.value = zoom;
  const texelsPerPixel = mosaic.block.scale * 2 ** zoom * 256;
  rasterUniforms.detailLod.value = Math.max(0, Math.log2(texelsPerPixel));
  rasterUniforms.hasDetail.value = 1;
  // Viewport goes in the readout; the URL cannot carry it.
  detailStatus.textContent =
    `detail z${zoom} · ${width}×${height} tiles · ` +
    `${window.innerWidth}×${window.innerHeight} @${window.devicePixelRatio}x`;
}

function hideDetail(message = "") {
  rasterUniforms.hasDetail.value = 0;
  detailStatus.textContent = message;
}

function neededWindow(maxZoom, pad = 0) {
  const pixelRatio = renderer.getPixelRatio();
  const pixelWidth = window.innerWidth * pixelRatio;
  const pixelHeight = window.innerHeight * pixelRatio;

  return probeVisibleWindow({
    unproject: ndcToPlane,
    projection: projection.value,
    center: { lon: center.value.x, lat: center.value.y },
    pixelWidth,
    pixelHeight,
    minZoom: 1,
    maxZoom,
    pad,
    budget: detailBudget(pixelWidth, pixelHeight) + 2 * pad,
  });
}

async function updateDetail() {
  const source = imagerySource();
  const provider = colorProviders[source];
  const target =
    provider && autoDetail() ? neededWindow(provider.maxZoom) : null;

  if (!target) {
    detailRequest?.abort();
    detailRequest = null;
    hideDetail();
    return;
  }

  if (detailMosaic?.source === source && covers(detailMosaic.block, target)) {
    showDetail(detailMosaic);
    return;
  }

  detailRequest?.abort();
  const controller = new AbortController();
  detailRequest = controller;
  detailStatus.textContent = `detail z${target.zoom} — loading…`;

  try {
    const { texture } = await buildWindowMosaic(provider, target, {
      signal: controller.signal,
      cacheKey: `colour:${source}`,
      onProgress: (done, total) => {
        if (controller.signal.aborted) return;
        setJob("imagery", done, total);
      },
    });

    if (controller.signal.aborted) {
      texture.dispose();
      return;
    }

    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    detailMosaic?.texture.dispose();
    detailMosaic = { texture, block: target, source };
    showDetail(detailMosaic);
  } catch (error) {
    if (error.name === "AbortError") return;
    hideDetail(`detail failed: ${error.message}`);
  } finally {
    clearJob("imagery");
    if (detailRequest === controller) detailRequest = null;
  }
}

function scheduleDetail() {
  clearTimeout(detailTimer);
  detailTimer = setTimeout(() => {
    updateDetail();
    loadElevation();
    loadWater();
  }, 450);
}

controls.addEventListener("change", () => {
  const { x, y } = camera.position;
  if (x === 0 && y === 0) return; // a zoom, not a pan

  const [rotatedLon, rotatedLat] = planeToLonLat(x, y, projection.value);
  const [lon, lat] = uncenter(rotatedLon, rotatedLat, {
    lon: center.value.x,
    lat: center.value.y,
  });

  selected.set(NONE);
  setCenter(lon, lat);
});

controls.addEventListener("change", scheduleDetail);
controls.minZoom = 1;

const gui = new GUI("Flat Earth", document.querySelector("#gui"), {
  storageKey: "flat-earth",
});

gui.addElement(document.querySelector("#ui"));

gui.addSection("Projection");
gui.addSegmented("Projection", projectionName, ["mercator", "equirectangular"]);
gui.addSlider("Centre lon", centreLon, -180, 180, 0.01);
gui.addSlider("Centre lat", centreLat, -90, 90, 0.01);
gui.addSelect(
  "Centre on country",
  selected,
  [NONE, ...countries.map((c) => c.name).sort()],
  {
    onChange: (name) => {
      const country = byName.get(name);
      if (!country) return;
      resetWobble();
      setCenter(country.lon, country.lat);
    },
  }
);
gui.addCheckbox("Country outlines", showOutlines);
gui.addCheckbox("Graticule", showGraticule);
gui.addButton("Reset to 0°, 0°", () => {
  selected.set(NONE);
  resetWobble();
  setCenter(0, 0);
});

gui.addSection("Imagery");
gui.addSelect("Source", imagerySource, ["none", ...Object.keys(colorProviders)]);

gui.addSlider("Opacity", imageryOpacity, 0, 1, 0.01);


gui.addSection("Terrain");
gui.addCheckbox("Shading", terrain);
const whileShaded = { disabledWhen: () => !terrain() };
const whileRelief = {
  disabledWhen: () => !terrain() || (hillshade() === 0 && !castShadows()),
};
gui.addSelect(
  "Elevation source",
  elevationSource,
  Object.keys(elevationProviders),
  whileShaded
);

gui.addSlider("Relief strength", hillshade, 0, 1, 0.01, whileShaded);
gui.addSlider("Exaggeration", exaggeration, 1, 20, 0.5, {
  ...whileRelief,
  title: "At world scale true slopes are too gentle to read",
});
gui.addSlider("Sun azimuth", sunAzimuth, 0, 360, 1, whileRelief);
gui.addCheckbox("Cast shadows", castShadows, {
  ...whileShaded,
  title: "March the heightfield toward the sun, so terrain shadows what is behind it",
});
const whileShadowing = { disabledWhen: () => !terrain() || !castShadows() };
gui.addSlider("Shadow strength", shadowStrength, 0, 1, 0.01, {
  ...whileShadowing,
  title: "How dark shadowed ground goes. Independent of relief strength.",
});
gui.addSlider("Shadow steps", shadowSteps, 16, 192, 8, {
  ...whileShadowing,
  title: "Samples along the march. More is smoother at the same reach, and costs more.",
});
gui.addSlider("Sun altitude", sunAltitude, 5, 90, 1, whileRelief);
gui.addSlider("Wobble", wobble, 0, 1, 0.01, {
  disabledWhen: () => !terrain(),
  title: "Tall ground lags the view and overshoots when it stops",
});
const whileWobbling = { disabledWhen: () => !terrain() || wobble() === 0 };
gui.addSlider("Bounciness", wobbleBounce, 0, 1, 0.01, {
  ...whileWobbling,
  title: "0 settles without overshooting; 1 rings on for a while",
});
gui.addSlider("Wobble speed", wobbleSpeed, 0.2, 2.5, 0.05, {
  ...whileWobbling,
  title: "How quickly it swings, in cycles per second",
});

gui.addSection("Water");
gui.addSelect("Mask", waterSource, ["none", ...Object.keys(waterProviders)], {
  title: "Observed water, from Landsat. A heightfield cannot tell flat land from water.",
});
gui.addSlider("Mask threshold", waterLevel, 0.05, 0.95, 0.01, {
  disabledWhen: () => waterSource() === "none",
  title: "How much water presence counts as water",
});
gui.addSlider("Waves", waves, 0, 1, 0.01, {
  disabledWhen: () => !terrain(),
  title: "Ripple the surface of anything perfectly level -- sea and lakes",
});
const whileWaves = { disabledWhen: () => !terrain() || waves() === 0 };
gui.addSlider("Wave scale", waveScale, 20, 1500, 10, {
  curve: 2,
  ...whileWaves,
  title: "Wavelength in metres on the ground, so it holds its size as you zoom",
});
gui.addSlider("Glint", glint, 0, 2, 0.01, {
  ...whileWaves,
  title: "Sun sheen off the surface. This is what reads as water rather than paint.",
});

gui.addSection("Diagnostics", { open: false });
gui.addCheckbox("Window layer", autoDetail, {
  title: "Off falls back to the whole-world backstop, which is deliberately coarse",
});
gui.addCheckbox("Show tiles", showTiles, {
  title: "Colour and outline each tile, to see the grid and where the window sits",
});
gui.addSlider("Tile tint", tileTint, 0, 1, 0.01, {
  disabledWhen: () => !showTiles(),
});
gui.addCheckbox("Show water mask", showWater, {
  title: "Paint everything the water test detects, regardless of wave settings",
});
gui.addCheckbox("Show raw mosaic", showMosaic, {
  title: "Draw the window unprojected, to tell a compositing fault from a sampling one",
});

effect(() => (rasterUniforms.opacity.value = imageryOpacity()));
effect(() => (rasterUniforms.tileDebug.value = showTiles() ? tileTint() : 0));
effect(() => (rasterUniforms.rawMosaic.value = showMosaic() ? 1 : 0));
effect(() => (rasterUniforms.showWater.value = showWater() ? 1 : 0));
effect(() => (rasterUniforms.hillshade.value = hillshade()));
effect(() => (rasterUniforms.exaggeration.value = exaggeration()));
effect(() => (rasterUniforms.shadowStrength.value = shadowStrength()));
effect(() => (rasterUniforms.waves.value = waves()));
effect(() => (rasterUniforms.waveScale.value = waveScale()));
effect(() => (rasterUniforms.glint.value = glint()));
function updateShadowMarch() {
  rasterUniforms.shadowSteps.value = shadowSteps();
}

effect(() => {
  shadowSteps();
  updateShadowMarch();
});
effect(() => {
  rasterUniforms.shadows.value = castShadows() ? 1 : 0;
  loadElevation();
});
effect(() => rasterUniforms.sun.value.set(sunAzimuth(), sunAltitude()));
effect(() => (graticule.visible = showGraticule()));
effect(() =>
  document.querySelector("#gui").classList.toggle("hidden", !uiVisible())
);
effect(() => (outlines.visible = showOutlines()));

effect(() => {
  projection.value = PROJECTION[projectionName()];
  resize();
  scheduleDetail();
});

effect(() => {
  center.value.set(centreLon(), centreLat());

  controls.target.set(0, 0, 0);
  camera.position.set(0, 0, 10);
  controls.update();

  const name = selected();
  status.textContent =
    `centred on ${centreLon().toFixed(2)}°, ${centreLat().toFixed(2)}°` +
    (name === NONE ? "" : ` — ${name}`);

  scheduleDetail();
});

effect(() => selectCountry(selected()));

effect(() => {
  loadImagery(imagerySource(), BACKSTOP_ZOOM);
  scheduleDetail();
});

effect(() => {
  autoDetail();
  scheduleDetail();
});
effect(() => loadElevation(terrain(), TERRAIN_MAX_ZOOM, elevationSource()));
effect(() => loadWater(waterSource()));
effect(() => (rasterUniforms.waterLevel.value = waterLevel()));

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
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.target instanceof Element && event.target.closest("#gui")) return;

  event.preventDefault();
  uiVisible.set(!uiVisible());
});

let downAt = null;

renderer.domElement.addEventListener("pointerdown", (e) => {
  downAt = new Vector2(e.clientX, e.clientY);
});

renderer.domElement.addEventListener("pointerup", (e) => {
  if (!downAt) return;
  const moved = downAt.distanceTo(new Vector2(e.clientX, e.clientY));
  downAt = null;
  if (moved > 4) return;

  const [planeX, planeY] = ndcToPlane(
    (e.clientX / window.innerWidth) * 2 - 1,
    -(e.clientY / window.innerHeight) * 2 + 1
  );

  const [lon, lat] = planeToLonLat(planeX, planeY, projection.value);
  if (Math.abs(lon) > 180 || Math.abs(lat) > 90) return;

  const [trueLon, trueLat] = uncenter(lon, lat, {
    lon: center.value.x,
    lat: center.value.y,
  });
  selected.set(NONE);
  setCenter(trueLon, trueLat);
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
  rasterUniforms.resolution.value.set(
    width * renderer.getPixelRatio(),
    height * renderer.getPixelRatio()
  );
}

window.addEventListener("resize", () => {
  resize();
  scheduleDetail();
});
resize();


let viewReady = false;
let applyingView = false;
let viewTimer = null;

// One table, so a signal cannot be added without persisting it.
const VIEW_PARAMS = [
  ["img", imagerySource, "string"],
  ["opacity", imageryOpacity, "number"],
  ["detail", autoDetail, "bool"],
  ["shadows", castShadows, "bool"],
  ["shadowstr", shadowStrength, "number"],
  ["shadowsteps", shadowSteps, "number"],
  ["wobble", wobble, "number"],
  ["bounce", wobbleBounce, "number"],
  ["wspeed", wobbleSpeed, "number"],
  ["shading", terrain, "bool"],
  ["terrainsrc", elevationSource, "string"],
  ["relief", hillshade, "number"],
  ["exag", exaggeration, "number"],
  ["sunaz", sunAzimuth, "number"],
  ["sunalt", sunAltitude, "number"],
  ["proj", projectionName, "string"],
  ["country", selected, "string"],
  ["outlines", showOutlines, "bool"],
  ["graticule", showGraticule, "bool"],
  ["ui", uiVisible, "bool"],
  ["waves", waves, "number"],
  ["wavescale", waveScale, "number"],
  ["glint", glint, "number"],
  ["tiles", showTiles, "bool"],
  ["tint", tileTint, "number"],
  ["mosaic", showMosaic, "bool"],
  ["watermask", showWater, "bool"],
  ["watersrc", waterSource, "string"],
  ["waterlevel", waterLevel, "number"],
].map(([key, value, kind]) => ({ key, value, kind, fallback: value() }));

function writeView() {
  if (!viewReady || applyingView) return;

  const params = new URLSearchParams();
  params.set("lon", centreLon().toFixed(7));
  params.set("lat", centreLat().toFixed(7));
  params.set("zoom", camera.zoom.toPrecision(10));
  params.set("px", camera.position.x.toPrecision(10));
  params.set("py", camera.position.y.toPrecision(10));

  for (const { key, value, kind, fallback } of VIEW_PARAMS) {
    const current = value();
    if (current === fallback) continue;
    params.set(key, kind === "bool" ? (current ? "1" : "0") : String(current));
  }

  history.replaceState(null, "", `#${params}`);
}

function writeViewSoon() {
  clearTimeout(viewTimer);
  viewTimer = setTimeout(writeView, 400);
}

function readView() {
  const hash = location.hash.replace(/^#/, "");
  if (!hash) return;

  const params = new URLSearchParams(hash);
  const number = (key) => {
    const value = parseFloat(params.get(key));
    return Number.isFinite(value) ? value : null;
  };

  applyingView = true;
  try {
    for (const { key, value, kind } of VIEW_PARAMS) {
      if (!params.has(key)) continue;
      const raw = params.get(key);
      if (kind === "bool") value.set(raw === "1");
      else if (kind === "number") {
        const parsed = parseFloat(raw);
        if (Number.isFinite(parsed)) value.set(parsed);
      } else value.set(raw);
    }

    const lon = number("lon");
    const lat = number("lat");
    if (lon !== null && lat !== null) setCenter(lon, lat);

    const zoom = number("zoom");
    const px = number("px") ?? 0;
    const py = number("py") ?? 0;
    if (zoom !== null && zoom > 0) camera.zoom = zoom;
    camera.position.set(px, py, 10);
    controls.target.set(px, py, 0);
    camera.updateProjectionMatrix();
    controls.update();
    resetWobble();
  } finally {
    applyingView = false;
  }
}

readView();
viewReady = true;

controls.addEventListener("change", writeViewSoon);
effect(() => {
  centreLon();
  centreLat();
  for (const { value } of VIEW_PARAMS) value();
  writeViewSoon();
});

function updateWobble(now) {
  const dt = Math.min((now - lastFrame) / 1000, 1 / 30);
  lastFrame = now;

  const strength = wobble();
  const anchor = viewAnchor();

  if (strength <= 0) {
    lean.x = lean.y = lean.vx = lean.vy = 0;
    lastAnchor = anchor;
    rasterUniforms.wobbleShift.value.set(0, 0);
    return;
  }

  const omega = 2 * Math.PI * wobbleSpeed();
  const zeta = 1 - 0.88 * wobbleBounce();
  const stiffness = omega * omega;
  const damping = 2 * zeta * omega;

  if (lastAnchor) {
    let du = anchor[0] - lastAnchor[0];
    if (Math.abs(du) > 0.5) du -= Math.sign(du);
    const dv = anchor[1] - lastAnchor[1];

    // A teleport is not a movement.
    const visible = (camera.right - camera.left) / camera.zoom / 360;
    const lurch = visible * 1.5;

    if (Math.abs(du) < lurch && Math.abs(dv) < lurch) {
      const throwIn = 0.035 * omega;
      lean.vx -= du * throwIn;
      lean.vy -= dv * throwIn;
    }
  }
  lastAnchor = anchor;

  lean.vx += (-lean.x * stiffness - lean.vx * damping) * dt;
  lean.vy += (-lean.y * stiffness - lean.vy * damping) * dt;
  lean.x += lean.vx * dt;
  lean.y += lean.vy * dt;

  rasterUniforms.wobbleShift.value.set(lean.x * strength, lean.y * strength);
}

renderer.setAnimationLoop((now) => {
  const stamp = now ?? performance.now();
  rasterUniforms.time.value = stamp / 1000;
  updateWobble(stamp);
  updatePlaneExtent();
  renderer.render(scene, camera);
});
