// A throttled response often has no CORS header, so no status.

const NEXTZEN_KEY = "rhDVUtyIRRWM3Umq0oELJw";

export const colorProviders = {
  "Esri satellite": Object.assign(
    (x, y, z) =>
      `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    { maxZoom: 19, attribution: "Esri, Maxar, Earthstar Geographics" }
  ),
  "Sentinel-2 cloudless": Object.assign(
    (x, y, z) =>
      `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/GoogleMapsCompatible/${z}/${y}/${x}.jpg`,
    { maxZoom: 16, attribution: "Sentinel-2 cloudless 2020 by EOX IT Services" }
  ),
  "Blue Marble": Object.assign(
    (x, y, z) =>
      `https://gitc.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/2004-01-01/GoogleMapsCompatible_Level8/${z}/${y}/${x}.jpeg`,
    { maxZoom: 8, attribution: "NASA EOSDIS GIBS" }
  ),
  "Esri physical": Object.assign(
    (x, y, z) =>
      `https://server.arcgisonline.com/ArcGIS/rest/services/World_Physical_Map/MapServer/tile/${z}/${y}/${x}`,
    { maxZoom: 8, attribution: "Esri, US National Park Service" }
  ),
  "Esri shaded relief": Object.assign(
    (x, y, z) =>
      `https://server.arcgisonline.com/ArcGIS/rest/services/World_Shaded_Relief/MapServer/tile/${z}/${y}/${x}`,
    { maxZoom: 13, attribution: "Esri" }
  ),
  "Esri ocean": Object.assign(
    (x, y, z) =>
      `https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/${z}/${y}/${x}`,
    { maxZoom: 16, attribution: "Esri, GEBCO, NOAA, National Geographic" }
  ),
  "Carto light": Object.assign(
    (x, y, z) => `https://basemaps.cartocdn.com/light_all/${z}/${x}/${y}.png`,
    { maxZoom: 20, attribution: "CARTO, OpenStreetMap contributors" }
  ),
  "Carto dark": Object.assign(
    (x, y, z) => `https://basemaps.cartocdn.com/dark_all/${z}/${x}/${y}.png`,
    { maxZoom: 20, attribution: "CARTO, OpenStreetMap contributors" }
  ),
  "Esri dark grey": Object.assign(
    (x, y, z) =>
      `https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/${z}/${y}/${x}`,
    { maxZoom: 16, attribution: "Esri, HERE, Garmin" }
  ),
  "Esri NatGeo": Object.assign(
    (x, y, z) =>
      `https://server.arcgisonline.com/ArcGIS/rest/services/NatGeo_World_Map/MapServer/tile/${z}/${y}/${x}`,
    { maxZoom: 16, attribution: "Esri, National Geographic" }
  ),

  "NASA true colour": Object.assign(
    (x, y, z) => gibs("MODIS_Terra_CorrectedReflectance_TrueColor", "2024-06-01", 9, "jpg", x, y, z),
    { maxZoom: 9, attribution: "NASA EOSDIS GIBS, MODIS Terra" }
  ),
  "NASA night lights": Object.assign(
    (x, y, z) => gibs("VIIRS_CityLights_2012", "2012-01-01", 8, "jpg", x, y, z),
    { maxZoom: 8, attribution: "NASA EOSDIS GIBS, VIIRS" }
  ),
  "NASA sea surface temp": Object.assign(
    (x, y, z) => gibs("GHRSST_L4_MUR_Sea_Surface_Temperature", "2024-06-01", 7, "png", x, y, z),
    { maxZoom: 7, attribution: "NASA EOSDIS GIBS, GHRSST MUR" }
  ),
  "NASA land temp": Object.assign(
    (x, y, z) => gibs("MODIS_Terra_Land_Surface_Temp_Day", "2024-06-01", 7, "png", x, y, z),
    { maxZoom: 7, attribution: "NASA EOSDIS GIBS, MODIS Terra" }
  ),
  "NASA snow cover": Object.assign(
    (x, y, z) => gibs("MODIS_Terra_NDSI_Snow_Cover", "2024-02-01", 8, "png", x, y, z),
    { maxZoom: 8, attribution: "NASA EOSDIS GIBS, MODIS Terra" }
  ),

  "GEBCO bathymetry": Object.assign(
    (x, y, z) =>
      `https://wms.gebco.net/mapserv?request=getmap&service=wms&crs=EPSG:3857` +
      `&format=image/png&layers=gebco_latest&width=256&height=256&version=1.3.0` +
      `&bbox=${tileBBox(x, y, z)}`,
    { maxZoom: 9, attribution: "GEBCO Compilation Group" }
  ),

  "Water: JRC occurrence": Object.assign(
    (x, y, z) =>
      `https://storage.googleapis.com/global-surface-water/tiles2021/occurrence/${z}/${x}/${y}.png`,
    { maxZoom: 12, attribution: "EC JRC / Google, Global Surface Water" }
  ),
  "Water: JRC change": Object.assign(
    (x, y, z) =>
      `https://storage.googleapis.com/global-surface-water/tiles2021/transitions/${z}/${x}/${y}.png`,
    { maxZoom: 12, attribution: "EC JRC / Google, Global Surface Water" }
  ),
  "Labels: Esri ocean": Object.assign(
    (x, y, z) =>
      `https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Reference/MapServer/tile/${z}/${y}/${x}`,
    { maxZoom: 16, attribution: "Esri, GEBCO, NOAA" }
  ),
  "Labels: Esri places": Object.assign(
    (x, y, z) =>
      `https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/${z}/${y}/${x}`,
    { maxZoom: 16, attribution: "Esri, HERE, Garmin" }
  ),
  "Labels: OpenSeaMap": Object.assign(
    (x, y, z) => `https://tiles.openseamap.org/seamark/${z}/${x}/${y}.png`,
    { maxZoom: 18, attribution: "OpenSeaMap, OpenStreetMap contributors" }
  ),
};

const WEB_MERCATOR_HALF = 20037508.342789244;

function tileBBox(x, y, z) {
  const span = (2 * WEB_MERCATOR_HALF) / 2 ** z;
  const minX = -WEB_MERCATOR_HALF + x * span;
  const maxY = WEB_MERCATOR_HALF - y * span;
  return `${minX},${maxY - span},${minX + span},${maxY}`;
}

function gibs(layer, date, level, format, x, y, z) {
  return (
    `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/${date}` +
    `/GoogleMapsCompatible_Level${level}/${z}/${y}/${x}.${format}`
  );
}

export const waterProviders = {
  "JRC surface water": Object.assign(
    (x, y, z) =>
      `https://storage.googleapis.com/global-surface-water/tiles2021/occurrence/${z}/${x}/${y}.png`,
    { maxZoom: 12, attribution: "EC JRC / Google, Global Surface Water" }
  ),
  "JRC water change": Object.assign(
    (x, y, z) =>
      `https://storage.googleapis.com/global-surface-water/tiles2021/transitions/${z}/${x}/${y}.png`,
    { maxZoom: 12, attribution: "EC JRC / Google, Global Surface Water" }
  ),
};

export const elevationProviders = {
  "AWS terrain": Object.assign(
    (x, y, z) =>
      `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`,
    { maxZoom: 15, attribution: "AWS Open Data, Tilezen, USGS, NASA" }
  ),
  Nextzen: Object.assign(
    (x, y, z) =>
      `https://tile.nextzen.org/tilezen/terrain/v1/256/terrarium/${z}/${x}/${y}.png?api_key=${NEXTZEN_KEY}`,
    { maxZoom: 14, attribution: "Nextzen, USGS, NASA" }
  ),
};
