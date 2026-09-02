import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import {
  BIKEPARK_FILTER,
  DEFAULT_BOUNDS,
  IMBA_COLORS,
  IMBA_FALLBACK_COLOR,
  IMBA_LABELS,
  MTB_CASING_COLOR,
  MTB_COLORS,
  MTB_FALLBACK_COLOR,
  MTB_LABELS,
  MTB_LABEL_COLOR,
  MTB_LABEL_FONT,
  MTB_LABEL_HALO_COLOR,
  MTB_LABEL_MINZOOM,
  MTB_LABEL_OFFSET,
  MTB_LABEL_SIZE,
  MTB_LABEL_SPACING,
  MTB_LINE_OPACITY,
  MTB_MINZOOM,
  MTB_SOURCE,
  MTB_SOURCE_LAYER,
  NATURAL_FILTER,
  OVERLAY_GROUPS,
  applyOverlayOpacity,
  applyOverlayVisibility,
  bikeParkColorEntries,
  bikeParkColorExpression,
  bikeParkOverlayLayers,
  firstSymbolLayerId,
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

test("mtbOverlayLayers: casing + colored line + name label, correct source/filter/minzoom", () => {
  const layers = mtbOverlayLayers();
  assert.equal(layers.length, 3, "casing, line, then the trail-name label");
  const [casing, line] = layers;

  assert.equal(casing?.id, "mtb-casing");
  assert.equal(line?.id, "mtb-scale");
  for (const layer of [casing, line]) {
    assert.ok(layer, "layer present");
    assert.equal(layer.type, "line");
    assert.equal(layer.source, MTB_SOURCE);
    assert.equal(layer["source-layer"], MTB_SOURCE_LAYER);
    assert.equal(layer.minzoom, MTB_MINZOOM);
    assert.deepEqual(layer.filter, NATURAL_FILTER);
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

test("step 11: line widths are thin at the minzoom floor, rising to 3.5px @ z18; casing = 2x", () => {
  const [, line] = mtbOverlayLayers();
  const stops = widthStops(line?.paint["line-width"]);
  assert.deepEqual([...stops.keys()].sort((a, b) => a - b), [MTB_MINZOOM, 11, 18], "stops: minzoom, z11, z18");
  assert.equal(stops.get(MTB_MINZOOM), 0.375, "0.375 px at the minzoom floor");
  assert.equal(stops.get(11), 0.75, "0.75 px @ z11");
  assert.equal(stops.get(18), 3.5, "3.5 px @ z18");
  const casing = widthStops(mtbOverlayLayers()[0]?.paint["line-width"]);
  for (const [zoom, w] of stops) {
    assert.equal(casing.get(zoom), 2 * w, `casing is exactly 2x the line at z${zoom}`);
  }
});

test("mtbOverlayLayers: both layers render at half opacity", () => {
  const [casing, line] = mtbOverlayLayers();
  assert.equal(MTB_LINE_OPACITY, 0.5);
  assert.equal(casing?.paint["line-opacity"], MTB_LINE_OPACITY);
  assert.equal(line?.paint["line-opacity"], MTB_LINE_OPACITY);
  const [bpCasing, bpLine] = bikeParkOverlayLayers();
  assert.equal(bpCasing?.paint["line-opacity"], MTB_LINE_OPACITY);
  assert.equal(bpLine?.paint["line-opacity"], MTB_LINE_OPACITY);
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
  assert.equal(stops.get(5), 0.375);
});

// ---------------------------------------------------------------------------
// Trail name labels (mtb:name) — symbol layer, z12+, offset off the centerline
// ---------------------------------------------------------------------------

test("MTB name-label constants are sensible", () => {
  assert.equal(MTB_LABEL_MINZOOM, 12, "labels appear from z12 (tileset spans z7–z14, so z12 tiles exist)");
  assert.equal(MTB_LABEL_OFFSET[0], 0, "no along-the-trail offset");
  assert.ok(MTB_LABEL_OFFSET[1] > 0, "a perpendicular offset (off-center, clears the basemap name)");
  assert.ok(Array.isArray(MTB_LABEL_FONT) && MTB_LABEL_FONT.length >= 1, "a glyph font stack");
  assert.match(MTB_LABEL_COLOR, /^#[0-9a-f]{6}$/i, "a hex text color");
  assert.match(MTB_LABEL_HALO_COLOR, /^rgba?\(/, "a halo color carrying its own opacity");
});

test("mtbOverlayLayers: the name label is a symbol layer reading mtb_name at z12+", () => {
  const [, , label] = mtbOverlayLayers();
  assert.ok(label, "the trail-name label is the 3rd layer");
  assert.equal(label.id, "mtb-names-natural");
  assert.equal(label.type, "symbol");
  assert.equal(label.source, MTB_SOURCE);
  assert.equal(label["source-layer"], MTB_SOURCE_LAYER);
  assert.equal(label.minzoom, MTB_LABEL_MINZOOM, "labels start at z12, independent of the group's line minzoom");
  // Only natural trails that actually carry a name are labeled.
  assert.deepEqual(label.filter, ["all", ["has", "mtb_name"], NATURAL_FILTER]);
  const layout = label.layout;
  assert.equal(layout["symbol-placement"], "line", "text runs along the trail");
  assert.equal(layout["symbol-spacing"], MTB_LABEL_SPACING, "spacing gates how early a name appears");
  assert.equal(layout["text-rotation-alignment"], "map");
  assert.deepEqual(layout["text-font"], MTB_LABEL_FONT);
  assert.deepEqual(layout["text-offset"], MTB_LABEL_OFFSET, "offset off-center so it clears the basemap name");
  assert.deepEqual(layout["text-field"], ["get", "mtb_name"], "labels the mtb:name (not the generic name)");
  assert.deepEqual(layout["text-size"], MTB_LABEL_SIZE, "zoom-aware size so short trails can host the name");
  assert.equal(label.paint["text-color"], MTB_LABEL_COLOR);
  assert.equal(label.paint["text-halo-color"], MTB_LABEL_HALO_COLOR);
  assert.ok(label.paint["text-halo-width"] > 0);
});

test("bikeParkOverlayLayers: the name label is filtered to bike-park trails", () => {
  const [, , label] = bikeParkOverlayLayers();
  assert.equal(label.id, "bikepark-names");
  assert.equal(label.type, "symbol");
  assert.equal(label.minzoom, MTB_LABEL_MINZOOM);
  assert.deepEqual(label.filter, ["all", ["has", "mtb_name"], BIKEPARK_FILTER]);
  assert.deepEqual(label.layout["text-field"], ["get", "mtb_name"]);
  assert.deepEqual(label.layout["text-offset"], MTB_LABEL_OFFSET);
});

test("the name-label ids do not collide with either group's line ids", () => {
  const naturalIds = mtbOverlayLayers().map((l) => l.id);
  const bikeparkIds = bikeParkOverlayLayers().map((l) => l.id);
  assert.ok(new Set(naturalIds).size === naturalIds.length, "natural group ids are unique");
  assert.ok(new Set(bikeparkIds).size === bikeparkIds.length, "bike-park group ids are unique");
  assert.ok(!naturalIds.includes("bikepark-names") && !bikeparkIds.includes("mtb-names-natural"), "no cross-group id");
});

// ---------------------------------------------------------------------------
// Bike-park group (mtb:scale:imba), levels 0–4
// ---------------------------------------------------------------------------

const IMBA_RAMP: Record<string, string> = {
  "0": "#009c3b",
  "1": "#2f7fe0",
  "2": "#e8281c",
  "3": "#1a1a1a",
  "4": "#8e44ad",
};

test("IMBA_COLORS: exactly the 5-level IMBA ramp (0–4)", () => {
  assert.deepEqual(Object.keys(IMBA_COLORS).sort(), ["0", "1", "2", "3", "4"]);
  for (const [level, color] of Object.entries(IMBA_RAMP)) {
    assert.equal(IMBA_COLORS[level], color, `IMBA level ${level} color`);
  }
});

test("IMBA_LABELS: one legend label per IMBA level", () => {
  assert.deepEqual(Object.keys(IMBA_LABELS).sort(), ["0", "1", "2", "3", "4"]);
  for (const label of Object.values(IMBA_LABELS)) {
    assert.ok(typeof label === "string" && label.length > 0);
  }
});

test("bikeParkColorEntries: covers every IMBA level 0–4", () => {
  const entries = bikeParkColorEntries();
  assert.equal(entries.length, 5, "5 levels");
  const map = new Map(entries);
  for (const [level, color] of Object.entries(IMBA_RAMP)) {
    assert.equal(map.get(level), color);
  }
});

test("bikeParkColorExpression: match on raw mtb_imba, all levels + fallback", () => {
  const expr = bikeParkColorExpression();
  assert.equal(expr[0], "match");
  assert.deepEqual(expr[1], ["get", "mtb_imba"]);
  assert.equal(expr[expr.length - 1], IMBA_FALLBACK_COLOR, "fallback is the final entry");
  const labels = [];
  for (let i = 2; i < expr.length - 1; i += 2) labels.push(expr[i]);
  assert.deepEqual(labels.sort(), ["0", "1", "2", "3", "4"]);
  for (let i = 3; i < expr.length - 1; i += 2) assert.match(expr[i], /^#[0-9a-f]{6}$/i);
});

test("bikeParkOverlayLayers: casing + colored line + name label, bikepark filter + imba color", () => {
  const layers = bikeParkOverlayLayers();
  assert.equal(layers.length, 3, "casing, line, then the trail-name label");
  const [casing, line] = layers;
  assert.equal(casing?.id, "bikepark-casing");
  assert.equal(line?.id, "bikepark-imba");
  for (const layer of [casing, line]) {
    assert.ok(layer, "layer present");
    assert.equal(layer.type, "line");
    assert.equal(layer.source, MTB_SOURCE);
    assert.equal(layer["source-layer"], MTB_SOURCE_LAYER);
    assert.equal(layer.minzoom, MTB_MINZOOM);
    assert.deepEqual(layer.filter, BIKEPARK_FILTER);
    assert.deepEqual(layer.layout, { "line-cap": "round", "line-join": "round" });
  }
  assert.equal(casing?.paint["line-color"], MTB_CASING_COLOR);
  assert.deepEqual(line?.paint["line-color"], bikeParkColorExpression());
  // Casing is strictly wider than the line at every shared zoom stop.
  const cStops = widthStops(casing?.paint["line-width"]);
  const lStops = widthStops(line?.paint["line-width"]);
  assert.deepEqual([...cStops.keys()], [...lStops.keys()], "same zoom stops");
  for (const [zoom, lineWidth] of lStops) {
    const casingWidth = cStops.get(zoom);
    assert.ok(casingWidth !== undefined && casingWidth > lineWidth, `casing > line at z${zoom}`);
    assert.ok(lineWidth > 0);
  }
});

test("bikeParkOverlayLayers honors a custom source + minzoom", () => {
  const [casing, line] = bikeParkOverlayLayers("mtb-9", 6);
  assert.equal(casing?.source, "mtb-9");
  assert.equal(line?.source, "mtb-9");
  assert.equal(casing?.minzoom, 6);
  assert.equal(line?.minzoom, 6);
  assert.equal(line?.["source-layer"], MTB_SOURCE_LAYER);
});

// ---------------------------------------------------------------------------
// Filters partition the trail groups (natural vs bike-park)
// ---------------------------------------------------------------------------

test("NATURAL_FILTER: defaults a missing mtb_kind to natural (back-compat)", () => {
  assert.deepEqual(NATURAL_FILTER, ["!=", ["coalesce", ["get", "mtb_kind"], "natural"], "bikepark"]);
});

test("BIKEPARK_FILTER: only ways explicitly tagged bike-park", () => {
  assert.deepEqual(BIKEPARK_FILTER, ["==", ["get", "mtb_kind"], "bikepark"]);
});

// ---------------------------------------------------------------------------
// OVERLAY_GROUPS drives the UI toggles + legends
// ---------------------------------------------------------------------------

test("OVERLAY_GROUPS: natural + bikepark, with matching layer ids", () => {
  assert.equal(OVERLAY_GROUPS.length, 2);
  const byId = new Map(OVERLAY_GROUPS.map((g) => [g.id, g]));

  const natural = byId.get("natural");
  assert.ok(natural, "natural group present");
  assert.equal(natural?.key, "mtb:scale");
  assert.deepEqual(natural?.layerIds, ["mtb-casing", "mtb-scale", "mtb-names-natural"]);
  assert.equal(natural?.colors, MTB_COLORS);
  assert.equal(natural?.labels, MTB_LABELS);

  const bikepark = byId.get("bikepark");
  assert.ok(bikepark, "bikepark group present");
  assert.equal(bikepark?.key, "mtb:scale:imba");
  assert.deepEqual(bikepark?.layerIds, ["bikepark-casing", "bikepark-imba", "bikepark-names"]);
  assert.equal(bikepark?.colors, IMBA_COLORS);
  assert.equal(bikepark?.labels, IMBA_LABELS);
});

test("OVERLAY_GROUPS layer ids match what the layer builders emit", () => {
  const naturalIds = mtbOverlayLayers().map((l) => l.id).sort();
  const bikeparkIds = bikeParkOverlayLayers().map((l) => l.id).sort();
  assert.deepEqual(naturalIds.sort(), [...OVERLAY_GROUPS[0]!.layerIds].sort());
  assert.deepEqual(bikeparkIds.sort(), [...OVERLAY_GROUPS[1]!.layerIds].sort());
});

test("applyOverlayVisibility: toggles each group's layers via the map API", () => {
  const calls: string[] = [];
  const layerSet = new Set([
    "mtb-casing", "mtb-scale", "mtb-names-natural",
    "bikepark-casing", "bikepark-imba", "bikepark-names",
  ]);
  const fakeMap = {
    getLayer: (id: string) => (layerSet.has(id) ? {} : undefined),
    setLayoutProperty: (id: string, name: string, value: string) => {
      assert.equal(name, "visibility");
      calls.push(`${id}=${value}`);
    },
  };

  // All on (default) → everything (lines + name labels) visible.
  applyOverlayVisibility(fakeMap, { natural: true, bikepark: true });
  assert.deepEqual(calls, [
    "mtb-casing=visible",
    "mtb-scale=visible",
    "mtb-names-natural=visible",
    "bikepark-casing=visible",
    "bikepark-imba=visible",
    "bikepark-names=visible",
  ]);
  calls.length = 0;

  // Natural off, bikepark on → natural (incl. its name label) hidden, bike-park visible.
  applyOverlayVisibility(fakeMap, { natural: false, bikepark: true });
  assert.deepEqual(calls, [
    "mtb-casing=none",
    "mtb-scale=none",
    "mtb-names-natural=none",
    "bikepark-casing=visible",
    "bikepark-imba=visible",
    "bikepark-names=visible",
  ]);
  calls.length = 0;

  // Absent state (e.g. pre-persistence) → defaults to visible (trails show).
  applyOverlayVisibility(fakeMap, {});
  assert.equal(calls.filter((c) => c.endsWith("=none")).length, 0);
});

test("applyOverlayVisibility: safe before layers exist (no throw, no calls)", () => {
  const calls: string[] = [];
  const emptyMap = {
    getLayer: () => undefined,
    setLayoutProperty: (...a: unknown[]) => calls.push(String(a[0])),
  };
  applyOverlayVisibility(emptyMap, { natural: false, bikepark: false });
  assert.equal(calls.length, 0, "skips layers that are not added yet");
  // A map without the API at all must not throw either.
  applyOverlayVisibility(null, { natural: false });
  applyOverlayVisibility({}, { natural: false });
});

test("applyOverlayOpacity: fades each group's lines (line-opacity) AND name label (text-opacity)", () => {
  const calls: string[] = [];
  const layerTypes: Record<string, string> = {
    "mtb-casing": "line", "mtb-scale": "line", "mtb-names-natural": "symbol",
    "bikepark-casing": "line", "bikepark-imba": "line", "bikepark-names": "symbol",
  };
  const fakeMap = {
    getLayer: (id: string) => (layerTypes[id] ? { type: layerTypes[id] } : undefined),
    setPaintProperty: (id: string, name: string, value: number) => {
      calls.push(`${id}=${name}=${value}`);
    },
  };

  // Per-group values apply to that group's casing + line (line-opacity) and its
  // name label (text-opacity) — the slider fades the line and its name together.
  applyOverlayOpacity(fakeMap, { opacity: { natural: 0.8, bikepark: 0.25 } });
  assert.deepEqual(calls, [
    "mtb-casing=line-opacity=0.8",
    "mtb-scale=line-opacity=0.8",
    "mtb-names-natural=text-opacity=0.8",
    "bikepark-casing=line-opacity=0.25",
    "bikepark-imba=line-opacity=0.25",
    "bikepark-names=text-opacity=0.25",
  ]);
});

test("applyOverlayOpacity: skips missing/invalid values (leaves layers untouched)", () => {
  const calls: string[] = [];
  const layerTypes: Record<string, string> = {
    "mtb-casing": "line", "mtb-scale": "line", "mtb-names-natural": "symbol",
    "bikepark-casing": "line", "bikepark-imba": "line", "bikepark-names": "symbol",
  };
  const fakeMap = {
    getLayer: (id: string) => (layerTypes[id] ? { type: layerTypes[id] } : undefined),
    setPaintProperty: (id: string, name: string, value: number) => calls.push(`${id}=${name}=${value}`),
  };

  // No opacity key at all → nothing applied.
  applyOverlayOpacity(fakeMap, {});
  assert.equal(calls.length, 0, "no opacity key → no calls");
  // A group absent from opacity → that group untouched, the other applied (line + label).
  calls.length = 0;
  applyOverlayOpacity(fakeMap, { opacity: { natural: 0.7 } });
  assert.deepEqual(calls, [
    "mtb-casing=line-opacity=0.7",
    "mtb-scale=line-opacity=0.7",
    "mtb-names-natural=text-opacity=0.7",
  ]);
  // Out-of-range / non-numeric values are rejected.
  calls.length = 0;
  applyOverlayOpacity(fakeMap, { opacity: { natural: 0, bikepark: 2 } });
  assert.equal(calls.length, 0, "0 and >1 are rejected");
  calls.length = 0;
  applyOverlayOpacity(fakeMap, { opacity: { natural: "0.5" } });
  assert.equal(calls.length, 0, "strings are rejected");
  calls.length = 0;
  applyOverlayOpacity(fakeMap, { opacity: { natural: NaN } });
  assert.equal(calls.length, 0, "NaN is rejected");
});

test("applyOverlayOpacity: safe before layers exist (no throw, no calls)", () => {
  const calls: string[] = [];
  const emptyMap = {
    getLayer: () => undefined,
    setPaintProperty: (...a: unknown[]) => calls.push(String(a[0])),
  };
  applyOverlayOpacity(emptyMap, { opacity: { natural: 0.5, bikepark: 0.5 } });
  assert.equal(calls.length, 0, "skips layers that are not added yet");
  // A map without the paint API (or null) must not throw either.
  applyOverlayOpacity(null, { opacity: { natural: 0.5 } });
  applyOverlayOpacity({}, { opacity: { natural: 0.5 } });
});

test("firstSymbolLayerId: the first symbol (label) layer id", () => {
  const style = {
    layers: [
      { id: "Background", type: "background" },
      { id: "Water", type: "fill" },
      { id: "Road", type: "line" },
      { id: "River labels", type: "symbol" },
      { id: "City labels", type: "symbol" },
    ],
  };
  assert.equal(firstSymbolLayerId(style), "River labels", "returns the FIRST symbol layer");
});

test("firstSymbolLayerId: undefined for no symbol layer / bad input (fallback = append last)", () => {
  assert.equal(firstSymbolLayerId({ layers: [{ id: "a", type: "fill" }] }), undefined, "no symbol layer");
  assert.equal(firstSymbolLayerId({ layers: [] }), undefined, "empty layers");
  assert.equal(firstSymbolLayerId({}), undefined, "no layers key");
  assert.equal(firstSymbolLayerId(undefined), undefined, "undefined style");
});

test("firstSymbolLayerId: matches the vendored basemap's first label layer (if present)", () => {
  const styleFile = new URL("../public/style.json", import.meta.url);
  if (!existsSync(styleFile)) return; // style is gitignored / vendored
  const style = JSON.parse(readFileSync(styleFile, "utf8"));
  const first = firstSymbolLayerId(style);
  assert.ok(first, "the OMT style has a symbol layer to insert before");
  assert.equal(style.layers.find((l) => l.id === first)?.type, "symbol", "that layer is a symbol layer");
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

test("DEFAULT_BOUNDS: a sensible mainland Norway extent (the default extract)", () => {
  const [[w, s], [e, n]] = DEFAULT_BOUNDS;
  assert.ok(w > -20 && w < 10, "west edge");
  assert.ok(e > 25 && e < 40, "east edge");
  assert.ok(s > 55 && s < 59, "south edge");
  assert.ok(n > 70 && n < 75, "north edge");
  assert.ok(w < e && s < n);
});
