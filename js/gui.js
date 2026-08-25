import { GUI } from "../third_party/guspira/guspira.min.js";
import {
  colorProviders,
  elevationProviders,
  waterProviders,
} from "./tile-providers.js";
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

export function buildGui({ countries, byName, setCenter, counters }) {
  const {
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
  } = counters;

  const gui = new GUI("Flat Earth", document.querySelector("#gui"), {
    storageKey: "flat-earth",
  });

  gui.addElement(document.querySelector("#ui"));

  gui.addSection("Projection");
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
          setCenter(country.lon, country.lat);
      },
    }
  );
  gui.addCheckbox("Country outlines", showOutlines);
  gui.addCheckbox("Graticule", showGraticule);
  gui.addButton("Reset to 0°, 0°", () => {
    selected.set(NONE);
    setCenter(0, 0);
  });
  gui.addSegmented("Unroll", projectionName, ["mercator", "equirectangular"], {
    title:
      "Mercator keeps shapes true and cannot reach the poles; equirectangular " +
      "keeps distance true along the line through the centre, and can.",
  });

  gui.addSection("Imagery");
  gui.addSelect("Source", imagerySource, ["none", ...Object.keys(colorProviders)]);


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

  gui.addSlider("Shading strength", hillshade, 0, 1, 0.01, {
    ...whileShaded,
    title:
      "How strongly the hillshade is drawn. It does not change the terrain, " +
      "so it does not change the shadows -- exaggeration does that.",
  });
  gui.addSlider("Exaggeration", exaggeration, 1, 20, 0.5, {
    ...whileRelief,
    title:
      "At world scale true slopes are too gentle to read. This is the one " +
      "control that changes the terrain, so it sets shadow length too.",
  });
  gui.addSlider("Sun azimuth", sunAzimuth, 0, 360, 1, whileRelief);
  gui.addCheckbox("Cast shadows", castShadows, {
    ...whileShaded,
    title: "March the heightfield toward the sun, so terrain shadows what is behind it",
  });
  const whileShadowing = { disabledWhen: () => !terrain() || !castShadows() };
  gui.addSlider("Shadow strength", shadowStrength, 0, 1, 0.01, {
    ...whileShadowing,
    title: "How dark shadowed ground goes. Independent of shading strength.",
  });
  gui.addSlider("Shadow softness", shadowSoftness, 0, 1, 0.01, {
    ...whileShadowing,
    title:
      "The sun as a disc rather than a point. Four rays scattered across it\n" +
      "and averaged, so the penumbra widens with distance from the caster.",
  });
  gui.addSlider("Shadow steps", shadowSteps, 16, 192, 8, {
    ...whileShadowing,
    title: "Samples along the march. More is smoother at the same reach, and costs more.",
  });
  gui.addSlider("Sun altitude", sunAltitude, 5, 90, 1, whileRelief);

  gui.addSection("Water");
  gui.addSelect("Mask", waterSource, ["none", ...Object.keys(waterProviders)], {
    title: "Observed water, from Landsat. A heightfield cannot tell flat land from water.",
  });
  gui.addSlider("Mask threshold", waterLevel, 0.05, 0.95, 0.01, {
    disabledWhen: () => waterSource() === "none",
    title: "How much water presence counts as water",
  });
  gui.addCheckbox("Fill", waterFill, {
    title: "Paint everything the mask calls water a flat colour",
  });
  const whileFilled = { disabledWhen: () => !waterFill() };
  gui.addColor("Tint", waterTint, whileFilled);

  const diagnostics = gui.addSection("Diagnostics", { open: false });
  gui.addCheckbox("Window layer", autoDetail, {
    title: "Off falls back to the whole-world backstop, which is deliberately coarse",
  });
  gui.addCheckbox("Show tiles", showTiles, {
    title: "Colour and outline each tile, to see the grid and where the window sits",
  });
  gui.addSlider("Tile tint", tileTint, 0, 1, 0.01, {
    disabledWhen: () => !showTiles(),
  });
  gui.addCheckbox("Show raw mosaic", showMosaic, {
    title: "Draw the window unprojected, to tell a compositing fault from a sampling one",
  });

  gui.addSection("Performance");
  const whileVisible = { pausedWhen: () => !uiVisible() };
  gui.addGraph("Frame ms", [submitTime, otherTime], {
    ...whileVisible,
    min: 0,
    max: 50,
    over: 16.7,
    samples: 180,
    title:
      "Where the frame goes. 'submit' is main-thread time inside " +
      "renderer.render; 'other' is GPU, compositing and anything that ran " +
      "between frames.",
  });
  gui.addMonitor("FPS", fps, {
    format: (v) => v.toFixed(0),
    below: 30,
  });
  gui.addMonitor("CPU submit", cpuSubmit, {
    format: (v) => `${v.toFixed(1)} ms`,
    title:
      "Main-thread time inside renderer.render. GPU work runs after it returns, " +
      "so this is not the cost of drawing a frame.",
  });
  gui.addGraph("Tiles pending", [imageryPending, terrainPending, waterPending], {
    ...whileVisible,
    min: 0,
    samples: 180,
    title: "Outstanding tile fetches, by layer -- which one is the long pole",
  });
  gui.addMonitor("Pyramid build", pyramidTime, {
    format: (v) => (v ? `${v.toFixed(0)} ms` : "—"),
    title:
      "Rebuilding the shadow march's max pyramid, once per settle, " +
      "round trip through the worker",
  });
  gui.addMonitor("Draw calls", drawCalls, { format: (v) => v.toFixed(0) });
  gui.addMonitor("Textures", textureCount, { format: (v) => v.toFixed(0) });

  gui.addSection("Map data");
  gui.addElement(document.querySelector("#readout"));

  // guspira persists both of these on first run, after which its own defaults
  // are never consulted again -- so they have to be set, not declared.
  if (window.matchMedia("(max-width: 950px)").matches) {
    gui.rowsExpanded.set(false);
  }

  diagnostics.setOpen(false);

  return gui;
}
