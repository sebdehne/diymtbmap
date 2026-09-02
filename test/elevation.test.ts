import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HILLSHADE_ID,
  CONTOUR_SOURCE_ID,
  CONTOUR_LAYER,
  CONTOUR_LINES_ID,
  CONTOUR_LABELS_ID,
  ELEVATION_KEY,
  LEVEL_KEY,
  CONTOUR_THRESHOLDS,
  CONTOUR_LABEL_FONT,
  ELEVATION_LAYER_IDS,
  contourProtocolOptions,
  hillshadeLayerSpec,
  contourLineSpec,
  contourLabelSpec,
  CONTOUR_IDS,
  applyHillshadeVisibility,
  applyContourVisibility,
} from "../shared/elevation.js";
import { DEM_SOURCE } from "../shared/terrain.js";

// ---------------------------------------------------------------------------
// stable ids + contract (shared/elevation.js)
// ---------------------------------------------------------------------------

test("elevation: stable ids are the documented contract", () => {
  assert.equal(HILLSHADE_ID, "hillshade");
  assert.equal(CONTOUR_SOURCE_ID, "contour-source");
  assert.equal(CONTOUR_LAYER, "contours");
  assert.equal(CONTOUR_LINES_ID, "contour-lines");
  assert.equal(CONTOUR_LABELS_ID, "contour-labels");
  assert.equal(ELEVATION_KEY, "ele");
  assert.equal(LEVEL_KEY, "level");
  // Draw order: hillshade first, then the contour lines, then the labels.
  assert.deepEqual(ELEVATION_LAYER_IDS, [HILLSHADE_ID, CONTOUR_LINES_ID, CONTOUR_LABELS_ID]);
});

test("elevation: thresholds are { zoom: [minor, major] } with major > minor, getting finer with zoom", () => {
  for (const [zoom, [minor, major]] of Object.entries(CONTOUR_THRESHOLDS)) {
    assert.ok(Number.isInteger(Number(zoom)), `zoom ${zoom} is an integer`);
    assert.ok(minor > 0 && major > 0, `positive intervals at z${zoom}`);
    assert.ok(major > minor, `major (${major}) > minor (${minor}) at z${zoom}`);
  }
  // The top zoom is the dem tileset's maxzoom (z11) and carries the 100 m index.
  assert.deepEqual(CONTOUR_THRESHOLDS[11], [20, 100]);
  // Finer as you zoom in (both minor and major shrink).
  assert.ok(CONTOUR_THRESHOLDS[11][0] < CONTOUR_THRESHOLDS[8][0]);
  assert.ok(CONTOUR_THRESHOLDS[11][1] < CONTOUR_THRESHOLDS[8][1]);
});

test("elevation: contourProtocolOptions names the output layer + properties the layers read", () => {
  const opts = contourProtocolOptions();
  assert.equal(opts.multiplier, 1, "meters, not feet");
  assert.equal(opts.contourLayer, CONTOUR_LAYER);
  assert.equal(opts.elevationKey, ELEVATION_KEY);
  assert.equal(opts.levelKey, LEVEL_KEY);
  assert.deepEqual(opts.thresholds, CONTOUR_THRESHOLDS);
});

test("elevation: hillshade layer is a `hillshade` on the given dem source", () => {
  const spec = hillshadeLayerSpec("terrain-7");
  assert.equal(spec.id, HILLSHADE_ID);
  assert.equal(spec.type, "hillshade");
  assert.equal(spec.source, "terrain-7");
  assert.equal(spec.paint["hillshade-illumination-direction"], 315);
  // Defaults to the dem source id when none is given.
  assert.equal(hillshadeLayerSpec(DEM_SOURCE).source, DEM_SOURCE);
});

test("elevation: contour line layer is a `line` on the contour source, styled by level", () => {
  const spec = contourLineSpec();
  assert.equal(spec.id, CONTOUR_LINES_ID);
  assert.equal(spec.type, "line");
  assert.equal(spec.source, CONTOUR_SOURCE_ID);
  assert.equal(spec["source-layer"], CONTOUR_LAYER);
  // The 0 m (and below-sea-level) isoline is dropped: only elevation > 0 is kept.
  // maplibre-contour tags the 0 m line as a major (index) line, so without this
  // it would render bold + labeled "0 m" right along the coast.
  assert.deepEqual(spec.filter, [">", ["get", ELEVATION_KEY], 0]);
  // Width + color are driven by the level property (1 = major, 0 = minor).
  // line-width = ["match", ["get","level"], 1, 1.25, 0.5] -> major (level 1) is
  // bolder/wider (1.25) than minor (0.5, the match default).
  assert.deepEqual(spec.paint["line-width"], ["match", ["get", LEVEL_KEY], 1, 1.25, 0.5]);
  assert.ok(Array.isArray(spec.paint["line-color"]));
  // A custom source id is honored.
  assert.equal(contourLineSpec("my-contours").source, "my-contours");
});

test("elevation: label layer is a `symbol` on the major lines, text = elevation + ' m'", () => {
  const spec = contourLabelSpec();
  assert.equal(spec.id, CONTOUR_LABELS_ID);
  assert.equal(spec.type, "symbol");
  assert.equal(spec.source, CONTOUR_SOURCE_ID);
  assert.equal(spec["source-layer"], CONTOUR_LAYER);
  // Only major lines (level > 0) get labels, and the 0 m line is excluded too
  // (elevation > 0) so no "0 m" label sits along the coast.
  assert.deepEqual(spec.filter, [
    "all",
    [">", ["get", LEVEL_KEY], 0],
    [">", ["get", ELEVATION_KEY], 0],
  ]);
  assert.equal(spec.layout["symbol-placement"], "line");
  assert.deepEqual(spec.layout["text-font"], CONTOUR_LABEL_FONT);
  // The label text is the integer elevation followed by " m".
  // `round` + `to-string`, NOT `number-format`: `number-format` routes through
  // Intl.NumberFormat and inserts the browser LOCALE's thousands separator
  // (en-US "1,200", de-DE "1.200" — the latter reads as a decimal), and our
  // old option name (`maximum-fraction-digits`) was silently ignored anyway.
  const field = spec.layout["text-field"];
  assert.deepEqual(field, [
    "concat",
    ["to-string", ["round", ["get", ELEVATION_KEY]]],
    " m",
  ]);
  // Regression guard: `text-halo-opacity` is NOT a MapLibre paint property.
  // An unknown property makes `addLayer` fail validation and the layer is
  // silently never added (this is why the labels never rendered). The 0.85
  // opacity must live in the halo color's alpha channel instead.
  assert.deepEqual(spec.paint, {
    "text-color": "#5a4632",
    "text-halo-color": "rgba(255, 255, 255, 0.85)",
    "text-halo-width": 1.25,
  });
});

// ---------------------------------------------------------------------------
// applyHillshadeVisibility / applyContourVisibility (shared/elevation.js)
// ---------------------------------------------------------------------------

// A fake map that records visibility flips for a fixed set of existing layers.
function recordingMap(existing: string[]) {
  const vis: Record<string, string> = {};
  return {
    vis,
    map: {
      getLayer: (id: string) => (existing.includes(id) ? {} : undefined),
      setLayoutProperty: (id: string, prop: string, value: string) => {
        if (prop === "visibility") vis[id] = value;
      },
    },
  };
}

test("CONTOUR_IDS groups the contour lines with their elevation labels", () => {
  assert.deepEqual(CONTOUR_IDS, [CONTOUR_LINES_ID, CONTOUR_LABELS_ID]);
});

test("applyHillshadeVisibility: flips only the hillshade layer", () => {
  const { vis, map } = recordingMap([
    HILLSHADE_ID,
    CONTOUR_LINES_ID,
    CONTOUR_LABELS_ID,
  ]);
  applyHillshadeVisibility(map, true);
  assert.deepEqual(vis, { [HILLSHADE_ID]: "visible" });
  applyHillshadeVisibility(map, false);
  assert.deepEqual(vis, { [HILLSHADE_ID]: "none" });
});

test("applyContourVisibility: flips the contour lines AND their labels together", () => {
  const { vis, map } = recordingMap([
    HILLSHADE_ID,
    CONTOUR_LINES_ID,
    CONTOUR_LABELS_ID,
  ]);
  applyContourVisibility(map, true);
  assert.deepEqual(vis, {
    [CONTOUR_LINES_ID]: "visible",
    [CONTOUR_LABELS_ID]: "visible",
  });
  applyContourVisibility(map, false);
  assert.deepEqual(
    Object.values(vis).sort(),
    ["none", "none"],
  );
});

test("elevation visibility: safe when the map or its layers are absent (no throw)", () => {
  assert.doesNotThrow(() => applyHillshadeVisibility(null, true));
  assert.doesNotThrow(() => applyHillshadeVisibility({}, true));
  assert.doesNotThrow(() => applyContourVisibility(null, true));
  assert.doesNotThrow(() => applyContourVisibility({}, true));
  // A map where none of the elevation layers exist yet (before `load`): no-op.
  assert.doesNotThrow(() =>
    applyContourVisibility({ getLayer: () => undefined }, false),
  );
});
