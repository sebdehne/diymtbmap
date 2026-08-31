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
| **MapLibre GL JS** | 6.6.0 | Browser renderer (basemap style + MTB overlay + 3D terrain/hillshade), bundled into the UI. |
| **maplibre-contour** | 0.1.0 | Browser lib that computes **contour lines client-side** from a `raster-dem` source (marching-squares isolines). DevDependency, web bundle only — no separate contour tileset. |
| **OpenMapTiles "OSM OpenMapTiles" style** | v3.16 | Off-the-shelf vector basemap style (248 layers). |
| **openmaptiles/fonts** | v2.0 (`noto-open-sans`) | Glyph PBFs for the style's Open Sans / Noto Sans stacks. |
| **better-sqlite3** | 12.x | Reads MBTiles (SQLite) metadata + tiles for verification. |
| **@mapbox/vector-tile** + **pbf** | 3.x / 5.x | Decodes MVT during verification + render smoke tests. |
 | **Python 3 + GDAL 3.x + numpy** | host-side, optional | `tools/dem-to-raster-tiles-converter/build-dem.py` — builds the optional `dem.mbtiles` elevation tileset (3D terrain). **Not in the image** (Option B, host-side). |

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

### The tilesets

| | Basemap | MTB overlay | Elevation (optional) |
|---|---|---|---|
| Artifact | `openmaptiles.mbtiles` | `mtb.mbtiles` | `dem.mbtiles` |
 | Builder | OMT profile jar (v3.16) | `mtb-profile` jar | `tools/dem-to-raster-tiles-converter/build-dem.py` (host-side, GDAL) |
| Type | vector (MVT) | vector (MVT) | **raster-dem** (PNG) |
| Content | All 16 OMT layers (roads, water, places, POI, …) | Only ways with a non-empty `mtb:scale` | Elevation in meters, per-pixel RGB-packed — drives **all three** elevation overlays |
| Key attribute | (class/subclass derived) | `mtb_scale` (raw string, e.g. `"3"`, `"4+"`) | `encoding` (mapbox/terrarium) + `tileSize` |
| Zoom range | z0–z14 | `z MTB_MINZOOM`–z14 | z6–z11 (defaults; overzooms above) |
| Martin source id | `openmaptiles` | `mtb` | `dem` (derived from the file name) |
| Optional? | required | required | **no — absent ⇒ all elevation overlays off** |

The basemap is **100% stock** OpenMapTiles. The MTB overlay exists because the
stock basemap only draws `path`/`track`/`service` ways at high zoom (z12+), so
`mtb:scale` trails would be invisible at low zoom. The dedicated tileset carries
every tagged way from `z MTB_MINZOOM` upward so the overlay can draw them at all
zooms, while the basemap keeps drawing the underlying road geometry. The elevation
tileset is a separate **raster** surface (a `raster-dem` source, not a vector layer)
and is the **single source for all three elevation overlays**: 3D relief
(`map.setTerrain`), hillshade (native `hillshade` layer), and contour lines
(computed client-side from the same tiles by `maplibre-contour`). It is the only
non-Martin-built artifact and is entirely optional.

### Single-port serving + tile proxy

All browser traffic uses the app's one port. Martin is an internal, loopback-bound
service the browser never reaches directly.

- `GET /tiles/:source/:z/:x/:y` — the app's **streaming proxy** to Martin's
  internal URL (status + `content-type` passed through, body piped without full
  buffering, client disconnect aborts the upstream read). `openmaptiles`, `mtb`,
  and the optional `dem` (3D terrain) all flow through this one route. (One
  exception: a missing **dem** tile is answered with a valid null tile rather than
  passed through — see the elevation section.)
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
- **Controls**: a top-right stack (navigation, geolocate, fullscreen, and the
  single **layers panel** — one round layers icon that expands into the trail
  toggles + opacity sliders and, when a `dem` source is served, the 3D view /
  hillshade / contour lines toggles, see below) plus a scale (bottom-left) and
  a single round **info control** (bottom-right, collapsed by default) that
  expands into a panel holding the difficulty legend (ramp swatches + level names +
  `+/−` note) **and** the data-source credits — MapLibre's own attribution control
  is disabled, so the ⓘ is the map's only attribution chrome. A default
  `fitBounds` fits the mainland Norway extent.

### Elevation: 3D terrain, hillshade & contour lines (optional)

One **single `dem.mbtiles` raster-DEM tileset** drives all three elevation
overlays. MapLibre reads elevation exclusively from a `raster-dem` source (a
per-pixel RGB packing — **not** a vector layer), so the pipeline adds a third,
*raster* artifact: `dem.mbtiles`. From that one source:

- **3D relief** — native, via `map.setTerrain({ source, exaggeration })`.
- **Hillshade** — a native MapLibre `hillshade` layer on the `dem` source.
- **Contour lines** — computed **client-side** in the browser by
  [`maplibre-contour`](https://github.com/onthegomap/maplibre-contour) from the
  *same* `dem` tiles (marching-squares isolines → MVT served over a custom
  `protocol://` URL). There is **no separate contour vector tileset** to build,
  serve, or verify.

> **Retired approach (do not reintroduce):** an earlier design built a standalone
> `contours.mbtiles` vector tileset (a `contours/` Python+GDAL subproject:
> `gdal_contour` → `ogr2ogr` → `tippecanoe`) served as a fourth Martin source.
> It produced an ~11 GB artifact and duplicated the DEM in a second tileset. That
> subproject, its `contours_out/` artifact, and all its app wiring (config,
> `martin.yaml` entry, style injection, serving verification, tests) have been
> **removed from the repo**. Contours now come from `maplibre-contour` over the
> single `dem` source.

#### The `dem` tileset (shared plumbing)

- **Built host-side** by `tools/dem-to-raster-tiles-converter/build-dem.py` (Python + GDAL, its own
   `tools/dem-to-raster-tiles-converter/` subproject under the shared `tools/` folder). The image stays GDAL/Python-free
  (Option B); the converter only *produces* the artifact.
- **Served by Martin** like the other tilesets: it rides the existing
  `/tiles/:source/:z/:x/:y` proxy (source id `dem`, derived from the file name)
  and the single-port model. No new route, no new process.
- **Missing-tile handling** (`src/tiles.ts`) — the `dem` tileset has finite bounds,
  so some edge tiles the client requests are absent. Martin answers an absent tile
  with `204 No Content` (an empty body); browsers treat 204 as success
  (`response.ok === true`), so a dem client's `createImageBitmap` on that empty
  body throws (`"The image could not be decoded"` — a map-load error in Firefox;
  Safari's decode path happens to skip it). The proxy therefore intercepts a
  missing **dem** tile (204/404/410) and serves a valid flat "no data" tile — a
  full-size, **elevation-0 PNG in the source's own `encoding`**
  (`makeNullDemTilePng`, generated once and cached) — instead of the empty 204, so
  both the native hillshade and `maplibre-contour` decode it cleanly (flat ⇒ no
  shading, no contour lines there). Vector sources (`openmaptiles`, `mtb`) are
  unaffected: a missing vector tile keeps its 204 pass-through.
- **Style injection** (`src/style.ts`) — when the artifact is present, the served
  style gains a `raster-dem` source (`encoding` + `tileSize` + min/max zoom read
  from the artifact's metadata so they always match). Absent ⇒ the source is not
  added and the style is byte-for-byte the pre-elevation one.
- **Fail-fast, optional** (`src/pipeline.ts` + `src/verify.ts`) — when present,
  the app verifies the tile is actually served as a decodable PNG of the right
  size before `ready`; when absent it logs that the feature is off and continues.
  A no-DEM deployment is unaffected.
- **Degradation contract** — the elevation UI renders **only** when the status
  snapshot reports a `dem` source. No `dem` ⇒ the layers panel shows no
  Elevation section (no 3D view, no hillshade, no contours); the map is the
  flat basemap, unchanged (the trail toggles are unaffected).

#### 3D view (native `setTerrain`)

- **Module** — `shared/terrain.js` (pure `applyTerrain(map, on, exagg, source)`,
  tested in `test/dem.test.ts`). Constants: `DEM_SOURCE = "dem"`,
  `DEFAULT_TERRAIN_EXAGGERATION = 1.5`.
- **Behavior** — on ⇒ `map.setTerrain({ source, exaggeration })`; off ⇒
  `map.setTerrain(null)`. A non-finite/≤0 exaggeration falls back to the
  default. The camera pitch is never touched: the map opens top-down (0°) with
  the terrain already enabled, and the visitor tilts it themselves — so the
  toggle never moves the camera. A pre-`load` call (style document still
  loading) is a safe no-op: MapLibre's "Style is not done loading." error is
  swallowed.
- **Map config** (`web/src/MapView.jsx`) — `maxPitch: 85` + `pitchWithGesture: true`
  raise the camera ceiling (MapLibre defaults to 60°) and let the visitor tilt
  with a two-finger/trackpad drag.
- **State** — part of the single layers-panel state: `web/src/layers-state.js`,
  localStorage key `diymtbmap.layers.v1`, default **ON**
  (`{ terrain: true, exaggeration: 1.5, … }`) — the 3D view is on by default;
  the first read migrates `diymtbmap.terrain.v1`, so a visitor who explicitly
  turned it OFF stays OFF.
- **UI** — a row in the single layers panel
  (`web/src/components/LayerPanel.jsx`): the "3D view" checkbox.

#### Elevation rows (hillshade + client-side contours)

These are two independent rows in the layers panel (both default **ON**):

- **Hillshade** — a native `hillshade` layer on the `dem` source
  (`shared/elevation.js` → `hillshadeLayerSpec`): `hillshade-method: standard`,
  illumination from the **NW** (direction `315`, altitude `45`), subtle
  `hillshade-exaggeration: 0.5`. MapLibre fills the rest of the hillshade paint
  properties with its own defaults.
- **Contour lines** — client-side. `web/src/MapView.jsx` (the **browser-only**
  part; `maplibre-contour` is not imported from the Node tests) builds a
  `mlcontour.DemSource` that **reuses the `dem` source's own** `tiles[0]`,
  `encoding`, and `maxzoom` (read from the served style spec, so it always matches
  the artifact):
  ```js
  const demSrc = new mlcontour.DemSource({ url, encoding, maxzoom, worker: true, cacheSize: 100 });
  demSrc.setupMaplibre({ addProtocol });                    // register the protocol (maplibre-gl `addProtocol`)
  map.addSource("contour-source", {
    type: "vector",
    tiles: [demSrc.contourProtocolUrl(contourProtocolOptions())],  // protocol:// isolines
    maxzoom: demMaxzoom + 4,                                 // overzoom past the dem's native range
  });
  ```
  `contourProtocolOptions()` (`shared/elevation.js`) is the pure, testable contract
  handed to the protocol: `multiplier: 1` (keep **meters**, no feet conversion),
  the `thresholds` table below, `contourLayer: "contours"`, `elevationKey: "ele"`,
  `levelKey: "level"`.

**Stable ids** (`shared/elevation.js`):

| Symbol | Value | Meaning |
|---|---|---|
| `HILLSHADE_ID` | `hillshade` | native hillshade layer |
| `CONTOUR_SOURCE_ID` | `contour-source` | client-side contour vector source |
| `CONTOUR_LAYER` | `contours` | MVT layer inside each contour tile |
| `CONTOUR_LINES_ID` | `contour-lines` | line layer (minor + major) |
| `CONTOUR_LABELS_ID` | `contour-labels` | symbol layer (elevation labels) |
| `ELEVATION_KEY` / `LEVEL_KEY` | `ele` / `level` | feature props maplibre-contour writes (`level`: 0 = minor, 1 = major) |

**Contour intervals** (`CONTOUR_THRESHOLDS`, `{ zoom: [minor, major] }` meters —
both get finer as you zoom in; z11 is the dem's maxzoom and the finest drawn):

| zoom | 6 | 7 | 8 | 9 | 10 | 11 |
|---|---|---|---|---|---|---|
| minor | 2000 | 1000 | 500 | 200 | 100 | **20** |
| major | 10000 | 5000 | 2500 | 1000 | 500 | **100** |

20 m minor / 100 m major at the top zoom. (10 m would alias against our ~19 m/px
`dem` tiles at z11, so 20 m is the safe floor; the 100 m major is the bold index
line.)

**Layer specs** (`shared/elevation.js`, pure + tested in `test/elevation.test.ts`):

- **Contour lines** (`contourLineSpec`) — `line` on `contour-source` /
  `source-layer: contours`; round caps/joins; `line-color` and `line-width` driven
  by the `level` property: **major** (level 1) `rgba(92,68,43,0.8)` @ **1.25 px**,
  **minor** `rgba(92,68,43,0.55)` @ **0.5 px** (traditional brown, readable over the
  light basemap).
- **Elevation labels** (`contourLabelSpec`) — `symbol` on the same source/layer,
  **major lines only** (`filter: [">", ["get","level"], 0]`);
  `symbol-placement: line`, spacing 320, font `Noto Sans Bold` (a vendored stack);
  text = the line's `ele` via `round` + `to-string` + `" m"` (e.g. `123 m`) —
  NOT `number-format`, which would insert the browser locale's thousands
  separator (`1,200` / `1.200`); dark text `#5a4632` with a white halo
  `rgba(255,255,255,0.85)` @ 1.25 px — the halo opacity is in the color's alpha
  (`text-halo-opacity` is not a MapLibre property; an unknown paint property
  makes `addLayer` fail validation and the layer is silently never added).
- **Draw order** — hillshade first, then contour lines, then labels
  (`ELEVATION_LAYER_IDS`).
- **Visibility** — `applyHillshadeVisibility(map, on)` flips the hillshade;
  `applyContourVisibility(map, on)` flips the contour lines **and** their
  elevation labels (`CONTOUR_IDS`) together — both safe to call before the
  layers exist.
- **State** — part of the single layers-panel state: `web/src/layers-state.js`,
  localStorage key `diymtbmap.layers.v1` — both default **ON**; the first read
  migrates `diymtbmap.elevation.v1` (an explicit OFF turns BOTH rows OFF).
- **UI** — rows in the single layers panel (`web/src/components/LayerPanel.jsx`):
  a "Hillshade" checkbox and a "Contour lines" checkbox (the elevation labels
  follow the contour lines).

The source id follows `DEM_MBTILES_FILE` end-to-end (Martin derives it from the
file name), so a custom artifact name works as long as `martin.yaml` and the env
var agree.

### Project layout

```
.
├── Dockerfile               # Multi-stage, fully-pinned image build
├── entrypoint.sh            # Container main → node dist/server.js
├── martin.yaml              # Martin config: the MBTiles sources (+ optional dem)
├── package.json             # Deps + scripts
├── .env.example             # Full configuration reference
├── vite.config.js           # UI build (web/ → public/) + dev-server proxy
├── web/                     # React UI source (Vite app)
│   ├── index.html           # Vite entry (root div → src/main.jsx)
│   └── src/
│       ├── main.jsx         # React mount
│       ├── App.jsx          # Status polling → progress card | map
│       ├── MapView.jsx      # MapLibre map init, MTB overlay, 3D terrain,
│       │                    #   hillshade + client-side contours (maplibre-contour), controls
│       ├── layers-state.js  # Persist ALL layers-panel choices (localStorage,
│       │                    #   migrates the 3 legacy state keys on first read)
│       ├── data.js          # Data-source credits (info panel)
│       ├── styles.css
│       └── components/      # ProgressCard, InfoControl/Panel,
│                            #   LayerControl/LayerPanel (the single layers panel)
├── shared/
│   ├── mtb-overlay.js       # Overlay layers + color ramp (pure, tested;
│   │                        #   used by web/ and the Node tests)
│   ├── terrain.js           # applyTerrain + dem defaults (pure, tested)
│   └── elevation.js         # hillshade + contour layer specs/ids/thresholds (pure, tested)
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
 ├── tools/                   # Host-side tooling (one subfolder per tool)
 │   └── dem/                 # Optional 3D-terrain converter (Python+GDAL, host-side)
 │       ├── build-dem.py     # GeoTIFF DEM → dem.mbtiles (raster-dem, PNG)
 │       ├── requirements.txt # GDAL/osgeo + numpy
 │       ├── README.md        # Install (per-OS) + run + output contract
 │       └── tests/           # Round-trip + metadata self-tests
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
- **maplibre-contour** — <https://github.com/onthegomap/maplibre-contour> (computes the client-side contour lines from the `dem` source)
- **Natural Earth** (admin boundaries / water, auto-downloaded by Planetiler) — <https://www.naturalearthdata.com/> (public domain)
- **Open Sans / Noto Sans glyphs** — <https://github.com/openmaptiles/fonts> (open source)
- **Elevation (optional 3D + hillshade + contours)** — the user's own GeoTIFF DEM,
   converted by `tools/dem-to-raster-tiles-converter/build-dem.py`. For the Norway default this is the **Norwegian
  Basisdata DTM10** (Kartverket). When a `dem.mbtiles` is served, the info panel
  adds an elevation credit.
