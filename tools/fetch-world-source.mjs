import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const SOURCE =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/" +
  "geojson/ne_10m_admin_0_countries.geojson";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "data", "natural-earth.geojson");

const response = await fetch(SOURCE);
if (!response.ok) {
  console.error(`${SOURCE}\n  HTTP ${response.status}`);
  process.exit(1);
}

const body = Buffer.from(await response.arrayBuffer());
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, body);

const { features } = JSON.parse(body.toString("utf8"));
console.log(
  `${features.length} features, ${(body.length / 1e6).toFixed(1)}MB -> ` +
    path.relative(root, target)
);
