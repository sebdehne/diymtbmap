import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { deflateSync } from "node:zlib";
import type { Express, Request } from "express";

/**
 * Step 12 (single-port serving): ALL browser traffic goes through the app's
 * single port. Martin is an internal, loopback-bound service — the browser
 * never reaches it directly. This module is the app's streaming tile proxy:
 * `GET /tiles/:source/:z/:x/:y` forwards to Martin's internal URL, passing
 * through the status + content headers and STREAMING the body (no full
 * buffering), so both the basemap (`openmaptiles`) and the step-11 overlay
 * (`mtb`) sources flow through the same route.
 */

const SOURCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const NUM_RE = /^\d+$/;

/** Upstream (loopback) timeout for the header phase and body read. */
const UPSTREAM_TIMEOUT_MS = 10_000;

export interface TilePath {
  source: string;
  z: string;
  x: string;
  y: string;
}

/**
 * Validates a `/tiles/:source/:z/:x/:y` path. The source id is a Martin
 * source id (derived from an MBTiles file name — alphanumerics, dot, dash);
 * z/x/y are bare non-negative integers. Anything else (path traversal,
 * encoded slashes, non-numeric coords) is rejected.
 */
export function parseTilePath(source: string, z: string, x: string, y: string): TilePath | null {
  if (!SOURCE_ID_RE.test(source)) return null;
  if (!NUM_RE.test(z) || !NUM_RE.test(x) || !NUM_RE.test(y)) return null;
  return { source, z, x, y };
}

function sendText(res: ServerResponse, statusCode: number, body: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.statusCode = statusCode;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(body);
}

/** The dem source's decode parameters, used to build a matching null tile. */
export interface DemNullTile {
  encoding: "mapbox" | "terrarium";
  tileSize: number;
}
/** Map of dem source id -> decode params (only the dem source is registered). */
export type DemSources = Record<string, DemNullTile>;

/**
 * Martin answers a MISSING tile with `204 No Content` (an empty body). Browsers
 * treat 204 as success (response.ok === true), so a dem client that calls
 * createImageBitmap on that empty blob throws `InvalidStateError: The image
 * could not be decoded` (Firefox surfaces this as a map-load error; Safari's
 * path happens to skip it). The standard dem-server remedy is to serve a valid
 * "no data" tile instead of an empty one — a flat elevation-0 tile in the
 * source's own encoding. Generated once per (tileSize, encoding) and cached.
 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE: number[] = (() => {
  const t: number[] = new Array(256).fill(0);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i] ?? 0;
    const entry = CRC_TABLE[(c ^ byte) & 0xff] ?? 0;
    c = entry ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(new Uint8Array(body)));
  return Buffer.concat([len, body, crc]);
}
const nullTileCache = new Map<string, Buffer>();
export function makeNullDemTilePng(tileSize: number, encoding: "mapbox" | "terrarium"): Buffer {
  const key = `${tileSize}:${encoding}`;
  const cached = nullTileCache.get(key);
  if (cached) return cached;
  // Elevation 0, packed per the source's encoding (mapbox: RGB 1,134,160;
  // terrarium: RGB 128,0,0) so the client decodes a flat "no data" surface.
  const [r, g, b] = encoding === "terrarium" ? [128, 0, 0] : [1, 134, 160];
  const row = Buffer.alloc(1 + tileSize * 3);
  row[0] = 0; // PNG filter type: none
  for (let x = 0; x < tileSize; x++) {
    row[1 + x * 3] = r;
    row[2 + x * 3] = g;
    row[3 + x * 3] = b;
  }
  const raw = Buffer.concat(new Array(tileSize).fill(row));
  const idat = deflateSync(raw, { level: 9 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(tileSize, 0);
  ihdr.writeUInt32BE(tileSize, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor (RGB)
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const png = Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  nullTileCache.set(key, png);
  return png;
}

/**
 * Fetches one tile from Martin and streams it to the client:
 *  - status + content-type pass through; `content-encoding`/`content-length`
 *    do NOT — Node's fetch (undici) transparently decodes a `gzip` body, so
 *    the streamed bytes are the raw MVT and passing the header on would make
 *    the browser decode a second time (broken tile);
 *  - the body is piped, never fully buffered;
 *  - the client disconnecting aborts the upstream read;
 *  - an unreachable/failed upstream becomes a 502 (before any header is sent)
 *    or a dropped response (mid-body).
 */
export async function proxyTile(
  martinUrl: string,
  tile: TilePath,
  req: IncomingMessage,
  res: ServerResponse,
  demSources: DemSources = {},
): Promise<void> {
  const upstreamUrl =
    `${martinUrl.replace(/\/+$/, "")}/${tile.source}/${tile.z}/${tile.x}/${tile.y}`;
  const controller = new AbortController();
  const onClose = () => controller.abort();
  req.once("close", onClose);
  try {
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(upstreamUrl, {
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]),
      });
    } catch (e) {
      if (controller.signal.aborted) return; // the client went away — nothing to send
      sendText(
        res,
        502,
        `tile upstream error: ${e instanceof Error ? e.message : String(e)} (upstream: ${upstreamUrl})`,
      );
      return;
    }
    // A MISSING dem tile: Martin answers 204 (empty body). Browsers treat 204
    // as success, so a dem client decodes the empty body and throws — instead,
    // serve a valid flat "no data" tile (elevation 0, in the source's encoding)
    // so native hillshade + maplibre-contour both decode it. Only dem sources
    // are affected; vector sources (basemap/mtb) keep their 204 pass-through.
    const dem = demSources[tile.source];
    if (dem !== undefined && (upstream.status === 204 || upstream.status === 404 || upstream.status === 410)) {
      const png = makeNullDemTilePng(dem.tileSize, dem.encoding);
      res.writeHead(200, {
        "content-type": "image/png",
        "content-length": String(png.length),
        "cache-control": "public, max-age=31536000, immutable",
      });
      res.end(png);
      return;
    }
    // content-type + etag describe the (decoded) tile and are safe to pass on.
    // content-encoding / content-length describe the wire form our fetch has
    // already decoded away, so they are dropped (see the function doc).
    const headers: Record<string, string> = {};
    for (const name of ["content-type", "etag"]) {
      const value = upstream.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    res.writeHead(upstream.status, headers);
    if (upstream.body === null) {
      res.end();
      return;
    }
    try {
      await pipeline(Readable.fromWeb(upstream.body as ReadableStream), res);
    } catch {
      // Client went away mid-stream, or Martin died after the headers: the
      // response can only be dropped (it is already partially sent).
      res.destroy();
    }
  } finally {
    req.off("close", onClose);
  }
}

/**
 * Registers the proxy route on the app. `getMartinUrl` is read PER REQUEST
 * (the pipeline creates the MartinServer after startup; until then the
 * route answers 503). Must be registered before the static handler — the
 * 4-segment path cannot collide with the 2-segment `/:fontstack/:range`
 * route.
 */
export function registerTileProxy(
  app: Express,
  getMartinUrl: () => string | undefined,
  demSources: DemSources = {},
): void {
  app.get("/tiles/:source/:z/:x/:y", (req, res) => {
    void handleTile(req, res, getMartinUrl(), demSources).catch((e: unknown) => {
      if (!res.headersSent) {
        sendText(res, 500, `tile proxy error: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
  });
}

async function handleTile(
  req: Request,
  res: ServerResponse,
  martinUrl: string | undefined,
  demSources: DemSources = {},
): Promise<void> {
  const tile = parseTilePath(
    req.params.source ?? "",
    req.params.z ?? "",
    req.params.x ?? "",
    req.params.y ?? "",
  );
  if (tile === null) {
    sendText(res, 400, "invalid tile path — expected /tiles/<source>/<z>/<x>/<y>");
    return;
  }
  if (martinUrl === undefined) {
    sendText(res, 503, "tile server not ready yet — the pipeline is still running");
    return;
  }
  await proxyTile(martinUrl, tile, req, res, demSources);
}
