import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  alreadyAttemptedToday,
  cleanStaging,
  readLastReimport,
  writeLastReimport,
  type ReimportRecord,
} from "../src/reimport-state.js";

/** Runs `fn` inside a fresh temp dir, always removing it afterwards. */
function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "reimport-state-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function touch(dir: string, name: string): void {
  writeFileSync(path.join(dir, name), "x");
}

const FULL_RECORD: ReimportRecord = {
  date: "2026-09-01",
  latestDate: "2026-08-31",
  result: "success",
  dataDate: "2026-08-31",
  startedAt: 1_756_900_000_000,
  finishedAt: 1_756_900_060_000,
};

test("readLastReimport: write/read round-trip", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "last-reimport.json");
    writeLastReimport(file, FULL_RECORD);
    assert.deepStrictEqual(readLastReimport(file), FULL_RECORD);
  });
});

test("readLastReimport: round-trips a record with latestDate null", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "last-reimport.json");
    const rec: ReimportRecord = {
      date: "2026-09-01",
      latestDate: null,
      result: "error",
      dataDate: "2026-08-31",
      message: "cannot determine latest",
    };
    writeLastReimport(file, rec);
    assert.deepStrictEqual(readLastReimport(file), rec);
  });
});

test("readLastReimport: missing file -> null", () => {
  withTempDir((dir) => {
    assert.equal(readLastReimport(path.join(dir, "nope.json")), null);
  });
});

test("readLastReimport: malformed JSON -> null", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "last-reimport.json");
    writeFileSync(file, "{not json");
    assert.equal(readLastReimport(file), null);
  });
});

test("writeLastReimport: creates the parent directory if needed", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "nested", "deep", "last-reimport.json");
    writeLastReimport(file, FULL_RECORD);
    assert.ok(existsSync(file));
    assert.deepStrictEqual(readLastReimport(file), FULL_RECORD);
  });
});

test("alreadyAttemptedToday: true when the record is dated today", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "last-reimport.json");
    writeLastReimport(file, { ...FULL_RECORD, date: "2026-09-01" });
    assert.equal(alreadyAttemptedToday(file, "2026-09-01"), true);
    assert.equal(alreadyAttemptedToday(file, "2026-09-02"), false);
  });
});

test("alreadyAttemptedToday: false with no record", () => {
  withTempDir((dir) => {
    assert.equal(alreadyAttemptedToday(path.join(dir, "nope.json"), "2026-09-01"), false);
  });
});

test("cleanStaging: removes only *.staging.mbtiles", () => {
  withTempDir((dir) => {
    // live + dem tilesets, other files, and a directory that must all survive:
    touch(dir, "openmaptiles.mbtiles");
    touch(dir, "mtb.mbtiles");
    touch(dir, "dem.mbtiles");
    touch(dir, "norway-latest.osm.pbf");
    touch(dir, "notes.txt");
    mkdirSync(path.join(dir, "sources"));
    // leftovers from a crashed re-import:
    touch(dir, "openmaptiles.staging.mbtiles");
    touch(dir, "mtb.staging.mbtiles");

    const removed = cleanStaging(dir).sort();
    assert.deepEqual(removed, ["mtb.staging.mbtiles", "openmaptiles.staging.mbtiles"]);

    assert.ok(!existsSync(path.join(dir, "mtb.staging.mbtiles")));
    assert.ok(!existsSync(path.join(dir, "openmaptiles.staging.mbtiles")));
    const remaining = readdirSync(dir).sort();
    assert.deepEqual(remaining, [
      "dem.mbtiles",
      "mtb.mbtiles",
      "norway-latest.osm.pbf",
      "notes.txt",
      "openmaptiles.mbtiles",
      "sources",
    ]);
  });
});

test("cleanStaging: is idempotent", () => {
  withTempDir((dir) => {
    touch(dir, "openmaptiles.staging.mbtiles");
    assert.deepEqual(cleanStaging(dir), ["openmaptiles.staging.mbtiles"]);
    assert.deepEqual(cleanStaging(dir), []);
  });
});

test("cleanStaging: missing data dir -> [] (no throw)", () => {
  withTempDir((dir) => {
    assert.deepEqual(cleanStaging(path.join(dir, "does-not-exist")), []);
  });
});
