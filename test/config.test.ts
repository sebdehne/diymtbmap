import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, after } from "node:test";
import { loadConfig, stagingPath } from "../src/config.js";

const base = mkdtempSync(join(tmpdir(), "config-"));
after(() => rmSync(base, { recursive: true, force: true }));

const STABLE_ENV: Record<string, string> = {
  BASE_PATH: "",
  PORT: "8080",
  MTB_MINZOOM: "3",
  PLANETILER_HEAP_MB: "4096",
  MTB_HEAP_MB: "2048",
  MARTIN_PORT: "3000",
};

function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void | Promise<void>,
): Promise<void> {
  const touched = Object.keys(vars);
  const saved = new Map(touched.map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return Promise.resolve(fn());
  } finally {
    for (const key of touched) {
      const original = saved.get(key);
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
  }
}

test("loadConfig: default re-import config", async () => {
  const dataDir = mkdtempSync(join(base, "default-"));
  await withEnv(
    {
      ...STABLE_ENV,
      DATA_DIR: dataDir,
      OSM_LISTING_URL: undefined,
      OSM_FILE: undefined,
      OSM_DOWNLOAD_FILE: undefined,
      REIMPORT_STATE_FILE: undefined,
    },
    () => {
      const cfg = loadConfig();
      assert.equal(cfg.osmListingUrl, "https://download.geofabrik.de/europe/norway.html");
      assert.equal(cfg.osmFile, join(dataDir, "norway-latest.osm.pbf"));
      assert.equal(cfg.osmDownloadFile, join(dataDir, "osm-download.osm.pbf"));
      assert.equal(cfg.reimportStateFile, join(dataDir, "last-reimport.json"));
    },
  );
});

test("loadConfig: OSM_LISTING_URL and REIMPORT_STATE_FILE env overrides", async () => {
  const dataDir = mkdtempSync(join(base, "override-"));
  await withEnv(
    {
      ...STABLE_ENV,
      DATA_DIR: dataDir,
      OSM_LISTING_URL: "https://example.com/norway.html",
      OSM_FILE: "/seed/norway-seed.osm.pbf",
      OSM_DOWNLOAD_FILE: join(dataDir, "custom-download.osm.pbf"),
      REIMPORT_STATE_FILE: join(dataDir, "custom-reimport.json"),
    },
    () => {
      const cfg = loadConfig();
      assert.equal(cfg.osmListingUrl, "https://example.com/norway.html");
      assert.equal(cfg.osmFile, "/seed/norway-seed.osm.pbf");
      assert.equal(cfg.osmDownloadFile, join(dataDir, "custom-download.osm.pbf"));
      assert.equal(cfg.reimportStateFile, join(dataDir, "custom-reimport.json"));
    },
  );
});

test("stagingPath: derives the staging artifact name", () => {
  const dataDir = join(base, "staging");
  assert.equal(
    stagingPath(join(dataDir, "openmaptiles.mbtiles")),
    join(dataDir, "openmaptiles.staging.mbtiles"),
  );
  assert.equal(stagingPath(join(dataDir, "mtb.mbtiles")), join(dataDir, "mtb.staging.mbtiles"));
  assert.equal(stagingPath(join(dataDir, "custom")), join(dataDir, "custom.staging"));
});
