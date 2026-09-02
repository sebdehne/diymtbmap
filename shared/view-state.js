// Shareable location — pure module (no browser APIs), shared by the React web
// app (web/src) and the Node test suite (test/view-state.test.ts). Mirrors
// shared/terrain.js: stable constants + pure helpers, with any browser side
// effects (history.replaceState) kept in the web app.
//
// The map's shareable location is a SINGLE pinned dot + the current zoom,
// encoded as an OSM-style location hash:
//
//   #<zoom>/<lat>/<lng>      e.g. #12.5/60.41210/5.32130
//
// Why a hash (and not query params):
//   - It is server-agnostic: the app is basePath-aware (it also runs under a
//     sub-path like /mtb/), and a hash never touches the server or its routes.
//   - It is the format OSM and most tile maps already use, so a shared link
//     reads familiar to visitors.
//
// Semantics (fixed in the plan): the dot IS the shared location. Panning the
// map after pinning does not change the hash; zooming updates ONLY the zoom
// token, so a shared link always carries the latest zoom. Parsing a URL that
// carries a hash yields the dot position + zoom; the web app opens the map
// centered there and places the dot.
//
// Precision: lat/lng are rounded to 5 decimal places (~1.1 m at the equator,
// more than enough for pointing at a trail) and zoom to 2 (MapLibre zooms are
// fractional — 12.5 must survive a roundtrip).

/** The map's maxZoom (mirrors the Map option in web/src/MapView.jsx). */
export const VIEW_MAX_ZOOM = 22;

/** lat/lng decimal precision in a shared hash (~1.1 m at the equator). */
const COORD_DP = 5;

/** zoom decimal precision (keeps fractional zooms like 12.5). */
const ZOOM_DP = 2;

function roundTo(value, dp) {
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * True when the triple is a valid location: finite numbers, lat within
 * [-90, 90], lng within [-180, 180], zoom within [0, VIEW_MAX_ZOOM].
 */
export function isValidLocation({ lng, lat, zoom }) {
  return (
    isFiniteNumber(lng) &&
    isFiniteNumber(lat) &&
    isFiniteNumber(zoom) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180 &&
    zoom >= 0 &&
    zoom <= VIEW_MAX_ZOOM
  );
}

/**
 * Parses a location hash into `{ lng, lat, zoom }`.
 *
 * Accepts either a bare hash (`"#12.5/60.41210/5.32130"`) or a full URL
 * string (the hash part is extracted; a URL without a hash yields `null`).
 * Expects EXACTLY three `/`-separated tokens in OSM order: `zoom/lat/lon`.
 * Returns `null` for anything malformed, non-numeric, or out of range — the
 * web app then falls back to its default initial view (a bad shared link must
 * never crash the map, it just opens on the usual extent).
 */
export function parseViewHash(hashOrUrl) {
  if (typeof hashOrUrl !== "string") return null;
  const hash = hashOrUrl.startsWith("#") ? hashOrUrl.slice(1) : extractHash(hashOrUrl);
  if (!hash) return null;

  const parts = hash.split("/");
  if (parts.length !== 3) return null;
  // Reject empty/blank tokens up front: Number("") === 0 would otherwise turn
  // a malformed "#12.5/60.4121/" into lng 0 (a place on the equator!) instead
  // of failing.
  if (parts.some((p) => p.trim() === "" || !Number.isFinite(Number(p)))) return null;

  const [zoom, lat, lng] = parts.map(Number);
  const location = { zoom, lat, lng };
  return isValidLocation(location) ? location : null;
}

/**
 * Formats a valid location as an OSM-style location hash
 * (`"#12.5/60.41210/5.32130"`), rounding lat/lng to COORD_DP and zoom to
 * ZOOM_DP decimal places. Returns `null` when the location is not valid, so a
 * caller can fall back to leaving the URL untouched.
 */
export function formatViewHash(location) {
  if (!location || !isValidLocation(location)) return null;
  const zoom = roundTo(location.zoom, ZOOM_DP);
  const lat = roundTo(location.lat, COORD_DP);
  const lng = roundTo(location.lng, COORD_DP);
  return `#${zoom}/${lat}/${lng}`;
}

function extractHash(url) {
  const i = url.indexOf("#");
  return i === -1 ? "" : url.slice(i + 1);
}
