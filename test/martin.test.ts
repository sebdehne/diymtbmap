import assert from "node:assert/strict";
import { test } from "node:test";
import type { Config } from "../src/config.js";
import {
  EXPECTED_SOURCE,
  MartinCatalog,
  MartinServer,
  assertExpectedCatalog,
  assertExpectedLayers,
  expectedMtbSource,
  parseMbtilesPaths,
  sourceIds,
} from "../src/martin.js";
import { EXPECTED_LAYERS, OPTIONAL_LAYERS, REQUIRED_LAYERS } from "../src/verify.js";

const REAL_YAML = `# comment
mbtiles:
  - /data/openmaptiles.mbtiles
`;

test("parseMbtilesPaths: single path (the real martin.yaml shape)", () => {
  assert.deepEqual(parseMbtilesPaths(REAL_YAML), ["/data/openmaptiles.mbtiles"]);
});

test("parseMbtilesPaths: multiple paths", () => {
  const yaml = `mbtiles:\n  - /a/x.mbtiles\n  - /b/y.mbtiles\n`;
  assert.deepEqual(parseMbtilesPaths(yaml), ["/a/x.mbtiles", "/b/y.mbtiles"]);
});

test("parseMbtilesPaths: quoted path + comments", () => {
  const yaml =
    "# top comment\nother: 1\nmbtiles:\n  - '/data/openmaptiles.mbtiles' # trailing\n";
  assert.deepEqual(parseMbtilesPaths(yaml), ["/data/openmaptiles.mbtiles"]);
});

test("parseMbtilesPaths: no mbtiles key -> empty", () => {
  assert.deepEqual(parseMbtilesPaths("raster: []\n  - x.png\n"), []);
  assert.deepEqual(parseMbtilesPaths(""), []);
});

test("sourceIds: sorted keys of catalog tiles, empty when absent", () => {
  assert.deepEqual(sourceIds({ tiles: { b: {}, a: {} } }), ["a", "b"]);
  assert.deepEqual(sourceIds({}), []);
});

/** Martin 1.14 /catalog shape for an MBTiles source (no layer list). */
function mvtCatalog(contentType = "application/x-protobuf"): MartinCatalog {
  return {
    tiles: {
      [EXPECTED_SOURCE]: {
        content_type: contentType,
        content_encoding: "gzip",
        name: "OpenMapTiles",
      },
    },
  };
}

test("assertExpectedCatalog: MVT source passes", () => {
  assert.doesNotThrow(() => assertExpectedCatalog(mvtCatalog()));
});

test("assertExpectedCatalog: extra sources are tolerated", () => {
  const catalog = mvtCatalog();
  catalog.tiles = { ...catalog.tiles, other: { content_type: "image/png" } };
  assert.doesNotThrow(() => assertExpectedCatalog(catalog));
});

test("assertExpectedCatalog: expected source absent throws", () => {
  assert.throws(
    () =>
      assertExpectedCatalog({
        tiles: { "OpenMapTiles": { content_type: "application/x-protobuf" } },
      }),
    /not serving the expected tile source/,
  );
});

test("assertExpectedCatalog: empty catalog throws", () => {
  assert.throws(() => assertExpectedCatalog({}), /serving: none/);
});

test("assertExpectedCatalog: non-MVT or missing content type throws", () => {
  assert.throws(() => assertExpectedCatalog(mvtCatalog("image/png")), /content_type/);
  assert.throws(
    () => assertExpectedCatalog({ tiles: { [EXPECTED_SOURCE]: {} } }),
    /content_type/,
  );
});

test("expectedMtbSource: Martin's id is the file name minus .mbtiles", () => {
  assert.equal(expectedMtbSource("/data/mtb.mbtiles"), "mtb");
  assert.equal(expectedMtbSource("/data/mtb-7.mbtiles"), "mtb-7");
  assert.equal(expectedMtbSource("tiles.mbtiles"), "tiles");
  assert.equal(expectedMtbSource("/data/odd"), "odd");
});

test("assertExpectedCatalog: two-source catalog (basemap + mtb) passes", () => {
  const catalog = mvtCatalog();
  catalog.tiles = {
    ...catalog.tiles,
    mtb: { content_type: "application/x-protobuf", name: "MTB" },
  };
  assert.doesNotThrow(() => assertExpectedCatalog(catalog, "mtb"));
});

test("assertExpectedCatalog: missing mtb source throws when required", () => {
  assert.throws(
    () => assertExpectedCatalog(mvtCatalog(), "mtb"),
    /not serving the expected tile source\(s\).*"mtb"/,
  );
  // ...but is tolerated when not required (backward-compatible call).
  assert.doesNotThrow(() => assertExpectedCatalog(mvtCatalog()));
});

test("assertExpectedCatalog: non-MVT mtb source throws when required", () => {
  const catalog = mvtCatalog();
  catalog.tiles = { ...catalog.tiles, mtb: { content_type: "image/png" } };
  assert.throws(() => assertExpectedCatalog(catalog, "mtb"), /content_type/);
});

test("assertExpectedLayers: all 16 layers pass", () => {
  assert.doesNotThrow(() => assertExpectedLayers([...EXPECTED_LAYERS].reverse()));
});

test("assertExpectedLayers: missing required layer throws", () => {
  const layers = [...REQUIRED_LAYERS.filter((l) => l !== "waterway"), ...OPTIONAL_LAYERS];
  assert.throws(() => assertExpectedLayers(layers), /missing required layers: waterway/);
});

test("assertExpectedLayers: missing optional layer (aerodrome_label) passes", () => {
  assert.doesNotThrow(() => assertExpectedLayers([...REQUIRED_LAYERS]));
});

test("MartinServer: maps wildcard binds to 127.0.0.1 for its own HTTP calls", () => {
  const mk = (bind: string) => new MartinServer({ martinBind: bind, martinPort: 3000 } as Config);
  assert.equal(mk("0.0.0.0").url, "http://127.0.0.1:3000");
  assert.equal(mk("::").url, "http://127.0.0.1:3000");
  assert.equal(mk("::1").url, "http://127.0.0.1:3000");
  assert.equal(mk("192.168.1.5").url, "http://192.168.1.5:3000");
});
