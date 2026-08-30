// MTB overlay (step 8, reworked in step 11) — pure module (no browser APIs),
// shared by the React web app (web/src) and the Node test suite
// (test/mtb-overlay.test.ts).
//
// The dedicated MTB tileset (mtb-profile) writes each way's `mtb:scale` tag
// (raw string, e.g. "3", "3+", "4-") to the `mtb_scale` attribute on the
// `mtb` layer, z MTB_MINZOOM..14. The overlay draws exactly those ways on
// top of the OMT basemap, colored by base difficulty level (0 = easiest … 6
// = extreme; +/− variants share the base level's color).

/** The Martin tile source id the style + overlay use (mtb.mbtiles -> "mtb"; verified at startup). */
export const MTB_SOURCE = "mtb";

/** MVT layer that carries `mtb_scale` in the MTB tileset. */
export const MTB_SOURCE_LAYER = "mtb";

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

/**
 * Default first zoom the overlay is drawn at: the build-time MTB_MINZOOM
 * (default 3). The served status snapshot carries the value the overlay must
 * use, so the display floor always equals the data floor (the MTB tileset's
 * minzoom) — MapView passes it to mtbOverlayLayers().
 */
export const MTB_MINZOOM = 3;

/** Dark casing behind the colored line so trails read over the basemap. */
export const MTB_CASING_COLOR = "#2b2b2b";

/** Fallback for values outside the known set (the `has` filter makes this rare). */
export const MTB_FALLBACK_COLOR = "#d8d3c8";

/**
 * Every raw `mtb_scale` value ("N", "N+", "N-" for base levels 0–6) mapped to
 * its base level's color — the match table for the line color.
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

/**
 * Linear-in-zoom line width in screen px (multiplied by `factor`). Thin at
 * the minzoom floor (0.75 px) so low-zoom trails read as subtle lines over
 * the basemap, rising to 7 px @ z18 for street-level prominence.
 */
function lineWidth(minzoom, factor) {
  return [
    "interpolate",
    ["linear"],
    ["zoom"],
    minzoom,
    0.75 * factor,
    11,
    1.5 * factor,
    18,
    7 * factor,
  ];
}

/**
 * The two overlay layers in draw order: dark casing first, colored line on
 * top. Add them AFTER the basemap style loads so they sit above every OMT
 * layer. Unknown/junk `mtb_scale` values fall back to a neutral gray (the
 * match's final entry), so they never render as a difficulty level.
 * `source`/`minzoom` default to the production values but are overridable
 * from the served status snapshot (they follow MTB_MBTILES_FILE /
 * MTB_MINZOOM).
 */
export function mtbOverlayLayers(source = MTB_SOURCE, minzoom = MTB_MINZOOM) {
  const common = {
    type: "line",
    source,
    "source-layer": MTB_SOURCE_LAYER,
    minzoom,
    filter: ["has", "mtb_scale"],
    layout: { "line-cap": "round", "line-join": "round" },
  };
  return [
    {
      ...common,
      id: "mtb-casing",
      paint: { "line-color": MTB_CASING_COLOR, "line-width": lineWidth(minzoom, 2) },
    },
    {
      ...common,
      id: "mtb-scale",
      paint: { "line-color": mtbColorExpression(), "line-width": lineWidth(minzoom, 1) },
    },
  ];
}

/** Default view: mainland Norway (WGS84 [west, south] / [east, north]). */
export const NORWAY_BOUNDS = [
  [4.0, 56.5],
  [31.5, 72.0],
];
