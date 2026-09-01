import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { PbfReader } from "pbf";
import { VectorTile } from "@mapbox/vector-tile";
import type { Config } from "./config.js";
import { log } from "./log.js";
import {
  EXPECTED_SOURCE,
  expectedDemSource,
  expectedMtbSource,
} from "./martin.js";
import {
  OPTIONAL_LAYERS,
  REQUIRED_LAYERS,
  REQUIRED_MAXZOOM,
  readDeclaredFields,
  readDemSpec,
  readTilesetView,
  type DemSpec,
} from "./verify.js";

/**
 * Basemap style (step 7): serve the off-the-shelf OpenMapTiles "OSM
 * OpenMapTiles" style, pointing the tile source at the app's `/tiles` proxy
 * (request-host-aware) and making the relative `sprite`/`glyphs` URLs
 * absolute (MapLibre GL JS 6.x requires an absolute sprite URL — a relative
 * one throws "Invalid sprite URL ... must be absolute"), and verify the
 * style is compatible with the tileset the profile produced (source-layers
 * + referenced fields) before the map is handed to the browser. The
 * vendored style file is never mutated — the rewrites happen in-memory at
 * serve time.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StyleLayerDoc {
  id?: string;
  type?: string;
  source?: string;
  "source-layer"?: string;
  filter?: unknown;
  layout?: Record<string, unknown>;
  paint?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface StyleDoc {
  version?: number;
  name?: string;
  sources?: Record<string, Record<string, unknown>>;
  layers?: StyleLayerDoc[];
  [key: string]: unknown;
}

/** A bare Express/Node request, narrowed to the headers we read. */
export interface IncomingRequestLike {
  headers: { [key: string]: string | string[] | undefined };
}

export interface StyleAnalysis {
  /** Distinct `source` values referenced by layers. */
  sources: string[];
  /** Distinct `source-layer` values referenced by layers. */
  sourceLayers: string[];
  /** Fields the style references, grouped by the source-layer that uses them. */
  fieldsBySourceLayer: Map<string, Set<string>>;
  /** Union of every field referenced anywhere in the style. */
  allFields: Set<string>;
}

export interface StyleCheckResult {
  /** Style-referenced layers that are required OMT layers but absent from the tileset. */
  missingRequiredLayers: string[];
  /** Style-referenced optional OMT layers absent from the tileset (render empty). */
  missingOptionalLayers: string[];
  /** Style-referenced layers that are not a known OMT layer. */
  unknownLayers: string[];
  /** Human-readable warnings for fields the style uses but the tileset does not declare. */
  fieldWarnings: string[];
}

export interface SmokeResult {
  url: string;
  layers: string[];
  featureCount: number;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Reads and parses the style JSON. Pure (no caching); the file is static at runtime. */
export function loadStyle(file: string): StyleDoc {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    throw new Error(
      `cannot read style ${file}: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  }
  try {
    return JSON.parse(raw) as StyleDoc;
  } catch (e) {
    throw new Error(
      `cannot parse style ${file}: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  }
}

// ---------------------------------------------------------------------------
// Analysis (source-layers + referenced fields)
// ---------------------------------------------------------------------------

/**
 * Operators and which argument index (1-based) holds the input field/expression.
 * Only these positions can carry a shorthand field reference; the value slots
 * (literals such as "residential", "cemetery", colors) are deliberately not
 * collected, which keeps false positives low.
 */
type FieldArgSpec = number | "all" | "odd" | null;
const FIELD_ARG: Record<string, FieldArgSpec> = {
  "==": 1,
  "!=": 1,
  ">": 1,
  ">=": 1,
  "<": 1,
  "<=": 1,
  "!": 1,
  all: "all",
  any: "all",
  in: 1,
  match: 1,
  coalesce: "all",
  case: "odd",
  step: 1,
  interpolate: 2,
  "interpolate-linear": 2,
  "interpolate-exponential": 2,
  "interpolate-identity": 2,
  "to-number": 1,
  "to-string": 1,
  "to-boolean": 1,
  "to-rounded": 1,
  upcase: 1,
  downcase: 1,
  get: 1,
  has: 1,
  // Expressions whose first argument is not a data field.
  var: null,
  env: null,
  image: null,
  "heatmap-density": null,
  "line-metrics": null,
};

/** Special tokens that can appear in expression position but are not data fields. */
const NON_FIELD_TOKENS = new Set(["linear", "exponential", "identity", "zoom"]);

const NUMERIC_RE = /^-?\d+(\.\d+)?$/;

function argIndices(spec: FieldArgSpec, len: number): number[] {
  if (spec === null) return [];
  if (spec === "all") {
    const r: number[] = [];
    for (let i = 1; i < len; i++) r.push(i);
    return r;
  }
  if (spec === "odd") {
    const r: number[] = [];
    for (let i = 1; i < len; i += 2) r.push(i);
    return r;
  }
  if (spec >= 1 && spec < len) return [spec];
  return [];
}

/**
 * Walks a MapLibre expression tree and records the data-field names it
 * references. Handles both the explicit `["get","field"]` / `["has","field"]`
 * forms and the shorthand form where a bare string in an expression position
 * means `["get","field"]`. Value literals are not collected.
 */
function collectFields(node: unknown, out: Set<string>): void {
  if (!Array.isArray(node)) return;
  const op = node[0];
  if (typeof op !== "string" || node.length < 2) return;
  const spec = FIELD_ARG[op] ?? 1;
  for (const i of argIndices(spec, node.length)) {
    const arg = node[i];
    if (typeof arg === "string") {
      if (arg.startsWith("$")) continue; // $type, $id, ...
      if (NON_FIELD_TOKENS.has(arg)) continue;
      if (NUMERIC_RE.test(arg)) continue;
      out.add(arg);
    } else if (arg !== null && typeof arg === "object") {
      collectFields(arg, out);
    }
  }
}

/** Extracts the sources, source-layers, and referenced fields a style uses. */
export function analyzeStyle(style: StyleDoc): StyleAnalysis {
  const sources = new Set<string>();
  const sourceLayers = new Set<string>();
  const fieldsBySourceLayer = new Map<string, Set<string>>();
  const allFields = new Set<string>();
  for (const layer of style.layers ?? []) {
    if (layer.source) sources.add(layer.source);
    const sl = layer["source-layer"];
    if (sl === undefined) continue;
    sourceLayers.add(sl);
    const fields = new Set<string>();
    if (layer.filter !== undefined) collectFields(layer.filter, fields);
    if (layer.layout !== undefined) collectFields(layer.layout, fields);
    if (layer.paint !== undefined) collectFields(layer.paint, fields);
    const existing = fieldsBySourceLayer.get(sl);
    if (existing) {
      for (const f of fields) existing.add(f);
    } else {
      fieldsBySourceLayer.set(sl, fields);
    }
    for (const f of fields) allFields.add(f);
  }
  return {
    sources: [...sources].sort(),
    sourceLayers: [...sourceLayers].sort(),
    fieldsBySourceLayer,
    allFields,
  };
}

// ---------------------------------------------------------------------------
// Compatibility with the tileset
// ---------------------------------------------------------------------------

/**
 * Cross-checks what the style references against what the tileset declares.
 *
 *  - a style-referenced source-layer that is a REQUIRED OMT layer but missing
 *    from the tileset is a hard problem (the layer renders empty);
 *  - a missing OPTIONAL layer, or a non-OMT layer, is a soft warning;
 *  - a field the style uses but the tileset does not declare on that layer is
 *    a warning (profile-vs-schema difference, or an extract with no such
 *    features — both render the affected rules empty but do not break the map).
 */
export function checkStyleCompatibility(
  analysis: StyleAnalysis,
  tilesetLayers: readonly string[],
  declaredFields: ReadonlyMap<string, readonly string[]>,
): StyleCheckResult {
  const layerSet = new Set(tilesetLayers);
  const requiredSet = new Set<string>(REQUIRED_LAYERS);
  const optionalSet = new Set<string>(OPTIONAL_LAYERS);

  const missingRequiredLayers: string[] = [];
  const missingOptionalLayers: string[] = [];
  const unknownLayers: string[] = [];
  for (const sl of analysis.sourceLayers) {
    if (layerSet.has(sl)) continue;
    if (requiredSet.has(sl)) missingRequiredLayers.push(sl);
    else if (optionalSet.has(sl)) missingOptionalLayers.push(sl);
    else unknownLayers.push(sl);
  }

  const fieldWarnings: string[] = [];
  for (const sl of [...analysis.fieldsBySourceLayer.keys()].sort()) {
    if (!layerSet.has(sl)) continue; // missing layer already reported above
    const used = analysis.fieldsBySourceLayer.get(sl);
    if (used === undefined) continue;
    const declared = declaredFields.get(sl) ?? [];
    const declaredSet = new Set(declared);
    for (const f of [...used].sort()) {
      if (declaredSet.has(f)) continue;
      fieldWarnings.push(
        `style uses field "${f}" on source-layer "${sl}" but the tileset does not declare it there (declared: ${
          declared.length > 0 ? declared.join(", ") : "none"
        }) — the affected rules will render empty`,
      );
    }
  }

  return { missingRequiredLayers, missingOptionalLayers, unknownLayers, fieldWarnings };
}

// ---------------------------------------------------------------------------
// Serve-time rewrite (request-host-aware)
// ---------------------------------------------------------------------------

function firstString(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v[0];
  return v;
}

function requestProto(req: IncomingRequestLike): string {
  return firstString(req.headers["x-forwarded-proto"])?.split(",")[0]?.trim() || "http";
}

/**
 * The origin (`proto://host[:port]`) the browser used to reach us, derived
 * from the request (Host header + optional x-forwarded-proto). The request
 * port is KEPT — the sprite/glyphs must be reachable on the app's own port
 * (e.g. 8080), not a scheme default. Remote clients get URLs on the same
 * hostname; the client already brackets IPv6 hosts in the Host header.
 */
export function buildAppOrigin(req: IncomingRequestLike): string {
  const hostRaw = firstString(req.headers["host"]) ?? "localhost";
  return `${requestProto(req)}://${hostRaw}`;
}

/**
 * The source-spec fragment for a vector tile source in the served style.
 *
 * MapLibre GL JS 6.x treats a vector source's `url` as a **TileJSON
 * endpoint it fetches** (`load()` does `transformRequest(url, "Source")` and
 * merges the JSON document into the source — the response must be JSON with
 * `tiles` etc.). A bare tile base is NOT a TileJSON endpoint, so the step 12
 * (single-port) default path instead inlines a `tiles` template — MapLibre
 * consumes it directly, no fetch:
 *
 *   { tiles: ["<origin>/tiles/openmaptiles/{z}/{x}/{y}"] }
 *
 * A full `TILE_SOURCE_URL` override (reverse proxies, external tile servers)
 * is a TileJSON endpoint (e.g. Martin's `http://host:3399/openmaptiles`)
 * and is passed through verbatim as `url`.
 *
 * The inline form also sets `maxzoom` to the tileset's max zoom (z14,
 * REQUIRED_MAXZOOM). Without it MapLibre uses its default source maxzoom
 * (18) and starts requesting z15+ tiles — the tileset ends at z14 and the
 * server 404s them, so the map renders completely blank beyond z14. With
 * `maxzoom: 14`, MapLibre overzooms instead (stretches the z14 vectors
 * client-side) and never requests deeper tiles. (The TileJSON `url` form
 * needs no such cap — the TileJSON document carries its own `maxzoom`.)
 */
export interface TileSourceSpec {
  url?: string;
  tiles?: string[];
  /** Max zoom MapLibre requests tiles at (see the doc comment above). */
  maxzoom?: number;
}

/**
 * The source-spec fragment for the optional 3D-terrain (`raster-dem`) source.
 * Unlike the vector sources, a `raster-dem` source MUST carry the artifact's
 * `tileSize` (pixel size — a mismatch decodes garbage elevation) and `encoding`
 * (the RGB packing — a mismatch decodes the wrong values). Both are read from
 * the dem.mbtiles metadata so they always match the artifact. `minzoom`/
 * `maxzoom` bound the pyramid (the artifact only has tiles in that range).
 */
export interface DemSourceSpec {
  url?: string;
  tiles?: string[];
  minzoom: number;
  maxzoom: number;
  /** Pixel size of each dem tile (must equal the artifact's tileSize). */
  tileSize: number;
  /** MapLibre raster-dem encoding (must equal the artifact's packing). */
  encoding: "mapbox" | "terrarium";
}

/** The source-spec fragment for the basemap (request-host-aware). */
export function buildTileSourceSpec(req: IncomingRequestLike, cfg: Config): TileSourceSpec {
  if (cfg.tileSourceUrl) return { url: cfg.tileSourceUrl };
  return {
    tiles: [`${buildAppOrigin(req)}${cfg.basePath || ""}/tiles/${EXPECTED_SOURCE}/{z}/{x}/{y}`],
    maxzoom: REQUIRED_MAXZOOM,
  };
}

/**
 * The source-spec fragment for the MTB overlay source (step 11), through the
 * same app-side `/tiles` proxy as the basemap (step 12). With a
 * `TILE_SOURCE_URL` override the same base is used and only the trailing
 * source id is swapped.
 */
export function buildMtbSourceSpec(req: IncomingRequestLike, cfg: Config): TileSourceSpec {
  const id = expectedMtbSource(cfg.mtbMbtilesFile);
  if (cfg.tileSourceUrl) return { url: `${cfg.tileSourceUrl.replace(/\/[^/]+$/, "")}/${id}` };
  return {
    tiles: [`${buildAppOrigin(req)}${cfg.basePath || ""}/tiles/${id}/{z}/{x}/{y}`],
    maxzoom: REQUIRED_MAXZOOM,
  };
}

/**
 * The dem.mbtiles artifact is static at runtime (like the basemap/mtb
 * artifacts), so its spec is read from the file once and cached — /style.json
 * is requested once per map load, but we avoid a SQLite open per request.
 */
let demSpecCache: { file: string; spec: DemSpec } | undefined;
export function demSpecFor(file: string): DemSpec {
  if (demSpecCache && demSpecCache.file === file) return demSpecCache.spec;
  const spec = readDemSpec(file);
  demSpecCache = { file, spec };
  return spec;
}

/**
 * The source-spec fragment for the optional 3D-terrain source, always through
 * the app's `/tiles` proxy: the dem artifact is local (served by this Martin),
 * never an external TileJSON endpoint, so `TILE_SOURCE_URL` does not apply to
 * it. Carries the artifact's own `tileSize` / `encoding` / `minzoom` /
 * `maxzoom` (read from its metadata) so MapLibre decodes the elevation
 * correctly — a tileSize or encoding mismatch would silently mis-decode.
 */
export function buildDemSourceSpec(req: IncomingRequestLike, cfg: Config): DemSourceSpec {
  const id = expectedDemSource(cfg.demMbtilesFile);
  const spec = demSpecFor(cfg.demMbtilesFile);
  return {
    tiles: [`${buildAppOrigin(req)}${cfg.basePath || ""}/tiles/${id}/{z}/{x}/{y}`],
    minzoom: spec.minzoom,
    maxzoom: spec.maxzoom,
    tileSize: spec.tileSize,
    encoding: spec.encoding,
  };
}

function isAbsoluteUrl(u: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(u);
}

/**
 * Returns a copy of the style with `sources[EXPECTED_SOURCE]` pointed at the
 * tile server via `basemap` (a `tiles` template, or a TileJSON `url` override),
 * with the step-11 MTB overlay source (`mtb.id` -> `{type: "vector", ...spec}`)
 * added, and — when `appOrigin` is given — with the relative `sprite` and
 * `glyphs` URLs resolved against it (MapLibre GL JS 6.x requires an absolute
 * sprite URL; glyphs resolve against the origin in browsers, but absolute is
 * explicit and safe). Already-absolute values are left as-is. The vendored
 * source's own `url` (Martin's `mbtiles://...`) is always dropped — a
 * leftover `url` would make MapLibre fetch it as a TileJSON endpoint. Every
 * other part of the style (including the inert `attribution` source, which
 * carries the OMT/OSM credit) is left untouched, and the input object is not
 * mutated. The vendored style never declares the MTB source (it is
 * app-specific), so it is always injected. The optional `dem` (3D-terrain)
  * source is injected only when provided — when omitted the served style has no
  * `dem` source and the terrain toggle degrades away (a no-DEM deployment is
  * unaffected). Contour lines are NOT a separate source: they are computed
  * client-side from this same `dem` source by maplibre-contour (see
  * shared/elevation.js), so there is no `contours` vector source to inject.
  */
export function withTileSources(
  style: StyleDoc,
  basemap: TileSourceSpec,
  mtb: { id: string; spec: TileSourceSpec },
  appOrigin?: string,
  dem?: { id: string; spec: DemSourceSpec },
): StyleDoc {
  const sources = style.sources ?? {};
  const target = sources[EXPECTED_SOURCE];
  if (target === undefined) {
    throw new Error(
      `style has no "${EXPECTED_SOURCE}" source to point at the tile server (sources: ${
        Object.keys(sources).join(", ") || "none"
      })`,
    );
  }
  const base = { ...target };
  delete base.url;
  const out: StyleDoc = {
    ...style,
    sources: {
      ...sources,
      [EXPECTED_SOURCE]: { ...base, ...basemap },
      [mtb.id]: { type: "vector", ...mtb.spec },
      ...(dem ? { [dem.id]: { type: "raster-dem", ...dem.spec } } : {}),
    },
  };
  if (appOrigin !== undefined) {
    const origin = appOrigin.replace(/\/+$/, "");
    if (typeof style.sprite === "string" && !isAbsoluteUrl(style.sprite)) {
      // The origin may carry a BASE_PATH prefix (app mounted under e.g.
      // /mtb): the trailing "/" makes the sprite resolve INSIDE the base.
      out.sprite = new URL(style.sprite, `${origin}/`).toString();
    }
    if (typeof style.glyphs === "string" && !isAbsoluteUrl(style.glyphs)) {
      // String concat on purpose: the glyphs template carries
      // {fontstack}/{range} tokens that MapLibre substitutes AFTER style
      // load — new URL() would percent-encode the braces and break the
      // substitution (and a bare new URL() rejects the relative value).
      const g = style.glyphs.startsWith("/") ? style.glyphs : `/${style.glyphs}`;
      out.glyphs = `${origin}${g}`;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Render smoke test (tiles over HTTP)
// ---------------------------------------------------------------------------

function isGzip(data: Uint8Array): boolean {
  return data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b;
}

function maybeGunzip(data: Uint8Array): Uint8Array {
  return isGzip(data) ? new Uint8Array(gunzipSync(Buffer.from(data))) : data;
}

/** Slippy-map tile for a lon/lat at a zoom (clamped to the valid grid). */
function tileForLonLat(lon: number, lat: number, zoom: number): [number, number, number] {
  const n = 2 ** zoom;
  const x = Math.max(0, Math.min(n - 1, Math.floor(((lon + 180) / 360) * n)));
  const clamped = Math.max(-85.05, Math.min(85.05, lat));
  const latRad = (clamped * Math.PI) / 180;
  const y = Math.max(
    0,
    Math.min(n - 1, Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n)),
  );
  return [zoom, x, y];
}

/**
 * Candidate tiles for the smoke test, independent of the country: low-zoom
 * world tiles guarantee at least one decodable tile with features for ANY
 * extract, and (when the tileset records a center) a couple of mid-zoom tiles
 * around that center give a representative, feature-rich sample.
 */
function smokeCandidates(center: [number, number, number] | null): [number, number, number][] {
  const candidates: [number, number, number][] = [
    [1, 0, 0],
    [1, 1, 0],
    [1, 0, 1],
    [1, 1, 1],
    [2, 1, 1],
    [2, 2, 1],
    [2, 1, 2],
    [2, 2, 2],
    [3, 2, 2],
    [3, 3, 3],
  ];
  if (center !== null) {
    const [lon, lat, zoom] = center;
    const z = Math.max(3, Math.min(7, Math.round(zoom) || 5));
    candidates.push(tileForLonLat(lon, lat, z), tileForLonLat(lon, lat, Math.max(3, z - 1)));
  }
  return candidates;
}

/**
 * Proves the full serving chain end-to-end: fetches real tiles from the tile
 * server over HTTP and decodes them as MVT. Prefers the first tile with
 * features; falls back to any decodable tile; throws if none decode.
 */
export async function renderSmokeTest(
  tileBaseUrl: string,
  source: string,
  center: [number, number, number] | null = null,
): Promise<SmokeResult> {
  const candidates = smokeCandidates(center);
  let lastDecoded: SmokeResult | null = null;
  for (const [z, x, y] of candidates) {
    const url = `${tileBaseUrl}/${source}/${z}/${x}/${y}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
      if (!res.ok) continue;
      const raw = new Uint8Array(await res.arrayBuffer());
      const vt = new VectorTile(new PbfReader(maybeGunzip(raw)));
      const layers = Object.keys(vt.layers).sort();
      let featureCount = 0;
      for (const name of layers) featureCount += vt.layers[name]!.length;
      const result: SmokeResult = { url, layers, featureCount };
      if (featureCount > 0) return result;
      lastDecoded = result;
    } catch {
      // not this tile — try the next
    }
  }
  if (lastDecoded !== null) return lastDecoded;
  throw new Error(
    `render smoke test failed: no decodable ${source} tile among ${candidates.length} candidates — the tile server is not serving valid MVT`,
  );
}

// ---------------------------------------------------------------------------
// Startup verification
// ---------------------------------------------------------------------------

/**
 * Step 7 gate: the style must exist, reference only layers the tileset has
 * (required ones present), and the tile server must actually serve decodable
 * tiles. Runs at startup (fail-fast) after Martin is up.
 */
export async function verifyStyleServing(cfg: Config, martinUrl: string): Promise<void> {
  const styleFile = path.join(cfg.publicDir, "style.json");
  if (!existsSync(styleFile)) {
    throw new Error(
      `basemap style not found: ${styleFile} — run "npm run vendor-style" (container builds always include it)`,
    );
  }
  const style = loadStyle(styleFile);
  const analysis = analyzeStyle(style);
  const declaredFields = readDeclaredFields(cfg.mbtilesFile);
  const result = checkStyleCompatibility(analysis, [...declaredFields.keys()], declaredFields);

  if (result.missingRequiredLayers.length > 0) {
    throw new Error(
      `the basemap style references required tileset layer(s) that are missing: ${result.missingRequiredLayers.join(
        ", ",
      )} (tileset layers: ${[...declaredFields.keys()].sort().join(", ")})`,
    );
  }
  for (const l of result.missingOptionalLayers) {
    log(`warning: style references optional layer "${l}" which the tileset lacks — it renders empty`);
  }
  for (const l of result.unknownLayers) {
    log(`warning: style references non-OMT layer "${l}" — it renders empty`);
  }
  for (const w of result.fieldWarnings) log(`warning: ${w}`);

  const smokeCenter = readTilesetView(cfg.mbtilesFile).center;
  const smoke = await renderSmokeTest(martinUrl, EXPECTED_SOURCE, smokeCenter);
  log(
    `basemap style OK: ${analysis.sourceLayers.length} source-layers, ${analysis.allFields.size} ` +
      `fields referenced (${result.fieldWarnings.length} field warning(s)); smoke tile ${smoke.url} ` +
      `decoded over HTTP (${smoke.layers.length} layers, ${smoke.featureCount} features)`,
  );
}

// ---------------------------------------------------------------------------
// 3D-terrain (dem) serving check (tiles over HTTP)
// ---------------------------------------------------------------------------

export interface DemServeResult {
  source: string;
  tileSize: number;
  encoding: "mapbox" | "terrarium";
  /** The artifact's pyramid range (for the status / UI). */
  minzoom: number;
  maxzoom: number;
}

/** The 8-byte PNG file signature (`\x89PNG\r\n\x1a\n`). */
const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Optional 3D-terrain gate: the dem source must actually be SERVED — a real
 * PNG tile of the artifact's exact `tileSize`, fetched over HTTP from the tile
 * server (the artifact spec `readDemSpec` checks the file; this checks the
 * serving chain: Martin config, source id, routing, PNG output). Picks the
 * tile at the artifact-bounds center at a mid-pyramid zoom (the artifact has a
 * full pyramid over its bounds, so that tile is guaranteed present).
 */
export async function verifyDemServing(cfg: Config, martinUrl: string): Promise<DemServeResult> {
  const source = expectedDemSource(cfg.demMbtilesFile);
  const spec = demSpecFor(cfg.demMbtilesFile);
  const [west, south, east, north] = spec.bounds ?? [0, 0, 0, 0];
  const centerLon = (west + east) / 2;
  const centerLat = (south + north) / 2;
  const zoom = clamp(Math.round((spec.minzoom + spec.maxzoom) / 2), spec.minzoom, spec.maxzoom);
  const size = 1 << zoom;
  const x = clamp(lonToTile(centerLon, zoom), 0, size - 1);
  const y = clamp(latToTile(centerLat, zoom), 0, size - 1);

  const res = await fetch(`${martinUrl}/${source}/${zoom}/${x}/${y}`, {
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) {
    throw new Error(
      `dem tile ${source}/${zoom}/${x}/${y} returned HTTP ${res.status} — the tile server is not ` +
        `serving the 3D terrain source (check martin.yaml lists ${cfg.demMbtilesFile})`,
    );
  }
  const raw = new Uint8Array(await res.arrayBuffer());
  if (!startsWith(raw, PNG_SIGNATURE)) {
    throw new Error(
      `dem tile ${source}/${zoom}/${x}/${y} is not a PNG (first bytes: ${hexPrefix(raw)}) — ` +
        `wrong tile format or a broken proxy`,
    );
  }
  const ihdr = readIhdr(raw);
  if (ihdr === null) {
    throw new Error(`dem tile ${source}/${zoom}/${x}/${y} has no IHDR chunk — not a valid PNG`);
  }
  if (ihdr.width !== spec.tileSize || ihdr.height !== spec.tileSize) {
    throw new Error(
      `dem tile ${source}/${zoom}/${x}/${y} is ${ihdr.width}x${ihdr.height}px but the artifact is ` +
        `${spec.tileSize}px — the style's tileSize would mis-decode the elevation`,
    );
  }
  log(
    `dem serving OK: source "${source}" serves a ${spec.tileSize}px PNG over HTTP at ` +
      `z${zoom}/${x}/${y} (encoding=${spec.encoding})`,
  );
  return {
    source,
    tileSize: spec.tileSize,
    encoding: spec.encoding,
    minzoom: spec.minzoom,
    maxzoom: spec.maxzoom,
  };
}

function startsWith(buf: Uint8Array, sig: Uint8Array): boolean {
  if (buf.length < sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (buf[i] !== sig[i]) return false;
  return true;
}

function hexPrefix(buf: Uint8Array): string {
  const n = Math.min(8, buf.length);
  return Array.from(buf.subarray(0, n))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
}

/**
 * Parses the PNG IHDR chunk (it must be the FIRST chunk) -> width/height, or
 * null when absent. PNG: 8-byte signature, then per-chunk 4-byte length +
 * 4-byte type + payload + 4-byte CRC; IHDR's payload starts with the
 * big-endian uint32 width then height.
 */
function readIhdr(buf: Uint8Array): { width: number; height: number } | null {
  if (buf.length < 8 + 8 + 8) return null; // signature + chunk header + width+height
  const type = buf.subarray(12, 16);
  if (type[0] !== 0x49 || type[1] !== 0x48 || type[2] !== 0x44 || type[3] !== 0x52) {
    return null; // not "IHDR"
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
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
