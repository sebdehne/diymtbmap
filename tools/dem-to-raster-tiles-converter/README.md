# diymtbmap — 3D terrain tile builder (`tools/dem-to-raster-tiles-converter/`)

Builds a `dem.mbtiles` for the diymtbmap **3D-terrain toggle** from the GeoTIFF
elevation rasters you already have (e.g. the Norwegian **Basisdata DTM10** in
EUREF89 UTM33 / EPSG:25833). It is a standalone, offline Python tool: **any GeoTIFF DEM in any
source CRS** → a MapLibre `raster-dem` MBTiles that Martin serves and the
MapLibre frontend reads via `map.setTerrain`.

```
GeoTIFF DEM tiles (any CRS)
   │  build-dem.py
   │   1. stitch into a VRT
   │   2. for each web-mercator tile in the range: reproject to EPSG:3857
   │   3. fill nodata/out-of-surface with sea level
   │   4. pack elevation into MapLibre RGB encoding (default: mapbox)
   │   5. encode lossless PNG
   ▼
dem.mbtiles  ──►  Martin (raster)  ──►  /tiles/dem/{z}/{x}/{y}  ──►  setTerrain
```

**What it is not:** it does not need the internet, does not need a special
container, and does not touch the Node app. It only *produces* the
`dem.mbtiles` artifact. (Serving the tileset + the UI 3D-terrain toggle are
implemented by the app — drop the artifact into the data volume and the map picks
it up; see the "3D terrain (optional)" section of the top-level `README.md`.)

---

## Getting the source data

`build-dem.py` works on GeoTIFFs you already have. To get the full Norwegian
**DTM 10 Terrengmodell (UTM33)** as GeoTIFFs, use the companion downloader
[`tools/dem-downloader-for-norway/`](../dem-downloader-for-norway/README.md) —
stdlib-only Python, all 254 areas, resumable:

```bash
python3 tools/dem-downloader-for-norway/download-dtm-norway.py          # -> dem/download_dtm_for_norway/
python3 tools/dem-to-raster-tiles-converter/build-dem.py \
  --input  dem/download_dtm_for_norway/geotiffs \   # or the zips/ dir (auto-extracted)
  --output dem_out/dem.mbtiles \
  --minzoom 6 --maxzoom 11 --tilesize 512 --sea-level 0
```

---

## Tools needed

| Tool | Purpose | Version |
|------|---------|---------|
| Python | runtime | 3.9+ |
| **GDAL** + Python bindings (`osgeo`) | read GeoTIFF, reproject (warp), write PNG | 3.x (any recent; tested 3.13) |
| `numpy` | fast elevation→RGB packing | ≥1.26 (pinned in `requirements.txt`) |

That's it. `sqlite3` and `zipfile` come with Python; PNG encoding uses GDAL's
built-in PNG driver, so **Pillow is not required**.

> **Note on GDAL:** GDAL and its Python bindings (`osgeo`) are not reliably
> available as a pip wheel — install them from your OS package manager first, then
> `pip install` just `numpy`.
>
> **Why `--system-site-packages`?** The OS installs `osgeo` into the *base*
> interpreter's site-packages. A plain `python3 -m venv .venv` hides those, so the
> venv would fail on `import osgeo`. Using `python3 -m venv --system-site-packages
> .venv` lets the venv see the OS-provided GDAL while keeping `numpy` isolated.
> (Alternative: skip the venv and run with the system Python directly.)

---

## Install

### macOS (Homebrew)
```bash
brew install gdal python@3.12
python3 -m venv --system-site-packages .venv && source .venv/bin/activate
pip install -r requirements.txt
```

### Debian / Ubuntu
```bash
sudo apt install gdal-bin python3-gdal python3-venv
python3 -m venv --system-site-packages .venv && source .venv/bin/activate
pip install -r requirements.txt
```

### Any OS (recommended: virtualenv)
```bash
# 1) install GDAL + bindings from your OS manager (brew/apt above, or your distro's pkg mgr)
# 2) then:
python3 -m venv --system-site-packages .venv && source .venv/bin/activate
pip install -r requirements.txt
```

### Verify the install
```bash
gdalinfo --version                                   # e.g. GDAL 3.13.x
python -c "from osgeo import gdal; print(gdal.VersionInfo())"   # e.g. 3130300 == GDAL 3.13.3
python build-dem.py --selftest                        # should print SELFTEST PASSED
```
All three must succeed before converting real data.

---

## Quick self-test (no real data needed)

```bash
python build-dem.py --selftest
```
Generates a synthetic elevation surface, runs the whole pipeline, decodes a tile,
and asserts the elevation round-trips (both `mapbox` and `terrarium`), that
nodata → sea level, that the MBTiles metadata + TMS row order are correct. Exits
`0` on success.

---

## How to run the conversion

Point `--input` at a **directory of `.tif` files**, a directory of `.zip`
archives (each holding a `.tif`), a single `.tif`, a single `.zip`, or a `.vrt`.
Zip `.tif` members are **auto-extracted** with Python's stdlib `zipfile` — you do
**not** need the GDAL ZIP driver or a manual extract step.

```bash
# Example: convert the Norwegian DTM10 subset (7 tiles, ~100×50 km of southern
# Norway) to a 3D-terrain tile set.
python build-dem.py \
  --input  /path/to/your/dtm-tiles \        # dir of .tif (or .zip) files
  --output /path/to/dem.mbtiles \
  --encoding mapbox \                        # mapbox (default) | terrarium
  --minzoom 6 --maxzoom 11 \                # bounded pyramid (keeps size small)
  --tilesize 512 \                          # 256 or 512 (power of 2)
  --sea-level 0 \                           # fill for nodata/out-of-surface (m)
  --bbox 7.0,57.8,8.5,58.4                  # optional clip: W,S,E,N (lng/lat)
  # --nodata -32767                          # omit to auto-detect from the data
  # --verbose                                # log every tile
```

On success it prints the tile count and artifact size, e.g.:
```
tiles to produce: 41
OK: wrote /path/to/dem.mbtiles
     tiles=41  size=5.24 MB
```

> **Bounded pyramid:** only the tiles that intersect your data (or `--bbox`) are
 > produced — not the whole world. That is what keeps `dem.mbtiles` small. A
 > 1.5°×0.6° region at z6–z10 / 512 px is ~5 MB.

### Two ways to run it

**1. Foreground** — for a short run (small region / low `--maxzoom`), the command
above is all you need: run it and wait for it to finish in the same terminal.

**2. Background** — for a long run (e.g. the full Norwegian DTM10 set, ~30–35 min),
detach it so it survives a disconnect or closing the terminal. `python3 -u` keeps
stdout unbuffered, so the `--verbose` progress lines stream to the log live:

```bash
OUT=/path/to/dem.mbtiles          # e.g. the app volume: /data/dem.mbtiles
LOG=/path/to/convert.log
nohup /usr/bin/time -l python3 -u build-dem.py \
  --input  /path/to/your/dtm-zips \   # dir of .zip (or .tif) — zips are auto-extracted
  --output "$OUT" \
  --encoding mapbox \
  --minzoom 6 --maxzoom 11 --tilesize 512 \
  --nodata -32767 --sea-level 0 --verbose \
  > "$LOG" 2>&1 &
echo "PID: $!"
```

- **Watch progress:** `tail -f /path/to/convert.log` — each `[i/N] z… x… y…` line
  prints as the tile is produced.
- **Stop early:** `kill <PID>` (the partial `dem.mbtiles` is left on disk — just re-run
  to overwrite it).
- **Timing + memory:** `/usr/bin/time -l` prints wall-clock time and peak RSS at the
  end. A full Norway run lands around **~30 min / ~1.9 GB artifact / ~3–4 GB peak RSS**.

### CLI reference

| Flag | Default | Description |
|------|---------|-------------|
| `--input` | — (required) | dir of `.tif`/`.zip`, or a single `.tif`/`.vrt`/`.zip` (zip `.tif` members auto-extracted) |
| `--output` | `dem.mbtiles` | output `.mbtiles` path |
| `--encoding` | `mapbox` | MapLibre `raster-dem` encoding to pack into |
| `--minzoom` | `6` | lowest zoom |
| `--maxzoom` | `11` | highest zoom |
| `--tilesize` | `512` | tile pixel size (256 or 512) |
| `--nodata` | auto-detect | source nodata value |
| `--sea-level` | `0.0` | fill value for nodata/out-of-surface (m) |
| `--bbox` | data's own | clip to `W,S,E,N` (lng/lat) |
| `--verbose` | off | log every tile |
| `--selftest` | — | run the synthetic round-trip test and exit |

### Running the tests
```bash
python build-dem.py --selftest
python tests/test_roundtrip.py     # pack/decode + geometry
python tests/test_metadata.py      # MBTiles schema/metadata/PNG/decode
# or, with pytest installed:
pytest tests/
```

---

## Output contract

`dem.mbtiles` is a standard [MBTiles](https://github.com/mapbox/mbtiles) database:

- **`tiles`** table: `zoom_level`, `tile_column`, `tile_row` (TMS, row 0 = bottom),
  `tile_data` (PNG bytes). Primary key `(zoom_level, tile_column, tile_row)`.
- **`metadata`** table: `name`, `format=png`, `bounds=W,S,E,N`, `minzoom`, `maxzoom`,
  `tileSize`, `encoding`, `type=overlay`, `attribution`.
- **Encoding:** each pixel's elevation is packed as RGB. MapLibre decodes it as
  `R*red + G*green + B*blue − baseShift`:
  - `mapbox`: `red 6553.6, green 25.6, blue 0.1, baseShift 10000` → ~10 cm precision,
    range −10 000…+1.67 M m (the MapLibre default — set `encoding:"mapbox"` in the
    source spec, or omit it).
  - `terrarium`: `red 256, green 1, blue 1/256, baseShift 32768` → ~4 mm precision,
    range −32 768…+32 767 m.

**Where the app expects it:** `/data/dem.mbtiles` (Phase 2 wires this into
`martin.yaml` as source id `dem`, reusing the existing `/tiles/dem/{z}/{x}/{y}`
proxy).

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `ModuleNotFoundError: No module named 'osgeo'` | Install GDAL + Python bindings from your OS manager (see Install); they are not on PyPI. |
| `ModuleNotFoundError: No module named 'numpy'` | `pip install -r requirements.txt` inside the venv. |
| GDAL version mismatch errors | Make the Python `osgeo` major version match `gdalinfo --version`. |
| "no .tif/.zip sources found" | `--input` must be a dir containing `.tif`/`.zip`, or a single `.tif`/`.vrt`/`.zip`. |
| Whole tile is flat 0 m | That area is nodata/coast — expected. Check your `--bbox` is over land. |
| Output looks shifted/flipped | This tool writes TMS row order (`tile_row = 2^z − 1 − y`); that is correct for MBTiles — don't "fix" it. |
| Out of memory on a huge region | Tiles are streamed to SQLite in batches (memory stays flat as tile count grows). The main RAM user is GDAL holding the opened source GeoTIFFs — cap it with `GDAL_CACHEMAX=256MB`, or lower `--maxzoom` / clip with `--bbox`. |
| Elevation off by a lot | Confirm `--nodata` matches the data's nodata (the DTM10 uses `-32767`). |

---

## Notes / design

- **Per-tile reprojection:** each tile is a small `gdal.Warp` of the source to
  `EPSG:3857`, so it works for any source CRS and stays memory-light (no giant
  master grid). Deterministic and offline.
- **Nodata handling:** the output nodata sentinel is the *source* nodata (not
  `sea_level`), because `sea_level` (often 0 m) is a legitimate coastal value;
  after warping, sentinel/NaN pixels are mapped to `sea_level`.
- **Memory-flat writes:** tiles are streamed into SQLite in batches (`MbtilesWriter`), so
  RAM does not grow with the number of tiles — a full-country run won't OOM on the
  tile data. The dominant RAM user is GDAL reading the source rasters (cap with
  `GDAL_CACHEMAX` if needed).
- **Deterministic:** same inputs + flags → same artifact.
