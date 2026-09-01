/**
 * End-to-end check of the step-11 MTB overlay served by a real Martin
 * (not part of the test suite — needs the `martin` binary on the PATH and a
 * built mtb.mbtiles):
 *   1. MartinServer starts the real `martin` serving BOTH the basemap and the
 *      mtb overlay (verified by the app's own catalog check: both source ids
 *      present as MVT)
 *   2. the mtb source is fetched OVER HTTP (top-left of the bounds) and
 *      confirmed to serve as MVT
 *   3. the total number of non-empty mtb_scale features at z14 meets the
 *      Sørlandet baseline (>= 1876) — the overlay is a superset of the
 *      basemap's trails
 *
 * Usage:
 *   npx tsx scripts/e2e-mtb.ts [mtb-mbtiles] [port-offset] [basemap-mbtiles]
 *
 * Defaults:
 *   mtb     /tmp/mtb-e2e/mtb.mbtiles
 *   port    3301 (deliberately NOT 3000 — the app's production tile port)
 *   basemap /tmp/mtb-e2e/sorlandet.mbtiles if present, otherwise a synthetic
 *           openmaptiles.mbtiles (all OMT layers declared) is generated — the
 *           basemap is a co-tenant source here; e2e-martin.ts covers it fully.
 *
 * Martin derives each source id from the MBTiles file name, so the files are
 * named exactly as production serves them (openmaptiles.mbtiles / mtb.mbtiles).
 */
import { existsSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { gunzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { PbfReader } from "pbf";
import { VectorTile } from "@mapbox/vector-tile";
import { EXPECTED_SOURCE, MartinServer, expectedMtbSource } from "../src/martin.js";
import {
  REQUIRED_LAYERS,
  OPTIONAL_LAYERS,
  MTB_OVERLAY_LAYER,
  verifyMtbMbtiles,
} from "../src/verify.js";
import type { Config } from "../src/config.js";

const mtbIn = process.argv[2] ?? "/tmp/mtb-e2e/mtb.mbtiles";
const port = 3301 + (process.argv[3] ? Number.parseInt(process.argv[3]!, 10) : 0);
const basemapIn = process.argv[4] ?? "/tmp/mtb-e2e/sorlandet.mbtiles";

const dir = "/tmp/mtb-e2e";
mkdirSync(dir, { recursive: true });
const mtbFile = join(dir, "mtb.mbtiles");
if (!existsSync(mtbIn)) {
  console.log(`[setup] FAILED: mtb tileset not found at ${mtbIn} — build it first`);
  process.exit(1);
}
if (basename(mtbIn) !== "mtb.mbtiles") {
  copyFileSync(mtbIn, mtbFile);
  console.log(`[setup] copied ${mtbIn} -> ${mtbFile} (production file name)`);
} else {
  console.log(`[setup] ${mtbIn}`);
}

/**
 * Ensure a servable basemap at openmaptiles.mbtiles. Martin + the app require
 * the basemap source to exist and declare the OMT layers, so reuse the real
 * one when available; otherwise synthesize a minimal valid MBTiles that
 * declares every required layer (the basemap content is e2e-covered by
 * e2e-martin.ts, not here).
 */
function ensureBasemap(): string {
  const target = join(dir, "openmaptiles.mbtiles");
  if (existsSync(target)) {
    console.log(`[setup] basemap ${target} (reused)`);
    return target;
  }
  if (existsSync(basemapIn)) {
    copyFileSync(basemapIn, target);
    console.log(`[setup] copied ${basemapIn} -> ${target} (real basemap)`);
    return target;
  }
  console.log(`[setup] ${basemapIn} not found — synthesizing a minimal basemap`);
  const layers = [...REQUIRED_LAYERS, ...OPTIONAL_LAYERS];
  const json = {
    name: "Sørlandet (synthetic e2e basemap)",
    vector_layers: layers.map((id) => ({
      id,
      name: id,
      description: "",
      minzoom: 0,
      maxzoom: 14,
      fields: { class: "string" },
    })),
  };
  const db = new Database(target);
  db.exec(`
    CREATE TABLE metadata (name text, value text, PRIMARY KEY (name));
    CREATE TABLE tiles (
      zoom_level integer, tile_column integer, tile_row integer, tile_data,
      PRIMARY KEY (zoom_level, tile_column, tile_row)
    );
  `);
  const meta = db.prepare("INSERT INTO metadata (name, value) VALUES (?, ?)");
  meta.run("name", "Sørlandet (synthetic e2e basemap)");
  meta.run("format", "pbf");
  meta.run("minzoom", "0");
  meta.run("maxzoom", "14");
  meta.run("bounds", "-179.99,85.05,-179.97,85.06");
  meta.run("json", JSON.stringify(json));
  db.close();
  console.log(`[setup] synthesized ${target} (${layers.length} declared layers)`);
  return target;
}

const basemapFile = ensureBasemap();

const configPath = join(dir, "martin-e2e-mtb.yaml");
writeFileSync(
  configPath,
  `mbtiles:\n  - ${basemapFile}\n  - ${mtbFile}\n`,
);

const cfg = {
  mbtilesFile: basemapFile,
  mtbMbtilesFile: mtbFile,
  mtbMinzoom: 7,
  martinConfig: configPath,
  martinBind: "127.0.0.1",
  martinPort: port,
} as Config;

const mtbSource = expectedMtbSource(mtbFile);
const martin = new MartinServer(cfg);
await martin.start();
console.log(`[catalog] sources: ${martin.sources.join(", ")}`);
const want = [EXPECTED_SOURCE, mtbSource].sort();
if (JSON.stringify([...martin.sources].sort()) !== JSON.stringify(want)) {
  console.log(`[catalog] FAILED: expected ${want.join(", ")}, got ${martin.sources.join(", ")}`);
  process.exitCode = 1;
} else {
  console.log(`[catalog] OK: serving both "${EXPECTED_SOURCE}" and "${mtbSource}" as MVT`);
}

// Verify the overlay artifact (metadata) before serving it.
const v = verifyMtbMbtiles(mtbFile, 7);
console.log(`[mtb] minzoom=${v.minzoom} maxzoom=${v.maxzoom} zooms=${v.zooms.join(",")}`);

function decode(raw: Uint8Array): Uint8Array {
  return raw[0] === 0x1f && raw[1] === 0x8b ? new Uint8Array(gunzipSync(Buffer.from(raw))) : raw;
}

function mtbScaleHits(data: Uint8Array): string[] {
  const vt = new VectorTile(new PbfReader(data));
  const layer = vt.layers[MTB_OVERLAY_LAYER];
  if (!layer) return [];
  const out: string[] = [];
  for (let i = 0; i < layer.length; i++) {
    const props = layer.feature(i).properties;
    const s = props.mtb_scale;
    if (s !== undefined && s !== "") out.push(String(s));
  }
  return out;
}

/** Top-left z-tile of the tileset's bounds (always present in a planetiler MBTiles). */
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

// Confirm the mtb source is served over HTTP as MVT (top-left of the bounds —
// always present in a planetiler MBTiles). Content coverage is checked
// file-level below.
const corner = topLeftTileFromBounds(mtbFile, 14);
if (!corner) {
  console.log("[tile] FAILED: tileset has no bounds metadata");
  martin.shutdown();
  process.exit(1);
}
const url = `${martin.url}/${mtbSource}/14/${corner.x}/${corner.y}`;
console.log(`[tile] GET ${url}`);
const res = await fetch(url);
if (!res.ok) {
  console.log(`[tile] FAILED: HTTP ${res.status}`);
  martin.shutdown();
  process.exit(1);
}
const raw = new Uint8Array(await res.arrayBuffer());
const scales = mtbScaleHits(decode(raw));
console.log(`[tile] OK: mtb source served as MVT (${scales.length} mtb_scale feature(s) in this tile)`);

// Coverage: total non-empty mtb_scale features at z14 (file-level, all tiles).
function countMtbScaleAtZoom(file: string, zoom: number): number {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  let count = 0;
  try {
    const compact = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='tiles_shallow'").get()
    ) !== undefined;
    const rows = (
      compact
        ? db.prepare(
            `SELECT d.tile_data AS data FROM tiles_shallow s
             JOIN tiles_data d ON d.tile_data_id = s.tile_data_id
             WHERE s.zoom_level = ?`,
          )
        : db.prepare("SELECT tile_data AS data FROM tiles WHERE zoom_level = ?")
      )
      .all(zoom) as { data: Uint8Array }[];
    for (const r of rows) count += mtbScaleHits(decode(r.data)).length;
  } finally {
    db.close();
  }
  return count;
}

const z14count = countMtbScaleAtZoom(mtbFile, 14);
const BASELINE_Z14 = 1876; // Sørlandet basemap transportation.mtb_scale @ z14
if (z14count < BASELINE_Z14) {
  console.log(`[coverage] FAILED: z14 mtb_scale features ${z14count} < baseline ${BASELINE_Z14}`);
  process.exitCode = 1;
} else {
  console.log(`[coverage] OK: z14 has ${z14count} non-empty mtb_scale features (baseline >= ${BASELINE_Z14})`);
}

martin.shutdown();
console.log("[done]");
process.exit(process.exitCode ?? 0);
