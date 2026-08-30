// @ts-check
import http from "node:http";
import fs from "node:fs";
import { createRequire } from "node:module";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// React UI (source in web/) → build output goes to public/, which the app
// server (src/server.ts) serves alongside the vendored style/sprite/fonts —
// so emptyOutDir stays OFF (public/ is never emptied by a build).
// base "./" → relative asset URLs → the UI works both at the host root and
// under a BASE_PATH sub-path (e.g. /mtb/).
//
// react / react-dom / maplibre-gl are devDependencies on purpose: Vite
// bundles them into public/assets, so the runtime server (and the pruned
// production image) never needs them at all.
//
// EXCEPTION — the MapLibre worker: maplibre-gl's prebuilt bundle finds its
// render-loop worker at RUNTIME via new URL("./maplibre-gl-worker.mjs",
// import.meta.url), i.e. next to whatever file ends up containing that code,
// and the worker itself imports its sibling ./maplibre-gl-shared.mjs. After
// Vite inlines maplibre into our bundle, "next to" means assets/ — but both
// files are siblings in maplibre's dist, not imports, so Vite never ships
// them. Without them the map cannot render at all (the `load` event never
// fires). We emit them into assets/ on build and serve them from disk in dev.
const require = createRequire(import.meta.url);
const maplibreDistFiles = ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"].map(
  (name) => require.resolve(`maplibre-gl/dist/${name}`),
);

const maplibreWorkerPlugin = {
  name: "maplibre-worker",
  apply: "build",
  generateBundle() {
    for (const file of maplibreDistFiles) {
      this.emitFile({
        type: "asset",
        fileName: `assets/${file.split("/").pop()}`,
        source: fs.readFileSync(file, "utf8"),
      });
    }
  },
};

const BACKEND = "http://localhost:8080";

export default defineConfig({
  root: "web",
  base: "./",
  plugins: [react(), maplibreWorkerPlugin],
  server: {
    // `npm run dev:web` = HMR loop; the app (container or `npm run dev`) on
    // :8080 is the backend — everything the UI fetches is proxied to it.
    proxy: {
      "/api": BACKEND,
      "/tiles": BACKEND,
      "/style.json": BACKEND,
      "/sprite.json": BACKEND,
      "/sprite.png": BACKEND,
      "/sprite@2x.json": BACKEND,
      "/sprite@2x.png": BACKEND,
    },
    configureServer(server) {
      // MapLibre worker + shared chunk (see header note): in dev,
      // import.meta.url points at Vite's optimized-deps copy of maplibre, so
      // ./maplibre-gl-{worker,shared}.mjs 404 there too — serve the real
      // files for any such request.
      server.middlewares.use((req, res, next) => {
        const m = (req.url ?? "").match(/\/(maplibre-gl-(?:worker|shared)\.mjs)(?:\?|$)/);
        if (req.method === "GET" && m) {
          res.setHeader("content-type", "text/javascript");
          fs.createReadStream(require.resolve(`maplibre-gl/dist/${m[1]}`)).pipe(res);
          return;
        }
        next();
      });
      // Glyph fonts are a catch-all route: /<fontstack>/<range>.pbf
      // (e.g. /Open%20Sans%20Regular/0-255.pbf) — proxy those to the app too.
      server.middlewares.use((req, res, next) => {
        if (req.method !== "GET" || !/^\/[^/]+\/\d+-\d+\.pbf$/.test(req.url ?? "")) {
          next();
          return;
        }
        const upstream = http.get({ host: "localhost", port: 8080, path: req.url }, (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        });
        upstream.on("error", () => {
          if (!res.headersSent) res.writeHead(502, {});
          res.end("502 — app backend (localhost:8080) unreachable");
        });
      });
    },
  },
  build: { outDir: "../public", emptyOutDir: false },
});
