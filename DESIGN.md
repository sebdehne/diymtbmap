## Tech stack

| Component | Version | Role |
|---|---|---|
| **Node.js** | 26.8.1 | Runtime for the orchestrator + web server. |
| **TypeScript** | 5.x (strict) | Language for the Node app (`src/`). |
| **Express** | 4.x | HTTP server: UI, `/api/status`, style, tile proxy, static. |
| **Planetiler** | 0.9.3 | Vector-tile compiler (Rust core, Java profile API), PBF → MBTiles. |
| **openmaptiles/planetiler-openmaptiles** | v3.16 (self-contained jar) | Official OMT profile — builds the 16-layer basemap tileset. |
| **mtb-profile** (this repo, `mtb-profile/`) | planetiler 0.9.3 core, Java 21 | Small custom profile — builds the low-zoom MTB overlay tileset. |
| **Eclipse Temurin JRE** | 21.0.9+10 | Runs the two Planetiler profile jars. |
| **Martin** | 1.14.0 (musl binary) | Vector tile server (serves both MBTiles files). |
| **React** | 19.x | UI framework (progress card, map view, info panel). Bundled at build time. |
| **Vite** (+ `@vitejs/plugin-react`) | 7.x | Dev server (HMR + app proxy) and the production UI build (`web/` → `public/`). |
| **MapLibre GL JS** | 6.6.0 | Browser renderer (basemap style + MTB overlay), bundled into the UI. |
| **OpenMapTiles "OSM OpenMapTiles" style** | v3.16 | Off-the-shelf vector basemap style (248 layers). |
| **openmaptiles/fonts** | v2.0 (`noto-open-sans`) | Glyph PBFs for the style's Open Sans / Noto Sans stacks. |
| **better-sqlite3** | 12.x | Reads MBTiles (SQLite) metadata + tiles for verification. |
| **@mapbox/vector-tile** + **pbf** | 3.x / 5.x | Decodes MVT during verification + render smoke tests. |

**Design principle: stay off-the-shelf.** The basemap is the OMT style, unmodified,
rendering the OMT data model produced by the OMT team's own Planetiler profile — so
data model and style stay in sync by construction. The only custom pieces are the
small `mtb-profile` (to get `mtb:scale` ways into a low-zoom tileset) and the thin
Node orchestrator around it. There is **no database at any stage** (no Postgres,
PostGIS, or imposm3).

All upstream versions are pinned (version + SHA256 where a binary/jar is fetched)
in the `Dockerfile` and the `scripts/vendor-*.sh` scripts for reproducible builds.

---

## Architecture

### Overview

One container, three cooperating processes. The Node app is the container's main
process: it serves everything the browser needs, runs the one-shot tileset build,
and spawns + supervises the tile server.

```
                    ┌──────────────────────────── single container ───────────────────────────┐
 browser            │                                                                          │
   │  :8080         │  ┌────────────┐   spawns   ┌──────────────────────────┐                 │
   ├────────────────┼─►│  Node app  │───────────►│  Martin (tile server)     │                 │
   │  UI/style/     │  │  (Express) │            │  127.0.0.1:3000 (internal)│                 │
   │  tiles/…       │  └─────┬──────┘            └────────────┬─────────────┘                 │
   │◄───────────────┼────────┴──── /tiles/… proxy ────────────┘                              │
                    │        │  one-shot (first run)                                          │
                    │        ▼                                                                │
                    │  ┌──────────────────────────────┐   ┌──────────────────────────┐        │
                    │  │ Planetiler + OMT profile (JRE)│   │ Planetiler + mtb-profile  │        │
                    │  │ PBF → openmaptiles.mbtiles    │   │ PBF → mtb.mbtiles         │        │
                    │  └──────────────────────────────┘   └──────────────────────────┘        │
                    │                                                                          │
                    │  /data volume: norway-latest.osm.pbf · openmaptiles.mbtiles ·            │
                    │                mtb.mbtiles · Planetiler source cache                     │
                    └──────────────────────────────────────────────────────────────────────────┘
```

- **Node app (orchestrator)** — container main process (`entrypoint.sh` →
  `node dist/server.js`). Serves the UI, `/api/status`, the basemap style +
  sprite + glyph fonts, and a streaming `/tiles/…` proxy. Runs the pipeline and
  keeps Martin alive (restarts it if it exits).
- **Planetiler + OMT profile** — one-shot: `Norway PBF → openmaptiles.mbtiles`
  (all 16 OMT layers, `mtb_scale` included). Auto-downloads Natural Earth + water
  polygons into its cache dir.
- **Planetiler + mtb-profile** — one-shot: `Norway PBF → mtb.mbtiles` (only
  `mtb:scale` ways, `z MTB_MINZOOM`–`z14`).
- **Martin** — tile server serving **both** MBTiles files as two sources
  (`openmaptiles` + `mtb`); loopback-bound, internal only.
- **MapLibre GL JS** — browser renderer (style + MTB overlay).

### Startup pipeline

`src/pipeline.ts` drives the sequence and reports it via the in-process
`Status` singleton (pollable at `GET /api/status`):

```
checking → [downloading → building → verify] → [mtb building → verify] → starting → ready
                                                                    (or → error)
```

- **checking** — probe the toolchain (Java can run both profile jars) and check
  for an existing `openmaptiles.mbtiles`. Decide the MTB artifact's fate up front
  (skip / build / fail-fast on a stale minzoom).
- **downloading** — stream the OSM PBF to `$OSM_FILE` with byte-accurate progress.
- **building** — run the OMT profile jar, then the mtb-profile jar (see below);
  per-stage progress is mapped from Planetiler's log onto a single 0–100 bar.
- **verify** — decode real tiles and assert: required layers present, zoom range
  z0–z14, and a **hard gate** that a non-empty `mtb_scale` feature actually exists
  (basemap at z14; MTB tileset at both its minzoom and z14). A region with no
  `mtb:scale` data is rejected, not silently served.
- **starting** — spawn Martin, poll `/health`, verify `/catalog` exposes both
  expected sources as MVT, then run a render smoke test that fetches + decodes
  real tiles over HTTP.
- **ready** — the status snapshot also reports the Martin URL, sources, layers,
  and the MTB overlay's source + minzoom so the frontend and data floor never diverge.

Fail-fast is a theme: a broken toolchain, a stale MTB minzoom, a missing required
layer, or an incompatible style is all caught **before** the browser ever loads,
with an actionable message (including a heap-`OOM` hint that names the env var to
raise).

### The two tilesets

| | Basemap | MTB overlay |
|---|---|---|
| Artifact | `openmaptiles.mbtiles` | `mtb.mbtiles` |
| Builder | OMT profile jar (v3.16) | `mtb-profile` jar |
| Content | All 16 OMT layers (roads, water, places, POI, …) | Only ways with a non-empty `mtb:scale` |
| Layer(s) | 16 (`transportation`, `water`, `place`, …) | 1 (`mtb`) |
| Key attribute | (class/subclass derived) | `mtb_scale` (raw string, e.g. `"3"`, `"4+"`) |
| Zoom range | z0–z14 | `z MTB_MINZOOM`–z14 |
| Martin source id | `openmaptiles` | `mtb` |

The basemap is **100% stock** OpenMapTiles. The MTB overlay exists because the
stock basemap only draws `path`/`track`/`service` ways at high zoom (z12+), so
`mtb:scale` trails would be invisible at low zoom. The dedicated tileset carries
every tagged way from `z MTB_MINZOOM` upward so the overlay can draw them at all
zooms, while the basemap keeps drawing the underlying road geometry.

### Single-port serving + tile proxy

All browser traffic uses the app's one port. Martin is an internal, loopback-bound
service the browser never reaches directly.

- `GET /tiles/:source/:z/:x/:y` — the app's **streaming proxy** to Martin's
  internal URL (status + `content-type` passed through, body piped without full
  buffering, client disconnect aborts the upstream read). Both `openmaptiles` and
  `mtb` flow through this one route.
- `GET /style.json` — serves the vendored style **with its sources rewritten** to
  point at the app's `/tiles` proxy (request-host-aware, honoring `Host` +
  `x-forwarded-proto`, and the `BASE_PATH` prefix), and with `sprite`/`glyphs`
  made absolute. The file on disk is never mutated. The `TILE_SOURCE_URL` env var
  can override the tile URL entirely.
- `GET /:fontstack/:range.pbf` — resolves MapLibre's whole comma-joined
  font-stack glyph request to the first vendored font that provides the range
  (MapLibre 6.x does not fall back per-font).
- `GET /api/status` — the pipeline status snapshot.
- `GET /` + `GET /assets/…` — the built UI: the React app with MapLibre GL JS
  bundled in (self-contained, no CDN, works offline).
- Everything else in `public/` — static (sprite, glyph fonts).

### Style + MTB overlay

- **Basemap**: the OpenMapTiles "OSM OpenMapTiles" style (v3.16), unmodified —
  a complete OSM-website-style vector basemap. Built once from the OMT source
  (`style-tools recompose` + `spreet`) in the Dockerfile `style` stage (or locally
  via `npm run vendor-style`); glyph fonts fetched from `openmaptiles/fonts` v2.0.
- **Overlay** (`shared/mtb-overlay.js`, a pure module shared by the web app and
  the Node tests): two line layers added **after** the basemap loads so they sit on top
  — a dark casing (`mtb-casing`) and the colored line (`mtb-scale`) on source
  `mtb` / layer `mtb`, filtered to `["has", "mtb_scale"]`.
    - **7-color ramp** by base level, with `+`/`−` variants sharing the base level's
      color; unknown/junk values fall back to a neutral gray (they never render as a
      difficulty).
    - **Zoom-interpolated width** — thin (0.375 px) at the minzoom floor, rising to
      3.5 px at z18; the casing is 2× the colored line. Round caps/joins. Both
      layers render at 50% opacity (`line-opacity: 0.5`).
    - **Display minzoom = `MTB_MINZOOM`**, taken from the served status snapshot so
      it always equals the tileset's data floor.
- **Controls**: a navigation control, and a single round **info control**
  (bottom-right, collapsed by default) that expands into a panel holding the
  difficulty legend (ramp swatches + level names + `+/−` note) **and** the
  data-source credits — MapLibre's own attribution control is disabled, so the
  ⓘ is the map's only chrome. A default `fitBounds` fits the mainland Norway
  extent.

### Project layout

```
.
├── Dockerfile               # Multi-stage, fully-pinned image build
├── entrypoint.sh            # Container main → node dist/server.js
├── martin.yaml              # Martin config: the two MBTiles sources
├── package.json             # Deps + scripts
├── .env.example             # Full configuration reference
├── vite.config.js           # UI build (web/ → public/) + dev-server proxy
├── web/                     # React UI source (Vite app)
│   ├── index.html           # Vite entry (root div → src/main.jsx)
│   └── src/
│       ├── main.jsx         # React mount
│       ├── App.jsx          # Status polling → progress card | map
│       ├── MapView.jsx      # MapLibre map init, MTB overlay, controls
│       ├── data.js          # Data-source credits (info panel)
│       ├── styles.css
│       └── components/      # ProgressCard, InfoControl, InfoPanel
├── shared/
│   └── mtb-overlay.js       # Overlay layers + color ramp (pure, tested;
│                            #   used by web/ and the Node tests)
├── public/                  # Served assets (build output + vendored, not committed)
│   ├── index.html           # Built UI shell (from web/)
│   ├── assets/              # Bundled UI (React + MapLibre + CSS)
│   └── (style.json, sprite*, glyph dirs — vendored at build time)
├── src/                     # Node/TS orchestrator (compiled to dist/)
│   ├── server.ts            # Express app: routes, proxy, style, mount
│   ├── pipeline.ts          # Startup orchestration + fail-fast checks
│   ├── build.ts             # Spawn the two Planetiler jars, stream progress
│   ├── download.ts          # Streamed OSM PBF download with progress
│   ├── verify.ts            # MBTiles/MVT artifact verification (SQLite + MVT)
│   ├── style.ts             # Style loading, source rewrite, serving checks
│   ├── martin.ts            # Spawn/supervise Martin, catalog/layer checks
│   ├── tiles.ts             # Streaming /tiles/… proxy to Martin
│   ├── fonts.ts             # Glyph font-stack resolution
│   ├── status.ts            # Pipeline state singleton
│   ├── config.ts            # Env → typed Config
│   └── log.ts
├── mtb-profile/             # Custom Planetiler profile (Java, Maven) → mtb-profile.jar
│   ├── pom.xml
│   └── src/main/java/com/diymtbmap/mtb/  # MtbProfile, MtbMain
├── scripts/
│   ├── vendor-style.sh      # Build the OMT style + sprite (docker/podman)
│   ├── vendor-fonts.sh      # Fetch glyph fonts
│   └── e2e-*.ts             # End-to-end harnesses (build + serve + decode)
└── test/                    # Unit tests (Node --test)
```

### Data model & MTB coloring

- The basemap follows the **OpenMapTiles v3.16 schema**: 16 MVT layers, each with
  derived attributes (`class`, `subclass`, …) computed from raw OSM tags by the
  profile. Geometries are Web Mercator (EPSG 3857).
- The MTB overlay reads the **raw `mtb:scale` string** (values `0`–`6` with
  optional `+`/`-`). `mtb-overlay.js` maps every valid raw value to its base
  level's color; values outside the set fall back to neutral gray.

| Level | Color | Label |
|---|---|---|
| 0 | `#43a047` | Easy |
| 1 | `#425cb3` | Intermediate |
| 2 | `#ff1b1b` | Advanced |
| 3 | `#393232` | Expert |
| 4 | `#201c1c` | Extreme I |
| 5 | `#070606` | Extreme II |
| 6 | `#4a148c` | Impossible |

### Data & attribution

Map data is licensed **Open Database License (ODbL) 1.0** by
[OpenStreetMap](https://www.openstreetmap.org/copyright) contributors. Per the
ODbL, this application and any redistribution of the data must:

- Prominently attribute the source: **© OpenStreetMap contributors**.
- License any database created from this data under the ODbL.
- Provide a link to the ODbL: <https://opendatacommons.org/licenses/odbl/>.

Data source for Norway: Geofabrik,
<https://download.geofabrik.de/europe/norway-latest.osm.pbf>.

Third-party tools and data:

- **Planetiler** — <https://github.com/onthegomap/planetiler> (Apache-2.0)
- **openmaptiles/planetiler-openmaptiles** profile + style — <https://github.com/openmaptiles/planetiler-openmaptiles>
- **Martin** — <https://github.com/maplibre/martin> (BSD-3-Clause)
- **MapLibre GL JS** — <https://maplibre.org/maplibre-gl-js/> (BSD-3-Clause)
- **Natural Earth** (admin boundaries / water, auto-downloaded by Planetiler) — <https://www.naturalearthdata.com/> (public domain)
- **Open Sans / Noto Sans glyphs** — <https://github.com/openmaptiles/fonts> (open source)
