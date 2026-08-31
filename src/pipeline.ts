import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { download, clearArtifact, fmtBytes } from "./download.js";
import { EXPECTED_SOURCE, MartinServer, expectedMtbSource } from "./martin.js";
import { log } from "./log.js";
import type { Config } from "./config.js";
import { status } from "./status.js";
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
  verifyMtbServing,
  verifyStyleServing,
} from "./style.js";

/**
 * Full startup pipeline:
 *
 *   checking -> [downloading -> building -> verify]
 *            -> [mtb building -> verify]
 *            -> starting -> ready
 *
 * The download+build stage is skipped when the openmaptiles.mbtiles artifact
 * already exists, unless FORCE_REIMPORT=1. The dedicated MTB overlay tileset
 * (step 11) is skipped when mtb.mbtiles exists AND its recorded minzoom
 * matches MTB_MINZOOM; a mismatch fails fast (stale artifact) unless
 * FORCE_REIMPORT=1. Returns the running MartinServer so the caller can shut
 * it down on exit.
 */
export async function runPipeline(cfg: Config): Promise< MartinServer> {
  status.update({
    state: "checking",
    progress: 0,
    message: "Checking toolchain + existing tileset artifact",
  });

  // Decide the MTB overlay artifact's fate up front (cheap metadata read),
  // so a stale minzoom fails fast BEFORE any long-running work.
  let mtbPlan: "skip" | "build";
  if (cfg.forceReimport) {
    // FORCE_REIMPORT rebuilds everything (the mtb artifact is cleared below).
    mtbPlan = "build";
  } else if (existsSync(cfg.mtbMbtilesFile)) {
    const recorded = readMtbMinzoom(cfg.mtbMbtilesFile);
    if (recorded === cfg.mtbMinzoom) {
      mtbPlan = "skip";
    } else {
      throw new VerifyError(
        `stale ${cfg.mtbMbtilesFile}: recorded minzoom ${recorded ?? "(missing)"} but MTB_MINZOOM is ${cfg.mtbMinzoom} — rebuild with FORCE_REIMPORT=1`,
      );
    }
  } else {
    mtbPlan = "build";
  }

  const artifactPresent = existsSync(cfg.mbtilesFile);
  if (artifactPresent && !cfg.forceReimport) {
    const size = statSync(cfg.mbtilesFile).size;
    log(`tileset artifact present — skipping download + build (${fmtBytes(size)})`);
    status.update({ message: `Tileset present (${fmtBytes(size)}) — checking MTB tileset` });
  } else {
    if (cfg.forceReimport) {
      log("FORCE_REIMPORT=1 — forcing a fresh download + build");
      clearArtifact(cfg.osmFile);
      clearArtifact(cfg.mbtilesFile);
      clearArtifact(cfg.mtbMbtilesFile);
    }
    // Fail fast on a broken toolchain BEFORE spending a ~1.3 GB download on a
    // pipeline that cannot build.
    checkToolchain(cfg);

    if (!existsSync(cfg.osmFile)) {
      status.update({
        state: "downloading",
        progress: 0,
        message: `Downloading OSM extract from ${cfg.osmUrl}`,
      });
      log(`downloading OSM extract: ${cfg.osmUrl} -> ${cfg.osmFile}`);
      await download(cfg.osmUrl, cfg.osmFile, (bytes, total) => {
        if (total !== null && total > 0) {
          status.update({
            progress: (bytes / total) * 100,
            message: `Downloading OSM extract ${fmtBytes(bytes)} / ${fmtBytes(total)}`,
          });
        } else {
          status.update({ message: `Downloading OSM extract ${fmtBytes(bytes)} (size unknown)` });
        }
      });
    } else {
      const size = statSync(cfg.osmFile).size;
      log(`OSM extract already present: ${cfg.osmFile} (${fmtBytes(size)}) — skipping download`);
      status.update({ message: `OSM extract present (${fmtBytes(size)}) — building tileset` });
    }

    status.update({
      state: "building",
      progress: 0,
      message: "Building OpenMapTiles tileset with Planetiler",
    });
    await runPlanetiler(cfg, {
      onProgress: (progress, message) => status.update({ progress, message }),
    });

    status.update({ state: "building", progress: 100, message: "Verifying tileset artifact" });
    const v = verifyMbtiles(cfg.mbtilesFile, {
      maxTiles: cfg.verifyMtbMaxTiles,
      onScan: (scanned) =>
        status.update({
          message: `Verifying tileset — scanning for mtb_scale (${scanned.toLocaleString("en-US")} tiles checked)`,
        }),
    });
    log(
      `tileset verified: ${v.layers.length} layers, z${v.zooms[0]}–z${v.zooms[v.zooms.length - 1]}, ` +
        `${v.tilesScanned.toLocaleString("en-US")} tiles scanned; mtb_scale sample at ` +
        `z${v.mtbHit.zoom}/${v.mtbHit.x}/${v.mtbHit.y}: ${JSON.stringify(v.mtbHit.properties)}`,
    );
    status.update({ message: "Tileset verified — building MTB tileset" });
  }

  // The mtb-profile version + whether the tileset carries bike-park trails,
  // tracked for the status snapshot and the stale-profile warning below.
  let mtbProfileVersion: string | null;
  let mtbHasBikePark: boolean;

  // Step 11 (decision B1): the dedicated low-zoom MTB overlay tileset. It is
  // built from the same OSM extract by the mtb-profile jar (ways with a
  // non-empty mtb:scale, z MTB_MINZOOM..14) and verified before serving.
  if (mtbPlan === "build") {
    if (!existsSync(cfg.osmFile)) {
      // The basemap was skipped (artifact present) but the extract is gone —
      // the mtb build still needs it.
      status.update({
        state: "downloading",
        progress: 0,
        message: `Downloading OSM extract from ${cfg.osmUrl}`,
      });
      log(`downloading OSM extract: ${cfg.osmUrl} -> ${cfg.osmFile}`);
      await download(cfg.osmUrl, cfg.osmFile, (bytes, total) => {
        if (total !== null && total > 0) {
          status.update({
            progress: (bytes / total) * 100,
            message: `Downloading OSM extract ${fmtBytes(bytes)} / ${fmtBytes(total)}`,
          });
        } else {
          status.update({ message: `Downloading OSM extract ${fmtBytes(bytes)} (size unknown)` });
        }
      });
    }
    // If the basemap was skipped, the toolchain was not checked above.
    if (!(artifactPresent && !cfg.forceReimport)) checkToolchain(cfg);

    status.update({
      state: "building",
      progress: 0,
      message: `Building MTB tileset (mtb:scale ways, z${cfg.mtbMinzoom}–z${REQUIRED_MAXZOOM})`,
    });
    await runMtbProfile(cfg, {
      onProgress: (progress, message) => status.update({ progress, message }),
    });

    status.update({ state: "building", progress: 100, message: "Verifying MTB tileset artifact" });
    const mv = verifyMtbMbtiles(cfg.mtbMbtilesFile, cfg.mtbMinzoom, {
      maxTiles: cfg.verifyMtbMaxTiles,
      onScan: (scanned) =>
        status.update({
          message: `Verifying MTB tileset — scanning mtb_scale (${scanned.toLocaleString("en-US")} tiles checked)`,
        }),
    });
    mtbProfileVersion = mv.profileVersion;
    mtbHasBikePark = mv.hasBikePark;
    const sample = mv.hits[0]!;
    log(
      `mtb tileset verified: ${mv.layers.join(", ")} layers, z${mv.zooms[0]}–z${mv.zooms[mv.zooms.length - 1]}, ` +
        `${mv.tilesScanned.toLocaleString("en-US")} tiles scanned; mtb_scale sample at ` +
        `z${sample.zoom}/${sample.x}/${sample.y}: ${JSON.stringify(sample.properties)}`,
    );
    status.update({ message: "MTB tileset verified — starting tile server" });
  } else {
    const size = statSync(cfg.mtbMbtilesFile).size;
    mtbProfileVersion = readMtbProfileVersion(cfg.mtbMbtilesFile);
    mtbHasBikePark = readMtbHasBikePark(cfg.mtbMbtilesFile);
    log(`mtb tileset present (minzoom ${cfg.mtbMinzoom}, ${fmtBytes(size)}) — skipping mtb build`);
    status.update({ message: `MTB tileset present (z${cfg.mtbMinzoom}) — starting tile server` });
  }

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

  // Step 11: the MTB overlay tileset must be served with content too (a
  // non-empty mtb_scale at the minzoom and z14 over HTTP) — fail fast now,
  // not in the browser.
  status.update({ message: "Verifying MTB overlay serving" });
  await verifyMtbServing(cfg, martin.url);

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
  const dataDate = readOsmDataDate(cfg.mbtilesFile, cfg.osmFile);
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
