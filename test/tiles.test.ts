import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { gzipSync } from "node:zlib";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test, after } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import express from "express";
import { feature, layer, pointGeometry, stringVal, tileBytes } from "./mvt.js";
import { parseTilePath, proxyTile, registerTileProxy } from "../src/tiles.js";

const TILE = tileBytes([
  layer("water", [feature([0, 0], pointGeometry(10, 10))], ["class"], [stringVal("ocean")]),
]);
// The fake upstream serves the tile the way Martin does: gzip + content-
// encoding (Node's fetch in the proxy decodes it — exactly the production
// shape).
const GZIP_TILE = gzipSync(Buffer.from(TILE));

/**
 * A fake "Martin" (loopback upstream): serves a fixed gzip MVT tile on
 * /openmaptiles/1/0/0 and /mtb/7/1/1, 404s elsewhere.
 */
function startFakeMartin(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.url === "/openmaptiles/1/0/0" || req.url === "/mtb/7/1/1") {
      res.setHeader("content-type", "application/x-protobuf");
      res.setHeader("content-encoding", "gzip");
      res.setHeader("etag", `"tile"`);
      res.end(GZIP_TILE);
    } else {
      res.statusCode = 404;
      res.setHeader("content-type", "text/plain");
      res.end("not found");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

/** An app wired exactly like src/server.ts: the proxy route reads the Martin URL per request. */
function startApp(getUrl: () => string | undefined): Promise<{ port: number; close: () => Promise<void> }> {
  const app = express();
  app.disable("x-powered-by");
  registerTileProxy(app, getUrl);
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo;
      resolve({
        port: addr.port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

const closers: Array<() => Promise<void>> = [];
after(async () => {
  for (const close of closers.splice(0)) await close();
});

test("parseTilePath: accepts a valid source id and integer coords", () => {
  assert.deepEqual(parseTilePath("openmaptiles", "7", "66", "37"), {
    source: "openmaptiles",
    z: "7",
    x: "66",
    y: "37",
  });
  assert.deepEqual(parseTilePath("mtb-7", "0", "0", "0"), { source: "mtb-7", z: "0", x: "0", y: "0" });
});

test("parseTilePath: rejects traversal and non-numeric coordinates", () => {
  assert.equal(parseTilePath("../etc", "1", "0", "0"), null);
  assert.equal(parseTilePath("..", "1", "0", "0"), null);
  assert.equal(parseTilePath("a/b", "1", "0", "0"), null);
  assert.equal(parseTilePath("openmaptiles", "-1", "0", "0"), null);
  assert.equal(parseTilePath("openmaptiles", "1.5", "0", "0"), null);
  assert.equal(parseTilePath("openmaptiles", "", "0", "0"), null);
  assert.equal(parseTilePath("openmaptiles", "1 0", "0", "0"), null);
  assert.equal(parseTilePath("openmaptiles", "1", "0", "x"), null);
});

test("proxy: streams the tile, passes through status + content-type", async () => {
  const martin = await startFakeMartin();
  const app = await startApp(() => martin.url);
  closers.push(martin.close, app.close);
  const res = await fetch(`http://127.0.0.1:${app.port}/tiles/openmaptiles/1/0/0`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/x-protobuf");
  assert.equal(res.headers.get("etag"), `"tile"`);
  // content-encoding must NOT pass through: Node's fetch decoded the gzip
  // body, so the client receives the raw MVT (a leftover header would make
  // the browser decode a second time and fail).
  assert.equal(res.headers.get("content-encoding"), null);
  const raw = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual(raw, TILE, "the body is byte-identical to the upstream tile");
});

test("proxy: both sources flow through the same route (mtb, step 11)", async () => {
  const martin = await startFakeMartin();
  const app = await startApp(() => martin.url);
  closers.push(martin.close, app.close);
  const res = await fetch(`http://127.0.0.1:${app.port}/tiles/mtb/7/1/1`);
  assert.equal(res.status, 200);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), TILE);
});

test("proxy: passes through upstream 404 (status + body)", async () => {
  const martin = await startFakeMartin();
  const app = await startApp(() => martin.url);
  closers.push(martin.close, app.close);
  const res = await fetch(`http://127.0.0.1:${app.port}/tiles/openmaptiles/5/5/5`);
  assert.equal(res.status, 404);
  assert.equal(await res.text(), "not found");
});

test("proxy: 503 until the MartinServer exists", async () => {
  const app = await startApp(() => undefined);
  closers.push(app.close);
  const res = await fetch(`http://127.0.0.1:${app.port}/tiles/openmaptiles/1/0/0`);
  assert.equal(res.status, 503);
  assert.match(await res.text(), /not ready/);
});

test("proxy: 400 on invalid path segments", async () => {
  const martin = await startFakeMartin();
  const app = await startApp(() => martin.url);
  closers.push(martin.close, app.close);
  for (const p of [
    "/tiles/..%2Fetc/1/0/0",
    "/tiles/openmaptiles/-1/0/0",
    "/tiles/openmaptiles/1.5/0/0",
    "/tiles/openmaptiles/x/0/0",
  ]) {
    const res = await fetch(`http://127.0.0.1:${app.port}${p}`);
    assert.equal(res.status, 400, `expected 400 for ${p}`);
  }
});

test("proxy: 502 when the upstream is unreachable", async () => {
  const app = await startApp(() => "http://127.0.0.1:1");
  closers.push(app.close);
  const res = await fetch(`http://127.0.0.1:${app.port}/tiles/openmaptiles/1/0/0`);
  assert.equal(res.status, 502);
  assert.match(await res.text(), /upstream/);
});

/**
 * A ServerResponse-shaped sink that drops the connection (destroys itself) as
 * soon as the first body byte arrives — simulating a client going away
 * mid-stream.
 */
class DisconnectingRes extends Writable {
  statusCode = 0;
  headers: Record<string, string> = {};
  headersSent = false;
  chunks: Buffer[] = [];
  writeHead(code: number, headers: Record<string, string>): this {
    this.statusCode = code;
    this.headers = headers;
    this.headersSent = true;
    return this;
  }
  _write(chunk: Buffer, _enc: string, cb: (e?: Error | null) => void): void {
    this.chunks.push(chunk);
    this.destroy(); // client disconnect
    cb();
  }
  _final(cb: (e?: Error | null) => void): void {
    cb();
  }
}

test("proxyTile: a client disconnect mid-body is contained (resolves, no throw)", async () => {
  const martin = await startFakeMartin();
  closers.push(martin.close);
  const req = new EventEmitter() as unknown as IncomingMessage;
  const res = new DisconnectingRes() as unknown as ServerResponse;
  await proxyTile(martin.url, { source: "openmaptiles", z: "1", x: "0", y: "0" }, req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "application/x-protobuf");
  assert.equal(res.chunks.length, 1, "the first chunk arrived before the disconnect");
  assert.equal(res.destroyed, true, "the half-sent response is dropped, not half-closed");
});
