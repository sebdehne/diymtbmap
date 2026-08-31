// Elevation overlays — pure module (no browser APIs, no maplibre-contour import),
// shared by the React web app (web/src) and the Node test suite (test/elevation.test.ts).
// Mirrors shared/terrain.js: stable ids/constants + map-mutating helpers, with the
// map instance passed in (never imported from the DOM).
//
// Single-source architecture: hillshade AND contour lines both derive from the one
// `dem` raster-dem tileset (built by tools/dem-to-raster-tiles-converter/build-dem.py). No separate contour vector
// tileset is built or served:
//   - hillshade  -> a native MapLibre `hillshade` layer on the `dem` source,
//   - contours   -> computed client-side from the same `dem` tiles by
//                   `maplibre-contour` (DemSource + marching-squares isolines),
//                   which the web app wires up in MapView (the browser-only part).
//
// This module carries the PURE pieces that both the map and the tests share:
// the stable layer/source ids, the per-zoom contour thresholds, and the MapLibre
// layer specs (hillshade + contour lines + elevation labels). The one thing it
// does NOT do is create the `maplibre-contour` DemSource / register its protocol
// / add the contour vector source — that needs the browser + the package and
// lives in MapView. It does, however, expose the exact options the web app passes
// to `DemSource.contourProtocolUrl(...)` (contourProtocolOptions) so the config
// is testable here.
//
// When the `dem` source is absent (a no-DEM deployment) the UI never offers the
// elevation toggle, so nothing here runs and the map is unaffected — the same
// degradation contract as shared/terrain.js.

/** The MapLibre layer id for the native hillshade. */
export const HILLSHADE_ID = "hillshade";

/** The client-side contour vector source id (added by MapView via maplibre-contour). */
export const CONTOUR_SOURCE_ID = "contour-source";

/** The MVT layer inside each maplibre-contour vector tile (carries the isolines). */
export const CONTOUR_LAYER = "contours";

/** The MapLibre line layer id (minor + major contour lines). */
export const CONTOUR_LINES_ID = "contour-lines";

/** The MapLibre symbol layer id (elevation labels on the major lines). */
export const CONTOUR_LABELS_ID = "contour-labels";

/** The feature property maplibre-contour writes for each line's elevation (meters). */
export const ELEVATION_KEY = "ele";

/** The feature property maplibre-contour writes: 0 = minor, 1 = major (index) line. */
export const LEVEL_KEY = "level";

/**
 * Per-zoom contour intervals as `{ zoom: [minor, major] }` (meters). MapView
 * hands these to the maplibre-contour `thresholds` option: at a given zoom,
 * minor lines are drawn every `minor` meters and a bolder major (index) line
 * every `major` meters. Both get finer as you zoom in. The top entry (z11)
 * matches our dem tileset's maxzoom; the source overzooms above it, so the z11
 * intervals (20 m minor / 100 m major) are the finest contours drawn.
 *
 * The major (index) line is the "every Nth" bold line — 100 m at the top zoom,
 * per the spec. The minor line is the fine "regular" line (20 m at the top zoom;
 * 10 m would alias against our ~19 m/px dem tiles, so 20 m is the safe floor).
 */
export const CONTOUR_THRESHOLDS = {
  6: [2000, 10000],
  7: [1000, 5000],
  8: [500, 2500],
  9: [200, 1000],
  10: [100, 500],
  11: [20, 100],
};

/**
 * The exact options the web app hands to `DemSource.contourProtocolUrl(...)`.
 * `multiplier: 1` keeps meters (no feet conversion). The rest name the output
 * MVT layer + properties so the layer specs below agree with what maplibre-contour
 * writes. Exposed as a pure value so tests can assert the contract without a map.
 */
export function contourProtocolOptions() {
  return {
    multiplier: 1,
    thresholds: CONTOUR_THRESHOLDS,
    contourLayer: CONTOUR_LAYER,
    elevationKey: ELEVATION_KEY,
    levelKey: LEVEL_KEY,
  };
}

/** A glyph font stack that exists in the vendored style (see public/ glyph dirs). */
export const CONTOUR_LABEL_FONT = ["Noto Sans Bold"];

/** Contour line colors (traditional brown, readable over the light basemap). */
export const CONTOUR_LINE_COLOR = "rgba(92, 68, 43, 0.55)";
export const CONTOUR_MAJOR_LINE_COLOR = "rgba(92, 68, 43, 0.8)";
export const CONTOUR_LABEL_COLOR = "#5a4632";

/**
 * The native hillshade layer spec on the given `dem` raster-dem source. Subtle
 * relief by default (moderate exaggeration, light from the NW); MapLibre fills
 * in the rest of the hillshade paint properties with its own defaults.
 * `source` defaults to DEM_SOURCE but MapView passes the id the status reports.
 */
export function hillshadeLayerSpec(source) {
  return {
    id: HILLSHADE_ID,
    type: "hillshade",
    source,
    paint: {
      "hillshade-method": "standard",
      "hillshade-illumination-direction": 315,
      "hillshade-illumination-altitude": 45,
      "hillshade-exaggeration": 0.5,
    },
  };
}

/**
 * The contour line layer spec (both minor + major). `line-width`/`line-color`
 * are driven by the maplibre-contour `level` property: major (level 1) is bolder
 * and wider than minor (level 0). `source` is the contour vector source id
 * (CONTOUR_SOURCE_ID by default); MapView passes the id it actually added.
 */
export function contourLineSpec(source = CONTOUR_SOURCE_ID) {
  return {
    id: CONTOUR_LINES_ID,
    type: "line",
    source,
    "source-layer": CONTOUR_LAYER,
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": [
        "match",
        ["get", LEVEL_KEY],
        1,
        CONTOUR_MAJOR_LINE_COLOR,
        CONTOUR_LINE_COLOR,
      ],
      "line-width": ["match", ["get", LEVEL_KEY], 1, 1.25, 0.5],
    },
  };
}

/**
 * The elevation label layer spec: a `symbol` layer placed along the lines,
 * showing each major line's elevation in meters (e.g. "123 m"). Minor lines
 * (level 0) are excluded via the filter. `source` defaults to CONTOUR_SOURCE_ID.
 *
 * The label text is `round` + `to-string` (NOT `number-format`): the
 * elevation is already a whole number of meters, and `number-format` would
 * route it through `Intl.NumberFormat`, which inserts the browser LOCALE's
 * thousands separator (en-US "1,200", de-DE "1.200" — the latter reads as a
 * decimal). `to-string` is locale-proof: "1200 m" in every browser.
 *
 * The halo is a semi-transparent WHITE COLOR (`text-halo-opacity` is NOT a
 * MapLibre property — an unknown paint property makes `addLayer` fail
 * validation and the layer silently never gets added): the 0.85 opacity is
 * carried by the color's alpha channel.
 */
export function contourLabelSpec(source = CONTOUR_SOURCE_ID) {
  return {
    id: CONTOUR_LABELS_ID,
    type: "symbol",
    source,
    "source-layer": CONTOUR_LAYER,
    filter: [">", ["get", LEVEL_KEY], 0],
    layout: {
      "symbol-placement": "line",
      "symbol-spacing": 320,
      "text-size": 11,
      "text-rotation-alignment": "map",
      "text-font": CONTOUR_LABEL_FONT,
      "text-field": ["concat", ["to-string", ["round", ["get", ELEVATION_KEY]]], " m"],
    },
    paint: {
      "text-color": CONTOUR_LABEL_COLOR,
      "text-halo-color": "rgba(255, 255, 255, 0.85)",
      "text-halo-width": 1.25,
    },
  };
}

/** Every elevation-overlay layer id, in draw order (hillshade, then contours). */
export const ELEVATION_LAYER_IDS = Object.freeze([
  HILLSHADE_ID,
  CONTOUR_LINES_ID,
  CONTOUR_LABELS_ID,
]);

/**
 * The "contour lines" feature's layer ids: the lines PLUS their elevation
 * labels — the labels only exist on the major lines, so they are shown and
 * hidden together with the lines.
 */
export const CONTOUR_IDS = Object.freeze([CONTOUR_LINES_ID, CONTOUR_LABELS_ID]);

function setVisibleLayers(map, ids, on) {
  for (const id of ids) {
    if (map && typeof map.getLayer === "function" && map.getLayer(id)) {
      map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    }
  }
}

/**
 * Toggles the hillshade layer visible/none on the map. Safe to call before the
 * layer exists (skipped), so it works both on initial load and on user toggles
 * — the same contract as applyOverlayVisibility in shared/mtb-overlay.js.
 */
export function applyHillshadeVisibility(map, on) {
  setVisibleLayers(map, [HILLSHADE_ID], on);
}

/**
 * Toggles the contour lines feature (lines + elevation labels) visible/none on
 * the map. Safe to call before the layers exist (skipped), the same contract
 * as applyHillshadeVisibility.
 */
export function applyContourVisibility(map, on) {
  setVisibleLayers(map, CONTOUR_IDS, on);
}
