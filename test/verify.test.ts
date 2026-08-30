import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { join } from "node:path";
import { test, after } from "node:test";
import Database from "better-sqlite3";
import {
  EXPECTED_LAYERS,
  readMtbBounds,
  verifyMbtiles,
  verifyMtbMbtiles,
} from "../src/verify.js";
import { feature, layer, pointGeometry, stringVal, tileBytes } from "./mvt.js";

const dir = mkdtempSync(join(tmpdir(), "mtb-verify-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** transportation layer with one track feature; mtb_scale may be empty. */
function transportTile(mtbScale: string): Uint8Array {
  // MVT tags are a flat [keyIdx, valueIdx, ...] list: class→track, mtb_scale→<value>
  const f = feature([0, 0, 1, 1], pointGeometry(128, 128));
  return tileBytes([layer("transportation", [f], ["class", "mtb_scale"], [stringVal("track"), stringVal(mtbScale)])]);
}

interface MakeOpts {
  layers?: readonly string[];
  transportFields?: Record<string, string>;
  z14Tile?: Uint8Array;
  extraZ14Tiles?: { x: number; data: Uint8Array }[];
  format?: string;
  minzoom?: string;
  maxzoom?: string;
  bounds?: string | null;
  compact?: boolean;
  /** Store tile data gzip-compressed, like planetiler (metadata compression=gzip). */
  gzipTiles?: boolean;
}

/** Synthetic OMT-style MBTiles: z0–z14 tiles at (0,0), metadata per OMT spec. */
function makeMbtiles(file: string, opts: MakeOpts = {}): void {
  const layers = opts.layers ?? EXPECTED_LAYERS;
  const transportFields = opts.transportFields ?? { class: "string", mtb_scale: "string" };
  const vectorLayers = layers.map((id) => ({
    id,
    name: id,
    description: "",
    minzoom: 0,
    maxzoom: 14,
    fields: id === "transportation" ? transportFields : { class: "string" },
  }));

  const db = new Database(file);
  if (opts.compact !== false) {
    db.exec(`
      CREATE TABLE metadata (name text, value text, PRIMARY KEY (name));
      CREATE TABLE tiles_shallow (
        zoom_level integer, tile_column integer, tile_row integer, tile_data_id integer,
        PRIMARY KEY (zoom_level, tile_column, tile_row)
      );
      CREATE TABLE tiles_data (tile_data_id integer PRIMARY KEY, tile_data);
      CREATE VIEW tiles AS
        SELECT zoom_level, tile_column, tile_row, tile_data
        FROM tiles_shallow LEFT JOIN tiles_data ON tiles_data.tile_data_id = tiles_shallow.tile_data_id;
    `);
  } else {
    db.exec(`
      CREATE TABLE metadata (name text, value text, PRIMARY KEY (name));
      CREATE TABLE tiles (
        zoom_level integer, tile_column integer, tile_row integer, tile_data,
        PRIMARY KEY (zoom_level, tile_column, tile_row)
      );
    `);
  }

  const meta = db.prepare("INSERT INTO metadata (name, value) VALUES (?, ?)");
  meta.run("name", "Synthetic Test");
  meta.run("description", "test");
  meta.run("attribution", "test");
  meta.run("version", "3.16");
  meta.run("type", "basemap");
  meta.run("format", opts.format ?? "pbf");
  meta.run("minzoom", opts.minzoom ?? "0");
  meta.run("maxzoom", opts.maxzoom ?? "14");
  // Small box around the antipodal point: covers tile (x=0..1, y=0) at z14 so
  // the mtb_scale scan stays a 2-position loop.
  if (opts.bounds !== null) meta.run("bounds", opts.bounds ?? "-179.99,85.05,-179.97,85.06");
  meta.run("center", "-179.98,85.055,0");
  meta.run(
    "json",
    JSON.stringify({ name: "test", vector_layers: vectorLayers }),
  );

  const insertPlain =
    opts.compact === false
      ? db.prepare("INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)")
      : null;
  const insertData =
    opts.compact !== false
      ? db.prepare("INSERT INTO tiles_data (tile_data_id, tile_data) VALUES (?, ?)")
      : null;
  const insertShallow =
    opts.compact !== false
      ? db.prepare("INSERT INTO tiles_shallow (zoom_level, tile_column, tile_row, tile_data_id) VALUES (?, ?, ?, ?)")
      : null;

  const putTile = (z: number, x: number, data: Uint8Array): void => {
    const tmsRow = (1 << z) - 1; // y_xyz = 0
    const stored = opts.gzipTiles ? gzipSync(Buffer.from(data)) : Buffer.from(data);
    if (opts.compact === false) {
      insertPlain!.run(z, x, tmsRow, stored);
    } else {
      const row = db.prepare("SELECT COALESCE(MAX(tile_data_id), 0) + 1 AS next FROM tiles_data").get() as { next: number };
      insertData!.run(row.next, stored);
      insertShallow!.run(z, x, tmsRow, row.next);
    }
  };

  for (let z = 0; z <= 14; z++) {
    putTile(z, 0, z === 14 ? (opts.z14Tile ?? transportTile("4")) : new Uint8Array(0));
  }
  for (const t of opts.extraZ14Tiles ?? []) putTile(14, t.x, t.data);

  db.close();
}

test("accepts a valid compact tileset with an mtb_scale feature", () => {
  const file = join(dir, "ok.mbtiles");
  makeMbtiles(file);
  const v = verifyMbtiles(file);
  assert.equal(v.format, "pbf");
  assert.equal(v.maxzoom, 14);
  assert.equal(v.layers.length, 16);
  assert.deepEqual(v.zooms, Array.from({ length: 15 }, (_, i) => i));
  assert.equal(v.mtbHit.zoom, 14);
  assert.equal(v.mtbHit.x, 0);
  assert.equal(v.mtbHit.layer, "transportation");
  assert.equal(v.mtbHit.properties.mtb_scale, "4");
  assert.equal(v.tilesScanned, 1);
});

test("accepts the plain tiles-table layout", () => {
  const file = join(dir, "ok-plain.mbtiles");
  makeMbtiles(file, { compact: false });
  const v = verifyMbtiles(file);
  assert.equal(v.mtbHit.properties.mtb_scale, "4");
});

test("accepts gzip-compressed tiles (planetiler default)", () => {
  const file = join(dir, "ok-gzip.mbtiles");
  makeMbtiles(file, { gzipTiles: true });
  const v = verifyMbtiles(file);
  assert.equal(v.mtbHit.properties.mtb_scale, "4");
});

test("rejects a non-vector format", () => {
  const file = join(dir, "bad-format.mbtiles");
  makeMbtiles(file, { format: "png" });
  assert.throws(() => verifyMbtiles(file), /unexpected tile format "png"/);
});

test("rejects maxzoom below 14", () => {
  const file = join(dir, "bad-maxzoom.mbtiles");
  makeMbtiles(file, { maxzoom: "13" });
  assert.throws(() => verifyMbtiles(file), /maxzoom must be >= 14/);
});

test("rejects a missing required layer", () => {
  const file = join(dir, "bad-layers.mbtiles");
  makeMbtiles(file, { layers: EXPECTED_LAYERS.filter((l) => l !== "waterway") });
  assert.throws(() => verifyMbtiles(file), /missing required layers: waterway/);
});

test("accepts a tileset without an optional layer (aerodrome_label)", () => {
  const file = join(dir, "no-optional.mbtiles");
  makeMbtiles(file, { layers: EXPECTED_LAYERS.filter((l) => l !== "aerodrome_label") });
  const v = verifyMbtiles(file);
  assert.equal(v.layers.length, 15);
});

test("accepts a tileset where mtb_scale is not a declared field but a feature carries it", () => {
  // planetiler derives declared fields from emitted features; a feature-level
  // mtb_scale is what matters, so verification must pass (with a warning).
  const file = join(dir, "warn-field.mbtiles");
  makeMbtiles(file, { transportFields: { class: "string" } });
  const v = verifyMbtiles(file);
  assert.equal(v.mtbHit.properties.mtb_scale, "4");
});

test("rejects an empty mtb_scale value", () => {
  const file = join(dir, "empty-mtb.mbtiles");
  makeMbtiles(file, { z14Tile: transportTile("") });
  assert.throws(() => verifyMbtiles(file), /no transportation feature with a non-empty mtb_scale/);
});

test("rejects when the scan cap is exceeded", () => {
  const file = join(dir, "cap.mbtiles");
  const noHit = transportTile("");
  makeMbtiles(file, { z14Tile: noHit, extraZ14Tiles: [{ x: 1, data: noHit }] });
  assert.throws(() => verifyMbtiles(file, { maxTiles: 1 }), /safety cap of 1 tiles/);
});

test("rejects when bounds metadata is missing", () => {
  const file = join(dir, "no-bounds.mbtiles");
  makeMbtiles(file, { bounds: null });
  assert.throws(() => verifyMbtiles(file), /bounds metadata/);
});

test("reports progress through onScan", () => {
  const file = join(dir, "scan-cb.mbtiles");
  makeMbtiles(file, { z14Tile: transportTile("") });
  const counts: number[] = [];
  assert.throws(
    () => verifyMbtiles(file, { onScan: (n) => counts.push(n) }),
    /no transportation feature/,
  );
  assert.ok(counts.length >= 1, "onScan should be called for each scanned tile");
  assert.equal(counts[0], 1);
});

// ---------------------------------------------------------------------------
// verifyMtbMbtiles (step 11: the dedicated MTB overlay tileset)
// ---------------------------------------------------------------------------

/** mtb layer with one feature; mtb_scale may be empty. */
function mtbTile(scale: string): Uint8Array {
  const f = feature([0, 0], pointGeometry(128, 128));
  return tileBytes([layer("mtb", [f], ["mtb_scale"], [stringVal(scale)])]);
}

interface MakeMtbOpts {
  minzoom?: string;
  maxzoom?: string;
  /** The `mtb_minzoom` metadata; null omits it. */
  mtbMinzoom?: string | null;
  layers?: readonly string[];
  /** null omits the mtb_scale field from the declaration. */
  mtbFields?: Record<string, string> | null;
  bounds?: string | null;
  /** Per-zoom mtb_scale value (default "4" at every zoom). */
  scaleAt?: Partial<Record<number, string>>;
  omitZooms?: number[];
  /** Extra zooms outside minzoom..maxzoom (e.g. tiles below the minzoom). */
  extraZooms?: number[];
  compact?: boolean;
  gzipTiles?: boolean;
}

/** Synthetic MTB overlay MBTiles (step 11 shape): layer mtb, z minzoom..14. */
function makeMtbMbtiles(file: string, opts: MakeMtbOpts = {}): void {
  const minzoom = Number.parseInt(opts.minzoom ?? "7", 10);
  const maxzoom = Number.parseInt(opts.maxzoom ?? "14", 10);
  const layers = opts.layers ?? ["mtb"];
  const fields = opts.mtbFields === null ? {} : opts.mtbFields ?? { mtb_scale: "string" };
  const vectorLayers = layers.map((id) => ({
    id,
    name: id,
    description: "",
    minzoom,
    maxzoom,
    fields: id === "mtb" ? fields : { class: "string" },
  }));

  const db = new Database(file);
  if (opts.compact !== false) {
    db.exec(`
      CREATE TABLE metadata (name text, value text, PRIMARY KEY (name));
      CREATE TABLE tiles_shallow (
        zoom_level integer, tile_column integer, tile_row integer, tile_data_id integer,
        PRIMARY KEY (zoom_level, tile_column, tile_row)
      );
      CREATE TABLE tiles_data (tile_data_id integer PRIMARY KEY, tile_data);
      CREATE VIEW tiles AS
        SELECT zoom_level, tile_column, tile_row, tile_data
        FROM tiles_shallow LEFT JOIN tiles_data ON tiles_data.tile_data_id = tiles_shallow.tile_data_id;
    `);
  } else {
    db.exec(`
      CREATE TABLE metadata (name text, value text, PRIMARY KEY (name));
      CREATE TABLE tiles (
        zoom_level integer, tile_column integer, tile_row integer, tile_data,
        PRIMARY KEY (zoom_level, tile_column, tile_row)
      );
    `);
  }

  const meta = db.prepare("INSERT INTO metadata (name, value) VALUES (?, ?)");
  meta.run("name", "MTB Overlay");
  meta.run("type", "overlay");
  meta.run("format", "pbf");
  meta.run("minzoom", opts.minzoom ?? "7");
  meta.run("maxzoom", opts.maxzoom ?? "14");
  if (opts.mtbMinzoom !== null) meta.run("mtb_minzoom", opts.mtbMinzoom ?? (opts.minzoom ?? "7"));
  if (opts.bounds !== null) {
    meta.run("bounds", opts.bounds ?? "-179.99,85.05,-179.97,85.06");
  }
  meta.run("json", JSON.stringify({ name: "mtb", vector_layers: vectorLayers }));

  const insertPlain =
    opts.compact === false
      ? db.prepare("INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)")
      : null;
  const insertData =
    opts.compact !== false
      ? db.prepare("INSERT INTO tiles_data (tile_data_id, tile_data) VALUES (?, ?)")
      : null;
  const insertShallow =
    opts.compact !== false
      ? db.prepare("INSERT INTO tiles_shallow (zoom_level, tile_column, tile_row, tile_data_id) VALUES (?, ?, ?, ?)")
      : null;
  const putTile = (z: number, x: number, data: Uint8Array): void => {
    const tmsRow = (1 << z) - 1; // y_xyz = 0
    const stored = opts.gzipTiles ? gzipSync(Buffer.from(data)) : Buffer.from(data);
    if (opts.compact === false) {
      insertPlain!.run(z, x, tmsRow, stored);
    } else {
      const row = db
        .prepare("SELECT COALESCE(MAX(tile_data_id), 0) + 1 AS next FROM tiles_data")
        .get() as { next: number };
      insertData!.run(row.next, stored);
      insertShallow!.run(z, x, tmsRow, row.next);
    }
  };

  for (let z = minzoom; z <= maxzoom; z++) {
    if (opts.omitZooms?.includes(z)) continue;
    putTile(z, 0, mtbTile(opts.scaleAt?.[z] ?? "4"));
  }
  for (const z of opts.extraZooms ?? []) putTile(z, 0, mtbTile("4"));
  db.close();
}

test("mtb tileset: accepts a valid z7-z14 tileset (mtb layer, mtb_scale at both gate zooms)", () => {
  const file = join(dir, "mtb-ok.mbtiles");
  makeMtbMbtiles(file);
  const v = verifyMtbMbtiles(file, 7);
  assert.equal(v.format, "pbf");
  assert.equal(v.minzoom, 7);
  assert.equal(v.maxzoom, 14);
  assert.equal(v.mtbMinzoom, 7);
  assert.deepEqual(v.layers, ["mtb"]);
  assert.deepEqual(v.zooms, [7, 8, 9, 10, 11, 12, 13, 14]);
  assert.deepEqual(v.hits.map((h) => h.zoom).sort((a, b) => a - b), [7, 14]);
  assert.equal(v.hits[0]!.layer, "mtb");
  assert.equal(v.hits[0]!.properties.mtb_scale, "4");
});

test("mtb tileset: accepts gzip tiles + the plain layout (planetiler variants)", () => {
  const gzip = join(dir, "mtb-gzip.mbtiles");
  makeMtbMbtiles(gzip, { gzipTiles: true });
  assert.equal(verifyMtbMbtiles(gzip, 7).hits.length, 2);
  const plain = join(dir, "mtb-plain.mbtiles");
  makeMtbMbtiles(plain, { compact: false });
  assert.equal(verifyMtbMbtiles(plain, 7).hits.length, 2);
});

test("mtb tileset: accepts a different MTB_MINZOOM (e.g. 5)", () => {
  const file = join(dir, "mtb-z5.mbtiles");
  makeMtbMbtiles(file, { minzoom: "5" });
  const v = verifyMtbMbtiles(file, 5);
  assert.deepEqual(v.zooms, [5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  assert.deepEqual(v.hits.map((h) => h.zoom).sort((a, b) => a - b), [5, 14]);
});

test("mtb tileset: stale minzoom (built 7, now 12) fails with the FORCE_REIMPORT hint", () => {
  const file = join(dir, "mtb-stale.mbtiles");
  makeMtbMbtiles(file);
  assert.throws(
    () => verifyMtbMbtiles(file, 12),
    /stale artifact, rebuild with FORCE_REIMPORT=1/,
  );
});

test("mtb tileset: missing mtb_minzoom metadata fails with the FORCE_REIMPORT hint", () => {
  const file = join(dir, "mtb-nometa.mbtiles");
  makeMtbMbtiles(file, { mtbMinzoom: null });
  assert.throws(
    () => verifyMtbMbtiles(file, 7),
    /stale artifact, rebuild with FORCE_REIMPORT=1/,
  );
});

test("mtb tileset: maxzoom below 14 is rejected", () => {
  const file = join(dir, "mtb-maxzoom.mbtiles");
  makeMtbMbtiles(file, { maxzoom: "13" });
  assert.throws(() => verifyMtbMbtiles(file, 7), /maxzoom must be >= 14/);
});

test("mtb tileset: missing mtb layer is rejected", () => {
  const file = join(dir, "mtb-nolayer.mbtiles");
  makeMtbMbtiles(file, { layers: ["roads"] });
  assert.throws(() => verifyMtbMbtiles(file, 7), /missing layer "mtb"/);
});

test("mtb tileset: mtb layer without the mtb_scale field is rejected", () => {
  const file = join(dir, "mtb-nofield.mbtiles");
  makeMtbMbtiles(file, { mtbFields: { class: "string" } });
  assert.throws(() => verifyMtbMbtiles(file, 7), /lacks the "mtb_scale" field/);
});

test("mtb tileset: tiles below the minzoom are rejected", () => {
  const file = join(dir, "mtb-below.mbtiles");
  makeMtbMbtiles(file, { extraZooms: [6] });
  assert.throws(() => verifyMtbMbtiles(file, 7), /tiles below its minzoom/);
});

test("mtb tileset: a missing zoom level is rejected", () => {
  const file = join(dir, "mtb-holey.mbtiles");
  makeMtbMbtiles(file, { omitZooms: [10] });
  assert.throws(() => verifyMtbMbtiles(file, 7), /no tiles at zoom levels: 10/);
});

test("mtb tileset: the hard gate — empty mtb_scale at the minzoom is rejected", () => {
  const file = join(dir, "mtb-empty7.mbtiles");
  makeMtbMbtiles(file, { scaleAt: { 7: "" } });
  assert.throws(
    () => verifyMtbMbtiles(file, 7),
    /no mtb feature with a non-empty mtb_scale at z7/,
  );
});

test("mtb tileset: the hard gate — empty mtb_scale at z14 is rejected", () => {
  const file = join(dir, "mtb-empty14.mbtiles");
  makeMtbMbtiles(file, { scaleAt: { 14: "" } });
  assert.throws(
    () => verifyMtbMbtiles(file, 7),
    /no mtb feature with a non-empty mtb_scale at z14/,
  );
});

test("readMtbBounds: returns the bounds metadata, or null when absent", () => {
  const withBounds = join(dir, "bounds-ok.mbtiles");
  makeMtbMbtiles(withBounds);
  assert.deepEqual(readMtbBounds(withBounds), [-179.99, 85.05, -179.97, 85.06]);
  const noBounds = join(dir, "bounds-none.mbtiles");
  makeMtbMbtiles(noBounds, { bounds: null });
  assert.equal(readMtbBounds(noBounds), null);
});
