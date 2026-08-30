import path from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  port: number;
  publicDir: string;
  dataDir: string;
  /**
   * Display name of the country the extract covers (workstream D): used for
   * the progress card title and the info panel. Defaults to "Norway" to keep
   * the historical branding; set COUNTRY_NAME to rebrand for another extract.
   */
  countryName: string;
  osmUrl: string;
  osmFile: string;
  mbtilesFile: string;
  planetilerJar: string;
  planetilerHeapMb: number;
  /**
   * Dedicated low-zoom MTB overlay tileset (step 11, decision B1): every OSM
   * way with a non-empty mtb:scale as layer `mtb` / attribute `mtb_scale`,
   * z MTB_MINZOOM..14, built by the mtb-profile jar into its own MBTiles and
   * served as a second Martin source.
   */
  mtbMinzoom: number;
  mtbProfileJar: string;
  mtbMbtilesFile: string;
  mtbHeapMb: number;
  planetilerSourcesDir: string;
  planetilerTmpDir: string;
  martinBind: string;
  martinPort: number;
  martinConfig: string;
  forceReimport: boolean;
  skipPipeline: boolean;
  verifyMtbMaxTiles: number;
  /**
   * Optional full URL for the tile source the style points at (wins over the
   * request-host-aware default). For reverse proxies / Martin port remaps.
   */
  tileSourceUrl: string;
  /**
   * Sub-path the app is mounted under (e.g. "/mtb") when served behind a
   * reverse proxy that keeps other host paths untouched. "" = served at the
   * host root (default). The app is mounted at this path AND every
   * browser-facing URL it emits (tiles / sprite / glyphs in the served
   * style) carries the prefix.
   */
  basePath: string;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) {
    throw new Error(`invalid value for ${name}: ${raw!} (expected a positive integer)`);
  }
  return n;
}

function envMtbMinzoom(fallback: number): number {
  const raw = process.env["MTB_MINZOOM"];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  // 0 is a valid minzoom (world zoom), so this cannot reuse envInt (n > 0).
  if (!Number.isInteger(n) || n < 0 || n > 14) {
    throw new Error(`invalid value for MTB_MINZOOM: ${raw} (expected an integer between 0 and 14)`);
  }
  return n;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function envBasePath(): string {
  const raw = process.env["BASE_PATH"] ?? "";
  const p = raw.replace(/\/+$/, "");
  if (p === "") return "";
  if (!/^\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(p)) {
    throw new Error(
      `invalid BASE_PATH: ${raw} (expected a URL path segment like /mtb, without a trailing slash)`,
    );
  }
  return p;
}

export function loadConfig(): Config {
  // dist/config.js -> <app>/dist -> <app>; src/config.ts (dev) -> <app>/src -> <app>
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dataDir = process.env.DATA_DIR ?? "/data";

  return {
    port: envInt("PORT", 8080),
    publicDir: path.join(appRoot, "public"),
    dataDir,
    countryName: process.env.COUNTRY_NAME ?? "Norway",
    osmUrl:
      process.env.OSM_URL ??
      "https://download.geofabrik.de/europe/norway-latest.osm.pbf",
    osmFile: process.env.OSM_FILE ?? path.join(dataDir, "norway-latest.osm.pbf"),
    mbtilesFile:
      process.env.MBTILES_FILE ?? path.join(dataDir, "openmaptiles.mbtiles"),
    // Self-contained openmaptiles/planetiler-openmaptiles profile jar
    // (v3.16 release, planetiler 0.9.3 baked in), installed by the image.
    planetilerJar:
      process.env.PLANETILER_JAR ??
      "/opt/planetiler/planetiler-openmaptiles.jar",
    // Planetiler heap. 768 MB OOMs in the Natural Earth / water-polygon
    // shapefile stage (verified 2026-08-29); 4096 MB builds real extracts.
    planetilerHeapMb: envInt("PLANETILER_HEAP_MB", 4096),
    // Dedicated mtb:scale overlay tileset (step 11 / decision B1). MTB_MINZOOM
    // is the build-time parameter: the tileset's minzoom, the MTB overlay's
    // display minzoom, and (recorded in the artifact) what "current" means.
    mtbMinzoom: envMtbMinzoom(3),
    // Self-contained mtb-profile jar (same planetiler 0.9.3 core as the
    // basemap jar), built from ./mtb-profile by the image.
    mtbProfileJar:
      process.env.MTB_PROFILE_JAR ?? "/opt/planetiler/mtb-profile.jar",
    // Where the mtb overlay tileset is written (separate from the basemap).
    mtbMbtilesFile:
      process.env.MTB_MBTILES_FILE ?? path.join(dataDir, "mtb.mbtiles"),
    // Heap for the mtb build. It only reads ways (no shapefile/Natural Earth
    // stage), so it needs far less than the basemap build.
    mtbHeapMb: envInt("MTB_HEAP_MB", 2048),
    // Where Planetiler caches its auto-downloaded sources (Natural Earth +
    // water polygons) so rebuilds work offline, and where it keeps temp data.
    planetilerSourcesDir:
      process.env.PLANETILER_SOURCES_DIR ?? path.join(dataDir, "sources"),
    planetilerTmpDir: process.env.PLANETILER_TMP_DIR ?? path.join(dataDir, "tmp"),
    // Step 12 (single-port serving): Martin is an INTERNAL service — the
    // browser reaches its tiles through the app's /tiles proxy, so it binds
    // to loopback by default and its port is never published from the
    // container.
    martinBind: process.env.MARTIN_BIND ?? "127.0.0.1",
    martinPort: envInt("MARTIN_PORT", 3000),
    martinConfig: process.env.MARTIN_CONFIG ?? path.join(appRoot, "martin.yaml"),
    // Full override for the tile source URL in the served style (escape
    // hatch for reverse proxies / external tile servers). Empty = derive it
    // request-host-aware from the app's own origin + the /tiles proxy (the
    // common case).
    tileSourceUrl: process.env.TILE_SOURCE_URL ?? "",
    basePath: envBasePath(),
    forceReimport: envBool("FORCE_REIMPORT", false),
    skipPipeline: envBool("SKIP_PIPELINE", false),
    // Safety cap for the mtb_scale tile scan in the artifact verification.
    verifyMtbMaxTiles: envInt("VERIFY_MTB_MAX_TILES", 4_000_000),
  };
}
