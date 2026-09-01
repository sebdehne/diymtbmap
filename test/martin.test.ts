import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import Database from "better-sqlite3";
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

const STUB_SCRIPT = [
  '#!/usr/bin/env node',
  'const http = require("node:http");',
  'const fs = require("node:fs");',
  'const args = process.argv.slice(2);',
  'const listenArg = args[args.indexOf("--listen-addresses") + 1];',
  'const [host, port] = listenArg.split(":");',
  'const logFile = process.env.MARTIN_STUB_START_LOG;',
  'if (logFile) fs.appendFileSync(logFile, process.pid + "\\n");',
  'const server = http.createServer((req, res) => {',
  '  if (req.url === "/health") { res.writeHead(200, {"content-type":"text/plain"}); res.end("ok"); return; }',
  '  if (req.url === "/catalog") {',
  '    res.writeHead(200, {"content-type":"application/json"});',
  '    res.end(JSON.stringify({ tiles: { openmaptiles: { content_type: "application/x-protobuf" }, mtb: { content_type: "application/x-protobuf" } } }));',
  '    return;',
  '  }',
  '  res.writeHead(404); res.end();',
  '});',
  'server.listen(Number(port), host);',
  'process.on("SIGTERM", () => process.exit(0));',
].join("\n");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        srv.close();
        reject(new Error("could not determine a free port"));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}

function makeBasemap(file: string): void {
  const db = new Database(file);
  db.exec("CREATE TABLE metadata (name text, value text, PRIMARY KEY (name));");
  const meta = db.prepare("INSERT INTO metadata (name, value) VALUES (?, ?)");
  meta.run("name", "Synthetic Test");
  meta.run("format", "pbf");
  meta.run("minzoom", "0");
  meta.run("maxzoom", "14");
  meta.run(
    "json",
    JSON.stringify({
      name: "Synthetic Test",
      vector_layers: EXPECTED_LAYERS.map((id) => ({ id, name: id, fields: {} })),
    }),
  );
  db.close();
}

function countLines(file: string): number {
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean).length;
}

test("MartinServer.restart: restarts and still serves (no double start)", async () => {
  const root = mkdtempSync(join(tmpdir(), "martin-restart-"));
  const oldPath = process.env.PATH;
  const oldLogEnv = process.env.MARTIN_STUB_START_LOG;
  try {
    const binDir = join(root, "bin");
    const dataDir = join(root, "data");
    mkdirSync(binDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });

    const bin = join(binDir, "martin");
    writeFileSync(bin, STUB_SCRIPT);
    chmodSync(bin, 0o755);
    process.env.PATH = oldPath ? `${binDir}:${oldPath}` : binDir;
    const startsLog = join(root, "starts.log");
    process.env.MARTIN_STUB_START_LOG = startsLog;

    const basemap = join(dataDir, "openmaptiles.mbtiles");
    const mtb = join(dataDir, "mtb.mbtiles");
    const dem = join(dataDir, "dem.mbtiles");
    makeBasemap(basemap);
    writeFileSync(mtb, "");
    const yaml = join(dataDir, "martin.yaml");
    writeFileSync(yaml, `mbtiles:\n  - ${basemap}\n  - ${mtb}\n`);

    const cfg = {
      martinBind: "127.0.0.1",
      martinPort: await freePort(),
      martinConfig: yaml,
      mbtilesFile: basemap,
      mtbMbtilesFile: mtb,
      demMbtilesFile: dem,
    } as Config;

    const server = new MartinServer(cfg);
    await server.start();
    assert.equal(countLines(startsLog), 1);
    assert.deepEqual(server.sources, ["mtb", "openmaptiles"]);

    await server.restart();
    assert.equal(countLines(startsLog), 2);
    const res = await fetch(`${server.url}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(server.sources, ["mtb", "openmaptiles"]);

    server.shutdown();
  } finally {
    process.env.PATH = oldPath;
    process.env.MARTIN_STUB_START_LOG = oldLogEnv;
    rmSync(root, { recursive: true, force: true });
  }
});
