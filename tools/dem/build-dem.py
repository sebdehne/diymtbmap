#!/usr/bin/env python3
"""build-dem.py — convert GeoTIFF DEM tiles into a `dem.mbtiles` for the diymtbmap
3D-terrain toggle.

What it does
------------
Takes a set of GeoTIFF elevation rasters (any source CRS, e.g. the Norwegian
DTM10 in EPSG:3045), reprojects each web-mercator tile on the fly, packs the
elevation into the MapLibre `raster-dem` RGB encoding (default: `mapbox`),
encodes each tile as a lossless PNG, and writes them to an MBTiles database
(`dem.mbtiles`) that Martin serves and the MapLibre frontend reads via
`setTerrain`.

Design notes
------------
* Per-tile reprojection: each output tile is a small `gdal.Warp` of the source
  to exactly `tileSize x tileSize` at `EPSG:3857`. Memory-light and correct for
  any source CRS; no giant master grid needed.
* Encoding: MapLibre 6.6 `raster-dem` decodes a pixel as
    elevation = R*red + G*green + B*blue - baseShift
  with the built-in factor sets (verified in node_modules):
      mapbox    : red 6553.6 green 25.6 blue 0.1 baseShift 10000   (~10 cm)
      terrarium : red 256    green 1    blue 1/256 baseShift 32768 (~4 mm)
  We pack by s = round((elevation + baseShift) / minFactor) and splitting `s`
  into three bytes: R = s>>16, G = s>>8, B = s&0xFF. That round-trips exactly
  against MapLibre's decode for both encodings.
* MBTiles uses the TMS y-axis (row 0 = bottom): tile_row = 2^z - 1 - y.

Only Python stdlib + numpy + GDAL (`osgeo`) are required. PNG encoding uses
GDAL's PNG driver, so Pillow is not a hard dependency.
"""

import argparse
import atexit
import math
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import zipfile

import numpy as np
from osgeo import gdal, osr

gdal.UseExceptions()

# Web Mercator (EPSG:3857) uses the WGS84 semi-major axis.
R_EARTH = 6378137.0

# MapLibre `raster-dem` factor sets (verified against the installed MapLibre).
# minFactor is always the blue factor (the smallest), i.e. the finest step.
ENCODINGS = {
    "mapbox":    {"red": 6553.6, "green": 25.6,    "blue": 0.1,     "baseShift": 10000.0},
    "terrarium": {"red": 256.0,  "green": 1.0,     "blue": 1 / 256, "baseShift": 32768.0},
}
DEFAULT_ENCODING = "mapbox"


# ---------------------------------------------------------------------------
# Elevation <-> RGB packing (mirrors MapLibre's DEMData.unpack / DEMData.pack)
# ---------------------------------------------------------------------------
def _min_factor(encoding):
    f = ENCODINGS[encoding]
    return min(f["red"], f["green"], f["blue"])


def pack_elevation(elevation_m, encoding=DEFAULT_ENCODING):
    """elevation (m, float array) -> uint8 HxWx3 RGB array (MapLibre raster-dem)."""
    f = ENCODINGS[encoding]
    minf = _min_factor(encoding)
    s = (np.asarray(elevation_m, dtype=np.float64) + f["baseShift"]) / minf
    s = np.clip(np.rint(s), 0, (1 << 24) - 1).astype(np.int64)
    r = ((s >> 16) & 0xFF).astype(np.uint8)
    g = ((s >> 8) & 0xFF).astype(np.uint8)
    b = (s & 0xFF).astype(np.uint8)
    return np.stack([r, g, b], axis=-1)


def decode_elevation(rgb, encoding=DEFAULT_ENCODING):
    """uint8 HxWx3 RGB -> elevation (m). Exactly MapLibre's unpack formula."""
    f = ENCODINGS[encoding]
    rgb = np.asarray(rgb)
    r = rgb[..., 0].astype(np.float64)
    g = rgb[..., 1].astype(np.float64)
    b = rgb[..., 2].astype(np.float64)
    return r * f["red"] + g * f["green"] + b * f["blue"] - f["baseShift"]


def pack_scalar(elevation_m, encoding=DEFAULT_ENCODING):
    """Scalar convenience: elevation (m) -> (R, G, B) ints 0..255."""
    rgb = pack_elevation(np.array([[float(elevation_m)]]), encoding)[0, 0]
    return int(rgb[0]), int(rgb[1]), int(rgb[2])


def decode_scalar(rgb, encoding=DEFAULT_ENCODING):
    """(R, G, B) ints -> elevation (m)."""
    return float(decode_elevation(np.array([[[rgb[0], rgb[1], rgb[2]]]]), encoding)[0, 0])


# ---------------------------------------------------------------------------
# Web-mercator / slippy-tile geometry
# ---------------------------------------------------------------------------
def lng_to_x_m(lng):
    return R_EARTH * math.radians(lng)


def lat_to_y_m(lat):
    s = math.sin(math.radians(lat))
    return R_EARTH * 0.5 * math.log((1.0 + s) / (1.0 - s))


def x_m_to_lng(x_m):
    return math.degrees(x_m / R_EARTH)


def y_m_to_lat(y_m):
    return math.degrees(2.0 * math.atan(math.exp(y_m / R_EARTH)) - math.pi / 2)


def tile_lnglat_bounds(z, x, y):
    """Slippy tile (z,x,y) -> (lng_w, lat_s, lng_e, lat_n). y is top-down (0 = top)."""
    n = 2 ** z
    lng_w = x / n * 360.0 - 180.0
    lng_e = (x + 1) / n * 360.0 - 180.0
    lat_n = math.degrees(math.atan(math.sinh(math.pi * (1.0 - 2.0 * y / n))))
    lat_s = math.degrees(math.atan(math.sinh(math.pi * (1.0 - 2.0 * (y + 1) / n))))
    return lng_w, lat_s, lng_e, lat_n


def tile_output_bounds_3857(z, x, y):
    """Tile (z,x,y) -> (minX, minY, maxX, maxY) in EPSG:3857 meters (for gdal.Warp)."""
    lng_w, lat_s, lng_e, lat_n = tile_lnglat_bounds(z, x, y)
    return (lng_to_x_m(lng_w), lat_to_y_m(lat_s), lng_to_x_m(lng_e), lat_to_y_m(lat_n))


def lng_to_tile_x(z, lng):
    return int(math.floor((lng + 180.0) / 360.0 * (2 ** z)))


def lat_to_tile_y(z, lat):
    frac = (1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0
    return int(math.floor(frac * (2 ** z)))


def tiles_for_bbox(bbox, zmin, zmax):
    """bbox (W,S,E,N lng/lat) -> list of (z,x,y) tiles intersecting it, z in [zmin,zmax]."""
    lng_w, lat_s, lng_e, lat_n = bbox
    tiles = []
    for z in range(zmin, zmax + 1):
        x0, x1 = lng_to_tile_x(z, lng_w), lng_to_tile_x(z, lng_e)
        y0, y1 = lat_to_tile_y(z, lat_n), lat_to_tile_y(z, lat_s)  # lat_n -> smaller y
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                tiles.append((z, x, y))
    return tiles


# ---------------------------------------------------------------------------
# Source handling
# ---------------------------------------------------------------------------
def _extract_zip_tifs(zip_path, out_dir):
    """Extract every .tif/.tiff member of a zip into `out_dir` using Python's stdlib
    `zipfile` (no GDAL ZIP driver required) and return the extracted file paths.

    Files are named `<sanitized-zip-stem>__<member-basename>` so members from
    different zips can't collide. The caller owns `out_dir` and its cleanup.
    """
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", os.path.basename(zip_path))
    out = []
    with zipfile.ZipFile(zip_path) as z:
        for m in z.namelist():
            if m.lower().endswith((".tif", ".tiff")):
                dest = os.path.join(out_dir, f"{safe}__{os.path.basename(m)}")
                with z.open(m) as src, open(dest, "wb") as dst:
                    shutil.copyfileobj(src, dst)
                out.append(dest)
    return out


def _register_workdir(out_dir):
    """Keep an extracted-zip temp dir alive for the run, then remove it at exit."""
    atexit.register(shutil.rmtree, out_dir, ignore_errors=True)
    return out_dir


def collect_sources(input_path):
    """Return a list of GDAL-openable source paths from a file, .vrt, or directory.

    Accepts a single `.tif`/`.tiff`/`.vrt`, a single `.zip` (holding `.tif`
    members), or a directory containing any of those. Zips are handled with
    Python's stdlib `zipfile` — members are extracted to a temp dir (so `gdal`
    needs no ZIP driver) and the temp dir is cleaned up when the process exits.
    """
    p = os.path.abspath(input_path)
    low = p.lower()

    if os.path.isdir(p):
        srcs = []
        workdir = None
        for name in sorted(os.listdir(p)):
            fp = os.path.join(p, name)
            if not os.path.isfile(fp):
                continue
            nlow = name.lower()
            if nlow.endswith((".tif", ".tiff", ".vrt")):
                srcs.append(fp)
            elif nlow.endswith(".zip"):
                if workdir is None:
                    workdir = _register_workdir(tempfile.mkdtemp(prefix="dem_zip_"))
                srcs.extend(_extract_zip_tifs(fp, workdir))
        if not srcs:
            raise SystemExit(f"error: no .tif/.zip/.vrt sources found in {p}")
        return srcs

    if os.path.isfile(p):
        if low.endswith((".tif", ".tiff", ".vrt")):
            return [p]
        if low.endswith(".zip"):
            workdir = _register_workdir(tempfile.mkdtemp(prefix="dem_zip_"))
            srcs = _extract_zip_tifs(p, workdir)
            if not srcs:
                raise SystemExit(f"error: no .tif members found in {p}")
            return srcs

    raise SystemExit(
        f"error: unrecognized --input {p} (expected a .tif, .vrt, .zip, or a directory)"
    )


def build_vrt(sources, vrt_path):
    vrt = gdal.BuildVRT(vrt_path, sources)
    vrt = None
    return vrt_path


def source_bbox_lnglat(vrt_path):
    """Bounding box (W,S,E,N in lng/lat) of a source/VRT."""
    ds = gdal.Open(vrt_path)
    if ds is None:
        raise SystemExit("error: could not open source dataset")
    gt = ds.GetGeoTransform()
    w, h = ds.RasterXSize, ds.RasterYSize
    srs = ds.GetSpatialRef()
    if srs is None:
        raise SystemExit("error: source has no CRS; cannot reproject to EPSG:3857")
    geo = osr.SpatialReference()
    geo.ImportFromEPSG(4326)
    # Force (lon, lat) order regardless of the EPSG:4326 authority axis order.
    srs.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    geo.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    tr = osr.CoordinateTransformation(srs, geo)
    lons, lats = [], []
    for (px, py) in ((0, 0), (w, 0), (0, h), (w, h)):
        sx = gt[0] + px * gt[1] + py * gt[2]
        sy = gt[3] + px * gt[4] + py * gt[5]
        lon, lat, _ = tr.TransformPoint(sx, sy)
        lons.append(lon)
        lats.append(lat)
    ds = None
    return (min(lons), min(lats), max(lons), max(lats))


def detect_nodata(sources):
    """Best-effort nodata value from the first openable source band."""
    for s in sources:
        try:
            ds = gdal.Open(s)
            if ds is not None:
                nd = ds.GetRasterBand(1).GetNoDataValue()
                ds = None
                if nd is not None:
                    return float(nd)
        except Exception:
            continue
    return None


# ---------------------------------------------------------------------------
# Per-tile production
# ---------------------------------------------------------------------------
def _encode_png(rgb, tilesize):
    """uint8 HxWx3 RGB -> PNG bytes (via GDAL PNG driver)."""
    mem = gdal.GetDriverByName("MEM").Create("", tilesize, tilesize, 3, gdal.GDT_Byte)
    for i in range(3):
        mem.GetRasterBand(i + 1).WriteArray(rgb[..., i])
    fd, tmp = tempfile.mkstemp(suffix=".png")
    os.close(fd)
    try:
        out = gdal.Translate(tmp, mem, format="PNG")
        out = None
        with open(tmp, "rb") as fh:
            return fh.read()
    finally:
        mem = None
        if os.path.exists(tmp):
            os.unlink(tmp)


def produce_tile(vrt_path, z, x, y, tilesize, encoding, nodata, sea_level):
    """Produce one PNG tile (z,x,y). Returns PNG bytes."""
    bounds = tile_output_bounds_3857(z, x, y)
    # Output nodata sentinel: use the source nodata (a value that cannot be a real
    # elevation) rather than `sea_level`, because sea_level (often 0.0 m) is a
    # legitimate data value in coastal DEMs and must not be conflated with nodata.
    out_nodata = nodata if nodata is not None else -9999.0
    warp_kwargs = dict(
        width=tilesize,
        height=tilesize,
        dstSRS="EPSG:3857",
        outputBounds=bounds,
        targetAlignedPixels=False,
        resampleAlg="bilinear",
        outputType=gdal.GDT_Float32,
        dstNodata=out_nodata,
    )
    if nodata is not None:
        warp_kwargs["srcNodata"] = nodata
    warped = gdal.Warp("/vsimem/dem_tile.tif", vrt_path, **warp_kwargs)
    arr = warped.GetRasterBand(1).ReadAsArray()
    warped = None
    # Nodata / out-of-surface pixels -> sea level (a real 0.0 stays 0.0).
    arr = np.where(np.isfinite(arr), arr, out_nodata)
    arr = np.where(arr == out_nodata, sea_level, arr)
    rgb = pack_elevation(arr, encoding)
    return _encode_png(rgb, tilesize)


def tms_row(z, y):
    """Slippy y (top-down) -> MBTiles TMS tile_row (bottom-up)."""
    return (2 ** z) - 1 - y


class MbtilesWriter:
    """Stream MBTiles rows into SQLite in batches so a large run never holds every
    tile's PNG bytes in RAM at once (avoids OOM on big regions like all of Norway).

    Usage:
        with MbtilesWriter(path, meta) as w:
            w.add(z, x, y, png_bytes)   # batched + committed automatically
    """

    def __init__(self, path, meta, batch=64):
        self.path = path
        self.meta = meta
        self.batch_size = batch
        self.count = 0
        self._buf = []
        self._con = None

    def __enter__(self):
        if os.path.exists(self.path):
            os.remove(self.path)
        self._con = sqlite3.connect(self.path)
        self._con.executescript(
            """
            CREATE TABLE metadata (name TEXT, value TEXT);
            CREATE TABLE tiles (
                zoom_level  INTEGER,
                tile_column INTEGER,
                tile_row    INTEGER,
                tile_data   BLOB,
                PRIMARY KEY (zoom_level, tile_column, tile_row)
            );
            """
        )
        self._con.executemany(
            "INSERT INTO metadata (name, value) VALUES (?, ?)",
            [(k, str(v)) for k, v in self.meta.items()],
        )
        self._con.commit()
        return self

    def add(self, z, x, y, png):
        self._buf.append((z, x, tms_row(z, y), png))
        self.count += 1
        if len(self._buf) >= self.batch_size:
            self._flush()

    def _flush(self):
        if not self._buf:
            return
        self._con.executemany(
            "INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)",
            self._buf,
        )
        self._con.commit()
        self._buf = []  # release the batched PNG bytes

    def close(self):
        self._flush()
        if self._con is not None:
            self._con.close()
            self._con = None

    def __exit__(self, exc_type, exc, tb):
        self.close()
        return False


def write_mbtiles(path, tiles, meta):
    """One-shot write (small sets, e.g. tests/selftest). Large runs should stream
    via MbtilesWriter to keep memory flat."""
    with MbtilesWriter(path, meta) as w:
        for (z, x, y, png) in tiles:
            w.add(z, x, y, png)
    return path


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------
def run(args):
    sources = collect_sources(args.input)
    tmpdir = tempfile.mkdtemp(prefix="dem_")
    vrt_path = os.path.join(tmpdir, "dem.vrt")
    build_vrt(sources, vrt_path)

    src_bbox = source_bbox_lnglat(vrt_path)
    if args.bbox:
        try:
            bbox = [float(v) for v in args.bbox.split(",")]
            if len(bbox) != 4:
                raise ValueError
        except ValueError:
            raise SystemExit("error: --bbox must be W,S,E,N (lng/lat)")
        print(f"source bbox: {src_bbox}")
        print(f"clipping to: {bbox}")
    else:
        bbox = src_bbox
        print(f"source bbox: {bbox}")

    nodata = args.nodata if args.nodata is not None else detect_nodata(sources)
    sea_level = float(args.sea_level)
    print(
        f"encoding={args.encoding}  nodata={nodata}  sea_level={sea_level}  "
        f"tilesize={args.tilesize}  z{args.minzoom}..z{args.maxzoom}"
    )

    tiles = tiles_for_bbox(bbox, args.minzoom, args.maxzoom)
    total = len(tiles)
    print(f"tiles to produce: {total}")
    if total == 0:
        raise SystemExit("error: no tiles fall in the requested range/bbox")

    out = os.path.abspath(args.output)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    meta = {
        "name": "diymtbmap terrain (3D)",
        "format": "png",
        "bounds": ",".join(f"{v:.6f}" for v in bbox),
        "minzoom": args.minzoom,
        "maxzoom": args.maxzoom,
        "tileSize": args.tilesize,
        "encoding": args.encoding,
        "type": "overlay",
        "attribution": "Norwegian DTM10 (Basisdata) elevation, packaged for diymtbmap",
    }

    # Stream tiles straight into SQLite in batches (MbtilesWriter) so we never
    # hold every PNG in RAM at once — flat memory even for the full Norway set.
    with MbtilesWriter(out, meta) as w:
        for i, (z, x, y) in enumerate(tiles, start=1):
            png = produce_tile(vrt_path, z, x, y, args.tilesize, args.encoding, nodata, sea_level)
            w.add(z, x, y, png)
            if args.verbose or i % 200 == 0 or i == total:
                print(f"  [{i}/{total}] z{z} x{x} y{y} -> {len(png)} B PNG")

    size = os.path.getsize(out)
    print(f"OK: wrote {out}")
    print(f"     tiles={total}  size={size/1e6:.2f} MB")
    return out


# ---------------------------------------------------------------------------
# Self-test (synthetic round-trip + packaging) — no real data or network needed
# ---------------------------------------------------------------------------
def synthetic_elevation(x_m, y_m):
    """Analytic elevation (m) used by the synthetic self-test source."""
    return 200.0 + 0.05 * x_m + 0.01 * y_m


def _make_synthetic_source(path, x0=100000.0, size_m=10000.0, px=10.0):
    """A smooth, analytically known EPSG:3857 elevation surface covering
    x_m in [x0, x0+size_m] and y_m in [x0, x0+size_m].

    elevation(x_m, y_m) = 200 + 0.05*x_m + 0.01*y_m
    The top-left quadrant (west half, north half) is marked nodata so we can
    verify nodata -> sea-level fill. Returns the nodata value used.
    """
    nodata = -32767.0
    n = int(size_m / px)  # e.g. 1000 for a 10 km square at 10 m
    w = h = n
    x_m = x0 + np.arange(w) * px            # col 0 = west edge
    y_m = (x0 + size_m) - np.arange(h) * px  # row 0 = top = max y_m
    X, Y = np.meshgrid(x_m, y_m)
    elev = synthetic_elevation(X, Y)
    half = n // 2
    elev[:half, :half] = nodata             # top-left quadrant = nodata
    ds = gdal.GetDriverByName("GTiff").Create(path, w, h, 1, gdal.GDT_Float32)
    ds.SetGeoTransform([x0, px, 0.0, x0 + size_m, 0.0, -px])
    srs = osr.SpatialReference()
    srs.ImportFromEPSG(3857)
    ds.SetProjection(srs.ExportToWkt())
    ds.GetRasterBand(1).WriteArray(elev.astype(np.float32))
    ds.GetRasterBand(1).SetNoDataValue(nodata)
    ds = None
    return nodata


def find_tile_fully_inside(bbox, zmax, rect, margin=50.0):
    """Return the highest-zoom (z,x,y) tile whose 3857 bounds lie fully inside
    `rect` (minX,minY,maxX,maxY meters), or None. Used by the self-test."""
    rx0, ry0, rx1, ry1 = rect
    best = None
    for z in range(1, zmax + 1):
        for (zz, x, y) in tiles_for_bbox(bbox, z, z):
            b = tile_output_bounds_3857(z, x, y)
            if (b[0] >= rx0 + margin and b[2] <= rx1 - margin
                    and b[1] >= ry0 + margin and b[3] <= ry1 - margin):
                best = (z, x, y)
    return best


def selftest():
    ok = True
    failures = []

    def check(name, cond, detail=""):
        nonlocal ok
        status = "PASS" if cond else "FAIL"
        print(f"  [{status}] {name}" + (f"  ({detail})" if detail else ""))
        if not cond:
            ok = False
            failures.append(name)

    print("== pack/decode round-trip (pure) ==")
    for enc in ("mapbox", "terrarium"):
        for e in (-1000, -10, 0, 12.345, 100, 500, 1234, 2469, 3200):
            r, g, b = pack_scalar(e, enc)
            d = decode_scalar((r, g, b), enc)
            tol = 0.2 if enc == "mapbox" else 0.01
            check(f"{enc} e={e}m", all(0 <= c <= 255 for c in (r, g, b)) and abs(d - e) <= tol,
                  f"rgb=({r},{g},{b}) decoded={d:.4f}m")

    print("== integration: convert a synthetic source and decode a tile ==")
    tmpdir = tempfile.mkdtemp(prefix="dem_selftest_")
    src = os.path.join(tmpdir, "synthetic.tif")
    nodata = _make_synthetic_source(src)
    vrt = os.path.join(tmpdir, "synthetic.vrt")
    build_vrt([src], vrt)
    bbox = source_bbox_lnglat(vrt)
    print(f"  synthetic bbox: {bbox}")

    tilesize = 64
    # Regions in EPSG:3857 meters for the 10km source at x0=100000.
    in_surface = (105000.0, 100000.0, 110000.0, 110000.0)  # east half: guaranteed non-nodata
    nodata_rect = (100000.0, 105000.0, 105000.0, 110000.0)   # top-left quadrant: all nodata
    t_dec = find_tile_fully_inside(bbox, 15, in_surface)
    t_sea = find_tile_fully_inside(bbox, 15, nodata_rect)
    print(f"  in-surface test tile: {t_dec}\n  nodata test tile:     {t_sea}")
    if t_dec is None or t_sea is None:
        check("found fully-inside test tiles", False, f"dec={t_dec} sea={t_sea}")
        return 1

    produced = []
    for (z, x, y) in (t_dec, t_sea):
        produced.append((z, x, y, produce_tile(vrt, z, x, y, tilesize, "mapbox", nodata, 0.0)))
    out = os.path.join(tmpdir, "selftest.mbtiles")
    zmin = min(t[0] for t in (t_dec, t_sea))
    zmax = max(t[0] for t in (t_dec, t_sea))
    write_mbtiles(out, produced, {"name": "selftest", "format": "png", "bounds": bbox,
                                 "minzoom": zmin, "maxzoom": zmax, "tileSize": tilesize})

    def read_tile(z, x, y):
        con = sqlite3.connect(out)
        row = (2 ** z) - 1 - y
        blob = con.execute(
            "SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?",
            (z, x, row)).fetchone()[0]
        con.close()
        return decode_elevation(_png_to_rgb(blob, tilesize), "mapbox")

    # 1) in-surface tile center decodes to the analytic elevation
    z, x, y = t_dec
    dec = read_tile(z, x, y)
    b = tile_output_bounds_3857(z, x, y)
    cx = (b[0] + b[2]) / 2.0
    cy = (b[1] + b[3]) / 2.0
    center = dec[tilesize // 2, tilesize // 2]
    expected = synthetic_elevation(cx, cy)
    check("in-surface center ~ analytic", abs(center - expected) <= 2.0,
          f"center={center:.2f}m expected~{expected:.2f}m tile {t_dec}")

    # 2) nodata tile decodes entirely to sea level (0 m)
    z, x, y = t_sea
    dec = read_tile(z, x, y)
    check("nodata tile -> sea level (0m)", dec.min() >= -0.05 and dec.max() <= 0.05,
          f"min={dec.min():.3f} max={dec.max():.3f} tile {t_sea}")

    # Metadata
    con = sqlite3.connect(out)
    meta = dict(con.execute("SELECT name, value FROM metadata").fetchall())
    con.close()
    check("metadata.format == png", meta.get("format") == "png", f"got {meta.get('format')}")
    check("metadata.minzoom/maxzoom", meta.get("minzoom") == str(zmin) and meta.get("maxzoom") == str(zmax))
    check("metadata.bounds present", len(str(meta.get("bounds", "")).split(",")) == 4)

    # TMS flip sanity: tile_row = 2^z - 1 - y
    check("tms_row flip",
          tms_row(1, 0) == 1 and tms_row(1, 1) == 0 and tms_row(2, 0) == 3 and tms_row(3, 5) == 2,
          f"tms_row(1,0)={tms_row(1,0)} tms_row(2,0)={tms_row(2,0)} tms_row(3,5)={tms_row(3,5)}")

    print()
    if ok:
        print(f"SELFTEST PASSED  (artifact: {out})")
        return 0
    print(f"SELFTEST FAILED: {len(failures)} failure(s): {failures}")
    return 1


def _png_to_rgb(png_bytes, tilesize):
    """PNG bytes (3-band 8-bit) -> uint8 HxWx3 via GDAL."""
    fd, tmp = tempfile.mkstemp(suffix=".png")
    os.close(fd)
    with open(tmp, "wb") as fh:
        fh.write(png_bytes)
    ds = gdal.Open(tmp)
    arr = np.dstack([ds.GetRasterBand(i).ReadAsArray() for i in range(1, 4)]).astype(np.uint8)
    ds = None
    os.unlink(tmp)
    assert arr.shape == (tilesize, tilesize, 3), f"unexpected tile shape {arr.shape}"
    return arr


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def build_parser():
    p = argparse.ArgumentParser(
        description="Convert GeoTIFF DEM tiles into a diymtbmap dem.mbtiles (MapLibre raster-dem).",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--input", help="a dir of .tif/.zip, or a single .tif / .vrt / .zip "
                                  "(zip .tif members are auto-extracted; no GDAL ZIP driver needed)")
    p.add_argument("--output", default="dem.mbtiles", help="output .mbtiles path")
    p.add_argument("--encoding", choices=sorted(ENCODINGS), default=DEFAULT_ENCODING,
                   help="MapLibre raster-dem encoding to pack into")
    p.add_argument("--minzoom", type=int, default=6)
    p.add_argument("--maxzoom", type=int, default=11)
    p.add_argument("--tilesize", type=int, default=512, help="tile pixel size (power of 2)")
    p.add_argument("--nodata", type=float, default=None, help="source nodata value (auto-detect if omitted)")
    p.add_argument("--sea-level", type=float, default=0.0, help="value used to fill nodata/out-of-surface")
    p.add_argument("--bbox", default=None, help="clip to W,S,E,N (lng/lat); default = data's own bbox")
    p.add_argument("--verbose", action="store_true", help="log every tile")
    p.add_argument("--selftest", action="store_true", help="run a synthetic round-trip test and exit")
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    if args.selftest:
        return selftest()
    if not args.input:
        print(build_parser().format_help())
        raise SystemExit("error: --input is required (or use --selftest)")
    run(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
