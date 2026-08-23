import { projectionGLSL } from "./projection.js";

export const vertexShader = /* glsl */ `
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

export const fragmentShader = /* glsl */ `
precision highp float;

uniform vec3 color;
uniform float opacity;

out vec4 fragColor;

void main() {
  fragColor = vec4(color, opacity);
}
`;

export const rasterVertexShader = /* glsl */ `
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

export const rasterFragmentShader = /* glsl */ `
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
uniform vec2 resolution;
uniform vec2 center;
uniform float projection;
uniform float opacity;
uniform float hasElevation;
uniform vec4 elevWindow;
uniform float elevationZoom;
uniform sampler2D elevBackstop;
uniform float hasElevBackstop;
uniform float elevBackstopZoom;
uniform float hillshade;
uniform float exaggeration;
uniform float shadows;
uniform float shadowStrength;
uniform float shadowSteps;
uniform sampler2D maxPyramid;
uniform float pyramidLevels;
uniform float terrainMax;
uniform float waterFill;
uniform vec3 waterColor;
uniform sampler2D waterMap;
uniform vec4 waterWindow;
uniform float waterZoom;
uniform float hasWaterMap;
uniform float waterLevel;
uniform vec2 sun;

in vec2 vPlane;
out vec4 fragColor;

${projectionGLSL}

#define EQUATOR_METRES_PER_PIXEL 156543.03392804097

float castShadow(in vec2 local, in float here, in float metres) {
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
      float h = texture(elevation, p).r;
      blocked = max(blocked, (h - here) / (t * metres) - rise);
      t += 1.;
    }
  }

  return smoothstep(0., .12, blocked);
}

float metresPerTexel(in float lat, in float zoom) {
  return EQUATOR_METRES_PER_PIXEL * cos(lat * DEG) / exp2(zoom) / exaggeration;
}

float terrainShade(
  in sampler2D field, in vec2 local, in vec2 texel, in float metres
) {
  float west = texture(field, local - vec2(texel.x, 0.)).r;
  float east = texture(field, local + vec2(texel.x, 0.)).r;
  float north = texture(field, local - vec2(0., texel.y)).r;
  float south = texture(field, local + vec2(0., texel.y)).r;

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

vec2 windowLocal(in vec2 uv, in vec4 win, in float zoom) {
  float side = exp2(zoom);
  vec2 tile = uv * side;
  // Lifted across the antimeridian, where uv wraps and the window does not.
  if (tile.x < win.x) tile.x += side;
  return (tile - win.xy) / win.zw;
}

bool insideWindow(in vec2 local) {
  return all(greaterThanEqual(local, vec2(0.)))
      && all(lessThanEqual(local, vec2(1.)));
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

  vec2 elocal = vec2(-1.);
  bool onElevation = false;

  if (hasElevation > .5) {
    elocal = windowLocal(uv, elevWindow, elevationZoom);
    onElevation = insideWindow(elocal);
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
    vec2 local = windowLocal(uv, detailWindow, detailZoom);

    if (insideWindow(local)) {
      vec4 detail = texture(detailMap, local);

      vec2 edge = min(local, 1. - local);
      // Alpha is coverage: an unlanded tile shows the backstop, not a hole.
      float blend = smoothstep(0., .02, min(edge.x, edge.y)) * detail.a;
      color = mix(color, detail.rgb, blend);
      if (blend > .5) shownZoom = detailZoom;
    }
  }

  float wetness = 0.;

  if (hasWaterMap > .5) {
    vec2 wlocal = windowLocal(uv, waterWindow, waterZoom);

    // Observed mask: flat land and water are alike by height.
    if (insideWindow(wlocal)) wetness = texture(waterMap, wlocal).a;
  }

  float surf = smoothstep(waterLevel, min(waterLevel + .25, 1.), wetness);

  if (surf > 0. && waterFill > .5) {
    color = mix(color, waterColor, surf);
  }

  if (hillshade > 0. && surf <= 0.) {
    if (hasElevation > .5 && onElevation) {
      color *= mix(1., terrainShade(
        elevation,
        elocal,
        1. / (elevWindow.zw * 256.),
        metresPerTexel(lonLat.y, elevationZoom)
      ), hillshade);
    } else if (hasElevBackstop > .5) {
      float side = exp2(elevBackstopZoom);
      color *= mix(1., terrainShade(
        elevBackstop,
        uv,
        vec2(1. / (side * 256.)),
        metresPerTexel(lonLat.y, elevBackstopZoom)
      ), hillshade);
    }
  }

  if (hasElevation > .5 && onElevation) {
    if (shadows > .5 && shadowStrength > 0.) {
      float metres = metresPerTexel(lonLat.y, elevationZoom);

      float here = texture(elevation, elocal).r;
      // Water is at sea level: from the bed the ocean shades itself from its
      // own coast, and seamounts shadow the surface above them.
      if (surf > 0.) here = max(here, 0.);

      float dark = castShadow(elocal, here, metres);
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
