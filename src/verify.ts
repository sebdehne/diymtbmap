import Database from "better-sqlite3";
import { gunzipSync } from "node:zlib";
import { PbfReader } from "pbf";
import { VectorTile } from "@mapbox/vector-tile";
import { log } from "./log.js";

/**
 * OpenMapTiles v3.16 layers the basemap style expects.
 *
 * Planetiler writes `vector_layers` metadata from the features actually
 * emitted, so a layer is absent when the extract contains no features for it
 * (e.g. aerodrome_label in a city without airports). The core basemap layers
 * must be present; the rest degrade gracefully (rendered empty by the style).
 */
export const REQUIRED_LAYERS = [
  "aeroway",
  "boundary",
  "building",
  "housenumber",
  "landcover",
  "landuse",
  "mountain_peak",
  "park",
  "place",
  "poi",
  "transportation",
  "transportation_name",
  "water",
  "water_name",
  "waterway",
] as const;

export const OPTIONAL_LAYERS = ["aerodrome_label"] as const;

/** All 16 OMT layers (required + optional), for convenience. */
export const EXPECTED_LAYERS = [...REQUIRED_LAYERS, ...OPTIONAL_LAYERS] as const;

export const MTB_LAYER = "transportation";
export const MTB_ATTR = "mtb_scale";

/**
 * The dedicated low-zoom MTB overlay tileset (decision B1): its own MBTiles,
 * served as a second Martin source, carrying every mtb:scale way from
 * z MTB_MINZOOM (default 3) to z14 in a single layer.
 */
export const MTB_OVERLAY_LAYER = "mtb";
export const MTB_OVERLAY_ATTR = "mtb_scale";
/** MBTiles metadata key recording the build-time MTB_MINZOOM (stale detection). */
export const MTB_MINZOOM_META = "mtb_minzoom";

/**
 * The mtb-profile schema version this app expects (workstream C). Profile v1
 * emitted only natural trails (mtb:scale) as `mtb_scale`; v2 splits natural
 * (mtb:scale) from bike-park (mtb:scale:imba) trails and adds the `mtb_kind`
 * discriminator + popover attributes. A tileset built by an older profile
 * still serves natural trails (the overlay filter back-compat handles it); it
 * just has no bike-park data, so a version < 2 is a warning, not a failure.
 */
export const MTB_PROFILE_VERSION = "2";
/** MBTiles metadata key recording the profile version that built the tileset. */
export const MTB_PROFILE_VERSION_META = "mtb_profile_version";
/** The attribute that marks a bike-park trail (present when any is emitted). */
export const MTB_IMBA_ATTR = "mtb_imba";

/** The tileset must cover at least z0–z14 (the style + overlay are built for it). */
export const REQUIRED_MAXZOOM = 14;

export interface MtbHit {
  zoom: number;
  x: number;
  y: number;
  layer: string;
  /** Sampled feature properties (e.g. { class: "track", mtb_scale: "4", ... }). */
  properties: Record<string, number | string | boolean>;
}

export interface VerifyResult {
  name: string | null;
  format: string | null;
  minzoom: number | null;
  maxzoom: number | null;
  bounds: [number, number, number, number] | null;
  layers: string[];
  zooms: number[];
  /** The first transportation feature with a non-empty mtb_scale (guaranteed present on success). */
  mtbHit: MtbHit;
  tilesScanned: number;
}

export interface VerifyOptions {
  /** Safety cap on the number of tiles scanned while looking for mtb_scale. */
  maxTiles?: number;
  /** Progress feedback (e.g. status message updates) during the mtb_scale scan. */
  onScan?: (scanned: number, zoom: number) => void;
}

export class VerifyError extends Error {}

const DEFAULT_MAX_TILES = 4_000_000;
const SCAN_LOG_INTERVAL = 50_000;

function makeOnCount(
  scannedRef: { value: number },
  onScan: ((scanned: number, zoom: number) => void) | undefined,
  zoom: number,
): (delta: number) => void {
  return (delta: number): void => {
    scannedRef.value += delta;
    const total = scannedRef.value;
    onScan?.(total, zoom);
    if (total % SCAN_LOG_INTERVAL === 0) log(`mtb_scale scan: ${total} tiles checked (zoom ${zoom})`);
  };
}

/**
 * The MVT layer ids declared in the MBTiles metadata (`json`/vector_layers) —
 * metadata-only read, no tiles touched, so it is cheap even on the
 * skip-the-pipeline path. Throws VerifyError if the metadata is absent or
 * unparseable.
 */
export function readDeclaredLayers(file: string): string[] {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare("SELECT value FROM metadata WHERE name = 'json'")
      .get() as { value: string } | undefined;
    return parseVectorLayers(row?.value ?? null).map((l) => l.id);
  } finally {
    db.close();
  }
}

/**
 * The fields the tileset declares per layer (from the `vector_layers`
 * metadata `fields`), as a layer-id → field-name map. Metadata-only read.
 * Planetiler derives these from the features actually emitted, so a missing
 * field means "no feature in this extract carried it" — callers should treat
 * absent fields as a warning, not a hard failure.
 */
export function readDeclaredFields(file: string): Map<string, string[]> {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare("SELECT value FROM metadata WHERE name = 'json'")
      .get() as { value: string } | undefined;
    const layers = parseVectorLayers(row?.value ?? null);
    const out = new Map<string, string[]>();
    for (const l of layers) out.set(l.id, Object.keys(l.fields));
    return out;
  } finally {
    db.close();
  }
}

/**
 * MBTiles tiles are stored gzip-compressed (metadata `compression = gzip`).
 * Returns the decompressed tile, or the input as-is if it is not gzip.
 */
function decompressTile(data: Uint8Array): Uint8Array {
  if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) {
    return new Uint8Array(gunzipSync(Buffer.from(data)));
  }
  return data;
}

/**
 * Verifies the Planetiler/OMT tileset artifact before it is served:
 *
 *  1. metadata: pbf format, z0–z14 coverage, all 16 OMT layers declared
 *     (via the `json`/`vector_layers` metadata) and `transportation.mtb_scale`
 *     present among its fields;
 *  2. tiles: every zoom 0…max(14, maxzoom) has tiles;
 *  3. content: at least one `transportation` feature carries a non-empty
 *     `mtb_scale` value (scans z14→z12 tiles over the tileset bounds; tiles
 *     are stored gzip-compressed, so each is decompressed first and the MVT
 *     keys' "mtb_scale" byte search pre-filters full decoding).
 *
 * Fails with a VerifyError describing the first violated requirement.
 *
 * Works with both the compact layout planetiler writes by default
 * (tiles_shallow + tiles_data) and the plain `tiles` table.
 */
export function verifyMbtiles(file: string, opts: VerifyOptions = {}): VerifyResult {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const meta = new Map<string, string>();
    const metaRows = db.prepare("SELECT name, value FROM metadata").all() as {
      name: string;
      value: string;
    }[];
    for (const row of metaRows) meta.set(row.name, row.value);

    const format = meta.get("format") ?? null;
    if (format !== "pbf" && format !== "mvt") {
      throw new VerifyError(`unexpected tile format "${format ?? "(missing)"}" (expected "pbf")`);
    }

    const minzoom = parseNum(meta.get("minzoom"));
    const maxzoom = parseNum(meta.get("maxzoom"));
    const bounds = parseBounds(meta.get("bounds"));
    if (minzoom === null || minzoom > 0) {
      throw new VerifyError(`minzoom must be 0 (got ${meta.get("minzoom") ?? "(missing)"})`);
    }
    if (maxzoom === null || maxzoom < REQUIRED_MAXZOOM) {
      throw new VerifyError(
        `maxzoom must be >= ${REQUIRED_MAXZOOM} (got ${meta.get("maxzoom") ?? "(missing)"}) — the style/overlay are built for z0–z${REQUIRED_MAXZOOM}`,
      );
    }

    // 1. Core layers declared in the vector_layers metadata.
    const layerIds = readVectorLayerIds(meta.get("json") ?? null);
    const missingRequired = REQUIRED_LAYERS.filter((l) => !layerIds.includes(l));
    if (missingRequired.length > 0) {
      throw new VerifyError(
        `tileset is missing required layers: ${missingRequired.join(", ")} (found: ${layerIds.join(", ")})`,
      );
    }
    const missingOptional = OPTIONAL_LAYERS.filter((l) => !layerIds.includes(l));
    if (missingOptional.length > 0) {
      log(`warning: tileset is missing optional layer(s) ${missingOptional.join(", ")} (no such features in the extract) — the style renders them empty`);
    }
    // Note: planetiler derives vector_layers (layers AND fields) from the
    // features actually emitted, so an absent field only means "no feature in
    // this extract carried it" — e.g. an extract without mtb:scale-tagged
    // trails. The hard guarantee that MTB data exists is the content scan
    // below (step 3), not the metadata declaration.
    const transport = findVectorLayer(meta.get("json") ?? null, MTB_LAYER);
    if (transport !== null && !Object.keys(transport).includes(MTB_ATTR)) {
      log(`warning: ${MTB_LAYER}.${MTB_ATTR} is not a declared field — no feature in the extract carried it (fields: ${Object.keys(transport).join(", ")})`);
    }

    // 2. Zoom coverage (query the physical table, not the join view, for speed).
    const zoomTable = hasTable(db, "tiles_shallow") ? "tiles_shallow" : "tiles";
    const zoomRows = db
      .prepare(`SELECT DISTINCT zoom_level FROM ${zoomTable} ORDER BY zoom_level`)
      .all() as { zoom_level: number }[];
    const zooms = zoomRows.map((r) => r.zoom_level);
    if (zooms.length === 0) throw new VerifyError("tileset contains no tiles");
    const requiredMax = Math.max(REQUIRED_MAXZOOM, maxzoom);
    const missingZooms: number[] = [];
    for (let z = 0; z <= requiredMax; z++) {
      if (!zooms.includes(z)) missingZooms.push(z);
    }
    if (missingZooms.length > 0) {
      throw new VerifyError(`tileset has no tiles at zoom levels: ${missingZooms.join(", ")}`);
    }

    // 3. At least one transportation feature with a non-empty mtb_scale.
    if (bounds === null) {
      throw new VerifyError(
        "missing/invalid bounds metadata — cannot locate tiles for the mtb_scale scan (and the tileset is unusable without bounds)",
      );
    }
    const maxTiles = opts.maxTiles ?? DEFAULT_MAX_TILES;
    const scanned = { value: 0 };
    let mtbHit: MtbHit | null = null;
    const scanZooms = [maxzoom, maxzoom - 1, maxzoom - 2].filter((z) => z >= 0);
    const boundsForScan = bounds;

    const fetchStmt = hasTable(db, "tiles_shallow")
      ? db.prepare(
          `SELECT d.tile_data
           FROM tiles_shallow s
           JOIN tiles_data d ON d.tile_data_id = s.tile_data_id
           WHERE s.zoom_level = ? AND s.tile_column = ? AND s.tile_row = ?`,
        )
      : db.prepare(
          "SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?",
        );
    const fetchTile = (z: number, x: number, yTms: number): Uint8Array | null => {
      const row = fetchStmt.get(z, x, yTms) as { tile_data: Uint8Array } | undefined;
      return row ? row.tile_data : null;
    };

    for (const z of scanZooms) {
      const found = scanTiles(z, boundsForScan, fetchTile, scanned, makeOnCount(scanned, opts.onScan, z), maxTiles);
      if (found !== null) {
        mtbHit = found;
        break;
      }
    }

    if (mtbHit === null) {
      throw new VerifyError(
         `no ${MTB_LAYER} feature with a non-empty ${MTB_ATTR} found in ${scanned.value} tiles scanned (z${scanZooms.join(",z")} over the tileset bounds) — the extract may lack mtb:scale tagging or the profile did not emit it`,
      );
    }

    return {
      name: meta.get("name") ?? null,
      format,
      minzoom,
      maxzoom,
      bounds,
      layers: layerIds,
      zooms,
      mtbHit,
      tilesScanned: scanned.value,
    };
  } finally {
    db.close();
  }
}

/**
 * The build-time MTB_MINZOOM recorded in the tileset's MBTiles metadata
 * (`mtb_minzoom`), or null when the file has no such metadata. Cheap
 * metadata-only read, for the pipeline's skip/stale decision.
 */
export function readMtbMinzoom(file: string): number | null {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare(`SELECT value FROM metadata WHERE name = ?`)
      .get(MTB_MINZOOM_META) as { value: string } | undefined;
    const n = row === undefined ? null : Number.parseInt(row.value, 10);
    return n !== null && Number.isNaN(n) ? null : n;
  } finally {
    db.close();
  }
}

/**
 * The tileset's bounds metadata (`"west,south,east,north"`), or null when
 * absent or invalid. Cheap metadata-only read; the serve-time MTB check uses
 * it to locate the tiles it must fetch over HTTP.
 */
export function readMtbBounds(file: string): [number, number, number, number] | null {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare("SELECT value FROM metadata WHERE name = 'bounds'")
      .get() as { value: string } | undefined;
    return parseBounds(row?.value);
  } finally {
    db.close();
  }
}

/**
 * The mtb-profile version that built the tileset (`mtb_profile_version`
 * metadata), or null when the file has no such metadata (e.g. a v1 tileset).
 * Cheap metadata-only read; the pipeline compares it to MTB_PROFILE_VERSION
 * to warn (not fail) when a rebuild would add bike-park trails.
 */
export function readMtbProfileVersion(file: string): string | null {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare("SELECT value FROM metadata WHERE name = ?")
      .get(MTB_PROFILE_VERSION_META) as { value: string } | undefined;
    return row?.value ?? null;
  } finally {
    db.close();
  }
}

/**
 * Whether the tileset carries bike-park trails (workstream C): true when the
 * `mtb` layer declares the `mtb_imba` field — i.e. at least one bike-park way
 * (mtb:scale:imba) was emitted. False for v1 tilesets (no such field) and for
 * extracts without bike-park tagging. Cheap metadata-only read.
 */
export function readMtbHasBikePark(file: string): boolean {
  const fields = readDeclaredFields(file);
  return (fields.get(MTB_OVERLAY_LAYER) ?? []).includes(MTB_IMBA_ATTR);
}

export interface TilesetView {
  bounds: [number, number, number, number] | null;
  center: [number, number, number] | null;
}

/**
 * The tileset's view (workstream D): its `bounds` ("west,south,east,north")
 * and `center` ("lon,lat,zoom") metadata, each null when absent/invalid.
 * Cheap metadata-only read; the pipeline reports it so the UI can open the
 * map on the extract's own extent/center instead of a hardcoded Norway view.
 */
export function readTilesetView(file: string): TilesetView {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const bounds = readMetaValue(db, "bounds");
    const center = readMetaValue(db, "center");
    return { bounds: parseBounds(bounds), center: parseCenter(center) };
  } finally {
    db.close();
  }
}

function readMetaValue(db: Database.Database, name: string): string | undefined {
  const row = db.prepare("SELECT value FROM metadata WHERE name = ?").get(name) as { value: string } | undefined;
  return row?.value;
}

function parseCenter(raw: string | undefined): [number, number, number] | null {
  if (raw === undefined) return null;
  const parts = raw.split(",").map((p) => Number.parseFloat(p.trim()));
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return [parts[0]!, parts[1]!, parts[2]!];
}

export interface MtbTilesetResult {
  format: string;
  minzoom: number;
  maxzoom: number;
  /** The recorded build-time MTB_MINZOOM (mtb_minzoom metadata). */
  mtbMinzoom: number;
  layers: string[];
  zooms: number[];
  /** One hit per gate zoom (the minzoom and z14), guaranteed on success. */
  hits: MtbHit[];
  tilesScanned: number;
  /** The mtb-profile version that built the tileset (null for v1). */
  profileVersion: string | null;
  /** True when the tileset carries bike-park trails (mtb_imba field present). */
  hasBikePark: boolean;
}

/**
 * Verifies the dedicated MTB overlay tileset (step 11) before it is served:
 *
 *  1. metadata: pbf format, minzoom == expectedMinzoom (the build-time
 *     MTB_MINZOOM), maxzoom >= z14, and the `mtb_minzoom` metadata matches
 *     the expected minzoom (a stale artifact fails here, not at serve time);
 *  2. layers: the `mtb` layer is declared with the `mtb_scale` field;
 *  3. zoom coverage: tiles exist at every zoom minzoom..maxzoom and none
 *     below minzoom (the profile emits only z minzoom..14 features);
 *  4. content (the hard gate): at least one `mtb` feature carries a
 *     non-empty `mtb_scale` at BOTH the minzoom and z14 — trails must be
 *     visible at the low zoom that motivated this tileset and at street
 *     level.
 *
 * Fails with a VerifyError describing the first violated requirement.
 * Works with both the compact layout (tiles_shallow + tiles_data) and the
 * plain `tiles` table.
 */
export function verifyMtbMbtiles(
  file: string,
  expectedMinzoom: number,
  opts: VerifyOptions = {},
): MtbTilesetResult {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const meta = new Map<string, string>();
    const metaRows = db.prepare("SELECT name, value FROM metadata").all() as {
      name: string;
      value: string;
    }[];
    for (const row of metaRows) meta.set(row.name, row.value);

    const format = meta.get("format") ?? null;
    if (format !== "pbf" && format !== "mvt") {
      throw new VerifyError(`unexpected tile format "${format ?? "(missing)"}" (expected "pbf")`);
    }

    const minzoom = parseNum(meta.get("minzoom"));
    const maxzoom = parseNum(meta.get("maxzoom"));
    const mtbMinzoom = parseNum(meta.get(MTB_MINZOOM_META));
    if (minzoom === null || minzoom !== expectedMinzoom) {
      throw new VerifyError(
        `mtb tileset minzoom is ${minzoom ?? "(missing)"} but the current MTB_MINZOOM is ${expectedMinzoom} — stale artifact, rebuild with FORCE_REIMPORT=1`,
      );
    }
    if (maxzoom === null || maxzoom < REQUIRED_MAXZOOM) {
      throw new VerifyError(`mtb tileset maxzoom must be >= ${REQUIRED_MAXZOOM} (got ${maxzoom ?? "(missing)"})`);
    }
    if (mtbMinzoom !== expectedMinzoom) {
      throw new VerifyError(
        `mtb tileset ${MTB_MINZOOM_META} metadata is ${mtbMinzoom ?? "(missing)"} but MTB_MINZOOM is ${expectedMinzoom} — stale artifact, rebuild with FORCE_REIMPORT=1`,
      );
    }

    // 2. The overlay layer must be declared with its scale field.
    const layerIds = readVectorLayerIds(meta.get("json") ?? null);
    if (!layerIds.includes(MTB_OVERLAY_LAYER)) {
      throw new VerifyError(`mtb tileset is missing layer "${MTB_OVERLAY_LAYER}" (found: ${layerIds.join(", ")})`);
    }
    const fields = findVectorLayer(meta.get("json") ?? null, MTB_OVERLAY_LAYER);
    if (fields !== null && !Object.keys(fields).includes(MTB_OVERLAY_ATTR)) {
      throw new VerifyError(
        `mtb tileset layer "${MTB_OVERLAY_LAYER}" lacks the "${MTB_OVERLAY_ATTR}" field (fields: ${Object.keys(fields).join(", ")})`,
      );
    }

    // 3. Zoom coverage: every zoom minzoom..maxzoom present, none below.
    const bounds = parseBounds(meta.get("bounds"));
    const zoomTable = hasTable(db, "tiles_shallow") ? "tiles_shallow" : "tiles";
    const zoomRows = db
      .prepare(`SELECT DISTINCT zoom_level FROM ${zoomTable} ORDER BY zoom_level`)
      .all() as { zoom_level: number }[];
    const zooms = zoomRows.map((r) => r.zoom_level);
    if (zooms.length === 0) throw new VerifyError("mtb tileset contains no tiles");
    if (zooms[0]! < minzoom) {
      throw new VerifyError(`mtb tileset has tiles below its minzoom (first zoom ${zooms[0]!} < ${minzoom})`);
    }
    const missingZooms: number[] = [];
    for (let z = minzoom; z <= Math.max(REQUIRED_MAXZOOM, maxzoom); z++) {
      if (!zooms.includes(z)) missingZooms.push(z);
    }
    if (missingZooms.length > 0) {
      throw new VerifyError(`mtb tileset has no tiles at zoom levels: ${missingZooms.join(", ")}`);
    }

    // 4. Hard gate: a non-empty mtb_scale at the minzoom AND at z14.
    if (bounds === null) {
      throw new VerifyError("missing/invalid bounds metadata — cannot locate tiles for the mtb content scan");
    }
    const maxTiles = opts.maxTiles ?? DEFAULT_MAX_TILES;
    const scanned = { value: 0 };
    const fetchStmt = hasTable(db, "tiles_shallow")
      ? db.prepare(
          `SELECT d.tile_data
           FROM tiles_shallow s
           JOIN tiles_data d ON d.tile_data_id = s.tile_data_id
           WHERE s.zoom_level = ? AND s.tile_column = ? AND s.tile_row = ?`,
        )
      : db.prepare(
          "SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?",
        );
    const fetchTile = (z: number, x: number, yTms: number): Uint8Array | null => {
      const row = fetchStmt.get(z, x, yTms) as { tile_data: Uint8Array } | undefined;
      return row ? row.tile_data : null;
    };

    const gateZooms = Array.from(new Set([expectedMinzoom, REQUIRED_MAXZOOM])).sort((a, b) => a - b);
    const hits: MtbHit[] = [];
    for (const z of gateZooms) {
      const hit = scanTiles(z, bounds, fetchTile, scanned, makeOnCount(scanned, opts.onScan, z), maxTiles, MTB_OVERLAY_LAYER);
      if (hit === null) {
        throw new VerifyError(
          `no ${MTB_OVERLAY_LAYER} feature with a non-empty ${MTB_OVERLAY_ATTR} at z${z} (${scanned.value} tiles scanned so far) — the min-zoom MTB gate failed`,
        );
      }
      hits.push(hit);
    }

    return {
      format: format!,
      minzoom,
      maxzoom,
      mtbMinzoom,
      layers: layerIds,
      zooms,
      hits,
      tilesScanned: scanned.value,
      profileVersion: meta.get(MTB_PROFILE_VERSION_META) ?? null,
      hasBikePark: fields !== null && MTB_IMBA_ATTR in fields,
    };
  } finally {
    db.close();
  }
}

function hasTable(db: Database.Database, name: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  return row !== undefined;
}

function parseNum(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? null : n;
}

function parseBounds(raw: string | undefined): [number, number, number, number] | null {
  if (raw === undefined) return null;
  const parts = raw.split(",").map((p) => Number.parseFloat(p.trim()));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  return [parts[0]!, parts[1]!, parts[2]!, parts[3]!];
}

interface VectorLayer {
  id: string;
  fields: Record<string, string>;
}

function readVectorLayerIds(jsonRaw: string | null): string[] {
  const layers = parseVectorLayers(jsonRaw);
  return layers.map((l) => l.id);
}

function findVectorLayer(jsonRaw: string | null, id: string): Record<string, string> | null {
  const layers = parseVectorLayers(jsonRaw);
  const layer = layers.find((l) => l.id === id);
  return layer ? layer.fields : null;
}

function parseVectorLayers(jsonRaw: string | null): VectorLayer[] {
  if (jsonRaw === null) {
    throw new VerifyError('missing "json" metadata (vector_layers) — not a planetiler/OMT tileset?');
  }
  let parsed: { vector_layers?: VectorLayer[] };
  try {
    parsed = JSON.parse(jsonRaw) as { vector_layers?: VectorLayer[] };
  } catch (e) {
    throw new VerifyError(`cannot parse vector_layers JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(parsed.vector_layers) || parsed.vector_layers.length === 0) {
    throw new VerifyError("vector_layers metadata is empty");
  }
  return parsed.vector_layers;
}

type TileFetcher = (zoom: number, x: number, yTms: number) => Uint8Array | null;

/**
 * Scans tiles covering `bounds` at `zoom` (row-major) for a transportation
 * feature with a non-empty mtb_scale value, stopping at the first hit or at
 * `maxTiles`. Returns the hit or null.
 */
function scanTiles(
  zoom: number,
  bounds: [number, number, number, number],
  fetchTile: TileFetcher,
  scannedRef: { value: number },
  onCount: (delta: number) => void,
  maxTiles: number,
  layerName: string = MTB_LAYER,
): MtbHit | null {
  const size = 1 << zoom;
  const [west, south, east, north] = bounds;
  const x0 = clamp(lonToTile(west, zoom), 0, size - 1);
  const x1 = clamp(lonToTile(east, zoom), 0, size - 1);
  const y0 = clamp(latToTile(north, zoom), 0, size - 1);
  const y1 = clamp(latToTile(south, zoom), 0, size - 1);

  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      const raw = fetchTile(zoom, x, size - 1 - y);
      if (raw === null) continue;
      onCount(1);
      if (scannedRef.value > maxTiles) {
        throw new VerifyError(
          `mtb_scale scan hit the safety cap of ${maxTiles} tiles without a hit — increase VERIFY_MTB_MAX_TILES to scan further`,
        );
      }
      // Tiles are gzip-compressed; decompress before the key pre-filter and
      // the MVT decode.
      const data = decompressTile(raw);
      // Fast pre-filter: the MVT keys array contains "mtb_scale" in every tile
      // where any feature carries the attribute.
      const buf = Buffer.from(data);
      if (buf.indexOf(MTB_ATTR) === -1) continue;
      const hit = confirmMtbFeature(buf, zoom, x, y, layerName);
      if (hit !== null) return hit;
    }
  }
  return null;
}

function confirmMtbFeature(
  buf: Buffer,
  zoom: number,
  x: number,
  y: number,
  layerName: string = MTB_LAYER,
): MtbHit | null {
  try {
    const vt = new VectorTile(new PbfReader(new Uint8Array(buf)));
    const layer = vt.layers[layerName];
    if (layer === undefined) return null;
    for (let i = 0; i < layer.length; i++) {
      const feature = layer.feature(i);
      const props = feature.properties;
      const value = props[MTB_ATTR];
      if (value !== undefined && value !== "") {
        return { zoom, x, y, layer: layerName, properties: { ...props } };
      }
    }
  } catch (e) {
    log(`warning: failed to decode tile z${zoom}/${x}/${y}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return null;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function lonToTile(lon: number, zoom: number): number {
  return Math.floor(((lon + 180) / 360) * (1 << zoom));
}

function latToTile(lat: number, zoom: number): number {
  const rad = (lat * Math.PI) / 180;
  const y = (1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2;
  return Math.floor(y * (1 << zoom));
}
