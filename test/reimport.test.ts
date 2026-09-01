import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, after } from "node:test";
import type { Config } from "../src/config.js";
import {
  reimportState,
  resetReimportForTests,
  setInFlightForTests,
  triggerReimport,
  type ReimportDeps,
} from "../src/reimport.js";
import { readLastReimport, writeLastReimport } from "../src/reimport-state.js";

const base = mkdtempSync(join(tmpdir(), "reimport-"));
after(() => rmSync(base, { recursive: true, force: true }));

function localToday(): string {
  const d = new Date();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

interface TestMartin {
  restartCount: number;
  restart(): Promise<void>;
}

function freshDeps(overrides: Partial<ReimportDeps> = {}) {
  const dir = mkdtempSync(join(base, "case-"));
  const cfg = {
    dataDir: dir,
    osmFile: join(dir, "norway.osm.pbf"),
    osmDownloadFile: join(dir, "norway-download.osm.pbf"),
    mbtilesFile: join(dir, "openmaptiles.mbtiles"),
    mtbMbtilesFile: join(dir, "mtb.mbtiles"),
  } as Config;
  const buildCalls: Config[] = [];
  const martin: TestMartin = {
    restartCount: 0,
    restart: async () => {
      martin.restartCount++;
    },
  };
  const deps: ReimportDeps = {
    cfg,
    lastReimportFile: join(dir, "last-reimport.json"),
    currentDataDate: "2026-01-01",
    getLatestDatasetDate: async () => "2026-02-02",
    buildTilesets: async (c) => {
      buildCalls.push(c);
      writeFileSync(c.mbtilesFile, "new basemap");
      writeFileSync(c.mtbMbtilesFile, "new mtb");
      // A forced re-import downloads a FRESH extract to the writable download
      // file and builds from it (the mounted seed is never touched).
      writeFileSync(c.osmDownloadFile, "osm");
      const t = Date.parse("2026-02-03T00:00:00Z") / 1000;
      utimesSync(c.osmDownloadFile, t, t);
      return { mtbProfileVersion: "2", mtbHasBikePark: true, osmInput: c.osmDownloadFile };
    },
    martin,
    ...overrides,
  };
  return { dir, cfg, deps, martin, buildCalls };
}

function record(deps: ReimportDeps) {
  return readLastReimport(deps.lastReimportFile);
}

test("triggerReimport: concurrent trigger -> already-running", async () => {
  resetReimportForTests();
  const { deps } = freshDeps();
  setInFlightForTests(true);
  try {
    const res = await triggerReimport(deps);
    assert.deepEqual(res.decision, { kind: "rejected", error: "already-running" });
    assert.equal(reimportState({ lastReimportFile: deps.lastReimportFile }).state, "running");
  } finally {
    resetReimportForTests();
  }
});

test("triggerReimport: already attempted today -> rejected without upstream contact", async () => {
  resetReimportForTests();
  const { deps } = freshDeps();
  writeLastReimport(deps.lastReimportFile, {
    date: localToday(),
    latestDate: "2026-02-02",
    result: "success",
    dataDate: "2026-02-03",
  });
  let upstreamCalls = 0;
  const res = await triggerReimport({
    ...deps,
    getLatestDatasetDate: async () => {
      upstreamCalls++;
      return "2026-03-03";
    },
  });
  assert.deepEqual(res.decision, { kind: "rejected", error: "already-attempted-today" });
  assert.equal(upstreamCalls, 0);
  assert.equal(reimportState({ lastReimportFile: deps.lastReimportFile }).state, "success");
});

test("triggerReimport: no newer dataset -> no-newer-dataset + record", async () => {
  resetReimportForTests();
  const { deps } = freshDeps({ currentDataDate: "2026-03-03" });
  const res = await triggerReimport({
    ...deps,
    getLatestDatasetDate: async () => "2026-03-02",
  });
  assert.deepEqual(res.decision, { kind: "rejected", error: "no-newer-dataset" });
  const rec = record(deps);
  assert.equal(rec?.result, "no-newer-dataset");
  assert.equal(rec?.latestDate, "2026-03-02");
  assert.equal(reimportState({ lastReimportFile: deps.lastReimportFile }).state, "no-newer-dataset");
});

test("triggerReimport: upstream unreachable -> upstream-error + record", async () => {
  resetReimportForTests();
  const { deps } = freshDeps();
  const res = await triggerReimport({
    ...deps,
    getLatestDatasetDate: async () => {
      throw new Error("boom");
    },
  });
  assert.deepEqual(res.decision, { kind: "upstream-error" });
  const rec = record(deps);
  assert.equal(rec?.result, "error");
  assert.match(rec?.message ?? "", /boom/);
  assert.equal(reimportState({ lastReimportFile: deps.lastReimportFile }).state, "error");
});

test("triggerReimport: success -> builds staging, swaps, restarts, records success", async () => {
  resetReimportForTests();
  const { deps, cfg, martin, buildCalls } = freshDeps();
  const res = await triggerReimport(deps);
  assert.equal(res.decision.kind, "started");
  if (res.decision.kind !== "started") throw new Error("expected started");
  assert.equal(res.decision.latestDate, "2026-02-02");
  assert.ok(res.job);
  await res.job;

  assert.equal(buildCalls.length, 1);
  assert.match(buildCalls[0]!.mbtilesFile, /openmaptiles\.staging\.mbtiles$/);
  assert.match(buildCalls[0]!.mtbMbtilesFile, /mtb\.staging\.mbtiles$/);
  assert.equal(buildCalls[0]!.forceReimport, true);

  assert.equal(readFileSync(cfg.mbtilesFile, "utf8"), "new basemap");
  assert.equal(readFileSync(cfg.mtbMbtilesFile, "utf8"), "new mtb");
  assert.equal(existsSync(buildCalls[0]!.mbtilesFile), false);
  assert.equal(existsSync(buildCalls[0]!.mtbMbtilesFile), false);
  assert.equal(martin.restartCount, 1);

  const rec = record(deps);
  assert.equal(rec?.result, "success");
  assert.equal(rec?.dataDate, "2026-02-03");
  assert.equal(reimportState({ lastReimportFile: deps.lastReimportFile }).state, "success");
});

test("reimportState: idle when no record or record is from another day", () => {
  resetReimportForTests();
  const { deps } = freshDeps();
  assert.equal(reimportState({ lastReimportFile: deps.lastReimportFile }).state, "idle");

  writeLastReimport(deps.lastReimportFile, {
    date: "2000-01-01",
    latestDate: null,
    result: "success",
    dataDate: "2000-01-01",
  });
  assert.equal(reimportState({ lastReimportFile: deps.lastReimportFile }).state, "idle");
});

test("reimportState: a stale running record is surfaced as error", () => {
  resetReimportForTests();
  const { deps } = freshDeps();
  writeLastReimport(deps.lastReimportFile, {
    date: localToday(),
    latestDate: null,
    result: "running",
    dataDate: "2026-01-01",
  });
  assert.equal(reimportState({ lastReimportFile: deps.lastReimportFile }).state, "error");
});
