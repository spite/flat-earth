import {
  BoxGeometry,
  Mesh,
  MeshNormalMaterial,
  Scene,
  WebGLRenderer,
  Vector3,
  BufferGeometry,
  Line,
  LineBasicMaterial,
  RawShaderMaterial,
  GLSL3,
  sRGBEncoding,
  AdditiveBlending,
  Vector2,
  Color,
  TextureLoader,
  PerspectiveCamera,
} from "three";
import { MeshLine, MeshLineMaterial } from "meshline";
import { OrbitControls } from "orbitcontrols";
import * as dat from "../third_party/dat.gui.module.js";

const params = {
  alpha: 0,
  beta: 0,
};

const gui = new dat.gui.GUI();

gui.remember(params);

gui.add(params, "alpha").min(-180).max(180).step(0.0001);
gui.add(params, "beta").min(-180).max(180).step(0.0001);

const scene = new Scene();
const camera = new PerspectiveCamera(55, 1, 0.001, 1000);

const vertexShader = `
in vec3 position;

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;

uniform float alpha;
uniform float beta;

#define M_PI 3.1415926535897932384626433832795
#define M_TAU (2. * M_PI)

mat3 rotation3dX(float angle) {
  float s = sin(angle);
  float c = cos(angle);

  return mat3(
    1.0, 0.0, 0.0,
    0.0, c, s,
    0.0, -s, c
  );
}

vec3 rotateAroundAxis(in vec3 point, in vec3 axis, in float angle) {
  float s = sin(angle);
  float c = cos(angle);
  return point * c + cross(axis, point) * s + axis * dot(axis, point) * (1. - c);
}

vec3 latLngToPoint(in vec2 latLng) {
  float phi = latLng.x * M_PI / 180.;// + M_PI;
  float theta = latLng.y * M_PI / 180.;// + M_PI / 2.;
  float r = 100.;
  float x = r * sin(theta) * cos(phi);
  float y = r * sin(theta) * sin(phi);
  float z = r * cos(theta);

  y = sin(theta);
	r = cos(theta);
	x = sin(phi) * r;
	z = -cos(phi) * r;

  return vec3(x, y, z);
  // mat3 rot = rotation3dX(M_PI/2.);
  // return rot * vec3(-x, y, z);
}

float atan2(in float y, in float x){
  bool s = (abs(x) > abs(y));
  return mix(M_PI/2.0 - atan(x,y), atan(y,x), s);
}

vec2 pointToLatLng(in vec3 p) {
  float r = length(p);
  float lon = atan2(p.x, -p.z);
	float lat = asin(p.y);
  if(lon>=M_PI) lon -= M_TAU;
  if(lon<=-M_PI) lon += M_TAU;
  return vec2( lon * 180. / M_PI , lat * 180. / M_PI);
}

void main() {
  // vec3 point = position;
  // gl_Position  = projectionMatrix * modelViewMatrix * vec4(position.xy, 0., 1.);
  vec3 point = latLngToPoint(position.xy);

  vec3 rotated = rotateAroundAxis(point, vec3(0.,1.,0.), beta * M_PI / 180.);
  rotated = rotateAroundAxis(rotated, vec3(1.,0.,0.), alpha * M_PI / 180.);
  
  // gl_Position  = projectionMatrix * modelViewMatrix * vec4(point, 1.);
  vec2 coords = pointToLatLng(rotated);
  gl_Position  = projectionMatrix * modelViewMatrix * vec4(coords.xy, 0., 1.);
}
`;

const fragmentShader = `
precision highp float;

out vec4 color;

void main() {
  color = vec4(1.,1.,1.,1.);
}`;

const material = new LineBasicMaterial();

const projMaterial = new RawShaderMaterial({
  uniforms: { alpha: { value: 0 }, beta: { value: 0 } },
  fragmentShader,
  vertexShader,
  glslVersion: GLSL3,
  // depthTest: false,
  // blending: AdditiveBlending,
  // transparent: true,
});

const renderer = new WebGLRenderer({ antialias: true });
renderer.setClearColor(0x202020);
renderer.outputEncoding = sRGBEncoding;
renderer.physicallyCorrectLights = true;
document.body.appendChild(renderer.domElement);

const mesh = new Mesh(new BoxGeometry(50, 50, 50), new MeshNormalMaterial());
// scene.add(mesh);

camera.position.set(0, 0, 1).normalize().multiplyScalar(300);

const orbitControls = new OrbitControls(camera, renderer.domElement);
// orbitControls.minDistance = 0.2;
// orbitControls.maxDistance = 1.5;
// orbitControls.enableDamping = true;

function render() {
  // material.uniforms.alpha.value = params.alpha;
  // material.uniforms.beta.value = params.beta;
  renderer.render(scene, camera);
  renderer.setAnimationLoop(render);
}

function resize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
}

window.addEventListener("resize", resize);

resize();
render();

// https://gadm.org/download_country.html

async function getCountry(id) {
  const url = `https://nominatim.openstreetmap.org/search?country=${id}&polygon_geojson=1&format=json`;
  const res = await fetch(url);
  const data = await res.json();
  return data;
}

async function getCountries() {
  const url = `data/custom.json`;
  const res = await fetch(url);
  const data = await res.json();
  const countries = {};
  for (const feature of data.features) {
    const id = feature.properties.gu_a3;
    if (countries[id]) {
      debugger;
    }
    countries[id] = feature;
  }
  return countries;
}

function makeLine(points) {
  const lineMaterial = new MeshLineMaterial({
    lineWidth: 0.2,
    color: new Color(255, 255, 255),
    sizeAttenuation: true,
    borderWidth: 0,
    // wireframe: true,
    resolution: new Vector2(window.innerWidth, window.innerHeight),
  });
  const trail = new MeshLine();
  trail.setPoints(points);
  const line = new Mesh(trail, lineMaterial);

  line.frustumCulled = false;
  scene.add(line);
}

const PI = Math.PI;
const TAU = 2 * Math.PI;

// function pointToLatLng(p) {
//   const r = p.length();
//   const lon = Math.atan2(p.x, -p.z);
//   const lat = Math.asin(p.y);
//   if (lon >= Math.PI) lon -= TAU;
//   if (lon <= -Math.PI) lon += TAU;
//   return vec2((lon * 180) / Math.PI, (lat * 180) / Math.PI);
// }

function latLngToPoint(coord) {
  const phi = (coord.x * PI) / 180; // + PI;
  const theta = (coord.y * PI) / 180; // + PI / 2.;
  let r = 100;
  let x = r * Math.sin(theta) * Math.cos(phi);
  let y = r * Math.sin(theta) * Math.sin(phi);
  let z = r * Math.cos(theta);

  y = Math.sin(theta);
  r = Math.cos(theta);
  x = Math.sin(phi) * r;
  z = -Math.cos(phi) * r;

  return new Vector3(-x, y, z).multiplyScalar(100);
  // mat3 rot = rotation3dX(M_PI/2.);
  // return rot * vec3(-x, y, z);
}

function reproject(p) {}

const loader = new TextureLoader();
const stroke = loader.load("../assets/PaintBrushStroke05.png");

function buildMeshLine(line) {
  const lineMaterial = new MeshLineMaterial({
    lineWidth: Math.random() * 0.2 + 0.8,
    // repeat: new Vector2(200, 1),
    // map: stroke,
    // useMap: true,
    // blending: AdditiveBlending,
    // depthTest: false,
    transparent: true,
    color: new Color().setHSL(
      0.8 + 0.4 * Math.random(),
      0.4 + 0.2 * Math.random(),
      0.4 + 0.2 * Math.random()
    ),
    sizeAttenuation: true,
    // sizeAttenuation: false,
    // wireframe: true,
    resolution: new Vector2(window.innerWidth, window.innerHeight),
  });

  const points = [];
  for (let i = 0; i < line.length; i++) {
    const a = latLngToPoint(new Vector3(line[i][0], line[i][1], 0));
    points.push(a);
  }
  points.push(points[0].clone());

  const trail = new MeshLine();
  trail.setPoints(points, (t) => 0.6 + 0.4 * Math.sin(t * 100));
  const mesh = new Mesh(trail, lineMaterial);

  mesh.frustumCulled = false;
  scene.add(mesh);
}

function countryToMeshLine(id) {
  while (scene.children.length) {
    // scene.remove(child);
  }

  const data = countries[id];

  if (data.geometry.coordinates.length === 1) {
    const line = data.geometry.coordinates[0];
    buildMeshLine(line);
  } else {
    for (const objects of data.geometry.coordinates) {
      for (const line of objects) {
        buildMeshLine(line);
      }
    }
  }
}

function buildLine(line) {
  const points = [];
  for (let i = 0; i < line.length; i++) {
    const a = latLngToPoint(new Vector3(line[i][0], line[i][1], 0));
    points.push(a);
  }
  points.push(points[0].clone());

  const geometry = new BufferGeometry().setFromPoints(points);
  const mesh = new Line(geometry, material);
  mesh.frustumCulled = false;
  scene.add(mesh);
}

async function loadCountry(id) {
  while (scene.children.length) {
    scene.remove(scene.children[0]);
  }

  const data = countries[id];
  const center = new Vector3(
    0, //parseFloat(data.properties.label_x),
    0, //(Math.random() * 1 - 0.5) * 10,
    0 //parseFloat(data.properties.label_y)
  );

  // console.log(data.properties.label_x, data.properties.label_y);
  // params.beta = data.properties.label_x;
  // params.alpha = data.properties.label_y;

  if (data.geometry.coordinates.length === 1) {
    const line = data.geometry.coordinates[0];
    buildLine(line);
  } else {
    for (const objects of data.geometry.coordinates) {
      for (const line of objects) {
        buildLine(line);
      }
    }
  }
}

const countries = await getCountries();
const select = document.createElement("select");
for (const key of Object.keys(countries)) {
  const country = countries[key];
  const option = document.createElement("option");
  option.value = key;
  option.textContent = country.properties.name;
  select.append(option);
  // countryToMeshLine(key);
}
select.addEventListener("change", async (e) => {
  const id = e.target.value;
  const data = countries[id];
  console.log(id, data.properties.label_x, data.properties.label_y);
  params.beta = data.properties.label_x;
  params.alpha = -data.properties.label_y;
  await loadCountry(e.target.value);
  // countryToMeshLine(e.target.value);
});
const ui = document.querySelector("#ui");
ui.append(select);

// loadCountry("GBR");
