import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, after } from "node:test";
import Database from "better-sqlite3";
import { readOsmDataDate } from "../src/osm-date.js";

const dir = mkdtempSync(join(tmpdir(), "osm-date-"));
after(() => rmSync(dir, { recursive: true, force: true }));

/** A minimal MBTiles with an optional replication-time metadata value. */
function makeMbtiles(file: string, replicationTime: string | null): void {
  const db = new Database(file);
  db.exec("CREATE TABLE metadata (name text, value text, PRIMARY KEY (name));");
  db.prepare("INSERT INTO metadata (name, value) VALUES (?, ?)").run("name", "Test");
  if (replicationTime !== null) {
    db.prepare("INSERT INTO metadata (name, value) VALUES (?, ?)").run(
      "planetiler:osm:osmosisreplicationtime",
      replicationTime,
    );
  }
  db.close();
}

test("prefers the recorded OSM replication time", () => {
  const file = join(dir, "rep.mbtiles");
  makeMbtiles(file, "2026-07-01T08:15:00Z");
  // osmFile does not matter here — the metadata wins.
  assert.equal(readOsmDataDate(file, join(dir, "missing.osm.pbf")), "2026-07-01");
});

test("falls back to the OSM PBF file mtime when the time is epoch/absent", () => {
  const file = join(dir, "epoch.mbtiles");
  makeMbtiles(file, "1970-01-01T00:00:00Z"); // epoch → treated as "no date"
  const osm = join(dir, "osm.osm.pbf");
  writeFileSync(osm, "pbf-bytes");
  utimesSync(osm, new Date("2026-03-15T00:00:00Z"), new Date("2026-03-15T00:00:00Z"));
  assert.equal(readOsmDataDate(file, osm), "2026-03-15");
});

test("falls back to the OSM PBF file mtime when metadata is missing entirely", () => {
  const file = join(dir, "nometa.mbtiles");
  makeMbtiles(file, null);
  const osm = join(dir, "osm2.osm.pbf");
  writeFileSync(osm, "pbf-bytes");
  utimesSync(osm, new Date("2025-11-20T12:34:56Z"), new Date("2025-11-20T12:34:56Z"));
  assert.equal(readOsmDataDate(file, osm), "2025-11-20");
});

test("returns null when neither the metadata nor the file yields a date", () => {
  const file = join(dir, "none.mbtiles");
  makeMbtiles(file, null);
  // osmFile does not exist.
  assert.equal(readOsmDataDate(file, join(dir, "missing.osm.pbf")), null);
});
