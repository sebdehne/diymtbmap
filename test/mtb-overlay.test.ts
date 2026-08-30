import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import {
  MTB_CASING_COLOR,
  MTB_COLORS,
  MTB_FALLBACK_COLOR,
  MTB_LABELS,
  MTB_MINZOOM,
  MTB_SOURCE,
  MTB_SOURCE_LAYER,
  NORWAY_BOUNDS,
  mtbColorEntries,
  mtbColorExpression,
  mtbOverlayLayers,
} from "../shared/mtb-overlay.js";

const PLANNED_RAMP: Record<string, string> = {
  "0": "#43a047",
  "1": "#425cb3",
  "2": "#ff1b1b",
  "3": "#393232",
  "4": "#201c1c",
  "5": "#070606",
  "6": "#4a148c",
};

test("step 11: the overlay reads from the dedicated mtb tileset (source + layer 'mtb')", () => {
  assert.equal(MTB_SOURCE, "mtb");
  assert.equal(MTB_SOURCE_LAYER, "mtb");
  // The display floor defaults to the build-time MTB_MINZOOM default (3).
  assert.equal(MTB_MINZOOM, 3);
});

test("MTB_COLORS: exactly the 7-color MTB difficulty ramp", () => {
  assert.deepEqual(
    Object.keys(MTB_COLORS).sort(),
    ["0", "1", "2", "3", "4", "5", "6"],
  );
  for (const [level, color] of Object.entries(PLANNED_RAMP)) {
    assert.equal(MTB_COLORS[level], color, `level ${level} color`);
  }
});

test("MTB_LABELS: one legend label per base level", () => {
  assert.deepEqual(Object.keys(MTB_LABELS).sort(), ["0", "1", "2", "3", "4", "5", "6"]);
  for (const label of Object.values(MTB_LABELS)) {
    assert.ok(typeof label === "string" && label.length > 0);
  }
});

test("mtbColorEntries: covers every raw variant N / N+ / N- for 0-6", () => {
  const entries = mtbColorEntries();
  assert.equal(entries.length, 21, "7 levels x 3 variants");
  const map = new Map(entries);
  for (const [level, color] of Object.entries(PLANNED_RAMP)) {
    assert.equal(map.get(level), color);
    assert.equal(map.get(level + "+"), color, `${level}+ maps to base color`);
    assert.equal(map.get(level + "-"), color, `${level}- maps to base color`);
  }
  // No unexpected values.
  for (const [value] of entries) {
    assert.match(value, /^[0-6][+-]?$/);
  }
});

test("mtbColorExpression: match on raw mtb_scale, all variants + fallback", () => {
  const expr = mtbColorExpression();
  assert.equal(expr[0], "match");
  assert.deepEqual(expr[1], ["get", "mtb_scale"]);
  assert.equal(expr[expr.length - 1], MTB_FALLBACK_COLOR, "fallback is the final entry");
  // Labels (even positions from index 2) cover all 21 raw values.
  const labels = [];
  for (let i = 2; i < expr.length - 1; i += 2) labels.push(expr[i]);
  assert.equal(labels.length, 21);
  for (const expected of ["0", "2+", "3", "5-", "6+"]) assert.ok(labels.includes(expected));
  // Every label maps to a valid hex color.
  for (let i = 3; i < expr.length - 1; i += 2) {
    assert.match(expr[i], /^#[0-9a-f]{6}$/i);
  }
});

function widthStops(widthExpr: unknown[]): Map<number, number> {
  assert.equal(widthExpr[0], "interpolate");
  assert.deepEqual(widthExpr[1], ["linear"]);
  assert.deepEqual(widthExpr[2], ["zoom"]);
  const stops = new Map<number, number>();
  for (let i = 3; i < widthExpr.length; i += 2) {
    stops.set(widthExpr[i], widthExpr[i + 1]);
  }
  return stops;
}

test("mtbOverlayLayers: casing + colored line, correct source/filter/minzoom", () => {
  const layers = mtbOverlayLayers();
  assert.equal(layers.length, 2);
  const [casing, line] = layers;

  assert.equal(casing?.id, "mtb-casing");
  assert.equal(line?.id, "mtb-scale");
  for (const layer of [casing, line]) {
    assert.ok(layer, "layer present");
    assert.equal(layer.type, "line");
    assert.equal(layer.source, MTB_SOURCE);
    assert.equal(layer["source-layer"], MTB_SOURCE_LAYER);
    assert.equal(layer.minzoom, MTB_MINZOOM);
    assert.deepEqual(layer.filter, ["has", "mtb_scale"]);
    assert.deepEqual(layer.layout, { "line-cap": "round", "line-join": "round" });
  }

  assert.equal(casing?.paint["line-color"], MTB_CASING_COLOR);
  // The colored layer uses the full match expression.
  assert.deepEqual(line?.paint["line-color"], mtbColorExpression());

  // Casing is strictly wider than the line at every shared zoom stop.
  const cStops = widthStops(casing?.paint["line-width"]);
  const lStops = widthStops(line?.paint["line-width"]);
  assert.deepEqual([...cStops.keys()], [...lStops.keys()], "same zoom stops");
  for (const [zoom, lineWidth] of lStops) {
    const casingWidth = cStops.get(zoom);
    assert.ok(casingWidth !== undefined && casingWidth > lineWidth, `casing > line at z${zoom}`);
    assert.ok(lineWidth > 0);
  }
  // Width grows with zoom.
  const zooms = [...lStops.keys()].sort((a, b) => a - b);
  for (let i = 1; i < zooms.length; i++) {
    assert.ok(lStops.get(zooms[i]!) > lStops.get(zooms[i - 1]!));
  }
});

test("step 11: line widths are thin at the minzoom floor, rising to 7px @ z18; casing = 2x", () => {
  const [, line] = mtbOverlayLayers();
  const stops = widthStops(line?.paint["line-width"]);
  assert.deepEqual([...stops.keys()].sort((a, b) => a - b), [MTB_MINZOOM, 11, 18], "stops: minzoom, z11, z18");
  assert.equal(stops.get(MTB_MINZOOM), 0.75, "0.75 px at the minzoom floor");
  assert.equal(stops.get(11), 1.5, "1.5 px @ z11");
  assert.equal(stops.get(18), 7, "7 px @ z18");
  const casing = widthStops(mtbOverlayLayers()[0]?.paint["line-width"]);
  for (const [zoom, w] of stops) {
    assert.equal(casing.get(zoom), 2 * w, `casing is exactly 2x the line at z${zoom}`);
  }
});

test("step 11: mtbOverlayLayers honors a custom source + minzoom (from the status snapshot)", () => {
  const [casing, line] = mtbOverlayLayers("mtb-7", 5);
  assert.equal(casing?.source, "mtb-7");
  assert.equal(line?.source, "mtb-7");
  assert.equal(casing?.minzoom, 5);
  assert.equal(line?.minzoom, 5);
  assert.equal(line?.["source-layer"], MTB_SOURCE_LAYER, "the layer id stays 'mtb'");
  const stops = widthStops(line?.paint["line-width"]);
  assert.ok(stops.has(5), "the low-zoom width stop follows the minzoom");
  assert.equal(stops.get(5), 0.75);
});

test("overlay layer ids do not collide with the basemap style (if vendored)", () => {
  const styleFile = new URL("../public/style.json", import.meta.url);
  if (!existsSync(styleFile)) {
    // Style is gitignored / vendored; nothing to cross-check against.
    return;
  }
  const style = JSON.parse(readFileSync(styleFile, "utf8"));
  const basemapIds = new Set((style.layers ?? []).map((l) => l.id));
  for (const layer of mtbOverlayLayers()) {
    assert.ok(!basemapIds.has(layer.id), `id "${layer.id}" must not collide with the basemap`);
  }
  assert.ok(basemapIds.size > 100, "sanity: the vendored OMT style has many layers");
});

test("NORWAY_BOUNDS: a sensible mainland Norway extent", () => {
  const [[w, s], [e, n]] = NORWAY_BOUNDS;
  assert.ok(w > -20 && w < 10, "west edge");
  assert.ok(e > 25 && e < 40, "east edge");
  assert.ok(s > 55 && s < 59, "south edge");
  assert.ok(n > 70 && n < 75, "north edge");
  assert.ok(w < e && s < n);
});
