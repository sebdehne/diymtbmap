#!/usr/bin/env python3
"""download-dtm-norway.py — download the full Norwegian "DTM 10 Terrengmodell
(UTM33)" as GeoTIFF tiles from the Geonorge kartkatalog.

What it does
------------
Downloads every DTM 10 (10 m grid) tile of mainland Norway in the UTM zone 33
projection (EPSG:25833, EUREF89 UTM sone 33) from the Geonorge download
service (nedlasting.geonorge.no), exactly like the "Last ned" (download) flow
of https://kartkatalog.geonorge.no — dataset *DTM 10 Terrengmodell (UTM33)*,
format *TIFF* (GeoTIFF), projection *25833*, **all areas** (254 tiles).

The pieces (all plain HTTP/JSON, Python stdlib only):

1. Catalog discovery — find the dataset record via
   `https://kartkatalog.geonorge.no/api/search?text=…` and take the record
   whose title is exactly "DTM 10 Terrengmodell (UTM33)" (not the UTM32/UTM35
   siblings, not "Historiske versjoner"). A hard-coded UUID fallback is used
   if the catalog search is unreachable.

2. Capabilities — `https://nedlasting.geonorge.no/api/capabilities/<uuid>`
   returns the HAL `_links` (area / projection / format code lists + the order
   endpoint). The code lists are fetched and the requested format/projection
   are validated against them.

3. Order + download — for each area a single-line order is POSTed to
   `https://nedlasting.geonorge.no/api/order`
   (payload shape per the Geonorge nedlasting API v3, cf.
   `Geonorge.NedlastingApi.V3.CanDownloadRequestType`):

       {
         "orderLines": [{
           "metadataUuid": "<dataset-uuid>",
           "areas":     [{"code": "6400-1", "name": "6400-1",
                          "type": "ikke spesifisert"}],
           "formats":   [{"name": "TIFF"}],
           "projections":[{"code": "25833",
                           "name": "EUREF89 UTM sone 33, 2d",
                           "codespace": "http://www.opengis.net/def/crs/EPSG/0/25833"}]
         }]
       }

   DTM 10 tiles are pre-produced, so the order returns
   `"status": "ReadyForDownload"` plus a `downloadUrl` immediately (no email,
   no queue). The ZIP is downloaded (streamed to a `.part` file, then renamed)
   and its GeoTIFF member is extracted.

4. Resume — `state.json` tracks per-area status, so an interrupted run is
   simply re-run; finished areas are skipped. `manifest.json` is written at
   the end with the full per-area breakdown.

Layout (default `--output <repo>/dem/download_dtm_for_norway`):

    dem/download_dtm_for_norway/
    ├── zips/      Basisdata_<area>_Celle_25833_DTM10UTM33_TIFF.zip   (254)
    ├── geotiffs/  <area>_10m_z33.tif            (254 GeoTIFFs, EPSG:25833)
    ├── state.json  (resume bookkeeping)
    └── manifest.json (dataset + per-area file/size/status summary)

Each GeoTIFF is a 5041×5041 px, 10 m grid, Float32 band, NoData −32767,
CRS EPSG:25833 (ETRS89 / UTM zone 33N). Total transfer ≈ 10 GB.

The GeoTIFFs (or their ZIPs — `build-dem.py` auto-extracts ZIPs) are the
intended `--input` for `tools/dem-to-raster-tiles-converter/build-dem.py`.

Notes
-----
* "Tur og friluft" and "Transport - trafikk - navigasjon" are theme filters in
  the kartkatalog UI that lead to this dataset; the API itself indexes the
  record under theme "Høydedata". Discovery here is by exact title, which is
  unambiguous.
* Be polite: default 3 parallel downloads and a small delay between orders.
  Lower `--jobs` if the connection or the service misbehaves.
"""

import argparse
import concurrent.futures
import json
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

CATALOG_API = "https://kartkatalog.geonorge.no/api"
NEDLASTING_API = "https://nedlasting.geonorge.no/api"
USER_AGENT = "diymtbmap-dtm-downloader/1.0 (python-urllib)"

DEFAULT_TITLE = "DTM 10 Terrengmodell (UTM33)"
DEFAULT_UUID = "dddbb667-1303-4ac5-8640-7ec04c0e3918"  # fallback if catalog search fails
DEFAULT_FORMAT = "TIFF"      # GeoTIFF (the "DEM" format is an ASCII grid — not GeoTIFF)
DEFAULT_PROJECTION = "25833"  # EUREF89 UTM sone 33 (EPSG:25833)

STATE_FILE = "state.json"
MANIFEST_FILE = "manifest.json"

_print_lock = threading.Lock()


def log(msg):
    with _print_lock:
        print(msg, flush=True)


# ---------------------------------------------------------------------------
# HTTP helpers (stdlib urllib; retries with backoff)
# ---------------------------------------------------------------------------
def _request(url, data=None, method=None, headers=None, timeout=120):
    hdrs = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    if headers:
        hdrs.update(headers)
    if data is not None:
        hdrs.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method or ("POST" if data is not None else "GET"))
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, dict(resp.headers), resp.read()


def http_get_json(url, timeout=60):
    status, _, body = _request(url, timeout=timeout)
    return status, json.loads(body.decode("utf-8"))


def http_post_json(url, payload, timeout=120):
    status, _, body = _request(url, data=json.dumps(payload).encode("utf-8"), timeout=timeout)
    return status, json.loads(body.decode("utf-8"))


def http_download(url, dest, timeout=600):
    """Stream `url` to `dest` (dest is the final path; caller manages .part)."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp, open(dest, "wb") as out:
        total = resp.length
        done = 0
        while True:
            chunk = resp.read(1024 * 256)
            if not chunk:
                break
            out.write(chunk)
            done += len(chunk)
    return done


def with_retries(label, fn, retries=4, backoffs=(2, 5, 15, 45), timeout=None):
    """Run `fn` with retries on transient failures (5xx/429/network errors)."""
    last = None
    for attempt in range(retries + 1):
        try:
            if timeout is not None:
                return fn(timeout)
            return fn()
        except urllib.error.HTTPError as e:
            body = ""
            try:
                body = e.read(300).decode("utf-8", "replace")
            except Exception:
                pass
            last = e
            if e.code in (408, 429, 500, 502, 503, 504):
                if attempt < retries:
                    wait = min(backoffs[min(attempt, len(backoffs) - 1)], 60)
                    log(f"    ! {label}: HTTP {e.code}, retry {attempt + 1}/{retries} in {wait}s  ({body[:120]})")
                    time.sleep(wait)
                    continue
            raise RuntimeError(f"{label}: HTTP {e.code}: {body[:200]}") from e
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
            last = e
            if attempt < retries:
                wait = min(backoffs[min(attempt, len(backoffs) - 1)], 60)
                log(f"    ! {label}: network error ({e}), retry {attempt + 1}/{retries} in {wait}s")
                time.sleep(wait)
                continue
            raise RuntimeError(f"{label}: network error after {retries + 1} attempts: {e}") from e
    raise RuntimeError(f"{label}: failed after retries: {last}")


# ---------------------------------------------------------------------------
# Catalog discovery
# ---------------------------------------------------------------------------
def find_dataset(title, timeout=60):
    """Search the kartkatalog API and return the record with the exact title.

    Returns (uuid, title) or (None, None) if not found.
    """
    params = urllib.parse.urlencode({"limit": 100, "offset": 0, "text": title})
    url = f"{CATALOG_API}/search?{params}"
    status, data = http_get_json(url, timeout=timeout)
    for rec in data.get("Results", []):
        if rec.get("Title") == title:
            return rec.get("Uuid"), rec.get("Title")
    # Fall back to a case-insensitive / prefix match if the exact title moved.
    for rec in data.get("Results", []):
        t = (rec.get("Title") or "").strip()
        if t.lower().startswith(title.split("(")[0].strip().lower()) and "historik" not in t.lower():
            return rec.get("Uuid"), rec.get("Title")
    return None, None


# ---------------------------------------------------------------------------
# Nedlasting (download) API
# ---------------------------------------------------------------------------
def get_capabilities(uuid, timeout=60):
    url = f"{NEDLASTING_API}/capabilities/{uuid}"
    status, caps = http_get_json(url, timeout=timeout)
    links = {}
    for lnk in caps.get("_links", []):
        rel = lnk.get("rel", "")
        if "download/area" in rel:
            links["area"] = lnk["href"]
        elif "download/projection" in rel:
            links["projection"] = lnk["href"]
        elif "download/format" in rel:
            links["format"] = lnk["href"]
        elif "download/order" in rel:
            links["order"] = lnk["href"]
    return caps, links


def get_codelist(url, timeout=60):
    status, data = http_get_json(url, timeout=timeout)
    if not isinstance(data, list):
        raise RuntimeError(f"codelist {url} did not return a list: {str(data)[:200]}")
    return data


def list_areas(links, timeout=60):
    areas = get_codelist(links["area"], timeout=timeout)
    return [{"code": a["code"], "name": a.get("name", a["code"]), "type": a.get("type", "")} for a in areas]


def list_formats(links, timeout=60):
    return [f.get("name", "").strip() for f in get_codelist(links["format"], timeout=timeout)]


def list_projections(links, timeout=60):
    return [p.get("code", "") for p in get_codelist(links["projection"], timeout=timeout)]


def order_area(order_url, uuid, area, format_name, projection, timeout=120):
    """Place a single-area order; return the file entry (ReadyForDownload)."""
    payload = {
        "orderLines": [
            {
                "metadataUuid": uuid,
                "areas": [area],
                "formats": [{"name": format_name}],
                "projections": [
                    {
                        "code": projection,
                        "name": f"EUREF89 UTM sone {int(projection) if projection.isdigit() else projection}, 2d",
                        "codespace": f"http://www.opengis.net/def/crs/EPSG/0/{projection}",
                    }
                ],
            }
        ]
    }
    status, receipt = http_post_json(order_url, payload, timeout=timeout)
    files = receipt.get("files", [])
    if not files:
        raise RuntimeError(f"order for area {area['code']} returned no files: {str(receipt)[:300]}")
    mine = [f for f in files if (f.get("area") or area["code"]) == area["code"]]
    f = mine[0] if mine else files[0]
    if f.get("status") not in ("ReadyForDownload", None):
        raise RuntimeError(
            f"area {area['code']} not ready for download: status={f.get('status')} (it will be produced "
            f"asynchronously; re-run this tool later to pick it up)"
        )
    if not f.get("downloadUrl"):
        raise RuntimeError(f"area {area['code']} has no downloadUrl: {str(f)[:300]}")
    return receipt.get("referenceNumber"), f


def safe_name(name):
    return re.sub(r"[^A-Za-z0-9._-]", "_", name)


def extract_tiffs(zip_path, out_dir):
    """Extract .tif/.tiff members of `zip_path` into `out_dir`; return paths."""
    os.makedirs(out_dir, exist_ok=True)
    out = []
    with zipfile.ZipFile(zip_path) as z:
        bad = z.testzip()
        if bad is not None:
            raise RuntimeError(f"corrupt zip member {bad!r} in {zip_path}")
        for m in z.namelist():
            if not m.lower().endswith((".tif", ".tiff")):
                continue
            dest = os.path.join(out_dir, safe_name(os.path.basename(m)))
            with z.open(m) as src, open(dest, "wb") as dst:
                while True:
                    chunk = src.read(1024 * 256)
                    if not chunk:
                        break
                    dst.write(chunk)
            out.append(dest)
    return out


def verify_geotiff(path):
    """Best-effort GDAL check (only if osgeo is importable). Returns (ok, info)."""
    try:
        from osgeo import gdal
    except Exception:
        return None, "GDAL not available (skipped)"
    gdal.SetConfigOption("CPL_VERBOSE", "0")
    ds = gdal.Open(path)
    if ds is None:
        return False, "gdal.Open failed"
    srs = ds.GetSpatialRef()
    auth = ""
    if srs is not None:
        code = srs.GetAuthorityCode(None)
        auth = f"EPSG:{code}" if code else srs.ExportToWkt()[:60]
    info = (
        f"{ds.RasterXSize}x{ds.RasterYSize}px band={ds.GetRasterBand(1).GetDescription() or ''} "
        f"nodata={ds.GetRasterBand(1).GetNoDataValue()} crs={auth}"
    )
    ds = None
    return True, info.strip()


# ---------------------------------------------------------------------------
# State (resume) + manifest
# ---------------------------------------------------------------------------
class State:
    def __init__(self, path):
        self.path = path
        self.data = {"areas": {}}
        self.lock = threading.Lock()
        if os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as fh:
                    self.data = json.load(fh)
            except Exception:
                log(f"warning: could not read {path}; starting fresh")

    def get(self, area_code, default=None):
        return self.data["areas"].get(area_code, default)

    def update(self, area_code, **kw):
        with self.lock:
            entry = self.data["areas"].setdefault(area_code, {})
            entry.update(kw)
            entry["updated"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(self.data, fh, indent=1, ensure_ascii=False)
            os.replace(tmp, self.path)

    def write_manifest(self, out_dir, dataset, wanted):
        areas = self.data["areas"]
        manifest = {
            "dataset": dataset,
            "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "requestedAreas": len(wanted),
            "completedAreas": sum(1 for a in wanted if areas.get(a, {}).get("status") == "complete"),
            "areas": {
                code: areas[code]
                for code in wanted
                if code in areas
            },
        }
        path = os.path.join(out_dir, MANIFEST_FILE)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(manifest, fh, indent=1, ensure_ascii=False)
        return path


def human(n):
    for unit in ("B", "kB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{int(n)} B"
        n /= 1024.0


# ---------------------------------------------------------------------------
# Per-area pipeline
# ---------------------------------------------------------------------------
def process_area(ctx, area):
    code = area["code"]
    state: State = ctx["state"]
    zips_dir = ctx["zips_dir"]
    tifs_dir = ctx["tifs_dir"]
    fmt = ctx["format"]
    existing = state.get(code)

    want_extract = not ctx["no_extract"]
    zip_path = os.path.join(zips_dir, safe_name(f"Basisdata_{code}_Celle_{ctx['projection']}_{ctx['meta_name']}_{fmt.strip()}.zip"))
    # The receipt gives the exact file name; prefer the recorded one.
    if existing and existing.get("zip"):
        zip_path = os.path.join(zips_dir, os.path.basename(existing["zip"]))
    tiff_path = existing.get("tiff") if existing else None

    def zip_file_ok():
        return os.path.exists(zip_path) and os.path.getsize(zip_path) > 0

    def zip_satisfied():
        """ZIP requirement met: file on disk, or downloaded before and removed
        by --remove-zips (recorded in state)."""
        if zip_file_ok():
            return True
        return bool(ctx["remove_zips"] and existing and existing.get("zip_bytes"))

    def done_tiff():
        if not want_extract:
            return True
        return bool(tiff_path and os.path.exists(tiff_path) and os.path.getsize(tiff_path) > 0)

    if (not ctx["overwrite"] and existing and existing.get("status") == "complete"
            and zip_satisfied() and done_tiff()):
        log(f"[skip] {code}: already complete")
        return code, "skipped"

    # 1) + 2) ensure the ZIP: order (fresh downloadUrl) + download, unless it is
    # already on disk — or was downloaded earlier and removed by --remove-zips.
    if not zip_file_ok() and not (
        ctx["remove_zips"] and existing and existing.get("zip_bytes") and (not want_extract or done_tiff())
    ):
        log(f"[order] {code}: placing order …")
        ref, f = with_retries(
            f"order {code}",
            lambda: order_area(ctx["order_url"], ctx["uuid"], area, fmt, ctx["projection"], ctx["timeout"]),
            retries=ctx["retries"],
        )
        fname = f.get("name") or f"Basisdata_{code}.zip"
        zip_path = os.path.join(zips_dir, safe_name(fname))
        part = zip_path + ".part"
        log(f"[dl ]   {code}: {fname} …")
        with_retries(
            f"download {code}",
            lambda t=ctx["timeout"]: http_download(f.get("downloadUrl"), part, timeout=t),
            retries=ctx["retries"],
        )
        if not (os.path.exists(part) and os.path.getsize(part) > 0):
            raise RuntimeError(f"download of {code} produced an empty file")
        # sanity: must be a readable zip (we extract its GeoTIFF member below)
        with zipfile.ZipFile(part) as z:
            if z.testzip() is not None:
                os.unlink(part)
                raise RuntimeError(f"corrupt zip for {code}; will retry")
        os.replace(part, zip_path)
        state.update(
            code,
            status="zip",
            zip=zip_path,
            zip_bytes=os.path.getsize(zip_path),
            file_id=f.get("fileId"),
            order_ref=ref,
            file_name=fname,
        )
    else:
        log(f"[skip] {code}: zip already present")

    # 3) extract the GeoTIFF
    if want_extract:
        if not done_tiff():
            tifs = extract_tiffs(zip_path, tifs_dir)
            if not tifs:
                raise RuntimeError(f"no GeoTIFF member found in {zip_path}")
            tiff_path = tifs[0]
            log(f"[ext]   {code}: {os.path.basename(tiff_path)} ({human(os.path.getsize(tiff_path))})")
            state.update(code, tiff=tiff_path, tiff_bytes=os.path.getsize(tiff_path))
        else:
            log(f"[skip]   {code}: GeoTIFF already extracted")

    # 4) optionally delete the ZIP once everything we need from it is in place
    if ctx["remove_zips"] and zip_file_ok() and (not want_extract or done_tiff()):
        os.unlink(zip_path)
        log(f"[rm ]   {code}: removed {os.path.basename(zip_path)} (--remove-zips)")

    state.update(code, status="complete")
    return code, "ok"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def default_output_dir():
    """<repo-root>/dem/download_dtm_for_norway, resolved from this file's location
    (tools/dem-downloader-for-norway/download-dtm-norway.py) so CWD does not matter."""
    here = os.path.abspath(os.path.dirname(__file__))          # .../tools/dem-downloader-for-norway
    root = os.path.dirname(os.path.dirname(here))              # repo root
    return os.path.join(root, "dem", "download_dtm_for_norway")


def run(args):
    out_dir = os.path.abspath(args.output)
    zips_dir = os.path.join(out_dir, "zips")
    tifs_dir = os.path.join(out_dir, "geotiffs")
    for d in (out_dir, zips_dir):
        os.makedirs(d, exist_ok=True)

    # ---- 1. resolve the dataset -------------------------------------------
    uuid, title = args.uuid, args.title
    if uuid is None:
        log(f"catalog search: looking for {title!r} …")
        try:
            uuid, found_title = find_dataset(args.title, timeout=args.timeout)
        except Exception as e:
            log(f"  ! catalog search failed ({e}); using built-in UUID fallback")
            uuid, found_title = DEFAULT_UUID, args.title
        if uuid is None:
            log(f"  ! catalog search found no exact match; using built-in UUID fallback")
            uuid, found_title = DEFAULT_UUID, args.title
        else:
            title = found_title
            log(f"  found: {title}  uuid={uuid}")
    else:
        log(f"using --uuid {uuid} (catalog search skipped)")

    # ---- 2. capabilities + code lists --------------------------------------
    caps, links = get_capabilities(uuid, timeout=args.timeout)
    areas = list_areas(links, timeout=args.timeout)
    formats = list_formats(links, timeout=args.timeout)
    projections = list_projections(links, timeout=args.timeout)

    fmt = args.format.strip()
    if fmt not in [f.strip() for f in formats]:
        raise SystemExit(f"error: format {fmt!r} not offered by the dataset (available: {formats!r})")
    if args.projection not in projections:
        raise SystemExit(f"error: projection {args.projection!r} not offered (available: {projections!r})")

    meta_name = "DTM10UTM33"  # used only to guess a zip name before the receipt arrives
    wanted = areas
    if args.areas:
        wanted_codes = [c.strip() for c in args.areas.split(",") if c.strip()]
        by_code = {a["code"]: a for a in areas}
        missing = [c for c in wanted_codes if c not in by_code]
        if missing:
            raise SystemExit(f"error: unknown area code(s): {missing} (use --list-areas to see all)")
        wanted = [by_code[c] for c in wanted_codes]

    log(f"dataset : {title}")
    log(f"uuid    : {uuid}")
    log(f"format  : {fmt!r} (GeoTIFF)   projection: {args.projection} (EPSG:{args.projection})")
    log(f"areas   : {len(wanted)} of {len(areas)}   jobs: {args.jobs}   extract: {not args.no_extract}")
    log(f"output  : {out_dir}")

    if args.list_areas:
        for a in areas:
            print(a["code"])
        return 0

    # ---- 3. order + download + extract --------------------------------------
    ctx = {
        "uuid": uuid,
        "title": title,
        "order_url": links.get("order", f"{NEDLASTING_API}/order"),
        "projection": args.projection,
        "format": fmt,
        "meta_name": meta_name,
        "zips_dir": zips_dir,
        "tifs_dir": tifs_dir,
        "no_extract": args.no_extract,
        "remove_zips": args.remove_zips,
        "overwrite": args.overwrite,
        "retries": args.retries,
        "timeout": args.timeout,
    }
    state = State(os.path.join(out_dir, STATE_FILE))
    ctx["state"] = state

    results = {"ok": [], "skipped": [], "failed": []}
    t0 = time.time()
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as ex:
            futs = {}
            for i, area in enumerate(wanted):
                futs[ex.submit(process_area, ctx, area)] = area
                if args.delay and i < len(wanted) - 1:
                    time.sleep(args.delay)
            for fut in concurrent.futures.as_completed(futs):
                area = futs[fut]
                try:
                    code, res = fut.result()
                    results[res].append(code)
                except Exception as e:
                    results["failed"].append(area["code"])
                    log(f"[FAIL] {area['code']}: {e}")
    except KeyboardInterrupt:
        log("interrupted — progress saved in state.json; re-run to resume")
        state.write_manifest(out_dir, {"uuid": uuid, "title": title, "format": fmt,
                                       "projection": args.projection}, [a["code"] for a in wanted])
        return 130

    dt = time.time() - t0
    manifest_path = state.write_manifest(out_dir, {"uuid": uuid, "title": title, "format": fmt,
                                                   "projection": args.projection},
                                        [a["code"] for a in wanted])

    # ---- 4. summary ---------------------------------------------------------
    total_zip = sum((state.get(a["code"]) or {}).get("zip_bytes", 0) for a in wanted)
    total_tif = sum((state.get(a["code"]) or {}).get("tiff_bytes", 0) for a in wanted)
    print()
    print("=" * 72)
    print(f"done in {dt/60:.1f} min")
    print(f"  ok       : {len(results['ok']):{len(wanted)}d}")
    print(f"  skipped  : {len(results['skipped'])} (already present)")
    print(f"  failed   : {len(results['failed'])}" + (f"  {results['failed'][:8]}…" if results["failed"] else ""))
    print(f"  zips     : {human(total_zip)}")
    if not args.no_extract:
        print(f"  geotiffs : {human(total_tif)}")
    print(f"  manifest : {manifest_path}")
    print(f"  output   : {out_dir}")
    if args.no_extract:
        print("             (ZIPs only — re-run without --no-extract to extract the GeoTIFFs)")
    if results["failed"]:
        print("  NOTE     : re-run the same command to retry the failed areas (resume is automatic)")
    print("=" * 72)

    # ---- 5. optional GDAL verification --------------------------------------
    if args.verify and not args.no_extract:
        print("\nverifying GeoTIFFs with GDAL …")
        ok = bad = skip = 0
        for a in wanted:
            e = state.get(a["code"], {})
            p = e.get("tiff")
            if not p or not os.path.exists(p):
                skip += 1
                continue
            good, info = verify_geotiff(p)
            if good is None:
                skip += 1
                break
            if good:
                ok += 1
            else:
                bad += 1
                log(f"  [BAD] {a['code']}: {info}")
        if skip and bad == 0 and ok == 0:
            print(f"  (skipped: {skip}) — GDAL not importable")
        else:
            print(f"  verified OK: {ok}, bad: {bad}, skipped: {skip}")

    return 0 if not results["failed"] else 2


def build_parser():
    p = argparse.ArgumentParser(
        description="Download the full Norwegian DTM 10 Terrengmodell (UTM33) as GeoTIFF tiles "
                    "from kartkatalog.geonorge.no (all areas / entire country).",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--output", default=default_output_dir(),
                   help="output directory (zips/ + geotiffs/ + state.json + manifest.json)")
    p.add_argument("--title", default=DEFAULT_TITLE, help="dataset title to look up in the catalog")
    p.add_argument("--uuid", default=None, help="dataset metadata UUID (skips catalog search)")
    p.add_argument("--format", default=DEFAULT_FORMAT,
                   help="download format name from the dataset code list (TIFF = GeoTIFF; DEM = ASCII grid)")
    p.add_argument("--projection", default=DEFAULT_PROJECTION, help="projection code (25833 = EUREF89 UTM zone 33)")
    p.add_argument("--areas", default=None, help="comma-separated area codes to download (default: ALL areas)")
    p.add_argument("--list-areas", action="store_true", help="print all area codes and exit (no download)")
    p.add_argument("--jobs", type=int, default=3, help="parallel downloads")
    p.add_argument("--delay", type=float, default=0.3, help="pause (s) between starting orders (politeness)")
    p.add_argument("--retries", type=int, default=4, help="retries per order/download on transient errors")
    p.add_argument("--timeout", type=int, default=600, help="per-request timeout (s)")
    p.add_argument("--no-extract", action="store_true", help="keep only the ZIPs, do not extract the GeoTIFFs")
    p.add_argument("--remove-zips", action="store_true", help="delete a ZIP after its GeoTIFF was extracted")
    p.add_argument("--overwrite", action="store_true", help="re-download even if already present")
    p.add_argument("--verify", action="store_true", help="after download, open each GeoTIFF with GDAL (if available)")
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    if args.jobs < 1:
        raise SystemExit("error: --jobs must be >= 1")
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
