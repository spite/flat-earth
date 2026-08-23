export const PROJECTION = { equirectangular: 0, mercator: 1 };

export const MERCATOR_MAX_LAT = 85.05113;

export const projectionGLSL = /* glsl */ `
#define M_PI 3.1415926535897932384626433832795
#define DEG (M_PI / 180.)
#define RAD (180. / M_PI)
#define MERCATOR_MAX_LAT ${MERCATOR_MAX_LAT}

vec3 lonLatToPoint(in vec2 lonLat) {
  float lon = lonLat.x * DEG;
  float lat = lonLat.y * DEG;
  float r = cos(lat);
  return vec3(sin(lon) * r, sin(lat), -cos(lon) * r);
}

vec2 pointToLonLat(in vec3 p) {
  float lon = (abs(p.x) < 1e-9 && abs(p.z) < 1e-9) ? 0. : atan(p.x, -p.z) * RAD;
  return vec2(lon, asin(clamp(p.y, -1., 1.)) * RAD);
}

vec3 rotateAroundAxis(in vec3 point, in vec3 axis, in float angle) {
  float s = sin(angle);
  float c = cos(angle);
  return point * c + cross(axis, point) * s + axis * dot(axis, point) * (1. - c);
}

vec2 recenter(in vec2 lonLat, in vec2 center) {
  vec3 p = lonLatToPoint(lonLat);
  p = rotateAroundAxis(p, vec3(0., 1., 0.), center.x * DEG);
  p = rotateAroundAxis(p, vec3(1., 0., 0.), -center.y * DEG);
  return pointToLonLat(p);
}

vec2 projectToPlane(in vec2 lonLat, in float mode) {
  if (mode < .5) return lonLat;
  float lat = clamp(lonLat.y, -MERCATOR_MAX_LAT, MERCATOR_MAX_LAT) * DEG;
  return vec2(lonLat.x, asinh(tan(lat)) * RAD);
}

// atan(sinh): the textbook inverse cancels near the equator.
vec2 planeToLonLat(in vec2 xy, in float mode) {
  if (mode < .5) return xy;
  return vec2(xy.x, atan(sinh(xy.y * DEG)) * RAD);
}

vec2 uncenter(in vec2 lonLat, in vec2 center) {
  vec3 p = lonLatToPoint(lonLat);
  p = rotateAroundAxis(p, vec3(1., 0., 0.), center.y * DEG);
  p = rotateAroundAxis(p, vec3(0., 1., 0.), -center.x * DEG);
  return pointToLonLat(p);
}

vec2 lonLatToMosaicUV(in vec2 lonLat) {
  float lat = clamp(lonLat.y, -MERCATOR_MAX_LAT, MERCATOR_MAX_LAT) * DEG;
  float y = asinh(tan(lat));
  return vec2(lonLat.x / 360. + .5, .5 - y / (2. * M_PI));
}
`;

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

function lonLatToPoint(lon, lat) {
  const l = lon * DEG;
  const t = lat * DEG;
  const r = Math.cos(t);
  return [Math.sin(l) * r, Math.sin(t), -Math.cos(l) * r];
}

function pointToLonLat(p) {
  const lon =
    Math.abs(p[0]) < 1e-9 && Math.abs(p[2]) < 1e-9
      ? 0
      : Math.atan2(p[0], -p[2]) * RAD;
  return [lon, Math.asin(Math.max(-1, Math.min(1, p[1]))) * RAD];
}

function rotateAroundAxis(p, axis, angle) {
  const s = Math.sin(angle);
  const c = Math.cos(angle);
  const cross = [
    axis[1] * p[2] - axis[2] * p[1],
    axis[2] * p[0] - axis[0] * p[2],
    axis[0] * p[1] - axis[1] * p[0],
  ];
  const dot = axis[0] * p[0] + axis[1] * p[1] + axis[2] * p[2];
  return [
    p[0] * c + cross[0] * s + axis[0] * dot * (1 - c),
    p[1] * c + cross[1] * s + axis[1] * dot * (1 - c),
    p[2] * c + cross[2] * s + axis[2] * dot * (1 - c),
  ];
}

const AXIS_Y = [0, 1, 0];
const AXIS_X = [1, 0, 0];

export function recenter(lon, lat, center) {
  let p = lonLatToPoint(lon, lat);
  p = rotateAroundAxis(p, AXIS_Y, center.lon * DEG);
  p = rotateAroundAxis(p, AXIS_X, -center.lat * DEG);
  return pointToLonLat(p);
}

export function uncenter(lon, lat, center) {
  let p = lonLatToPoint(lon, lat);
  p = rotateAroundAxis(p, AXIS_X, center.lat * DEG);
  p = rotateAroundAxis(p, AXIS_Y, -center.lon * DEG);
  return pointToLonLat(p);
}

export function projectToPlane(lon, lat, projection) {
  if (projection === PROJECTION.equirectangular) return [lon, lat];
  const clamped =
    Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat)) * DEG;
  return [lon, Math.asinh(Math.tan(clamped)) * RAD];
}

export function planeToLonLat(x, y, projection) {
  if (projection === PROJECTION.equirectangular) return [x, y];
  return [x, Math.atan(Math.sinh(y * DEG)) * RAD];
}

export function lonLatToMosaicUV(lon, lat) {
  const clamped =
    Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat)) * DEG;
  const y = Math.asinh(Math.tan(clamped));
  return [lon / 360 + 0.5, 0.5 - y / (2 * Math.PI)];
}

export function planeHalfHeight(projection) {
  return projection === PROJECTION.equirectangular ? 90 : 180;
}
