/**
 * End-to-end check of basemap style serving (step 7, not part of the test
 * suite — needs a built tileset + the `martin` binary on the PATH):
 *   1. MartinServer starts the real `martin` serving the tileset
 *   2. verifyStyleServing: the style's source-layers/fields are compatible
 *      with the tileset, and a real tile decodes over HTTP (render smoke test)
 *   3. the serve-time /style.json rewrite is confirmed (request-host-aware URL)
 *
 * Usage:
 *   npx tsx scripts/e2e-style.ts [mbtiles-file] [port-offset]
 *
 * Defaults:
 *   mbtiles /tmp/mtb-e2e/sorlandet.mbtiles
 *
 * The tileset is copied to /tmp/mtb-e2e/openmaptiles.mbtiles first, because
 * Martin derives the source id from the file name — production serves exactly
 * "openmaptiles.mbtiles", and the app/style hard-code that source id.
 */
import { existsSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import Database from "better-sqlite3";
import { EXPECTED_SOURCE, MartinServer, expectedMtbSource } from "../src/martin.js";
import {
  analyzeStyle,
  buildMtbSourceSpec,
  buildTileSourceSpec,
  loadStyle,
  verifyStyleServing,
  withTileSources,
} from "../src/style.js";
import type { Config } from "../src/config.js";

const [mbtilesIn = "/tmp/mtb-e2e/sorlandet.mbtiles"] = process.argv.slice(2);
const portOffset = process.argv.length > 3 ? Number.parseInt(process.argv[3]!, 10) : 0;

const dir = "/tmp/mtb-e2e";
mkdirSync(dir, { recursive: true });
const mbtiles = join(dir, "openmaptiles.mbtiles");
if (basename(mbtilesIn) !== "openmaptiles.mbtiles") {
  copyFileSync(mbtilesIn, mbtiles);
  console.log(`[setup] copied ${mbtilesIn} -> ${mbtiles} (production file name)`);
} else {
  console.log(`[setup] ${mbtilesIn}`);
}

// Base port 3300 on purpose: 3000 is the app's internal Martin port (step 12:
// loopback-only), and an e2e Martin on 127.0.0.1:3000 would shadow the real
// one for any client that resolves the host to IPv4 (and survive the script
// if it is killed, serving the fixture tileset to the live map).
const port = 3300 + portOffset;

/**
 * MartinServer.verifyConfig requires BOTH tilesets (basemap + step-11 mtb
 * overlay) in the config and on disk. The mtb overlay's content is covered by
 * e2e-mtb.ts — here a metadata-only fixture is enough (it must exist and be
 * listed, so the catalog + serve-time rewrite see the same two sources as
 * production).
 */
function ensureMtbFixture(): string {
  const target = join(dir, "mtb.mbtiles");
  if (existsSync(target)) {
    console.log(`[setup] mtb fixture ${target} (reused)`);
    return target;
  }
  const db = new Database(target);
  db.exec(`
    CREATE TABLE metadata (name text, value text, PRIMARY KEY (name));
    CREATE TABLE tiles (
      zoom_level integer, tile_column integer, tile_row integer, tile_data,
      PRIMARY KEY (zoom_level, tile_column, tile_row)
    );
  `);
  const meta = db.prepare("INSERT INTO metadata (name, value) VALUES (?, ?)");
  meta.run("name", "MTB overlay (synthetic e2e fixture)");
  meta.run("format", "pbf");
  meta.run("minzoom", "0");
  meta.run("maxzoom", "14");
  meta.run("bounds", "-179.99,85.05,-179.97,85.06");
  meta.run("json", JSON.stringify({
    name: "MTB overlay (synthetic e2e fixture)",
    vector_layers: [{ id: "mtb", name: "mtb", description: "", minzoom: 0, maxzoom: 14, fields: { mtb_scale: "string" } }],
  }));
  db.close();
  console.log(`[setup] synthesized ${target}`);
  return target;
}

const mtbFile = ensureMtbFixture();
const configPath = join(dir, "martin-e2e.yaml");
writeFileSync(configPath, `mbtiles:\n  - ${mbtiles}\n  - ${mtbFile}\n`);

const cfg = {
  publicDir: join(process.cwd(), "public"),
  mbtilesFile: mbtiles,
  mtbMbtilesFile: mtbFile,
  martinConfig: configPath,
  martinBind: "127.0.0.1",
  martinPort: port,
  tileSourceUrl: "",
} as Config;

// 1. start martin (verifies config, the served file's layers, /catalog)
const martin = new MartinServer(cfg);
await martin.start();
console.log(`[martin] ready at ${martin.url} (source: ${EXPECTED_SOURCE}, ${martin.layers.length} layers)`);

// 2. step 7 gate: style/tileset compatibility + render smoke test over HTTP
await verifyStyleServing(cfg, martin.url);
console.log("[style] PASS: style compatible with tileset + real tile decoded over HTTP");

// 3. confirm the serve-time rewrite (request-host-aware, step 12: app origin
// + the /tiles proxy — Martin itself is loopback-only). The source is
// rewritten to an inline `tiles` template (MapLibre 6.x would otherwise
// fetch the bare base as a TileJSON endpoint and 404).
const styleFile = join(cfg.publicDir, "style.json");
const style = loadStyle(styleFile);
const req = { headers: { host: `127.0.0.1:${port}` } };
const mtbSourceId = expectedMtbSource(cfg.mtbMbtilesFile);
const rewritten = withTileSources(
  style,
  buildTileSourceSpec(req, cfg),
  { id: mtbSourceId, spec: buildMtbSourceSpec(req, cfg) },
);
const analysis = analyzeStyle(style);
console.log(
  `[style] sources.${EXPECTED_SOURCE} -> ${JSON.stringify(rewritten.sources![EXPECTED_SOURCE])}`,
);
console.log(`[style] sources.${mtbSourceId} -> ${JSON.stringify(rewritten.sources![mtbSourceId])}`);
console.log(
  `[style] analysis: ${analysis.sourceLayers.length} source-layers, ${analysis.allFields.size} fields referenced`,
);

martin.shutdown();
console.log("[done]");
process.exit(0);
