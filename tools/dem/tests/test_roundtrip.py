"""Round-trip and geometry tests for build-dem.py.

Run standalone (no pytest needed):   python3 tests/test_roundtrip.py
Or under pytest:                     pytest tools/dem/tests/test_roundtrip.py
"""

import importlib.util
import os

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(os.path.dirname(HERE), "build-dem.py")

_spec = importlib.util.spec_from_file_location("build_dem", BUILD)
bd = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bd)

ELEVATIONS = (-1000, -10, 0, 12.345, 100, 500, 1234, 2469, 3200)


def test_pack_decode_roundtrip_mapbox():
    for e in ELEVATIONS:
        r, g, b = bd.pack_scalar(e, "mapbox")
        assert all(0 <= c <= 255 for c in (r, g, b)), (r, g, b)
        assert abs(bd.decode_scalar((r, g, b), "mapbox") - e) <= 0.2


def test_pack_decode_roundtrip_terrarium():
    for e in ELEVATIONS:
        r, g, b = bd.pack_scalar(e, "terrarium")
        assert all(0 <= c <= 255 for c in (r, g, b)), (r, g, b)
        assert abs(bd.decode_scalar((r, g, b), "terrarium") - e) <= 0.01


def test_pack_is_a_valid_maplibre_unpack():
    """Our pack must invert exactly MapLibre's unpack formula (R*red+G*green+B*blue-baseShift)."""
    f = bd.ENCODINGS["mapbox"]
    for e in (0, 12.345, 500, 2469):
        r, g, b = bd.pack_scalar(e, "mapbox")
        assert abs(r * f["red"] + g * f["green"] + b * f["blue"] - f["baseShift"] - e) <= 0.2


def test_pack_vectorized_shape_dtype():
    arr = np.linspace(-100, 3000, 100).reshape(10, 10)
    rgb = bd.pack_elevation(arr, "mapbox")
    assert rgb.shape == (10, 10, 3)
    assert rgb.dtype == np.uint8
    dec = bd.decode_elevation(rgb, "mapbox")
    assert np.max(np.abs(dec - arr)) <= 0.2


def test_tms_row_flip():
    # tile_row = 2^z - 1 - y
    assert bd.tms_row(1, 0) == 1
    assert bd.tms_row(1, 1) == 0
    assert bd.tms_row(2, 0) == 3
    assert bd.tms_row(3, 5) == 2


def test_tile_geometry_inverse():
    z, x, y = 12, 1234, 987
    lng_w, lat_s, lng_e, lat_n = bd.tile_lnglat_bounds(z, x, y)
    assert lng_w < lng_e and lat_s < lat_n
    assert bd.lng_to_tile_x(z, lng_w) == x
    assert bd.lng_to_tile_x(z, lng_e - 1e-9) == x
    assert bd.lat_to_tile_y(z, lat_n) == y
    assert bd.lat_to_tile_y(z, lat_s + 1e-9) == y


def test_3857_roundtrip():
    for lng, lat in [(0, 0), (10.5, 59.9), (-122.4, 37.7), (6.9, 57.5)]:
        x_m = bd.lng_to_x_m(lng)
        y_m = bd.lat_to_y_m(lat)
        assert abs(bd.x_m_to_lng(x_m) - lng) < 1e-9
        assert abs(bd.y_m_to_lat(y_m) - lat) < 1e-9


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
