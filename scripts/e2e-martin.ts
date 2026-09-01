/**
 * End-to-end check of Martin serving a built MBTiles tileset (step 6, not
 * part of the test suite — needs the `martin` binary on the PATH):
 *   1. MartinServer starts the real `martin` with a generated config
 *   2. verified: config/file agreement, the served file's 16 OMT layers,
 *      /catalog source id "openmaptiles" + MVT content type
 *   3. a tile (top-left of the bounds) is fetched OVER HTTP and confirmed to
 *      serve as MVT
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
import Database from "better-sqlite3";
import type { Config } from "../src/config.js";

/**
 * Top-left z-tile of the tileset's bounds (always present in a planetiler
 * MBTiles, which tiles the full bounds at every zoom). Used to confirm Martin
 * serves the source over HTTP without scanning for content.
 */
function topLeftTileFromBounds(file: string, z: number): { x: number; y: number } | null {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare("SELECT value FROM metadata WHERE name = 'bounds'").get() as
      | { value: string }
      | undefined;
    if (!row) return null;
    const parts = row.value.split(",").map(Number);
    const west = parts[0];
    const north = parts[3];
    if (west === undefined || north === undefined) return null;
    if (!Number.isFinite(west) || !Number.isFinite(north)) return null;
    const n = 2 ** z;
    const x = Math.max(0, Math.floor(((west + 180) / 360) * n));
    const latRad = (north * Math.PI) / 180;
    const y = Math.max(
      0,
      Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n),
    );
    return { x, y };
  } finally {
    db.close();
  }
}

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

// 3. fetch a tile over HTTP (top-left of the bounds — always present) and
// confirm it serves as MVT
const corner = topLeftTileFromBounds(mbtiles, 14);
if (!corner) {
  console.log("[tile] FAILED: tileset has no bounds metadata");
  martin.shutdown();
  process.exit(1);
}
const url = `${martin.url}/${EXPECTED_SOURCE}/14/${corner.x}/${corner.y}`;
console.log(`[tile] GET ${url}`);
const res = await fetch(url);
if (!res.ok) {
  console.log(`[tile] FAILED: HTTP ${res.status}`);
  process.exitCode = 1;
  } else {
    const raw = new Uint8Array(await res.arrayBuffer());
    const data = raw[0] === 0x1f && raw[1] === 0x8b ? new Uint8Array(gunzipSync(Buffer.from(raw))) : raw;
    const vt = new VectorTile(new PbfReader(data));
    console.log(`[tile] OK: served as MVT (${vt.layers.length} layer(s))`);
  }

martin.shutdown();
rmSync(join(dir, "tmp"), { recursive: true, force: true });
console.log("[done]");
process.exit(process.exitCode ?? 0);
