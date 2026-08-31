// 3D terrain — pure module (no browser APIs), shared by the React web app
// (web/src) and the Node test suite (test/dem.test.ts). Mirrors
// shared/mtb-overlay.js: carries the stable ids/constants and the map-mutating
// helpers, with the map instance passed in (never imported from the DOM).
//
// The optional dem tileset (built by tools/dem/build-dem.py) is a `raster-dem`
// MBTiles source: image/png tiles whose RGB channels pack elevation (encoding
// "mapbox" by default, 512 px). The app serves it as source id "dem"
// (dem.mbtiles -> "dem") and injects it into the served style ONLY when the
// artifact is present. MapLibre 3D terrain reads elevation exclusively from a
// `raster-dem` source:
//   - map.setTerrain({ source: "dem", exaggeration }) enables it,
//   - map.setTerrain(null) disables it (restores the flat basemap).
//
// When the dem source is absent (a no-DEM deployment) the UI never offers the
// toggle, so the map is unaffected — this module is then simply unused.

/** The Martin tile source id the style + terrain use (dem.mbtiles -> "dem"). */
export const DEM_SOURCE = "dem";

/**
 * The raster-dem packing the artifact uses. "mapbox" is the converter default
 * (and MapLibre's own default); "terrarium" is the sub-mm alternative. The
 * served status snapshot carries the value the artifact actually uses, so the
 * UI should prefer that over this constant (this is the fallback).
 */
export const DEM_ENCODING = "mapbox";

/**
 * Default vertical exaggeration for 3D terrain (1 = true scale; >1 exaggerates
 * relief so gentle terrain reads as 3D). The plan's default is 1.5×.
 */
export const DEFAULT_TERRAIN_EXAGGERATION = 1.5;

/**
 * Applies the 3D-terrain toggle to the map: when `on`, enables MapLibre 3D
 * terrain on the `dem` source with the given (or default) vertical
 * exaggeration; when `off`, disables it (restoring the flat basemap).
 *
 * A non-finite / non-positive exaggeration falls back to the default so the
 * map never gets an invalid `exaggeration`. Safe to call when `map` is not yet
 * ready (a no-op), the same contract as applyOverlayVisibility in
 * shared/mtb-overlay.js. The UI only offers the toggle when the served status
 * snapshot reports a `dem` source, so by the time this runs the source exists;
 * the `source` id defaults to DEM_SOURCE but the web app passes the id the
 * status reports (it follows DEM_MBTILES_FILE, e.g. "terrain-7").
 *
 * Readiness: MapLibre's setTerrain throws "Style is not done loading." until
 * the style DOCUMENT has loaded — the layers panel's first effect runs before
 * the `load` event, so we swallow exactly that error and treat the call as a
 * no-op: MapView re-applies the persisted state on `load`, and a user click
 * always runs against a loaded style.
 *
 * Deliberately NOT guarded on map.isStyleLoaded(): that checks Style.loaded(),
 * which is also false while ANY source update is pending — true for the whole
 * window of the MapView load handler, because addLayer / setLayoutProperty /
 * setPaintProperty each queue a source reload (Style._updatedSources). Yet
 * setTerrain itself only needs the style document, so an isStyleLoaded() guard
 * would no-op exactly the initial-load apply this function exists for (the
 * "3D enabled but flat until a toggle" regression).
 *
 * The camera pitch is deliberately NOT touched: the map opens top-down (0°)
 * with the terrain already enabled, and the visitor tilts it themselves with a
 * two-finger / trackpad drag (up to the map's maxPitch, 85° in MapView).
 * Toggling the 3D view therefore never moves the camera.
 */
export function applyTerrain(
  map,
  on,
  exaggeration = DEFAULT_TERRAIN_EXAGGERATION,
  source = DEM_SOURCE,
) {
  if (!map || typeof map.setTerrain !== "function") return;
  const apply = () => {
    if (on) {
      const exag =
        typeof exaggeration === "number" && Number.isFinite(exaggeration) && exaggeration > 0
          ? exaggeration
          : DEFAULT_TERRAIN_EXAGGERATION;
      map.setTerrain({ source, exaggeration: exag });
    } else {
      map.setTerrain(null);
    }
  };
  try {
    apply();
  } catch (err) {
    // "Style is not done loading." = the style document is still loading (an
    // early call, before the `load` event): a safe no-op, not a failure.
    if (err instanceof Error && /not done loading/i.test(err.message)) return;
    throw err;
  }
}
