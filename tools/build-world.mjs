import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOLERANCE = 0.02; // degrees, ~2.2km at the equator
const PRECISION = 3; // decimal places, ~110m

function sqSegmentDistance(p, a, b) {
  let x = a[0];
  let y = a[1];
  let dx = b[0] - x;
  let dy = b[1] - y;

  if (dx !== 0 || dy !== 0) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = b[0];
      y = b[1];
    } else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }

  dx = p[0] - x;
  dy = p[1] - y;
  return dx * dx + dy * dy;
}

function simplify(points, tolerance) {
  if (points.length <= 2) return points;

  const sqTolerance = tolerance * tolerance;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;

  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxDistance = 0;
    let index = -1;

    for (let i = first + 1; i < last; i++) {
      const d = sqSegmentDistance(points[i], points[first], points[last]);
      if (d > maxDistance) {
        maxDistance = d;
        index = i;
      }
    }

    if (maxDistance > sqTolerance) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }

  return points.filter((_, i) => keep[i]);
}

const CANDIDATES = ["custom.json", "natural-earth.geojson"];

const sourceName = CANDIDATES.find((name) =>
  fs.existsSync(path.join(root, "data", name))
);

if (!sourceName) {
  console.error(
    `no source in data/ -- looked for ${CANDIDATES.join(", ")}\n` +
      "  run: node tools/fetch-world-source.mjs"
  );
  process.exit(1);
}

const sourcePath = path.join(root, "data", sourceName);
const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));

const field = (properties, name) =>
  properties[name] ?? properties[name.toUpperCase()];

const coords = [];
const ringOffsets = [0];
const countries = [];

const round = (v) => Number(v.toFixed(PRECISION));

function addRings(polygons, tolerance) {
  let added = 0;
  for (const polygon of polygons) {
    for (const ring of polygon) {
      const simplified = simplify(ring, tolerance);
      if (simplified.length < 3) continue;

      for (const [lon, lat] of simplified) coords.push(round(lon), round(lat));
      const [lon, lat] = simplified[0];
      coords.push(round(lon), round(lat));

      ringOffsets.push(coords.length / 2);
      added++;
    }
  }
  return added;
}

for (const feature of source.features) {
  const { properties, geometry } = feature;
  const polygons =
    geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;

  const firstRing = ringOffsets.length - 1;

  let ringCount = addRings(polygons, TOLERANCE);
  if (ringCount === 0) ringCount = addRings(polygons, 0);

  if (ringCount === 0) {
    console.warn(`  dropped entirely: ${field(properties, "name")}`);
    continue;
  }

  countries.push({
    id: field(properties, "gu_a3"),
    name: field(properties, "name"),
    lon: round(parseFloat(field(properties, "label_x"))),
    lat: round(parseFloat(field(properties, "label_y"))),
    firstRing,
    ringCount,
  });
}

const world = { coords, ringOffsets, countries };
const out = path.join(root, "data", "world.json");
fs.writeFileSync(out, JSON.stringify(world));

const sourceSize = fs.statSync(sourcePath).size;
const outSize = fs.statSync(out).size;
console.log(
  `${countries.length} countries, ${ringOffsets.length - 1} rings, ` +
    `${coords.length / 2} points`
);
console.log(
  `${sourceName}: ${(sourceSize / 1e6).toFixed(1)}MB -> ` +
    `${(outSize / 1e6).toFixed(2)}MB`
);
