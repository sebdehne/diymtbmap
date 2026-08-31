"""MBTiles metadata / packaging tests for build-dem.py.

Builds a small synthetic source, converts a tile, and checks the output
MBTiles: schema, metadata, TMS row order, PNG bytes, and elevation decode.

Run standalone (no pytest needed):   python3 tests/test_metadata.py
Or under pytest:                     pytest tools/dem/tests/test_metadata.py
"""

import importlib.util
import os
import sqlite3
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(os.path.dirname(HERE), "build-dem.py")

_spec = importlib.util.spec_from_file_location("build_dem", BUILD)
bd = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bd)

PNG_SIG = b"\x89PNG\r\n\x1a\n"
TILESIZE = 64


def _build_sample_mbtiles():
    tmp = tempfile.mkdtemp(prefix="dem_meta_")
    src = os.path.join(tmp, "synthetic.tif")
    nodata = bd._make_synthetic_source(src)
    vrt = os.path.join(tmp, "synthetic.vrt")
    bd.build_vrt([src], vrt)
    bbox = bd.source_bbox_lnglat(vrt)

    in_surface = (105000.0, 100000.0, 110000.0, 110000.0)  # east half: non-nodata
    tile = bd.find_tile_fully_inside(bbox, 15, in_surface)
    assert tile is not None, "no fully-inside tile found"
    z, x, y = tile
    png = bd.produce_tile(vrt, z, x, y, TILESIZE, "mapbox", nodata, 0.0)
    out = os.path.join(tmp, "sample.mbtiles")
    bd.write_mbtiles(
        out,
        [(z, x, y, png)],
        {"name": "sample", "format": "png", "bounds": bbox,
         "minzoom": z, "maxzoom": z, "tileSize": TILESIZE, "encoding": "mapbox"},
    )
    return out, (z, x, y), bbox


def test_metadata_fields():
    out, (z, x, y), bbox = _build_sample_mbtiles()
    con = sqlite3.connect(out)
    meta = dict(con.execute("SELECT name, value FROM metadata"))
    con.close()
    assert meta["format"] == "png"
    assert meta["minzoom"] == str(z)
    assert meta["maxzoom"] == str(z)
    assert len(str(meta["bounds"]).split(",")) == 4
    assert meta.get("encoding") == "mapbox"


def test_tms_row_order():
    out, (z, x, y), _ = _build_sample_mbtiles()
    con = sqlite3.connect(out)
    row = con.execute(
        "SELECT tile_row FROM tiles WHERE zoom_level=? AND tile_column=?", (z, x)
    ).fetchone()[0]
    con.close()
    assert row == bd.tms_row(z, y) == (2 ** z) - 1 - y


def test_tile_is_valid_png():
    out, _, _ = _build_sample_mbtiles()
    con = sqlite3.connect(out)
    blob = con.execute("SELECT tile_data FROM tiles").fetchone()[0]
    con.close()
    assert blob[:8] == PNG_SIG, "tile blob is not a PNG"
    assert len(blob) > 64


def test_tile_decodes_to_real_elevation():
    out, (z, x, y), _ = _build_sample_mbtiles()
    con = sqlite3.connect(out)
    blob = con.execute("SELECT tile_data FROM tiles").fetchone()[0]
    con.close()
    rgb = bd._png_to_rgb(blob, TILESIZE)
    dec = bd.decode_elevation(rgb, "mapbox")
    # the east-half in-surface region: 200 + 0.05*x + 0.01*y for x in [105000,110000],
    # y in [100000,110000]  =>  roughly 6450 .. 6800 m
    lo = bd.synthetic_elevation(105000.0, 100000.0)
    hi = bd.synthetic_elevation(110000.0, 110000.0)
    assert dec.min() > lo - 50 and dec.max() < hi + 50, (dec.min(), dec.max(), lo, hi)


if __name__ == "__main__":
    import sys

    fns = [(n, f) for n, f in list(globals().items()) if n.startswith("test_") and callable(f)]
    fails = 0
    for name, fn in fns:
        try:
            fn()
            print(f"  [PASS] {name}")
        except AssertionError as exc:
            fails += 1
            print(f"  [FAIL] {name}: {exc}")
    print(f"\n{len(fns) - fails}/{len(fns)} passed")
    sys.exit(1 if fails else 0)
