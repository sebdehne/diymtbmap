import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test, after } from "node:test";
import Database from "better-sqlite3";
import { EXPECTED_SOURCE, expectedDemSource } from "../src/martin.js";
import { readDemSpec } from "../src/verify.js";
import {
  buildDemSourceSpec,
  verifyDemServing,
  withTileSources,
  type StyleDoc,
} from "../src/style.js";
import type { Config } from "../src/config.js";
import {
  DEM_ENCODING,
  DEM_SOURCE,
  DEFAULT_TERRAIN_EXAGGERATION,
  applyTerrain,
} from "../shared/terrain.js";

const dir = mkdtempSync(join(tmpdir(), "dem-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/**
 * Writes a dem.mbtiles fixture (SQLite, MBTiles metadata) with the given
 * metadata rows — just enough for readDemSpec / demSpecFor to read. The tile
 * content itself arrives over HTTP (see verifyDemServing).
 */
function writeDemMbtiles(file: string, meta: Record<string, string>): void {
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  try {
    db.exec("CREATE TABLE metadata (name text, value text)");
    for (const [name, value] of Object.entries(meta)) {
      db.prepare("INSERT INTO metadata (name, value) VALUES (?, ?)").run(name, value);
    }
  } finally {
    db.close();
  }
}

/**
 * A minimal PNG: the 8-byte signature + an IHDR chunk carrying the requested
 * width/height (big-endian). verifyDemServing only inspects the signature and
 * the IHDR dimensions — it never decodes the (absent) pixel data.
 */
function pngBytes(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33); // signature + IHDR chunk (4 len + 4 type + 13 payload + 4 crc)
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buf.writeUInt32BE(13, 8); // IHDR payload length
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

// ---------------------------------------------------------------------------
// expectedDemSource (src/martin.ts)
// ---------------------------------------------------------------------------

test("expectedDemSource: Martin's id is the file name minus .mbtiles", () => {
  assert.equal(expectedDemSource("/data/dem.mbtiles"), "dem");
  assert.equal(expectedDemSource("/data/dem-7.mbtiles"), "dem-7");
  assert.equal(expectedDemSource("terrain.mbtiles"), "terrain");
  assert.equal(expectedDemSource("/data/odd"), "odd");
});

// ---------------------------------------------------------------------------
// readDemSpec (src/verify.ts)
// ---------------------------------------------------------------------------

test("readDemSpec: reads the artifact's serving spec from its metadata", () => {
  const file = join(dir, "spec", "dem.mbtiles");
  writeDemMbtiles(file, {
    name: "Norway DTM",
    format: "png",
    bounds: "-1.6,57.4,32.9,70.9",
    minzoom: "6",
    maxzoom: "11",
    tileSize: "512",
    encoding: "mapbox",
  });
  const spec = readDemSpec(file);
  assert.deepEqual(spec.bounds, [-1.6, 57.4, 32.9, 70.9]);
  assert.equal(spec.minzoom, 6);
  assert.equal(spec.maxzoom, 11);
  assert.equal(spec.tileSize, 512);
  assert.equal(spec.encoding, "mapbox");
});

test("readDemSpec: falls back to the documented contract for absent fields", () => {
  const file = join(dir, "spec-fallback", "dem.mbtiles");
  writeDemMbtiles(file, { format: "png" }); // no min/max/tileSize/encoding/bounds
  const spec = readDemSpec(file);
  assert.equal(spec.minzoom, 6);
  assert.equal(spec.maxzoom, 11);
  assert.equal(spec.tileSize, 512);
  assert.equal(spec.encoding, "mapbox");
  assert.equal(spec.bounds, null);
});

test("readDemSpec: honors a terrarium encoding + non-default tileSize", () => {
  const file = join(dir, "spec-terrarium", "dem.mbtiles");
  writeDemMbtiles(file, { format: "png", encoding: "terrarium", tileSize: "256" });
  const spec = readDemSpec(file);
  assert.equal(spec.encoding, "terrarium");
  assert.equal(spec.tileSize, 256);
});

// ---------------------------------------------------------------------------
// buildDemSourceSpec (src/style.ts)
// ---------------------------------------------------------------------------

test("buildDemSourceSpec: inline tiles template, id from the file name, spec from the artifact", () => {
  const file = join(dir, "bld", "dem.mbtiles");
  writeDemMbtiles(file, {
    bounds: "-1.6,57.4,32.9,70.9",
    minzoom: "6",
    maxzoom: "11",
    tileSize: "512",
    encoding: "mapbox",
  });
  const req = { headers: { host: "myhost.example.com:8080" } };
  const cfg = { tileSourceUrl: "", demMbtilesFile: file } as Config;
  assert.deepEqual(buildDemSourceSpec(req, cfg), {
    tiles: ["http://myhost.example.com:8080/tiles/dem/{z}/{x}/{y}"],
    minzoom: 6,
    maxzoom: 11,
    tileSize: 512,
    encoding: "mapbox",
  });
});

test("buildDemSourceSpec: follows a custom DEM_MBTILES_FILE name + terrarium spec", () => {
  const file = join(dir, "bld-2", "terrain-7.mbtiles");
  writeDemMbtiles(file, { tileSize: "256", encoding: "terrarium" });
  const req = { headers: { host: "localhost:8080" } };
  const cfg = { tileSourceUrl: "", demMbtilesFile: file } as Config;
  const spec = buildDemSourceSpec(req, cfg);
  assert.deepEqual(spec.tiles, ["http://localhost:8080/tiles/terrain-7/{z}/{x}/{y}"]);
  assert.equal(spec.encoding, "terrarium");
  assert.equal(spec.tileSize, 256);
});

test("buildDemSourceSpec: BASE_PATH prefixes the /tiles template (sub-path mount)", () => {
  const file = join(dir, "bld-3", "dem.mbtiles");
  writeDemMbtiles(file, { tileSize: "512", encoding: "mapbox" });
  const req = { headers: { host: "maps.example.com" } };
  const cfg = { tileSourceUrl: "", basePath: "/mtb", demMbtilesFile: file } as Config;
  const spec = buildDemSourceSpec(req, cfg);
  assert.deepEqual(spec.tiles, ["http://maps.example.com/mtb/tiles/dem/{z}/{x}/{y}"]);
});

// ---------------------------------------------------------------------------
// withTileSources — the optional dem source (src/style.ts)
// ---------------------------------------------------------------------------

const STYLE: StyleDoc = {
  version: 8,
  name: "synthetic",
  sources: {
    [EXPECTED_SOURCE]: { type: "vector", url: "mbtiles:///data/tiles.mbtiles" },
  },
  layers: [{ id: "bg", type: "background" }],
};

test("withTileSources: injects the dem raster-dem source when provided", () => {
  const out = withTileSources(
    STYLE,
    { tiles: ["http://localhost:8080/tiles/openmaptiles/{z}/{x}/{y}"] },
    { id: "mtb", spec: { tiles: ["http://localhost:8080/tiles/mtb/{z}/{x}/{y}"] } },
    undefined,
    {
      id: "dem",
      spec: {
        tiles: ["http://localhost:8080/tiles/dem/{z}/{x}/{y}"],
        minzoom: 6,
        maxzoom: 11,
        tileSize: 512,
        encoding: "mapbox",
      },
    },
  );
  assert.equal(out.sources!.dem!.type, "raster-dem");
  assert.deepEqual(out.sources!.dem!.tiles, ["http://localhost:8080/tiles/dem/{z}/{x}/{y}"]);
  assert.equal(out.sources!.dem!.tileSize, 512);
  assert.equal(out.sources!.dem!.encoding, "mapbox");
  assert.equal(out.sources!.dem!.minzoom, 6);
  assert.equal(out.sources!.dem!.maxzoom, 11);
  // The input style gains no dem source (the vendored file stays pristine).
  assert.equal(STYLE.sources!.dem, undefined);
});

test("withTileSources: omits the dem source when not provided (no-DEM deployment)", () => {
  const out = withTileSources(
    STYLE,
    { tiles: ["http://localhost:8080/tiles/openmaptiles/{z}/{x}/{y}"] },
    { id: "mtb", spec: { tiles: ["http://localhost:8080/tiles/mtb/{z}/{x}/{y}"] } },
  );
  assert.equal(out.sources!.dem, undefined, "no dem source when absent");
  // The required sources are still injected.
  assert.ok(out.sources![EXPECTED_SOURCE]);
  assert.ok(out.sources!.mtb);
});

// ---------------------------------------------------------------------------
// verifyDemServing (src/style.ts)
// ---------------------------------------------------------------------------

const DEM_TILE_URL_RE = /^\/dem\/\d+\/\d+\/\d+$/;

test("verifyDemServing: serves a PNG of the artifact's tileSize over HTTP", async () => {
  const file = join(dir, "serve-ok", "dem.mbtiles");
  writeDemMbtiles(file, {
    bounds: "-1.6,57.4,32.9,70.9",
    minzoom: "6",
    maxzoom: "11",
    tileSize: "512",
    encoding: "mapbox",
  });
  const server: Server = createServer((req, res) => {
    if (DEM_TILE_URL_RE.test(req.url ?? "")) {
      res.setHeader("content-type", "image/png");
      res.end(pngBytes(512, 512));
    } else {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as AddressInfo;
  try {
    const cfg = { demMbtilesFile: file } as Config;
    const result = await verifyDemServing(cfg, `http://127.0.0.1:${addr.port}`);
    assert.equal(result.source, "dem");
    assert.equal(result.tileSize, 512);
    assert.equal(result.encoding, "mapbox");
    assert.equal(result.minzoom, 6);
    assert.equal(result.maxzoom, 11);
  } finally {
    server.close();
  }
});

test("verifyDemServing: throws when the served tile is not a PNG", async () => {
  const file = join(dir, "serve-notpng", "dem.mbtiles");
  writeDemMbtiles(file, { tileSize: "512" });
  const server: Server = createServer((_req, res) => {
    res.setHeader("content-type", "text/plain");
    res.end(Buffer.from("not a png"));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as AddressInfo;
  try {
    const cfg = { demMbtilesFile: file } as Config;
    await assert.rejects(
      () => verifyDemServing(cfg, `http://127.0.0.1:${addr.port}`),
      /not a PNG/,
    );
  } finally {
    server.close();
  }
});

test("verifyDemServing: throws when the PNG size != the artifact's tileSize", async () => {
  const file = join(dir, "serve-wrongsize", "dem.mbtiles");
  writeDemMbtiles(file, { tileSize: "512" }); // artifact is 512, served PNG is 256
  const server: Server = createServer((_req, res) => {
    res.setHeader("content-type", "image/png");
    res.end(pngBytes(256, 256));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as AddressInfo;
  try {
    const cfg = { demMbtilesFile: file } as Config;
    await assert.rejects(
      () => verifyDemServing(cfg, `http://127.0.0.1:${addr.port}`),
      /but the artifact is 512px/,
    );
  } finally {
    server.close();
  }
});

test("verifyDemServing: throws on a 404 (source not served)", async () => {
  const file = join(dir, "serve-404", "dem.mbtiles");
  writeDemMbtiles(file, { tileSize: "512" });
  const server: Server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as AddressInfo;
  try {
    const cfg = { demMbtilesFile: file } as Config;
    await assert.rejects(
      () => verifyDemServing(cfg, `http://127.0.0.1:${addr.port}`),
      /HTTP 404/,
    );
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// shared/terrain.js (pure helpers for the web UI + this suite)
// ---------------------------------------------------------------------------

test("terrain: stable ids + defaults", () => {
  assert.equal(DEM_SOURCE, "dem");
  assert.equal(DEM_ENCODING, "mapbox");
  assert.equal(DEFAULT_TERRAIN_EXAGGERATION, 1.5);
});

test("applyTerrain: enables 3D terrain on the dem source with the default exaggeration", () => {
  let terrain: unknown = "unset";
  const map = { setTerrain: (t: unknown) => { terrain = t; } };
  applyTerrain(map, true);
  assert.deepEqual(terrain, { source: DEM_SOURCE, exaggeration: DEFAULT_TERRAIN_EXAGGERATION });
});

test("applyTerrain: uses a custom exaggeration", () => {
  let terrain: unknown = "unset";
  const map = { setTerrain: (t: unknown) => { terrain = t; } };
  applyTerrain(map, true, 2);
  assert.deepEqual(terrain, { source: DEM_SOURCE, exaggeration: 2 });
});

test("applyTerrain: uses a custom source id (follows a non-default DEM_MBTILES_FILE name)", () => {
  let terrain: unknown = "unset";
  const map = { setTerrain: (t: unknown) => { terrain = t; } };
  applyTerrain(map, true, 1.5, "terrain-7");
  assert.deepEqual(terrain, { source: "terrain-7", exaggeration: 1.5 });
  // Off still clears terrain regardless of the source id.
  applyTerrain(map, false, 1.5, "terrain-7");
  assert.equal(terrain, null);
});

test("applyTerrain: falls back to the default for an invalid exaggeration", () => {
  let terrain: unknown = "unset";
  const map = { setTerrain: (t: unknown) => { terrain = t; } };
  applyTerrain(map, true, NaN);
  assert.deepEqual(terrain, { source: DEM_SOURCE, exaggeration: DEFAULT_TERRAIN_EXAGGERATION });
  applyTerrain(map, true, 0);
  assert.deepEqual(terrain, { source: DEM_SOURCE, exaggeration: DEFAULT_TERRAIN_EXAGGERATION });
});

test("applyTerrain: off disables terrain (setTerrain(null))", () => {
  let terrain: unknown = "unset";
  const map = { setTerrain: (t: unknown) => { terrain = t; } };
  applyTerrain(map, false);
  assert.equal(terrain, null);
});

test("applyTerrain: safe when the map is not ready (no throw)", () => {
  assert.doesNotThrow(() => applyTerrain(null, true));
  assert.doesNotThrow(() => applyTerrain({}, true));
});

test("applyTerrain: no-op until the style is loaded (avoids setTerrain throwing on an unready map)", () => {
  let terrain: unknown = "unset";
  let styleLoaded = false;
  const map = {
    setTerrain: (t: unknown) => {
      if (!styleLoaded) throw new Error("Style is not done loading.");
      terrain = t;
    },
  };
  // Before the style document finishes loading, MapLibre's setTerrain throws
  // "Style is not done loading." — applyTerrain must swallow it (the
  // terrain-toggle regression), not let it unmount the control.
  applyTerrain(map, true);
  assert.equal(terrain, "unset", "setTerrain is skipped while the style is still loading");
  // Once the style is loaded (the `load` event fired), the same call takes effect.
  styleLoaded = true;
  applyTerrain(map, true);
  assert.deepEqual(terrain, { source: DEM_SOURCE, exaggeration: DEFAULT_TERRAIN_EXAGGERATION });
});

test("applyTerrain: applies even while isStyleLoaded() is false (sources still settling after load)", () => {
  let terrain: unknown = "unset";
  // Mirrors MapLibre mid-load-handler: the style document IS loaded (so
  // setTerrain works), but Style.loaded() — and thus isStyleLoaded() — is
  // false because addLayer/setLayoutProperty queued a source reload
  // (Style._updatedSources). Guarding on isStyleLoaded() here no-oped the
  // initial apply and left the map flat until a toggle ("3D on but flat" bug).
  const map = {
    setTerrain: (t: unknown) => { terrain = t; },
    isStyleLoaded: () => false,
  };
  applyTerrain(map, true);
  assert.deepEqual(terrain, { source: DEM_SOURCE, exaggeration: DEFAULT_TERRAIN_EXAGGERATION });
});

test("applyTerrain: never touches the camera pitch (the map stays top-down until the visitor tilts)", () => {
  let terrain: unknown = "unset";
  const pitchCalls: number[] = [];
  const map = {
    setTerrain: (t: unknown) => { terrain = t; },
    setPitch: (p: number) => { pitchCalls.push(p); },
  };
  applyTerrain(map, true);
  assert.deepEqual(terrain, { source: DEM_SOURCE, exaggeration: DEFAULT_TERRAIN_EXAGGERATION });
  applyTerrain(map, false);
  assert.equal(terrain, null);
  assert.deepEqual(pitchCalls, [], "toggling terrain never moves the camera");
});
