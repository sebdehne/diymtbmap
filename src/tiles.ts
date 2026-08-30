import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
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
export function registerTileProxy(app: Express, getMartinUrl: () => string | undefined): void {
  app.get("/tiles/:source/:z/:x/:y", (req, res) => {
    void handleTile(req, res, getMartinUrl()).catch((e: unknown) => {
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
  await proxyTile(martinUrl, tile, req, res);
}
