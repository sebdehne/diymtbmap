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
  /**
   * Geofabrik listing page parsed for the newest dated `.osm.pbf` release.
   * The boot pipeline and the on-demand re-import both resolve the concrete
   * download URL from this page.
   */
  osmListingUrl: string;
  /**
   * OSM extract SEED (optional): a PBF you provide or bind-mount (read-only is
   * fine) as a "kickoff" extract so the app doesn't have to download one — e.g.
   * to avoid repeated ~1.3 GB downloads during testing. It is a FALLBACK only:
   * when a downloaded extract (`osmDownloadFile`) is present, that one wins.
   * The app never deletes or overwrites this file.
   */
  osmFile: string;
  /**
   * OSM extract DOWNLOAD destination: where a fresh extract is fetched (normal
   * boot with no seed, `FORCE_REIMPORT`, or an on-demand re-import). Higher
   * priority than the seed (`osmFile`) — when present the app builds from it.
   * Must be writable (it lives in the data volume, never on a read-only mount).
   */
  osmDownloadFile: string;
  /**
   * Persisted re-import attempt state (date + outcome). Deleting this file is
   * the supported way to allow another attempt on the same day.
   */
  reimportStateFile: string;
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
  /**
   * Optional 3D-terrain tileset (raster DEM, `dem.mbtiles`): a `raster-dem`
   * MBTiles source the web UI can toggle for real elevation. Built by the
   * standalone `tools/dem-to-raster-tiles-converter/build-dem.py` converter (Option B, host-side) and dropped
   * into the data volume — it is NOT built by this app. When the file is
   * absent the whole feature degrades away (no `dem` source, no toggle) and
   * everything else is unchanged.
   */
   demMbtilesFile: string;
   planetilerSourcesDir: string;
  planetilerTmpDir: string;
  martinBind: string;
  martinPort: number;
  martinConfig: string;
  forceReimport: boolean;
  skipPipeline: boolean;
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

/**
 * Staging destination for an artifact being rebuilt in place during an
 * on-demand re-import: `openmaptiles.mbtiles` ->
 * `openmaptiles.staging.mbtiles`. The staging file is verified, then renamed
 * over the live artifact.
 */
export function stagingPath(file: string): string {
  return file.endsWith(".mbtiles")
    ? `${file.slice(0, -".mbtiles".length)}.staging.mbtiles`
    : `${file}.staging`;
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
    osmListingUrl:
      process.env.OSM_LISTING_URL ??
      "https://download.geofabrik.de/europe/norway.html",
    osmFile: process.env.OSM_FILE ?? path.join(dataDir, "norway-latest.osm.pbf"),
    osmDownloadFile:
      process.env.OSM_DOWNLOAD_FILE ?? path.join(dataDir, "osm-download.osm.pbf"),
    reimportStateFile:
      process.env.REIMPORT_STATE_FILE ?? path.join(dataDir, "last-reimport.json"),
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
    // Optional 3D-terrain tileset. Built externally by tools/dem-to-raster-tiles-converter/build-dem.py into
    // this file; the app only serves it. Absent file = feature off (degraded).
    demMbtilesFile:
      process.env.DEM_MBTILES_FILE ?? path.join(dataDir, "dem.mbtiles"),
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
  };
}
