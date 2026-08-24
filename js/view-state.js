import {
  autoDetail,
  castShadows,
  centreLat,
  centreLon,
  elevationSource,
  exaggeration,
  hillshade,
  imagerySource,
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
} from "./signals.js";

// One table, so a signal cannot be added without persisting it.
const PARAMS = [
  ["img", imagerySource, "string"],
  ["detail", autoDetail, "bool"],
  ["shadows", castShadows, "bool"],
  ["shadowstr", shadowStrength, "number"],
  ["shadowsteps", shadowSteps, "number"],
  ["shadowsoft", shadowSoftness, "number"],
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
  ["tiles", showTiles, "bool"],
  ["tint", tileTint, "number"],
  ["mosaic", showMosaic, "bool"],
  ["waterfill", waterFill, "bool"],
  ["watertint", waterTint, "string"],
  ["watersrc", waterSource, "string"],
  ["waterlevel", waterLevel, "number"],
].map(([key, value, kind]) => ({ key, value, kind, fallback: value() }));

export function createViewState({ camera, controls, setCenter }) {
  let ready = false;
  let applying = false;
  let timer = null;

  function write() {
    if (!ready || applying) return;

    const params = new URLSearchParams();
    params.set("lon", centreLon().toFixed(7));
    params.set("lat", centreLat().toFixed(7));
    params.set("zoom", camera.zoom.toPrecision(10));
    params.set("px", camera.position.x.toPrecision(10));
    params.set("py", camera.position.y.toPrecision(10));

    for (const { key, value, kind, fallback } of PARAMS) {
      const current = value();
      if (current === fallback) continue;
      params.set(key, kind === "bool" ? (current ? "1" : "0") : String(current));
    }

    history.replaceState(null, "", `#${params}`);
  }

  function read() {
    const hash = location.hash.replace(/^#/, "");
    if (!hash) return;

    const params = new URLSearchParams(hash);
    const number = (key) => {
      const value = parseFloat(params.get(key));
      return Number.isFinite(value) ? value : null;
    };

    applying = true;
    try {
      for (const { key, value, kind } of PARAMS) {
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
    } finally {
      applying = false;
    }
  }

  return {
    params: PARAMS,
    readView: read,
    writeViewSoon() {
      clearTimeout(timer);
      timer = setTimeout(write, 400);
    },
    // Window layers wait on this, or they load the default view then the
    // URL's and throw the first away.
    isReady: () => ready,
    markReady() {
      ready = true;
    },
  };
}
