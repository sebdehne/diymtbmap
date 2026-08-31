# diymtbmap — DTM10 source-data downloader (`tools/dem-downloader-for-norway/`)

Downloads the full Norwegian **DTM 10 Terrengmodell (UTM33)** from the Geonorge
kartkatalog (https://kartkatalog.geonorge.no) — the same "Last ned" flow the web
UI uses: dataset *DTM 10 Terrengmodell (UTM33)*, format **TIFF/GeoTIFF**,
projection **25833** = EUREF89 UTM zone 33, **all 254 areas** = entire mainland.

`download-dtm-norway.py` is a standalone script using **only the Python standard
library** (no GDAL, no numpy, no pip install) — just Python 3.9+ and a network
connection. The GeoTIFFs it produces are the intended `--input` for the
companion converter [`tools/dem-to-raster-tiles-converter/`](../dem-to-raster-tiles-converter/README.md).

```bash
# Full country, default output dir <repo>/dem/download_dtm_for_norway/:
python3 tools/dem-downloader-for-norway/download-dtm-norway.py

# Useful variants:
python3 tools/dem-downloader-for-norway/download-dtm-norway.py --list-areas                 # see the 254 area codes
python3 tools/dem-downloader-for-norway/download-dtm-norway.py --areas 6400-1,6400-2        # a subset
python3 tools/dem-downloader-for-norway/download-dtm-norway.py --jobs 4 --delay 0.1         # faster, a bit less polite
python3 tools/dem-downloader-for-norway/download-dtm-norway.py --no-extract                 # keep only the ZIPs
python3 tools/dem-downloader-for-norway/download-dtm-norway.py --verify                     # open every GeoTIFF with GDAL at the end

# Or via npm (see package.json):
npm run download:dem -- --list-areas
```

What it does, step by step:

1. **Find the dataset** via `kartkatalog.geonorge.no/api/search` (exact title
   match "DTM 10 Terrengmodell (UTM33)" — not the UTM32/UTM35 siblings, not
   "Historiske versjoner"); a hard-coded UUID fallback covers an unreachable
   catalog.
2. **Read capabilities** from `nedlasting.geonorge.no/api/capabilities/<uuid>`
   (HAL links) and validate the requested format/projection against the
   code lists.
3. **Order + download** each area: one order POST to
   `nedlasting.geonorge.no/api/order` returns `"status":"ReadyForDownload"`
   with a `downloadUrl` (the tiles are pre-produced; no email/queue). The ZIP
   is streamed to a `.part` file, checked, then renamed.
4. **Extract** the GeoTIFF member into `geotiffs/`.

Output layout (gitignored):

```
dem/download_dtm_for_norway/
├── zips/      Basisdata_<area>_Celle_25833_DTM10UTM33_TIFF.zip   (254 files, ≈10 GB)
├── geotiffs/  <area>_10m_z33.tif     (254 GeoTIFFs: 5041×5041 px, 10 m grid,
├── state.json                            Float32, NoData −32767, EPSG:25833)
└── manifest.json  (per-area file names, sizes, order refs, status)
```

**Resume:** progress is tracked in `state.json`; an interrupted run is simply
re-run — completed areas are skipped and failures are retried.

**Then build the terrain tiles** with the converter:

```bash
python3 tools/dem-to-raster-tiles-converter/build-dem.py \
  --input  dem/download_dtm_for_norway/geotiffs \   # or the zips/ dir (auto-extracted)
  --output dem_out/dem.mbtiles \
  --minzoom 6 --maxzoom 11 --tilesize 512 --sea-level 0
```

| Flag | Default | Description |
|------|---------|-------------|
| `--output` | `<repo>/dem/download_dtm_for_norway` | output directory |
| `--areas` | all 254 | comma-separated area codes (see `--list-areas`) |
| `--format` | `TIFF` | format name from the dataset (GeoTIFF; `DEM` is an ASCII grid) |
| `--projection` | `25833` | EUREF89 UTM zone 33 |
| `--jobs` | `3` | parallel downloads |
| `--delay` | `0.3` s | pause between starting orders |
| `--retries` | `4` | retries per order/download on transient errors |
| `--no-extract` | off | keep only the ZIPs |
| `--remove-zips` | off | delete a ZIP after its GeoTIFF is extracted |
| `--overwrite` | off | re-download even if already present |
| `--verify` | off | open each GeoTIFF with GDAL at the end (if GDAL is installed) |
| `--uuid` / `--title` | DTM10 UTM33 | pin the dataset (skips the catalog search) |

> Be considerate: this pulls ≈10 GB from a public service. Keep the default
> politeness (`--jobs 3 --delay 0.3`) unless you have a reason to go faster.
