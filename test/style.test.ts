import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test, after } from "node:test";
import Database from "better-sqlite3";
import {
  analyzeStyle,
  buildAppOrigin,
  buildMtbSourceSpec,
  buildTileSourceSpec,
  checkStyleCompatibility,
  loadStyle,
  renderSmokeTest,
  verifyMtbServing,
  withTileSources,
  type StyleDoc,
} from "../src/style.js";
import { EXPECTED_SOURCE } from "../src/martin.js";
import { REQUIRED_MAXZOOM } from "../src/verify.js";
import type { Config } from "../src/config.js";
import { feature, layer, pointGeometry, stringVal, tileBytes } from "./mvt.js";

const dir = mkdtempSync(join(tmpdir(), "mtb-style-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/**
 * A small OMT-shaped style exercising: an explicit `get`, a shorthand
 * comparison (`==`), `in`, `has`, and `match` (whose labels/values are
 * literals that must NOT be collected as fields).
 */
const STYLE: StyleDoc = {
  version: 8,
  name: "synthetic",
  // Relative sprite/glyphs URLs, exactly as the vendored OMT style ships
  // them (MapLibre 6.x requires the sprite to be absolute at serve time).
  sprite: "sprite",
  glyphs: "{fontstack}/{range}.pbf",
  sources: {
    [EXPECTED_SOURCE]: { type: "vector", url: "mbtiles:///data/tiles.mbtiles" },
    attribution: { type: "vector", attribution: "test credit" },
  },
  layers: [
    { id: "bg", type: "background" },
    {
      id: "residential",
      type: "fill",
      source: EXPECTED_SOURCE,
      "source-layer": "landuse",
      filter: [
        "all",
        ["in", "class", "residential", "suburbs", "neighbourhood"],
        ["==", "class", "cemetery"],
      ],
      paint: {
        "fill-color": ["match", ["get", "class"], "park", "green", "blue"],
      },
    },
    {
      id: "mtb",
      type: "line",
      source: EXPECTED_SOURCE,
      "source-layer": "transportation",
      filter: ["has", "mtb_scale"],
      paint: { "line-color": ["get", "mtb_scale"] },
    },
  ],
};

test("analyzeStyle: collects sources, source-layers, and referenced fields", () => {
  const a = analyzeStyle(STYLE);
  assert.deepEqual(a.sources, [EXPECTED_SOURCE]);
  assert.deepEqual(a.sourceLayers, ["landuse", "transportation"]);
  assert.ok(a.allFields.has("class"), "shorthand + get fields are collected");
  assert.ok(a.allFields.has("mtb_scale"), "has/get fields are collected");
  assert.ok(!a.allFields.has("residential"), "in-list literals are not fields");
  assert.ok(!a.allFields.has("cemetery"), "== value literals are not fields");
  assert.ok(!a.allFields.has("park"), "match labels are not fields");
  assert.ok(!a.allFields.has("green"), "match value literals are not fields");
  assert.ok(a.fieldsBySourceLayer.get("landuse")!.has("class"));
  assert.ok(a.fieldsBySourceLayer.get("transportation")!.has("mtb_scale"));
});

test("analyzeStyle: ignores $-variables, zoom, and interpolation types", () => {
  const s: StyleDoc = {
    layers: [
      {
        id: "x",
        type: "line",
        source: EXPECTED_SOURCE,
        "source-layer": "transportation",
        paint: {
          "line-width": [
            "interpolate",
            ["linear", ["zoom"]],
            ["zoom"],
            5,
            1,
            10,
            4,
          ],
          "line-opacity": ["case", ["==", "$type", "LineString"], 1, 0],
        },
      },
    ],
  };
  const a = analyzeStyle(s);
  assert.ok(!a.allFields.has("zoom"), "zoom is not a data field");
  assert.ok(!a.allFields.has("$type"), "$-variables are not data fields");
  assert.ok(!a.allFields.has("linear"), "interpolation types are not fields");
  // No real data field is referenced here.
  assert.equal(a.allFields.size, 0);
});

test("withTileSources: inlines tiles templates, injects the mtb source, input untouched", () => {
  const out = withTileSources(
    STYLE,
    { tiles: ["http://localhost:8080/tiles/openmaptiles/{z}/{x}/{y}"] },
    { id: "mtb", spec: { tiles: ["http://localhost:8080/tiles/mtb/{z}/{x}/{y}"] } },
  );
  assert.deepEqual(
    out.sources![EXPECTED_SOURCE]!.tiles,
    ["http://localhost:8080/tiles/openmaptiles/{z}/{x}/{y}"],
  );
  // A leftover `url` would make MapLibre fetch it as a TileJSON endpoint.
  assert.equal(out.sources![EXPECTED_SOURCE]!.url, undefined);
  // Step 11: the MTB overlay source is injected (the vendored style never
  // declares it — it is app-specific).
  assert.equal(out.sources!.mtb!.type, "vector");
  assert.deepEqual(out.sources!.mtb!.tiles, ["http://localhost:8080/tiles/mtb/{z}/{x}/{y}"]);
  assert.equal(out.sources!.mtb!.url, undefined);
  // The original object is not mutated (the vendored file stays pristine).
  assert.equal(STYLE.sources![EXPECTED_SOURCE]!.url, "mbtiles:///data/tiles.mbtiles");
  assert.equal(STYLE.sources!.mtb, undefined, "the input style gains no mtb source");
  // The inert attribution source is preserved.
  assert.ok(out.sources!.attribution);
  assert.equal(out.sources!.attribution!.attribution, "test credit");
  // Without an app origin the sprite/glyphs are left as-is.
  assert.equal(out.sprite, "sprite");
  assert.equal(out.glyphs, "{fontstack}/{range}.pbf");
});

test("withTileSources: resolves relative sprite + glyphs against the app origin", () => {
  const out = withTileSources(
    STYLE,
    { tiles: ["http://myhost.example.com:8080/tiles/openmaptiles/{z}/{x}/{y}"] },
    { id: "mtb", spec: { tiles: ["http://myhost.example.com:8080/tiles/mtb/{z}/{x}/{y}"] } },
    "http://myhost.example.com:8080",
  );
  assert.deepEqual(
    out.sources![EXPECTED_SOURCE]!.tiles,
    ["http://myhost.example.com:8080/tiles/openmaptiles/{z}/{x}/{y}"],
  );
  assert.deepEqual(
    out.sources!.mtb!.tiles,
    ["http://myhost.example.com:8080/tiles/mtb/{z}/{x}/{y}"],
  );
  assert.equal(out.sprite, "http://myhost.example.com:8080/sprite");
  assert.equal(out.glyphs, "http://myhost.example.com:8080/{fontstack}/{range}.pbf");
  // The input object is not mutated (the vendored file stays pristine).
  assert.equal(STYLE.sprite, "sprite");
  assert.equal(STYLE.glyphs, "{fontstack}/{range}.pbf");
});

test("withTileSources: already-absolute sprite + glyphs are left as-is", () => {
  const s: StyleDoc = {
    ...STYLE,
    sprite: "https://cdn.example.com/sprite",
    glyphs: "https://cdn.example.com/{fontstack}/{range}.pbf",
  };
  const out = withTileSources(
    s,
    { tiles: ["http://x:8080/tiles/openmaptiles/{z}/{x}/{y}"] },
    { id: "mtb", spec: { tiles: ["http://x:8080/tiles/mtb/{z}/{x}/{y}"] } },
    "http://localhost:8080",
  );
  assert.equal(out.sprite, "https://cdn.example.com/sprite");
  assert.equal(out.glyphs, "https://cdn.example.com/{fontstack}/{range}.pbf");
});

test("withTileSources: a TileJSON url override is passed through verbatim", () => {
  const out = withTileSources(
    STYLE,
    { url: "https://tiles.example.com/openmaptiles" },
    { id: "mtb", spec: { url: "https://tiles.example.com/mtb" } },
  );
  assert.equal(out.sources![EXPECTED_SOURCE]!.url, "https://tiles.example.com/openmaptiles");
  assert.equal(out.sources![EXPECTED_SOURCE]!.tiles, undefined);
  assert.equal(out.sources!.mtb!.url, "https://tiles.example.com/mtb");
  assert.equal(out.sources!.mtb!.tiles, undefined);
});

test("withTileSources: throws when the expected source is missing", () => {
  assert.throws(
    () =>
      withTileSources(
        { sources: { other: { type: "vector" } } },
        { tiles: ["http://x/{z}/{x}/{y}"] },
        { id: "mtb", spec: { tiles: ["http://x/mtb/{z}/{x}/{y}"] } },
      ),
    /no "openmaptiles" source/,
  );
});

const baseCfg = { tileSourceUrl: "" } as Config;

test("buildAppOrigin: keeps the request port (app's own port)", () => {
  const req = { headers: { host: "myhost.example.com:8080" } };
  assert.equal(buildAppOrigin(req), "http://myhost.example.com:8080");
});

test("buildAppOrigin: honors x-forwarded-proto", () => {
  const req = { headers: { host: "localhost:8443", "x-forwarded-proto": "https" } };
  assert.equal(buildAppOrigin(req), "https://localhost:8443");
});

test("buildAppOrigin: IPv6 host from the client stays bracketed", () => {
  const req = { headers: { host: "[::1]:8080" } };
  assert.equal(buildAppOrigin(req), "http://[::1]:8080");
});

test("buildTileSourceSpec: inline tiles template on the app origin (step 12)", () => {
  const req = { headers: { host: "myhost.example.com:8080" } };
  assert.deepEqual(
    buildTileSourceSpec(req, baseCfg),
    {
      tiles: ["http://myhost.example.com:8080/tiles/openmaptiles/{z}/{x}/{y}"],
      maxzoom: REQUIRED_MAXZOOM,
    },
  );
});

test("buildTileSourceSpec: keeps the request port (the app's own port)", () => {
  const req = { headers: { host: "localhost:8080" } };
  assert.deepEqual(
    buildTileSourceSpec(req, baseCfg),
    {
      tiles: ["http://localhost:8080/tiles/openmaptiles/{z}/{x}/{y}"],
      maxzoom: REQUIRED_MAXZOOM,
    },
  );
});

test("buildTileSourceSpec: honors x-forwarded-proto", () => {
  const req = { headers: { host: "localhost", "x-forwarded-proto": "https" } };
  assert.deepEqual(
    buildTileSourceSpec(req, baseCfg),
    {
      tiles: ["https://localhost/tiles/openmaptiles/{z}/{x}/{y}"],
      maxzoom: REQUIRED_MAXZOOM,
    },
  );
});

test("buildTileSourceSpec: IPv6 host from the client stays bracketed", () => {
  const req = { headers: { host: "[::1]:8080" } };
  assert.deepEqual(
    buildTileSourceSpec(req, baseCfg),
    {
      tiles: ["http://[::1]:8080/tiles/openmaptiles/{z}/{x}/{y}"],
      maxzoom: REQUIRED_MAXZOOM,
    },
  );
});

test("buildTileSourceSpec: TILE_SOURCE_URL override -> TileJSON endpoint, verbatim", () => {
  const req = { headers: { host: "localhost:8080" } };
  const cfg = { tileSourceUrl: "https://mtb.example.com/tiles/openmaptiles" } as Config;
  assert.deepEqual(
    buildTileSourceSpec(req, cfg),
    { url: "https://mtb.example.com/tiles/openmaptiles" },
  );
});

test("buildMtbSourceSpec: inline tiles template, id from the file name (step 12)", () => {
  const req = { headers: { host: "myhost.example.com:8080" } };
  const cfg = { tileSourceUrl: "", mtbMbtilesFile: "/data/mtb.mbtiles" } as Config;
  assert.deepEqual(
    buildMtbSourceSpec(req, cfg),
    {
      tiles: ["http://myhost.example.com:8080/tiles/mtb/{z}/{x}/{y}"],
      maxzoom: REQUIRED_MAXZOOM,
    },
  );
});

test("buildMtbSourceSpec: follows a custom MTB_MBTILES_FILE name", () => {
  const req = { headers: { host: "localhost:8080" } };
  const cfg = {
    tileSourceUrl: "",
    mtbMbtilesFile: "/data/mtb-7.mbtiles",
  } as Config;
  assert.deepEqual(
    buildMtbSourceSpec(req, cfg),
    {
      tiles: ["http://localhost:8080/tiles/mtb-7/{z}/{x}/{y}"],
      maxzoom: REQUIRED_MAXZOOM,
    },
  );
});

test("buildMtbSourceSpec: TILE_SOURCE_URL override -> same base, mtb id swapped in", () => {
  const req = { headers: { host: "localhost:8080" } };
  const cfg = {
    tileSourceUrl: "https://mtb.example.com/tiles/openmaptiles",
    mtbMbtilesFile: "/data/mtb.mbtiles",
  } as Config;
  assert.deepEqual(
    buildMtbSourceSpec(req, cfg),
    { url: "https://mtb.example.com/tiles/mtb" },
  );
});

test("buildTileSourceSpec: BASE_PATH prefixes the /tiles template (sub-path mount)", () => {
  const req = { headers: { host: "maps.example.com" } };
  const cfg = { tileSourceUrl: "", basePath: "/mtb" } as Config;
  assert.deepEqual(
    buildTileSourceSpec(req, cfg),
    {
      tiles: ["http://maps.example.com/mtb/tiles/openmaptiles/{z}/{x}/{y}"],
      maxzoom: REQUIRED_MAXZOOM,
    },
  );
});

test("buildMtbSourceSpec: BASE_PATH prefixes the /tiles template (sub-path mount)", () => {
  const req = { headers: { host: "maps.example.com" } };
  const cfg = { tileSourceUrl: "", basePath: "/mtb", mtbMbtilesFile: "/data/mtb.mbtiles" } as Config;
  assert.deepEqual(
    buildMtbSourceSpec(req, cfg),
    {
      tiles: ["http://maps.example.com/mtb/tiles/mtb/{z}/{x}/{y}"],
      maxzoom: REQUIRED_MAXZOOM,
    },
  );
});

test("inline source specs cap maxzoom at the tileset max (blank-map regression)", () => {
  // The tileset ends at z14 and the server 404s deeper zooms. Without
  // `maxzoom` on the inline source spec, MapLibre (default source maxzoom
  // 18) requests z15+ tiles and the map renders completely blank beyond
  // z14. Capping maxzoom at REQUIRED_MAXZOOM makes MapLibre overzoom the
  // z14 vectors client-side instead. (The TILE_SOURCE_URL/TileJSON path
  // carries its own maxzoom and is not affected.)
  const req = { headers: { host: "localhost:8080" } };
  assert.equal(buildTileSourceSpec(req, baseCfg).maxzoom, REQUIRED_MAXZOOM);
  assert.equal(
    buildMtbSourceSpec(req, { tileSourceUrl: "", mtbMbtilesFile: "/data/mtb.mbtiles" } as Config).maxzoom,
    REQUIRED_MAXZOOM,
  );
});

test("withTileSources: sprite + glyphs keep the BASE_PATH prefix of the app origin", () => {
  const out = withTileSources(
    STYLE,
    { tiles: ["http://maps.example.com/mtb/tiles/openmaptiles/{z}/{x}/{y}"] },
    { id: "mtb", spec: { tiles: ["http://maps.example.com/mtb/tiles/mtb/{z}/{x}/{y}"] } },
    "http://maps.example.com/mtb",
  );
  assert.equal(out.sprite, "http://maps.example.com/mtb/sprite");
  assert.equal(out.glyphs, "http://maps.example.com/mtb/{fontstack}/{range}.pbf");
  // The input object is not mutated (the vendored file stays pristine).
  assert.equal(STYLE.sprite, "sprite");
  assert.equal(STYLE.glyphs, "{fontstack}/{range}.pbf");
});

test("checkStyleCompatibility: missing required layer is reported", () => {
  const a = analyzeStyle(STYLE);
  const declaredFields = new Map<string, string[]>([["landuse", ["class"]]]);
  const r = checkStyleCompatibility(a, ["landuse"], declaredFields);
  assert.deepEqual(r.missingRequiredLayers, ["transportation"]);
  // transportation is missing, so its field check is skipped (already reported).
  assert.equal(r.fieldWarnings.length, 0);
});

test("checkStyleCompatibility: all layers present + declared -> clean", () => {
  const a = analyzeStyle(STYLE);
  const declaredFields = new Map<string, string[]>([
    ["landuse", ["class"]],
    ["transportation", ["class", "mtb_scale"]],
  ]);
  const r = checkStyleCompatibility(a, ["landuse", "transportation"], declaredFields);
  assert.equal(r.missingRequiredLayers.length, 0);
  assert.equal(r.fieldWarnings.length, 0);
});

test("checkStyleCompatibility: used field not declared on its layer -> warning", () => {
  const a = analyzeStyle(STYLE);
  const declaredFields = new Map<string, string[]>([
    ["landuse", ["class"]],
    ["transportation", ["class"]], // has class but not mtb_scale
  ]);
  const r = checkStyleCompatibility(a, ["landuse", "transportation"], declaredFields);
  assert.equal(r.missingRequiredLayers.length, 0);
  assert.equal(r.fieldWarnings.length, 1);
  assert.match(r.fieldWarnings[0]!, /mtb_scale/);
  assert.match(r.fieldWarnings[0]!, /transportation/);
});

test("loadStyle: parses a style file and rejects bad JSON", () => {
  const good = join(dir, "good.json");
  writeFileSync(good, JSON.stringify(STYLE));
  const s = loadStyle(good);
  assert.equal(s.version, 8);
  assert.ok(s.layers && s.layers.length === 3);

  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{ not json");
  assert.throws(() => loadStyle(bad), /cannot parse style/);
});

test("renderSmokeTest: decodes a gzip MVT tile served over HTTP", async () => {
  const tile = tileBytes([
    layer("water", [feature([0, 0], pointGeometry(10, 10))], ["class"], [stringVal("ocean")]),
  ]);
  const server: Server = createServer((req, res) => {
    if (req.url === `/${EXPECTED_SOURCE}/1/0/0`) {
      res.setHeader("content-type", "application/x-protobuf");
      res.setHeader("content-encoding", "gzip");
      res.end(gzipSync(Buffer.from(tile)));
    } else {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as AddressInfo;
  try {
    const result = await renderSmokeTest(`http://127.0.0.1:${addr.port}`, EXPECTED_SOURCE);
    assert.ok(result.url.endsWith("/1/0/0"), `expected the served tile, got ${result.url}`);
    assert.ok(result.layers.includes("water"));
    assert.equal(result.featureCount, 1);
  } finally {
    server.close();
  }
});

test("renderSmokeTest: decodes a non-gzip tile too", async () => {
  const tile = tileBytes([
    layer("landuse", [feature([0, 0], pointGeometry(5, 5))], ["class"], [stringVal("grass")]),
  ]);
  const server: Server = createServer((req, res) => {
    if (req.url === `/${EXPECTED_SOURCE}/1/0/0`) {
      res.setHeader("content-type", "application/x-protobuf");
      res.end(Buffer.from(tile));
    } else {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as AddressInfo;
  try {
    const result = await renderSmokeTest(`http://127.0.0.1:${addr.port}`, EXPECTED_SOURCE);
    assert.equal(result.featureCount, 1);
    assert.ok(result.layers.includes("landuse"));
  } finally {
    server.close();
  }
});

test("renderSmokeTest: throws when nothing decodes", async () => {
  const server: Server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as AddressInfo;
  try {
    await assert.rejects(
      () => renderSmokeTest(`http://127.0.0.1:${addr.port}`, EXPECTED_SOURCE),
      /no decodable/,
    );
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// verifyMtbServing (step 11)
// ---------------------------------------------------------------------------

/**
 * An MTB MBTiles fixture with just the metadata verifyMtbServing reads from
 * the file (bounds); the tile content itself arrives over HTTP.
 */
function writeMtbMbtiles(file: string, bounds: string | null): void {
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  try {
    db.exec("CREATE TABLE metadata (name text, value text)");
    db.prepare("INSERT INTO metadata (name, value) VALUES ('format', 'pbf')").run();
    if (bounds !== null) {
      db.prepare("INSERT INTO metadata (name, value) VALUES ('bounds', ?)").run(bounds);
    }
  } finally {
    db.close();
  }
}

const MTB_TILE = tileBytes([
  layer("mtb", [feature([0, 0], pointGeometry(10, 10))], ["mtb_scale"], [stringVal("4")]),
]);

const MTB_TILE_URL_RE = /^\/mtb\/\d+\/\d+\/\d+$/;

// NOTE: the fixtures are all named `mtb.mbtiles` (in separate dirs) because
// Martin derives the source id from the file name, and verifyMtbServing
// requests exactly that id.
test("verifyMtbServing: finds a non-empty mtb_scale at the minzoom and z14 over HTTP", async () => {
  const file = join(dir, "serve-ok", "mtb.mbtiles");
  writeMtbMbtiles(file, "7,58,11,62");
  const server: Server = createServer((req, res) => {
    if (MTB_TILE_URL_RE.test(req.url ?? "")) {
      res.setHeader("content-type", "application/x-protobuf");
      res.end(Buffer.from(MTB_TILE));
    } else {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as AddressInfo;
  try {
    const cfg = { mtbMbtilesFile: file, mtbMinzoom: 7 } as Config;
    const result = await verifyMtbServing(cfg, `http://127.0.0.1:${addr.port}`);
    assert.equal(result.source, "mtb");
    assert.deepEqual(
      result.hits.map((h) => h.zoom).sort((a, b) => a - b),
      [7, 14],
      "both gate zooms (minzoom + z14) must hit",
    );
    for (const h of result.hits) {
      assert.equal(h.layer, "mtb");
      assert.equal(h.properties.mtb_scale, "4");
    }
  } finally {
    server.close();
  }
});

test("verifyMtbServing: finds content on the far side of wide bounds (scan must cover, not just the first corner)", async () => {
  // Mirrors the real Sørlandet tileset at z14: the bounds span 224×181 tiles
  // but content only exists in the central-eastern block x 8491-8612,
  // y 4794-4933. A corner-anchored raster scan burns its 2000-tile cap on
  // the first ~11 columns and never reaches it — the scan must cover the
  // whole bounds instead.
  const file = join(dir, "serve-far", "mtb.mbtiles");
  writeMtbMbtiles(file, "5.69866,57.58445,10.59256,59.67468");
  const server: Server = createServer((req, res) => {
    const m = /^\/mtb\/(\d+)\/(\d+)\/(\d+)$/.exec(req.url ?? "");
    if (m) {
      const z = Number(m[1]);
      const x = Number(m[2]);
      const y = Number(m[3]);
      const hasContent = z === 7 || (z === 14 && x >= 8491 && x <= 8612 && y >= 4794 && y <= 4933);
      if (hasContent) {
        res.setHeader("content-type", "application/x-protobuf");
        res.end(Buffer.from(MTB_TILE));
        return;
      }
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as AddressInfo;
  try {
    const cfg = { mtbMbtilesFile: file, mtbMinzoom: 7 } as Config;
    const result = await verifyMtbServing(cfg, `http://127.0.0.1:${addr.port}`);
    assert.deepEqual(
      result.hits.map((h) => h.zoom).sort((a, b) => a - b),
      [7, 14],
    );
    const z14 = result.hits.find((h) => h.zoom === 14)!;
    assert.ok(z14.x >= 8491 && z14.x <= 8612 && z14.y >= 4794 && z14.y <= 4933, "hit must be inside the content block");
  } finally {
    server.close();
  }
});

test("verifyMtbServing: throws when no served tile carries a non-empty mtb_scale", async () => {
  const file = join(dir, "serve-empty", "mtb.mbtiles");
  writeMtbMbtiles(file, "7,58,11,62");
  const noScale = tileBytes([
    layer("mtb", [feature([0, 0], pointGeometry(10, 10))], ["class"], [stringVal("track")]),
  ]);
  const server: Server = createServer((req, res) => {
    if (MTB_TILE_URL_RE.test(req.url ?? "")) {
      res.setHeader("content-type", "application/x-protobuf");
      res.end(Buffer.from(noScale));
    } else {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as AddressInfo;
  try {
    const cfg = { mtbMbtilesFile: file, mtbMinzoom: 7 } as Config;
    await assert.rejects(
      () => verifyMtbServing(cfg, `http://127.0.0.1:${addr.port}`),
      /no mtb feature with a non-empty mtb_scale/,
    );
  } finally {
    server.close();
  }
});

test("verifyMtbServing: throws when the tileset has no bounds metadata", async () => {
  const file = join(dir, "serve-nobounds", "mtb.mbtiles");
  writeMtbMbtiles(file, null);
  const cfg = { mtbMbtilesFile: file, mtbMinzoom: 7 } as Config;
  await assert.rejects(() => verifyMtbServing(cfg, "http://127.0.0.1:1"), /bounds/);
});
