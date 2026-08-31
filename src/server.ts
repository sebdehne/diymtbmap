import { existsSync } from "node:fs";
import path from "node:path";
import express from "express";
import { loadConfig } from "./config.js";
import { log } from "./log.js";
import { runPipeline } from "./pipeline.js";
import type { MartinServer } from "./martin.js";
import { status } from "./status.js";
import { resolveGlyphFile } from "./fonts.js";
import {
  buildAppOrigin,
  buildDemSourceSpec,
  buildMtbSourceSpec,
  buildTileSourceSpec,
  demSpecFor,
  loadStyle,
  withTileSources,
} from "./style.js";
import { expectedDemSource, expectedMtbSource } from "./martin.js";
import { registerTileProxy } from "./tiles.js";

const cfg = loadConfig();

// The inner app is always defined at the ROOT of its mount point; when
// BASE_PATH is set it is mounted under that prefix by the root app below, so
// every route (/api/status, /style.json, /tiles/..., /:fontstack/:range,
// static) works both at the host root and under a sub-path like /mtb —
// leaving every other path on the host untouched.
const inner = express();
inner.disable("x-powered-by");

// Glyph fonts are gitignored and fetched (Dockerfile at build time; locally
// via `npm run vendor-fonts`) — warn early if they are missing, otherwise
// map labels silently fail to render in the browser.
if (!existsSync(path.join(cfg.publicDir, "Open Sans Regular"))) {
  log(
    `warning: glyph fonts missing in ${cfg.publicDir} — map labels will not render; run "npm run vendor-fonts" (container builds always include them)`,
  );
}

inner.use((_req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  next();
});

inner.get("/api/status", (_req, res) => {
  res.json(status.snapshot());
});

// Step 12 (single-port serving): ALL browser traffic goes through the app's
// single port. Martin is an internal, loopback-bound service the browser
// never reaches directly — this proxy forwards /tiles/<source>/<z>/<x>/<y>
// to it, streaming the body (no full buffering). `:source` is parameterized
// so both the basemap (openmaptiles) and the step-11 overlay (mtb) flow
// through the same route. The MartinServer is created by the pipeline after
// startup, so the URL is read per request (503 until it exists). Registered
// before the static handler; the 4-segment path cannot collide with the
// 2-segment /:fontstack/:range route.
let martin: MartinServer | undefined;
// When a dem tileset is served, register it so a MISSING dem tile (Martin's
// 204 No Content) is answered with a valid flat "no data" PNG instead of an
// empty body. An empty body makes the dem client's createImageBitmap throw
// ("The image could not be decoded" — a map-load error in Firefox). Only the
// dem source is registered; vector sources keep their 204 pass-through. The
// id/encoding/tileSize are derived from the artifact, so this is computed once.
const demSources: Record<string, { encoding: "mapbox" | "terrarium"; tileSize: number }> = (() => {
  if (!existsSync(cfg.demMbtilesFile)) return {};
  try {
    const spec = demSpecFor(cfg.demMbtilesFile);
    return {
      [expectedDemSource(cfg.demMbtilesFile)]: { encoding: spec.encoding, tileSize: spec.tileSize },
    };
  } catch {
    // A corrupt/unreadable dem file degrades to no null-tile (same as a no-DEM
    // deployment) rather than crashing server startup.
    return {};
  }
})();
registerTileProxy(inner, () => martin?.url, demSources);

// Serve the basemap style with the tile sources pointed at the app's /tiles
// proxy (request-host-aware): the basemap source plus the step-11 MTB
// overlay source as inline `tiles` templates (MapLibre 6.x fetches a vector
// source `url` as a TileJSON endpoint — a bare base 404s and kills the
// source), and the relative sprite/glyphs URLs made absolute (MapLibre 6.x
// requires an absolute sprite URL). Everything else is the vendored style,
// byte for byte; the file on disk is never mutated. Must be registered
// before the static handler so it wins over public/style.json.
inner.get("/style.json", (req, res) => {
  const styleFile = path.join(cfg.publicDir, "style.json");
  if (!existsSync(styleFile)) {
    res
      .status(500)
      .type("text/plain")
      .send(`basemap style not found: ${styleFile} — run "npm run vendor-style"`);
    return;
  }
  try {
    const style = loadStyle(styleFile);
    // The optional 3D-terrain source is injected only when the dem.mbtiles
    // artifact is present — a no-DEM deployment serves the exact same style as
    // before (no `dem` source), so the map is unaffected. (Contour lines are
    // not a separate source: they are computed client-side from this same `dem`
    // source by maplibre-contour, so there is no contours source to inject.)
    const demPresent = existsSync(cfg.demMbtilesFile);
    res.json(
      withTileSources(
        style,
        buildTileSourceSpec(req, cfg),
        { id: expectedMtbSource(cfg.mtbMbtilesFile), spec: buildMtbSourceSpec(req, cfg) },
        // The app origin the browser sees, INCLUDING the BASE_PATH prefix, so
        // the absolute sprite/glyphs URLs resolve inside the mount (e.g.
        // /mtb/sprite, /mtb/{fontstack}/{range}.pbf).
        buildAppOrigin(req) + (cfg.basePath || ""),
        demPresent
          ? { id: expectedDemSource(cfg.demMbtilesFile), spec: buildDemSourceSpec(req, cfg) }
          : undefined,
      ),
    );
  } catch (e) {
    res.status(500).type("text/plain").send(`style error: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
});

// MapLibre 6.x requests glyph ranges for the WHOLE comma-joined text-font
// stack (e.g. "Open Sans Semibold,Noto Sans Regular/0-255.pbf"), but the
// vendored fonts ship one directory per font. Resolve the stack to the first
// font that provides the range (like OpenMapTiles' font server). Single-font
// paths (no comma) and non-glyph ranges pass through to the static handler.
inner.get("/:fontstack/:range", (req, res, next) => {
  const file = resolveGlyphFile(cfg.publicDir, String(req.params.fontstack), String(req.params.range));
  if (!file) return next();
  res.sendFile(file);
});

inner.use(express.static(cfg.publicDir));

inner.use((_req, res) => {
  res.status(404).type("text/plain").send("404 not found");
});

// Root app: mounts the inner app at the BASE_PATH (default "" = host root).
// /mtb (no trailing slash) redirects to /mtb/ so the relative asset URLs in
// index.html (assets/...) resolve against <base>/ in the browser.
// With BASE_PATH set, every OTHER path on this port still 404s from the
// inner app's catch-all — the app occupies exactly its sub-path and nothing
// else (nginx routes only /mtb/ here anyway).
const app = express();
if (cfg.basePath) {
  // Strict check on purpose: express routing is non-strict by default, so a
  // `app.get(basePath)` route would ALSO match `<basePath>/` and 302-redirect
  // to itself (infinite loop). Only the exact slash-less form is redirected.
  app.use((req, res, next) => {
    if (req.method === "GET" && req.originalUrl === cfg.basePath) {
      res.redirect(302, `${cfg.basePath}/`);
      return;
    }
    next();
  });
  app.use(cfg.basePath, inner);
} else {
  app.use(inner);
}

const server = app.listen(cfg.port, () => {
  log(
    `web UI + API listening on http://0.0.0.0:${cfg.port}${cfg.basePath || "/"} (public dir: ${cfg.publicDir})`,
  );
});

if (cfg.skipPipeline) {
  log("SKIP_PIPELINE=1 — not running the tileset pipeline");
  status.update({ state: "ready", progress: 100, message: "Pipeline skipped (SKIP_PIPELINE=1)" });
} else {
  runPipeline(cfg)
    .then((m) => {
      martin = m;
      log("pipeline complete — ready");
    })
    .catch((e: unknown) => {
      const detail = e instanceof Error ? e.stack ?? e.message : String(e);
      log(`pipeline failed: ${detail}`);
      status.update({
        state: "error",
        message: `Pipeline failed: ${e instanceof Error ? e.message : String(e)}`,
        error: detail,
      });
    });
}

function shutdown(): void {
  log("shutting down");
  martin?.shutdown();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3_000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
