import { signal } from "../third_party/guspira/guspira.min.js";

export const NONE = "—";

export const projectionName = signal("mercator");
export const centreLon = signal(0);
export const centreLat = signal(0);
export const selected = signal(NONE);
export const showGraticule = signal(false);
export const showOutlines = signal(false);
export const uiVisible = signal(true);

export const imagerySource = signal("Esri satellite");
export const imageryOpacity = signal(1);
export const autoDetail = signal(true);

export const terrain = signal(true);
export const elevationSource = signal("AWS terrain");
export const hillshade = signal(0);
export const exaggeration = signal(20);
export const sunAzimuth = signal(324);
export const sunAltitude = signal(25);
export const castShadows = signal(true);
export const shadowStrength = signal(0.55);
export const shadowSteps = signal(192);
export const shadowSoftness = signal(0.35);

export const waterSource = signal("JRC surface water");
export const waterLevel = signal(0.35);
export const waterFill = signal(true);
export const waterTint = signal("#ffffff");

export const showTiles = signal(false);
export const tileTint = signal(0.5);
export const showMosaic = signal(false);

export const worldError = signal("");
