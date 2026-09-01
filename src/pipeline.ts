import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { download, clearArtifact, fmtBytes } from "./download.js";
import { getLatestDatasetUrl } from "./upstream.js";
import { EXPECTED_SOURCE, MartinServer, expectedMtbSource } from "./martin.js";
import { log } from "./log.js";
import type { Config } from "./config.js";
import { status, type PipelineState } from "./status.js";
import { runMtbProfile, runPlanetiler } from "./build.js";
import {
  MTB_OVERLAY_LAYER,
  MTB_PROFILE_VERSION,
  readMtbMinzoom,
  readMtbProfileVersion,
  readMtbHasBikePark,
  readTilesetView,
  REQUIRED_MAXZOOM,
  VerifyError,
  verifyMbtiles,
  verifyMtbMbtiles,
} from "./verify.js";
import { readOsmDataDate } from "./osm-date.js";
import {
  verifyDemServing,
  verifyStyleServing,
} from "./style.js";

/** The skip/build decision for each vector tileset. */
export interface BuildPlan {
  basemap: "skip" | "build";
  mtb: "skip" | "build";
}

/**
 * The skip/build decision, derived from the config + the presence of the
 * existing artifacts (cheap metadata read — no download/build). A stale MTB
 * minzoom fails fast HERE, before any long-running work. Shared by the startup
 * pipeline and the on-demand re-import.
 *
 *  - basemap: skip when `openmaptiles.mbtiles` exists, unless FORCE_REIMPORT.
 *  - mtb: rebuild on FORCE_REIMPORT or a missing artifact; keep an existing
 *    `mtb.mbtiles` only when its recorded minzoom matches MTB_MINZOOM,
 *    otherwise throw (stale artifact).
 */
export function planBuilds(cfg: Config, artifactPresent: boolean): BuildPlan {
  const basemap: "skip" | "build" =
    artifactPresent && !cfg.forceReimport ? "skip" : "build";

  let mtb: "skip" | "build";
  if (cfg.forceReimport) {
    mtb = "build";
  } else if (existsSync(cfg.mtbMbtilesFile)) {
    const recorded = readMtbMinzoom(cfg.mtbMbtilesFile);
    if (recorded === cfg.mtbMinzoom) {
      mtb = "skip";
    } else {
      throw new VerifyError(
        `stale ${cfg.mtbMbtilesFile}: recorded minzoom ${recorded ?? "(missing)"} but MTB_MINZOOM is ${cfg.mtbMinzoom} — rebuild with FORCE_REIMPORT=1`,
      );
    }
  } else {
    mtb = "build";
  }
  return { basemap, mtb };
}

/** A progress/status update the build core reports to its caller. */
export interface BuildProgress {
  state?: PipelineState;
  progress?: number;
  message?: string;
}
export type BuildProgressFn = (update: BuildProgress) => void;

/** What the build core reports back about the MTB tileset (for the snapshot). */
export interface BuildTilesetsResult {
  mtbProfileVersion: string | null;
  mtbHasBikePark: boolean;
  /**
   * The OSM PBF the tilesets were actually built from. This is the resolved
   * extract — the downloaded one (`osmDownloadFile`) when present, else the
   * mounted seed (`osmFile`).
   */
  osmInput: string;
}

/**
 * The reusable download → build → verify core for BOTH vector tilesets (the
 * basemap `openmaptiles.mbtiles` and the MTB overlay `mtb.mbtiles`), shared by
 * the startup pipeline and the on-demand re-import. Progress is reported
 * through `hooks` (the pipeline feeds it to the status snapshot; the re-import
 * to its own state). It does NOT start Martin or flip the app to "ready" — the
 * caller does that. `dem.mbtiles` is never touched here (it is mounted, not
 * built by this app).
 */
export async function buildTilesets(
  cfg: Config,
  hooks: BuildProgressFn,
): Promise<BuildTilesetsResult> {
  const artifactPresent = existsSync(cfg.mbtilesFile);
  const plan = planBuilds(cfg, artifactPresent);

  let mtbProfileVersion: string | null;
  let mtbHasBikePark: boolean;
  // `buildCfg` tracks the resolved OSM input: it starts as the seed config and
  // is replaced by `ensureOsExtract` with the actually-usable extract (download
  // over seed). Both build steps read the PBF path from `buildCfg.osmFile`.
  let buildCfg: Config = cfg;

  if (plan.basemap === "build") {
    if (cfg.forceReimport) {
      log("FORCE_REIMPORT=1 — forcing a fresh download + build");
      // Only the writable download file is cleared; the mounted seed
      // (cfg.osmFile) is never touched, so a read-only bind mount keeps working.
      clearArtifact(cfg.osmDownloadFile);
      clearArtifact(cfg.mbtilesFile);
      clearArtifact(cfg.mtbMbtilesFile);
    }
    // Fail fast on a broken toolchain BEFORE spending a ~1.3 GB download on a
    // pipeline that cannot build.
    checkToolchain(cfg);

    buildCfg = await ensureOsExtract(buildCfg, hooks, cfg.forceReimport);

    hooks({ state: "building", progress: 0, message: "Building OpenMapTiles tileset with Planetiler" });
    await runPlanetiler(buildCfg, {
      onProgress: (progress, message) => hooks({ progress, message }),
    });

    hooks({ state: "building", progress: 100, message: "Verifying tileset artifact" });
    const v = verifyMbtiles(cfg.mbtilesFile);
    log(
      `tileset verified: ${v.layers.length} layers, z${v.zooms[0]}–z${v.zooms[v.zooms.length - 1]}`,
    );
    hooks({ message: "Tileset verified — building MTB tileset" });
  } else {
    const size = statSync(cfg.mbtilesFile).size;
    log(`tileset artifact present — skipping download + build (${fmtBytes(size)})`);
    hooks({ message: `Tileset present (${fmtBytes(size)}) — checking MTB tileset` });
  }

  // Step 11 (decision B1): the dedicated low-zoom MTB overlay tileset. It is
  // built from the same OSM extract by the mtb-profile jar (ways with a
  // non-empty mtb:scale, z MTB_MINZOOM..14) and verified before serving.
  if (plan.mtb === "build") {
    // The basemap may have been skipped (artifact present) while the extract
    // is gone — the mtb build still needs the OSM PBF.
    buildCfg = await ensureOsExtract(buildCfg, hooks, cfg.forceReimport);
    // Preserved from the original pipeline: the toolchain is re-checked in the
    // MTB branch only when the basemap was also built (already checked); the
    // basemap-skipped path relies on runMtbProfile's own jar check.
    if (plan.basemap === "build") checkToolchain(cfg);

    hooks({ state: "building", progress: 0, message: `Building MTB tileset (mtb:scale ways, z${cfg.mtbMinzoom}–z${REQUIRED_MAXZOOM})` });
    await runMtbProfile(buildCfg, {
      onProgress: (progress, message) => hooks({ progress, message }),
    });

    hooks({ state: "building", progress: 100, message: "Verifying MTB tileset artifact" });
    const mv = verifyMtbMbtiles(cfg.mtbMbtilesFile, cfg.mtbMinzoom);
    mtbProfileVersion = mv.profileVersion;
    mtbHasBikePark = mv.hasBikePark;
    log(
      `mtb tileset verified: ${mv.layers.join(", ")} layers, z${mv.zooms[0]}–z${mv.zooms[mv.zooms.length - 1]}`,
    );
    hooks({ message: "MTB tileset verified — starting tile server" });
  } else {
    const size = statSync(cfg.mtbMbtilesFile).size;
    mtbProfileVersion = readMtbProfileVersion(cfg.mtbMbtilesFile);
    mtbHasBikePark = readMtbHasBikePark(cfg.mtbMbtilesFile);
    log(`mtb tileset present (minzoom ${cfg.mtbMinzoom}, ${fmtBytes(size)}) — skipping mtb build`);
    hooks({ message: `MTB tileset present (z${cfg.mtbMinzoom}) — starting tile server` });
  }

  return { mtbProfileVersion, mtbHasBikePark, osmInput: buildCfg.osmFile };
}

/**
 * Full startup pipeline:
 *
 *   checking -> buildTilesets (download/build/verify both tilesets)
 *            -> starting -> ready
 *
 * The download+build stage is skipped when the openmaptiles.mbtiles artifact
 * already exists, unless FORCE_REIMPORT=1 (see planBuilds). Returns the running
 * MartinServer so the caller can shut it down on exit.
 */
export async function runPipeline(cfg: Config): Promise< MartinServer> {
  status.update({
    state: "checking",
    progress: 0,
    message: "Checking toolchain + existing tileset artifact",
  });

  const { mtbProfileVersion, mtbHasBikePark, osmInput } = await buildTilesets(cfg, (u) => status.update(u));

  // Workstream C: a tileset built by an older profile (v1) still renders
  // natural trails (the overlay filter is back-compatible) but has no
  // bike-park data — warn (do not fail) and point at FORCE_REIMPORT. A
  // future/newer version is fine.
  const expectedProfile = Number(MTB_PROFILE_VERSION);
  const gotProfile = mtbProfileVersion === null ? null : Number(mtbProfileVersion);
  if (gotProfile === null || gotProfile < expectedProfile) {
    log(
      `warning: mtb tileset was built by profile ${mtbProfileVersion ?? "(v1, no version recorded)"} ` +
        `but this app expects profile ${MTB_PROFILE_VERSION} — natural trails render, but bike-park ` +
        `trails (mtb:scale:imba) need a rebuild: FORCE_REIMPORT=1`,
    );
  }

  status.update({ state: "starting", message: "Starting Martin tile server" });
  const martin = new MartinServer(cfg);
  await martin.start();

  // Step 7: the basemap style must be compatible with the tileset, and the
  // tile server must actually serve decodable tiles — fail fast now, not in
  // the browser.
  status.update({ message: "Verifying basemap style + render smoke test" });
  await verifyStyleServing(cfg, martin.url);

  // 3D-terrain (OPTIONAL): when a dem.mbtiles artifact is present, the dem
  // source must actually be SERVED (a decodable PNG of the artifact's
  // tileSize) — fail fast now, not in the browser. Absent artifact = the
  // feature is simply off; a no-DEM deployment is unaffected.
  let demInfo:
    | {
        source: string;
        encoding: "mapbox" | "terrarium";
        tileSize: number;
        minzoom: number;
        maxzoom: number;
      }
    | null = null;
  if (existsSync(cfg.demMbtilesFile)) {
    status.update({ message: "Verifying 3D terrain serving" });
    demInfo = await verifyDemServing(cfg, martin.url);
  }

  // Workstream A + D: the OSM data date and the tileset's own bounds/center,
  // so the UI can show "data as of …" and open the map on the extract's
  // extent instead of a hardcoded Norway view.
  const dataDate = readOsmDataDate(cfg.mbtilesFile, osmInput);
  const view = readTilesetView(cfg.mbtilesFile);
  if (dataDate) log(`OSM data as of ${dataDate}`);

  status.update({
    state: "ready",
    progress: 100,
    message: "Ready — loading map",
    name: cfg.countryName,
    dataDate: dataDate ?? null,
    bounds: view.bounds,
    center: view.center,
    martin: {
      url: martin.url,
      source: EXPECTED_SOURCE,
      layers: martin.layers,
      mtb: {
        source: expectedMtbSource(cfg.mtbMbtilesFile),
        layer: MTB_OVERLAY_LAYER,
        minzoom: cfg.mtbMinzoom,
        hasBikePark: mtbHasBikePark,
        profileVersion: mtbProfileVersion ?? undefined,
      },
      dem: demInfo ?? undefined,
    },
  });
  return martin;
}

/**
 * Verifies the build toolchain before any long-running work, for BOTH profile
 * jars (the basemap openmaptiles jar and the mtb-profile jar):
 *  - the jar exists,
 *  - `java` is on the PATH and can run the jar,
 *  - the jar accepts the CLI flags this app passes (catches a jar/version
 *    mismatch early instead of mid-build).
 */
function checkToolchain(cfg: Config): void {
  const problems: string[] = [];
  probeJar(cfg.planetilerJar, "PLANETILER_JAR", "openmaptiles/planetiler-openmaptiles v3.16", problems);
  probeJar(cfg.mtbProfileJar, "MTB_PROFILE_JAR", "the mtb-profile jar (./mtb-profile)", problems);
  if (problems.length > 0) {
    throw new VerifyError(`toolchain check failed:\n  - ${problems.join("\n  - ")}`);
  }
  log("toolchain OK (java + basemap jar + mtb-profile jar)");
}

function probeJar(jar: string, envName: string, expected: string, problems: string[]): void {
  if (!existsSync(jar)) {
    problems.push(`profile jar not found: ${jar} (set ${envName} or use the container image)`);
    return;
  }
  const probe = spawnSync("java", ["-jar", jar, "--help"], {
    encoding: "utf8",
    timeout: 120_000,
  });
  if (probe.error !== undefined) {
    problems.push(`java not usable: ${probe.error.message}`);
  } else if (probe.status !== 0) {
    problems.push(
      `profile jar --help failed (exit ${probe.status}): ${[probe.stdout, probe.stderr]
        .filter(Boolean)
        .join("\n")
        .slice(-500)}`,
    );
  } else if (!/osm_path/.test(`${probe.stdout}\n${probe.stderr}`)) {
    problems.push(`profile jar --help does not list "osm_path" — incompatible jar (expected ${expected})`);
  }
}

/**
 * Resolves the OSM extract PBF to build from and downloads the provider's
 * newest dated release (resolved from the listing page) only when needed.
 *
 * This is called once per build step (basemap, then MTB overlay), so it must be
 * idempotent within a run: a downloaded extract that already exists is REUSED,
 * never re-downloaded. `forceDownload` only means "do not fall back to the
 * mounted seed" — it is what makes a re-import fetch a NEWER extract than the
 * seed, not re-download a file that is already present.
 *
 * Resolution order:
 *   1. `cfg.osmDownloadFile` — a fresh extract, if present, always wins and is
 *      reused (this is what prevents a double download across the two build steps).
 *   2. `cfg.osmFile` — the mounted seed, but ONLY when not forcing a fresh download.
 *   3. otherwise — download the newest release into the writable `osmDownloadFile`.
 *
 * The seed is never a write/delete target, so a read-only bind mount stays safe.
 * Returns a config whose `osmFile` points at the resolved PBF for the build steps.
 */
export async function ensureOsExtract(
  cfg: Config,
  hooks: BuildProgressFn,
  forceDownload: boolean,
): Promise<Config> {
  // 1. A downloaded extract, once present, always wins and is reused. This is
  //    what makes the MTB step reuse the file the basemap step just downloaded.
  if (existsSync(cfg.osmDownloadFile)) {
    const size = statSync(cfg.osmDownloadFile).size;
    log(`OSM extract present: ${cfg.osmDownloadFile} (${fmtBytes(size)}) — using it, skipping download`);
    hooks({ message: `OSM extract present (${fmtBytes(size)}) — building tileset` });
    return { ...cfg, osmFile: cfg.osmDownloadFile };
  }

  // 2. No fresh extract yet. A mounted seed can be used — but only when we are
  //    NOT forcing a fresh download (a re-import wants a NEWER extract than the
  //    seed, so it skips the seed and downloads).
  if (!forceDownload) {
    if (existsSync(cfg.osmFile)) {
      const size = statSync(cfg.osmFile).size;
      log(`using seed extract: ${cfg.osmFile} (${fmtBytes(size)}) — skipping download`);
      hooks({ message: `OSM extract present (${fmtBytes(size)}) — building tileset` });
      return { ...cfg, osmFile: cfg.osmFile };
    }
  } else {
    log("no fresh extract yet — forcing a fresh download (ignoring the mounted seed)");
  }

  // 3. Download the newest release into the writable download file.
  const dest = cfg.osmDownloadFile;
  const latestUrl = await getLatestDatasetUrl(cfg.osmListingUrl);
  if (latestUrl === null) {
    throw new VerifyError(`could not determine an OSM extract URL from ${cfg.osmListingUrl}`);
  }

  hooks({ state: "downloading", progress: 0, message: `Downloading OSM extract from ${latestUrl}` });
  log(`downloading OSM extract: ${latestUrl} -> ${dest}`);
  await download(latestUrl, dest, (bytes, total) => {
    if (total !== null && total > 0) {
      hooks({
        progress: (bytes / total) * 100,
        message: `Downloading OSM extract ${fmtBytes(bytes)} / ${fmtBytes(total)}`,
      });
    } else {
      hooks({ message: `Downloading OSM extract ${fmtBytes(bytes)} (size unknown)` });
    }
  });
  return { ...cfg, osmFile: dest };
}
