import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, after } from "node:test";
import Database from "better-sqlite3";
import { planBuilds } from "../src/pipeline.js";
import { VerifyError } from "../src/verify.js";
import type { Config } from "../src/config.js";

const dir = mkdtempSync(join(tmpdir(), "pipeline-plan-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function makeCfg(overrides: Partial<Config> = {}): Config {
  return {
    port: 0,
    publicDir: dir,
    dataDir: dir,
    countryName: "Test",
    osmListingUrl: "https://example.test/norway.html",
    reimportStateFile: join(dir, "last-reimport.json"),
    osmFile: join(dir, "norway.osm.pbf"),
    osmDownloadFile: join(dir, "norway-download.osm.pbf"),
    mbtilesFile: join(dir, "openmaptiles.mbtiles"),
    planetilerJar: join(dir, "planetiler.jar"),
    planetilerHeapMb: 0,
    mtbMinzoom: 3,
    mtbProfileJar: join(dir, "mtb-profile.jar"),
    mtbMbtilesFile: join(dir, "mtb.mbtiles"),
    mtbHeapMb: 0,
    demMbtilesFile: join(dir, "dem.mbtiles"),
    planetilerSourcesDir: join(dir, "sources"),
    planetilerTmpDir: join(dir, "tmp"),
    martinBind: "127.0.0.1",
    martinPort: 0,
    martinConfig: join(dir, "martin.yaml"),
    forceReimport: false,
    skipPipeline: false,
    tileSourceUrl: "",
    basePath: "",
    ...overrides,
  };
}

function makeMtb(file: string, minzoom: number | null): void {
  rmSync(file, { force: true });
  const db = new Database(file);
  db.exec("CREATE TABLE metadata (name text, value text, PRIMARY KEY (name));");
  const meta = db.prepare("INSERT INTO metadata (name, value) VALUES (?, ?)");
  meta.run("format", "pbf");
  meta.run("minzoom", "0");
  meta.run("maxzoom", "14");
  if (minzoom !== null) meta.run("mtb_minzoom", String(minzoom));
  db.close();
}

test("plans a full build when no artifacts exist", () => {
  const cfg = makeCfg();
  assert.deepEqual(planBuilds(cfg, false), { basemap: "build", mtb: "build" });
});

test("skips the basemap when the artifact is present and not forcing", () => {
  const cfg = makeCfg();
  assert.deepEqual(planBuilds(cfg, true), { basemap: "skip", mtb: "build" });
});

test("forces both builds when forceReimport is set", () => {
  const cfg = makeCfg({ forceReimport: true });
  assert.deepEqual(planBuilds(cfg, true), { basemap: "build", mtb: "build" });
});

test("skips the MTB tileset when its recorded minzoom matches", () => {
  const cfg = makeCfg({ mtbMinzoom: 5 });
  makeMtb(cfg.mtbMbtilesFile, 5);
  assert.deepEqual(planBuilds(cfg, true), { basemap: "skip", mtb: "skip" });
});

test("fails fast when the MTB tileset minzoom is stale", () => {
  const cfg = makeCfg({ mtbMinzoom: 4 });
  makeMtb(cfg.mtbMbtilesFile, 3);
  assert.throws(() => planBuilds(cfg, true), (err: unknown) => {
    assert.ok(err instanceof VerifyError);
    return /stale .+mtb\.mbtiles.* MTB_MINZOOM is 4/.test(err.message);
  });
});

test("fails fast when mtb_minzoom metadata is missing", () => {
  const cfg = makeCfg({ mtbMinzoom: 3 });
  makeMtb(cfg.mtbMbtilesFile, null);
  assert.throws(() => planBuilds(cfg, true), (err: unknown) => {
    assert.ok(err instanceof VerifyError);
    return /recorded minzoom \(missing\)/.test(err.message);
  });
});
