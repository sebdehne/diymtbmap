// MTB overlay — pure module (no browser APIs), shared by the React web app
// (web/src) and the Node test suite (test/mtb-overlay.test.ts).
//
// The dedicated MTB tileset (mtb-profile) writes, per way, into the `mtb`
// layer (z MTB_MINZOOM..14):
//   - mtb_kind  : "natural" | "bikepark" (a discriminator for the two trails)
//   - mtb_scale : the raw mtb:scale value (natural trails), e.g. "3", "3+"
//   - mtb_imba  : the raw mtb:scale:imba value (bike-park trails), e.g. "2"
//   - optional  : mtb_name, class_bicycle_mtb, trail_visibility, bicycle,
//                 aerialway_bicycle (popover / metadata, set only if tagged)
//
// The overlay draws exactly those ways on top of the OMT basemap, split into
// two INDEPENDENTLY toggled groups:
//   1. natural trails   (mtb:scale)  -> MTB_COLORS ramp  (levels 0–6)
//   2. bike-park trails (mtb:scale:imba) -> IMBA_COLORS ramp (levels 0–4)
//
// Back-compat: tilesets built by the old profile (v1) have no `mtb_kind`.
// The natural group's filter coalesces a missing `mtb_kind` to "natural", so
// old tilesets still render as natural trails; the bike-park group renders
// empty (no way carries mtb_kind=bikepark), which is correct.

/** The Martin tile source id the style + overlay use (mtb.mbtiles -> "mtb"; verified at startup). */
export const MTB_SOURCE = "mtb";

/** MVT layer that carries mtb_kind / mtb_scale / mtb_imba in the MTB tileset. */
export const MTB_SOURCE_LAYER = "mtb";

/** The attribute that splits the two trail groups. */
export const KIND_ATTR = "mtb_kind";

// ---------------------------------------------------------------------------
// Group 1 — natural MTB trails (mtb:scale), levels 0–6
// ---------------------------------------------------------------------------

/** Base levels 0–6 → color (the 7-color ramp documented in README.md). */
export const MTB_COLORS = Object.freeze({
  "0": "#43a047",
  "1": "#425cb3",
  "2": "#ff1b1b",
  "3": "#393232",
  "4": "#201c1c",
  "5": "#070606",
  "6": "#4a148c",
});

/** Legend labels per base level. */
export const MTB_LABELS = Object.freeze({
  "0": "Easy",
  "1": "Intermediate",
  "2": "Advanced",
  "3": "Expert",
  "4": "Extreme I",
  "5": "Extreme II",
  "6": "Impossible",
});

/** Fallback for values outside the known set (the `has` filter makes this rare). */
export const MTB_FALLBACK_COLOR = "#d8d3c8";

/**
 * Every raw `mtb_scale` value ("N", "N+", "N-" for base levels 0–6) mapped to
 * its base level's color — the match table for the natural line color.
 */
export function mtbColorEntries() {
  const entries = [];
  for (const [level, color] of Object.entries(MTB_COLORS)) {
    for (const suffix of ["", "+", "-"]) {
      entries.push([level + suffix, color]);
    }
  }
  return entries;
}

/** `["match", ["get","mtb_scale"], "0", color, …, fallback]` expression. */
export function mtbColorExpression() {
  const expr = ["match", ["get", "mtb_scale"]];
  for (const [value, color] of mtbColorEntries()) {
    expr.push(value, color);
  }
  expr.push(MTB_FALLBACK_COLOR);
  return expr;
}

// ---------------------------------------------------------------------------
// Group 2 — bike-park trails (mtb:scale:imba), levels 0–4
// ---------------------------------------------------------------------------

/**
 * IMBA (Mountain Bike Association) difficulty ramp, levels 0–4. A distinct
 * palette from the natural ramp so the two groups read differently at a
 * glance. 0 = Beginner … 4 = Expert.
 */
export const IMBA_COLORS = Object.freeze({
  "0": "#009c3b",
  "1": "#2f7fe0",
  "2": "#e8281c",
  "3": "#1a1a1a",
  "4": "#8e44ad",
});

/** Legend labels per IMBA level. */
export const IMBA_LABELS = Object.freeze({
  "0": "Beginner",
  "1": "Novice",
  "2": "Intermediate",
  "3": "Advanced",
  "4": "Expert",
});

/** Fallback for mtb_imba values outside 0–4. */
export const IMBA_FALLBACK_COLOR = "#d8d3c8";

/** Every raw `mtb_imba` value ("0"–"4") mapped to its color. */
export function bikeParkColorEntries() {
  const entries = [];
  for (const [level, color] of Object.entries(IMBA_COLORS)) {
    entries.push([level, color]);
  }
  return entries;
}

/** `["match", ["get","mtb_imba"], "0", color, …, fallback]` expression. */
export function bikeParkColorExpression() {
  const expr = ["match", ["get", "mtb_imba"]];
  for (const [value, color] of bikeParkColorEntries()) {
    expr.push(value, color);
  }
  expr.push(IMBA_FALLBACK_COLOR);
  return expr;
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/**
 * Default first zoom the overlay is drawn at: the build-time MTB_MINZOOM
 * (default 3). The served status snapshot carries the value the overlay must
 * use, so the display floor always equals the data floor (the MTB tileset's
 * minzoom) — MapView passes it to the layer builders.
 */
export const MTB_MINZOOM = 3;

/** Dark casing behind the colored line so trails read over the basemap. */
export const MTB_CASING_COLOR = "#2b2b2b";

/** Opacity of both the casing and the colored line (half strength over the basemap). */
export const MTB_LINE_OPACITY = 0.5;

/**
 * Natural-group filter: a way is "natural" unless its mtb_kind says otherwise.
 * `coalesce` defaults a missing mtb_kind (old v1 tilesets) to "natural", so
 * they keep rendering as natural trails.
 */
export const NATURAL_FILTER = ["!=", ["coalesce", ["get", KIND_ATTR], "natural"], "bikepark"];

/** Bike-park-group filter: only ways explicitly tagged as bike-park. */
export const BIKEPARK_FILTER = ["==", ["get", KIND_ATTR], "bikepark"];

/**
 * Linear-in-zoom line width in screen px (multiplied by `factor`). Thin at
 * the minzoom floor (0.375 px) so low-zoom trails read as subtle lines over
 * the basemap, rising to 3.5 px @ z18 for street-level prominence.
 */
function lineWidth(minzoom, factor) {
  return [
    "interpolate",
    ["linear"],
    ["zoom"],
    minzoom,
    0.375 * factor,
    11,
    0.75 * factor,
    18,
    3.5 * factor,
  ];
}

/**
 * Builds the two overlay layers for one trail group in draw order: dark
 * casing first, colored line on top. Unknown/junk difficulty values fall back
 * to a neutral gray (the match's final entry) so they never render as a
 * level. `source`/`minzoom` default to the production values but are
 * overridable from the served status snapshot.
 */
function groupLayers(
  source,
  minzoom,
  { casingId, lineId, filter, colorExpression },
) {
  const common = {
    type: "line",
    source,
    "source-layer": MTB_SOURCE_LAYER,
    minzoom,
    filter,
    layout: { "line-cap": "round", "line-join": "round" },
  };
  return [
    {
      ...common,
      id: casingId,
      paint: {
        "line-color": MTB_CASING_COLOR,
        "line-width": lineWidth(minzoom, 2),
        "line-opacity": MTB_LINE_OPACITY,
      },
    },
    {
      ...common,
      id: lineId,
      paint: {
        "line-color": colorExpression,
        "line-width": lineWidth(minzoom, 1),
        "line-opacity": MTB_LINE_OPACITY,
      },
    },
  ];
}

/**
 * The natural MTB trail layers (mtb:scale). Layer ids: `mtb-casing`,
 * `mtb-scale`. Filtered to natural trails (mtb_kind != "bikepark"), with
 * back-compat for tilesets lacking mtb_kind.
 */
export function mtbOverlayLayers(source = MTB_SOURCE, minzoom = MTB_MINZOOM) {
  return groupLayers(source, minzoom, {
    casingId: "mtb-casing",
    lineId: "mtb-scale",
    filter: NATURAL_FILTER,
    colorExpression: mtbColorExpression(),
  });
}

/**
 * The bike-park trail layers (mtb:scale:imba). Layer ids: `bikepark-casing`,
 * `bikepark-imba`. Filtered to bike-park trails (mtb_kind == "bikepark");
 * renders empty on tilesets built before the split (correct).
 */
export function bikeParkOverlayLayers(source = MTB_SOURCE, minzoom = MTB_MINZOOM) {
  return groupLayers(source, minzoom, {
    casingId: "bikepark-casing",
    lineId: "bikepark-imba",
    filter: BIKEPARK_FILTER,
    colorExpression: bikeParkColorExpression(),
  });
}

/**
 * The id of the FIRST symbol (text-label) layer in a MapLibre style document,
 * or `undefined` when there is none. MapView passes it as the `beforeId` of
 * `map.addLayer` so the non-symbol overlays (MTB trails, hillshade, contour
 * lines) are inserted BETWEEN the basemap content and its labels — the
 * basemap's text/icons stay on top and readable instead of being covered by
 * the overlay lines. A style with no symbol layer returns `undefined`, and
 * `addLayer(layer, undefined)` appends last (the pre-change behavior).
 */
export function firstSymbolLayerId(style) {
  const layers = style?.layers;
  if (!Array.isArray(layers)) return undefined;
  for (const layer of layers) {
    if (layer?.type === "symbol") return layer.id;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Overlay groups (drives the UI toggles + legends)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} OverlayGroup
 * @property {string} id          stable id (also the key in the persisted toggle state)
 * @property {string} label       human label for the UI
 * @property {string} key         the OSM tag the group is built from
 * @property {string[]} layerIds  the two map layer ids (casing + line)
 * @property {Record<string,string>} colors  difficulty color ramp (level → hex)
 * @property {Record<string,string>} labels  difficulty legend labels (level → text)
 * @property {string} note        a short note under the legend
 */

/**
 * The two independently-toggleable MTB trail groups, in display order. The
 * UI iterates this to build its toggles and legends, so adding a third group
 * (e.g. e-bike lines) only requires extending the tileset + this array.
 */
export const OVERLAY_GROUPS = Object.freeze([
  Object.freeze({
    id: "natural",
    label: "Natural MTB trails",
    key: "mtb:scale",
    layerIds: Object.freeze(["mtb-casing", "mtb-scale"]),
    colors: MTB_COLORS,
    labels: MTB_LABELS,
    note: "+ / − variants use the base level’s color",
  }),
  Object.freeze({
    id: "bikepark",
    label: "Bike-park trails",
    key: "mtb:scale:imba",
    layerIds: Object.freeze(["bikepark-casing", "bikepark-imba"]),
    colors: IMBA_COLORS,
    labels: IMBA_LABELS,
    note: "IMBA difficulty 0–4",
  }),
]);

/**
 * Applies a toggle state ({ natural: bool, bikepark: bool, ... }) to the map
 * by flipping each group's layers visible/none. A group is VISIBLE unless its
 * state is explicitly false (so a partial/absent state still shows trails).
 * Safe to call before the layers exist (layers that are not added yet are
 * skipped), so it works both on initial load and on user toggles.
 */
export function applyOverlayVisibility(map, state) {
  for (const g of OVERLAY_GROUPS) {
    const visible = state?.[g.id] !== false;
    for (const id of g.layerIds) {
      if (map && typeof map.getLayer === "function" && map.getLayer(id)) {
        map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
      }
    }
  }
}

/**
 * Applies per-group line opacity (state.opacity = { natural: number,
 * bikepark: number, ... }) to the map by setting `line-opacity` on each
 * group's casing + line layers. A value is applied only when it is a finite
 * number in (0, 1]; missing/invalid values are skipped so the layer keeps
 * its current opacity. Safe to call before the layers exist (skipped), so it
 * works both on initial load and on live slider changes — the same contract
 * as applyOverlayVisibility.
 */
export function applyOverlayOpacity(map, state) {
  for (const g of OVERLAY_GROUPS) {
    const opacity = state?.opacity?.[g.id];
    if (typeof opacity !== "number" || !Number.isFinite(opacity) || opacity <= 0 || opacity > 1) {
      continue;
    }
    for (const id of g.layerIds) {
      if (map && typeof map.getLayer === "function" && typeof map.setPaintProperty === "function" && map.getLayer(id)) {
        map.setPaintProperty(id, "line-opacity", opacity);
      }
    }
  }
}

/**
 * Default view (WGS84 [west, south] / [east, north]): mainland Norway — this
 * app's default extract. Used only as a fallback when the tileset carries no
 * `center`/`bounds` metadata (workstream D); the pipeline's auto-detected view
 * normally takes precedence.
 */
export const DEFAULT_BOUNDS = [
  [4.0, 56.5],
  [31.5, 72.0],
];
