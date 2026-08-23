// Faults that neither `node --check` nor the browser reports, and that have
// each happened here: a backtick inside a GLSL comment, a uniform left
// unset, a #define read from JS. Run: node tools/check.mjs

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
const notes = [];

const THREE_BUILTINS = new Set([
  "modelMatrix",
  "modelViewMatrix",
  "projectionMatrix",
  "viewMatrix",
  "normalMatrix",
  "cameraPosition",
  "isOrthographic",
]);

const SHADERS = /const (\w+) = \/\* glsl \*\/ `([\s\S]*?)\n`;/g;

function jsFiles() {
  const out = [];
  for (const dir of ["js", "tools"]) {
    for (const name of readdirSync(join(root, dir))) {
      if (name.endsWith(".js") || name.endsWith(".mjs")) out.push(join(dir, name));
    }
  }
  return out;
}

function stripShaders(source) {
  return source.replace(/\/\* glsl \*\/ `[\s\S]*?\n`;/g, '""');
}

for (const file of jsFiles()) {
  try {
    execFileSync(process.execPath, ["--check", join(root, file)], { stdio: "pipe" });
  } catch (error) {
    problems.push(`${file}: does not parse\n    ${String(error.stderr).trim().split("\n")[0]}`);
  }
}

const main = readFileSync(join(root, "js/main.js"), "utf8");
const shaderSource = readFileSync(join(root, "js/shaders.js"), "utf8");
const shaders = [...shaderSource.matchAll(SHADERS)];
const mainJs = stripShaders(main);

if (shaders.length === 0) problems.push("js/shaders.js: found no GLSL templates to check");

for (const [, name, body] of shaders) {
  const open = (body.match(/{/g) || []).length;
  const close = (body.match(/}/g) || []).length;
  if (open !== close) {
    problems.push(`${name}: ${open} '{' against ${close} '}' -- unbalanced`);
  }
  if (body.includes("`")) {
    problems.push(`${name}: contains a backtick, which closes the template literal early`);
  }
}

const uniformsAt = main.indexOf("const rasterUniforms = {");
if (uniformsAt === -1) {
  problems.push("js/main.js: no rasterUniforms object found");
} else {
  const block = main.slice(uniformsAt);
  const body = block.slice(0, block.indexOf("\n};"));
  const declared = [...body.matchAll(/^  ([A-Za-z0-9_]+)\s*[:,]/gm)].map((m) => m[1]);
  const shared = new Set(
    [...body.matchAll(/^  ([A-Za-z0-9_]+)\s*,/gm)].map((m) => m[1])
  );

  const table = main.slice(main.indexOf("const UNIFORM_BINDINGS = ["));
  const bound = new Set(
    [...table.slice(0, table.indexOf("\n];")).matchAll(/^  \["(\w+)"/gm)].map((m) => m[1])
  );

  for (const name of declared) {
    const written =
      bound.has(name) ||
      new RegExp(`rasterUniforms\\.${name}\\b`).test(mainJs) ||
      (shared.has(name) && new RegExp(`(?<![.\\w])${name}\\.value\\b`).test(mainJs));
    if (!written) {
      problems.push(`rasterUniforms.${name}: declared but never assigned -- it keeps its initial value forever`);
    }
  }

  const rasterSource = shaders
    .filter(([, name]) => name.startsWith("raster"))
    .map(([, , body]) => body)
    .join("\n");
  const used = new Set(
    [...rasterSource.matchAll(/^uniform\s+\w+\s+(\w+)\s*;/gm)].map((m) => m[1])
  );
  for (const name of used) {
    if (!declared.includes(name) && !THREE_BUILTINS.has(name)) {
      problems.push(`uniform ${name}: read by the shader with nothing in rasterUniforms to set it`);
    }
  }
  notes.push(
    `${declared.length} raster uniforms, ${used.size} read by the shaders, ` +
      `${bound.size} bound by table`
  );
}

const glsl = shaders.map(([, , body]) => body).join("\n");
const projection = readFileSync(join(root, "js/projection.js"), "utf8");
const defines = [...`${glsl}\n${projection}`.matchAll(/^#define\s+([A-Z][A-Z0-9_]*)/gm)].map((m) => m[1]);

const imported = new Set(
  [...main.matchAll(/import\s*{([^}]*)}\s*from/g)]
    .flatMap((m) => m[1].split(","))
    .map((part) => part.split(" as ").pop().trim())
);

for (const name of new Set(defines)) {
  const usedInJs = new RegExp(`(?<![.\\w])${name}\\b`).test(mainJs);
  const declaredInJs =
    imported.has(name) || new RegExp(`(?:const|let|var)\\s+${name}\\b`).test(mainJs);
  if (usedInJs && !declaredInJs) {
    problems.push(`${name}: a GLSL #define used from JS, where it does not exist`);
  }
}

notes.push(`${shaders.length} shader templates, ${jsFiles().length} modules`);

for (const note of notes) console.log(`  ${note}`);
if (problems.length === 0) {
  console.log("ok");
  process.exit(0);
}
console.error(`\n${problems.length} problem${problems.length === 1 ? "" : "s"}:`);
for (const problem of problems) console.error(`  ${problem}`);
process.exit(1);
