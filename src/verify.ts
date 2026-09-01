import Database from "better-sqlite3";
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

export interface VerifyResult {
  name: string | null;
  format: string | null;
  minzoom: number | null;
  maxzoom: number | null;
  bounds: [number, number, number, number] | null;
  layers: string[];
  zooms: number[];
}

export class VerifyError extends Error {}

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
 * Verifies the Planetiler/OMT tileset artifact before it is served:
 *
 *  1. metadata: pbf format, z0–z14 coverage, all 16 OMT layers declared
 *     (via the `json`/`vector_layers` metadata);
 *  2. tiles: every zoom 0…max(14, maxzoom) has tiles.
 *
 * Fails with a VerifyError describing the first violated requirement.
 *
 * Works with both the compact layout planetiler writes by default
 * (tiles_shallow + tiles_data) and the plain `tiles` table.
 */
export function verifyMbtiles(file: string): VerifyResult {
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
    // trails. An absent field is a warning, not a failure.
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

    return {
      name: meta.get("name") ?? null,
      format,
      minzoom,
      maxzoom,
      bounds,
      layers: layerIds,
      zooms,
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
 * The mtb-profile version that built the tileset (`mtb_profile_version`
 * metadata), or null when the file has no such metadata (e.g. a v1 tileset).
 * Cheap metadata-only read; the pipeline compares it to MTB_PROFILE_VERSION
 * to warn (not fail) when a rebuild would add bike-park trails.
 */
export function readMtbProfileVersion(file: string): string | null {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const row = db
      .prepare(`SELECT value FROM metadata WHERE name = ?`)
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

/** MapLibre `raster-dem` encoding the dem.mbtiles artifact was packed with. */
export type DemEncoding = "mapbox" | "terrarium";

/**
 * The dem.mbtiles artifact spec the served style must declare to match it:
 * the tile pixel size, the raster-dem packing, the zoom range, and (for
 * locating a tile to verify) the bounds. Written by tools/dem-to-raster-tiles-converter/build-dem.py.
 */
export interface DemSpec {
  bounds: [number, number, number, number] | null;
  minzoom: number;
  maxzoom: number;
  /** Pixel size of each dem tile — the style source's `tileSize` must equal it. */
  tileSize: number;
  /** The raster-dem packing — the style source's `encoding` must equal it. */
  encoding: DemEncoding;
}

/**
 * Reads the dem.mbtiles artifact's serving spec (bounds, minzoom, maxzoom,
 * tileSize, encoding) from its MBTiles metadata. Any field the metadata lacks
 * falls back to the documented artifact contract (mapbox, 512 px, z6–z11), so
 * a slightly older artifact still serves. Cheap metadata-only read.
 */
export function readDemSpec(file: string): DemSpec {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return {
      bounds: parseBounds(readMetaValue(db, "bounds")),
      minzoom: readMetaInt(db, "minzoom", 6),
      maxzoom: readMetaInt(db, "maxzoom", 11),
      tileSize: readMetaInt(db, "tileSize", 512),
      encoding: (readMetaValue(db, "encoding") ?? "mapbox") as DemEncoding,
    };
  } finally {
    db.close();
  }
}

function readMetaInt(db: Database.Database, name: string, fallback: number): number {
  const raw = readMetaValue(db, name);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? fallback : n;
}

export interface MtbTilesetResult {
  format: string;
  minzoom: number;
  maxzoom: number;
  /** The recorded build-time MTB_MINZOOM (mtb_minzoom metadata). */
  mtbMinzoom: number;
  layers: string[];
  zooms: number[];
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
 *     below minzoom (the profile emits only z minzoom..14 features).
 *
 * Fails with a VerifyError describing the first violated requirement.
 * Works with both the compact layout (tiles_shallow + tiles_data) and the
 * plain `tiles` table.
 */
export function verifyMtbMbtiles(
  file: string,
  expectedMinzoom: number,
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

    return {
      format: format!,
      minzoom,
      maxzoom,
      mtbMinzoom,
      layers: layerIds,
      zooms,
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
