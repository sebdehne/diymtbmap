# Map viewer for Mountain bike trails 

A self-contained web app (runs in a **single container**).
On first start it downloads the latest [OpenStreetMap](https://www.openstreetmap.org)
extract for the selected country (default is Norway) from [Geofabrik](https://download.geofabrik.de/europe/norway.html),
builds [OpenMapTiles](https://openmaptiles.org/) vector tiles with
[Planetiler](https://github.com/onthegomap/planetiler) + the official
`openmaptiles/planetiler-openmaptiles` profile (no database), serves them with
[Martin](https://github.com/maplibre/martin), and renders a
[MapLibre GL JS](https://maplibre.org/maplibre-gl-js/) map where every
`mtb:scale` trail is highlighted and colored by difficulty (0 = easy … 6 = extreme).

## Features

- **One-shot PBF → MBTiles build** of the full 16-layer OpenMapTiles basemap,
  with live download + build progress in the browser.
- **Dedicated low-zoom MTB tileset** so `mtb:scale` trails are visible from
  `z7` (thin lines) up to `z14`, drawn on top of an otherwise stock basemap.
- **Off-the-shelf OpenMapTiles "OSM OpenMapTiles" style (v3.16)** — a complete
  OSM-website-style vector basemap.
- **7-color difficulty ramp** (with `+`/`−` variants) and an info panel —
  collapsed to a round "i" button by default (mobile-friendly); one tap opens
  the full overlay: the difficulty legend plus data-source credits.
- **Single published port** — every browser request (UI, style, sprite, glyphs,
  and tiles) goes through the app; the tile server stays internal.
- **No database.** The persisted artifact is an MBTiles file in a volume;
  re-runs skip the download + build unless `FORCE_REIMPORT=1`.
- **Sub-path friendly** — can be mounted under a reverse-proxy path (e.g. `/mtb/`)
  without touching other paths on the host.

---

## How to build and run

The app ships as one multi-process container image. Build it, then run it with a
single published port and a volume for the data. The same `Dockerfile` works with
both **Podman** and **Docker** (it uses the BuildKit syntax front-matter, which
both support).

### Prerequisites

- A working **Podman** or **Docker** (with the BuildKit/buildah builder).
- Enough RAM for the one-time tileset build: the Planetiler build is run with a
  4 GB Java heap by default. A machine with ≥ 6–8 GB RAM is comfortable.
- Outbound network access on first run (to fetch the ~1.3 GB Norway OSM extract
  and Planetiler's small external data: Natural Earth + water polygons).

### 1. Build the image

Podman:

```sh
podman build -t diymtbmap .
```

Docker:

```sh
docker build -t diymtbmap .
```

The build is fully pinned (Node, JRE, Martin, profile jar, style, fonts — all
SHA256- or version-pinned), so it is reproducible and multi-arch (amd64 + arm64).

### 2. Run it

Podman:

```sh
podman run -d --name diymtbmap -p 8080:8080 -v diymtbmap-data:/data diymtbmap
```

Docker:

```sh
docker run -d --name diymtbmap -p 8080:8080 -v diymtbmap-data:/data diymtbmap
```

Then open <http://localhost:8080>.

- **Publish only port `8080`.** The tile server (Martin) binds to loopback inside
  the container and is reached by the browser through the app's `/tiles/…` proxy —
  do not publish its port.
- The **`/data` volume** holds the OSM PBF, both MBTiles artifacts, and Planetiler's
  cached external data. Use a named volume (as above) or a bind mount to a writable
  directory. Everything the app needs to rebuild is reproducible from this volume.

### What happens on first start

The app shows a progress card (state, %, elapsed) and walks through:

```
checking → downloading → building → starting → ready
```

1. **checking** — verifies the toolchain (Java + both profile jars) and whether
   `openmaptiles.mbtiles` already exists.
2. **downloading** — streams the ~1.3 GB Norway PBF from Geofabrik (tracked by bytes).
3. **building** — runs Planetiler twice: once for the 16-layer basemap
   (`openmaptiles.mbtiles`), once for the MTB overlay (`mtb.mbtiles`), then
   verifies both artifacts (layer coverage + a real `mtb_scale` feature present).
4. **starting** — starts Martin (loopback) and confirms it serves both expected
   sources with the right layers; runs a render smoke test against real tiles.
5. **ready** — the progress card is replaced by the map.

Real-world timing (arm64 container, measured): download ≈ 25–30 s, basemap build
≈ 4 min (4 GB heap), MTB build ≈ 1 min. **Restarting with the existing artifacts
takes a few seconds** (the download + build stage is skipped).

### Rebuilding / updating the data

- **`FORCE_REIMPORT=1`** — force a fresh download + rebuild of both tilesets even
  if the artifacts exist (clears them first).
- **`SKIP_PIPELINE=1`** — serve the UI + `/api/status` only; do not run the pipeline
  (for local development against pre-built data).
- To update to a newer OSM extract, set `FORCE_REIMPORT=1` and restart, or delete
  the artifacts from the `/data` volume and restart.

### Configuration

All knobs are environment variables (defaults shown). Copy `.env.example` for the
full list.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | The app's (only published) port. |
| `BASE_PATH` | `""` (root) | Sub-path to mount under (e.g. `/mtb`). No trailing slash. |
| `DATA_DIR` | `/data` | Where PBF + MBTiles + Planetiler cache live. |
| `OSM_URL` | Norway Geofabrik PBF | Source extract to download. |
| `OSM_FILE` | `/data/norway-latest.osm.pbf` | Local path for the extract. |
| `MBTILES_FILE` | `/data/openmaptiles.mbtiles` | Basemap tileset artifact. |
| `MTB_MINZOOM` | `3` | MTB overlay start zoom (build arg, baked in). |
| `MTB_MBTILES_FILE` | `/data/mtb.mbtiles` | MTB overlay tileset artifact. |
| `PLANETILER_HEAP_MB` | `4096` | Java heap for the basemap build (768 MB OOMs). |
| `MTB_HEAP_MB` | `2048` | Java heap for the MTB build (much smaller). |
| `PLANETILER_JAR` | `/opt/planetiler/planetiler-openmaptiles.jar` | Basemap profile jar. |
| `MTB_PROFILE_JAR` | `/opt/planetiler/mtb-profile.jar` | MTB profile jar. |
| `PLANETILER_SOURCES_DIR` | `$DATA_DIR/sources` | Cache for Natural Earth / water (offline rebuilds). |
| `PLANETILER_TMP_DIR` | `$DATA_DIR/tmp` | Planetiler scratch space. |
| `MARTIN_BIND` | `127.0.0.1` | Martin listen address (internal only). |
| `MARTIN_PORT` | `3000` | Martin port (internal only — never published). |
| `MARTIN_CONFIG` | `/app/martin.yaml` | Martin config file. |
| `TILE_SOURCE_URL` | *(empty)* | Full tile-source URL override for the style (escape hatch for proxies). |
| `FORCE_REIMPORT` | `0` | `1` = force a fresh download + rebuild. |
| `SKIP_PIPELINE` | `0` | `1` = serve UI + status only. |
| `VERIFY_MTB_MAX_TILES` | `4000000` | Safety cap for the `mtb_scale` verification scan. |

Example — serve under a sub-path and force a rebuild:

```sh
docker run -d --name diymtbmap -p 8080:8080 -v diymtbmap-data:/data \
  -e BASE_PATH=/mtb -e FORCE_REIMPORT=1 diymtbmap
```

### Sub-path deployment (reverse proxy)

When a host already serves other things and the map must live under its own path
(e.g. nginx `location /mtb/`), set `BASE_PATH=/mtb`. The app mounts itself there
and prefixes every browser-facing URL it emits (tiles, sprite, glyphs). A
slash-less request to `/mtb` 302-redirects to `/mtb/`. A minimal nginx block:

```nginx
location /mtb/ {
    proxy_pass http://localhost:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

(With `BASE_PATH` unset the app is served at the host root — zero behavior change.)

### Developing against the running container (fast UI iteration)

The UI is a React app in `web/`, built by Vite. For iteration, run the Vite dev
server alongside the running container:

```sh
npm ci
npm run dev:web            # Vite dev server on :5173, with HMR
```

Then open <http://localhost:5173> — the dev server proxies everything the UI
fetches to the app on :8080 (`/api`, `/tiles`, `style.json`, sprites, glyph
fonts; the target host is `const BACKEND` in `vite.config.js`). The loop is
**edit `web/src` → HMR** — no image rebuild, no full reload.

- `npm run build:web` — production bundle into `public/` (what the server and
  the image build consume).
- Backend changes (`src/`, `mtb-profile/`) still need an image rebuild:

  ```sh
  podman build -t diymtbmap .
  podman rm -f diymtbmap
  podman run -d --name diymtbmap -p 8080:8080 -v diymtbmap-data:/data diymtbmap
  ```

  (identical with `docker` — swap the binary name. Startup takes seconds: the
  tileset artifacts live in the `diymtbmap-data` volume, so the pipeline is
  skipped.)

### Developing without a container

The container is the supported runtime, but the Node app can run locally for
iteration. It still needs a Java 21 runtime, a `martin` binary on `PATH`, and the
two profile jars (build the MTB one with `cd mtb-profile && mvn package`, and point
`PLANETILER_JAR` / `MTB_PROFILE_JAR` at the jars). Then vendor the style + fonts
once and run:

```sh
npm ci
npm run vendor-style     # builds public/style.json + sprite (needs docker/podman)
npm run vendor-fonts     # fetches glyph pbf into public/
npm run build:web        # builds the React UI into public/
npm run dev              # tsx watch src/server.ts
```

Useful scripts:

| Script | Purpose |
|---|---|
| `npm run build` | Compile TypeScript (`tsc`) to `dist/`. |
| `npm run build:web` | Build the React UI (`vite build`) into `public/`. |
| `npm run dev` | Run the server with `tsx` in watch mode. |
| `npm run dev:web` | Vite dev server with HMR (proxies the app on :8080). |
| `npm start` | Run the compiled server (`node dist/server.js`). |
| `npm test` | Unit tests (Node `--test`). |
| `npm run lint` | ESLint. |
| `npm run typecheck` | TypeScript type check. |
| `npm run vendor-style` / `vendor-fonts` | Build/fetch the vendored style + glyph fonts. |

E2E harnesses live in `scripts/` (e.g. `e2e-check.ts`, `e2e-martin.ts`,
`e2e-mtb.ts`, `e2e-style.ts`) and exercise the real build + serving chain.

