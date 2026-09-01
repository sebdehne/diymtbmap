/**
 * End-to-end check of the build pipeline (not part of the test suite —
 * downloads and builds real data):
 *   1. toolchain probe: java -jar <jar> --help lists osm_path
 *   2. download an OSM PBF extract (geofabrik -latest alias)
 *   3. build with src/build.ts (StageTracker progress)
 *   4. verify with src/verify.ts (structure + mtb_scale content scan)
 *
 * Usage:
 *   npx tsx scripts/e2e-check.ts [osm-url] [jar] [heap-mb]
 *
 * Defaults:
 *   osm-url  https://download.geofabrik.de/europe/norway/sorlandet-latest.osm.pbf
 *            (Sørlandet: small, and it contains mtb:scale-tagged trails —
 *            a trail-less extract like Monaco builds fine but verification
 *            correctly rejects it: "no mtb_scale feature")
 *   jar      /tmp/mtb-e2e/planetiler-openmaptiles.jar
 *   heap     4096
 *
 * The jar is the self-contained openmaptiles profile:
 *   https://github.com/openmaptiles/planetiler-openmaptiles/releases/download/v3.16/planetiler-openmaptiles.jar
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { download } from "../src/download.js";
import { runPlanetiler } from "../src/build.js";
import { verifyMbtiles } from "../src/verify.js";
import type { Config } from "../src/config.js";

const DEFAULT_OSM_URL = "https://download.geofabrik.de/europe/norway/sorlandet-latest.osm.pbf";
const [osmUrl = DEFAULT_OSM_URL, jar = "/tmp/mtb-e2e/planetiler-openmaptiles.jar", heapMb = "4096"] =
  process.argv.slice(2);

const dir = "/tmp/mtb-e2e";
mkdirSync(dir, { recursive: true });
const base = basename(osmUrl).replace(/-latest\.osm\.pbf$/, "").replace(/\.osm\.pbf$/, "");
const pbf = join(dir, `${base}.osm.pbf`);
const mbtiles = join(dir, `${base}.mbtiles`);

// 1. toolchain probe
if (!existsSync(jar)) {
  console.error(`[toolchain] jar not found: ${jar}`);
  process.exit(1);
}
const probe = spawnSync("java", ["-jar", jar, "--help"], { encoding: "utf8", timeout: 120_000 });
const out = `${probe.stdout}\n${probe.stderr}`;
console.log(`[toolchain] exit=${probe.status} lists_osm_path=${/osm_path/.test(out)}`);
if (probe.status !== 0 || !/osm_path/.test(out)) {
  console.error(out.slice(-800));
  process.exit(1);
}

// 2. download
if (!existsSync(pbf)) {
  let last = 0;
  await download(osmUrl, pbf, (b, t) => {
    if (t && t > 0 && Math.abs(b - last) > t / 20) {
      last = b;
      console.log(`[download] ${(100 * b) / t}%`);
    }
  });
}
console.log(`[download] ${pbf}`);

// 3. build
const cfg = {
  planetilerJar: jar,
  osmFile: pbf,
  mbtilesFile: mbtiles,
  planetilerHeapMb: Number.parseInt(heapMb, 10),
  planetilerSourcesDir: join(dir, "sources"),
  planetilerTmpDir: join(dir, "tmp"),
} as Config;
let lastP = -1;
const t0 = Date.now();
await runPlanetiler(cfg, {
  onProgress: (p, m) => {
    if (p !== lastP) {
      lastP = p;
      console.log(`[build] ${p}% ${m}`);
    }
  },
});
console.log(`[build] finished in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// 4. verify
try {
  const v = verifyMbtiles(mbtiles);
  console.log(
    `[verify] OK: ${v.layers.length} layers, z${v.zooms[0]}-z${v.zooms[v.zooms.length - 1]}`,
  );
} catch (e) {
  console.log(`[verify] FAILED: ${(e as Error).message}`);
  process.exitCode = 2;
}
rmSync(join(dir, "tmp"), { recursive: true, force: true });
