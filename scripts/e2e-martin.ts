/**
 * End-to-end check of Martin serving a built MBTiles tileset (step 6, not
 * part of the test suite — needs the `martin` binary on the PATH):
 *   1. MartinServer starts the real `martin` with a generated config
 *   2. verified: config/file agreement, the served file's 16 OMT layers,
 *      /catalog source id "openmaptiles" + MVT content type
 *   3. the known mtb_scale tile is fetched OVER HTTP, decoded, and the
 *      feature's mtb_scale value confirmed
 *
 * Usage:
 *   npx tsx scripts/e2e-martin.ts [mbtiles-file] [port-offset]
 *
 * Defaults:
 *   mbtiles /tmp/mtb-e2e/sorlandet.mbtiles
 *   port 3300 (deliberately NOT 3000 — see the port note below)
 *
 * The tileset is copied to /tmp/mtb-e2e/openmaptiles.mbtiles first, because
 * Martin derives the source id from the file name — production serves exactly
 * "openmaptiles.mbtiles", and the app/style hard-code that source id.
 */
import { mkdirSync, rmSync, copyFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { EXPECTED_SOURCE, MartinServer } from "../src/martin.js";
import { verifyMbtiles } from "../src/verify.js";
import { gunzipSync } from "node:zlib";
import { PbfReader } from "pbf";
import { VectorTile } from "@mapbox/vector-tile";
import type { Config } from "../src/config.js";

const [mbtilesIn = "/tmp/mtb-e2e/sorlandet.mbtiles"] = process.argv.slice(2);

const dir = "/tmp/mtb-e2e";
mkdirSync(dir, { recursive: true });
const mbtiles = join(dir, "openmaptiles.mbtiles");
if (basename(mbtilesIn) !== "openmaptiles.mbtiles") {
  copyFileSync(mbtilesIn, mbtiles);
  console.log(`[setup] copied ${mbtilesIn} -> ${mbtiles} (production file name)`);
} else {
  console.log(`[setup] ${mbtilesIn}`);
}

// Base port 3300 on purpose: 3000 is the app's production tile port, and an
// e2e Martin on 127.0.0.1:3000 would shadow the real one for any client
// that resolves the host to IPv4 (and survive the script if it is killed,
// serving the fixture tileset to the live map).
const port = 3300 + (process.argv.length > 3 ? Number.parseInt(process.argv[3]!, 10) : 0);
const configPath = join(dir, "martin-e2e.yaml");
writeFileSync(configPath, `mbtiles:\n  - ${mbtiles}\n`);

const cfg = {
  mbtilesFile: mbtiles,
  martinConfig: configPath,
  martinBind: "127.0.0.1",
  martinPort: port,
} as Config;

// 1+2. start martin (verifies config, the served file's layers, and the
// /catalog source id + MVT content type) via the app's own logic
const martin = new MartinServer(cfg);
await martin.start();
console.log(`[catalog] sources: ${martin.sources.join(", ")}`);
console.log(`[layers] (${martin.layers.length}): ${martin.layers.join(", ")}`);

// locate the known mtb tile (scan stops at the first hit, so this stays fast)
const v = verifyMbtiles(mbtiles);
const meta = v.layers.sort();
const cat = [...martin.layers].sort();
if (JSON.stringify(meta) !== JSON.stringify(cat)) {
  console.log(`[catalog] MISMATCH: mbtiles=${JSON.stringify(meta)} catalog=${JSON.stringify(cat)}`);
  process.exitCode = 1;
} else {
  console.log(`[catalog] matches the MBTiles vector_layers metadata (${meta.length} layers)`);
}

// 3. fetch the mtb tile over HTTP and confirm the feature content
const { zoom, x, y } = v.mtbHit;
const url = `${martin.url}/${EXPECTED_SOURCE}/${zoom}/${x}/${y}`;
console.log(`[tile] GET ${url}`);
const res = await fetch(url);
if (!res.ok) {
  console.log(`[tile] FAILED: HTTP ${res.status}`);
  process.exitCode = 1;
} else {
  const raw = new Uint8Array(await res.arrayBuffer());
  const data = raw[0] === 0x1f && raw[1] === 0x8b ? new Uint8Array(gunzipSync(Buffer.from(raw))) : raw;
  const vt = new VectorTile(new PbfReader(data));
  const layer = vt.layers["transportation"];
  let hit: unknown;
  if (layer) {
    for (let i = 0; i < layer.length; i++) {
      const props = layer.feature(i).properties;
      if (props.mtb_scale !== undefined && props.mtb_scale !== "") {
        hit = props;
        break;
      }
    }
  }
  if (hit === undefined) {
    console.log("[tile] FAILED: no transportation feature with a non-empty mtb_scale");
    process.exitCode = 1;
  } else {
    console.log(`[tile] OK: ${JSON.stringify(hit)}`);
  }
}

martin.shutdown();
rmSync(join(dir, "tmp"), { recursive: true, force: true });
console.log("[done]");
process.exit(process.exitCode ?? 0);
