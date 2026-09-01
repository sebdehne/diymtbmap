import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, before, after } from "node:test";
import type { Config } from "../src/config.js";
import { ensureOsExtract } from "../src/pipeline.js";

const base = mkdtempSync(join(tmpdir(), "extract-"));
after(() => rmSync(base, { recursive: true, force: true }));

const LISTING_HTML = `<html><body>
  <a href="norway-latest.osm.pbf">latest</a>
  <a href="norway-260831.osm.pbf">2026-08-31</a>
</body></html>`;

interface TestServer {
  url: string;
  /** How many times the PBF download endpoint was hit (a proxy for "a download ran"). */
  pbfRequests: number;
  close: () => Promise<void>;
}

/**
 * Serves a dated listing and a tiny PBF. Counts PBF fetches so a test can assert
 * exactly how many times `ensureOsExtract` downloaded.
 */
function startServer(): Promise<TestServer> {
  const counter = { count: 0 };
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/listing.html") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(LISTING_HTML);
        return;
      }
      if (req.url === "/norway-260831.osm.pbf") {
        counter.count++;
        res.writeHead(200, { "content-type": "application/octet-stream" });
        res.end("osm!");
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        reject(new Error("server has no port"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        get pbfRequests() {
          return counter.count;
        },
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

let server: TestServer | null = null;
before(async () => {
  server = await startServer();
});
after(async () => {
  if (server) await server.close();
});

function makeCfg(dir: string): Config {
  return {
    osmListingUrl: `${server!.url}/listing.html`,
    osmFile: join(dir, "seed.osm.pbf"),
    osmDownloadFile: join(dir, "download.osm.pbf"),
  } as Config;
}

const noop = () => {};

test("force mode reuses an existing download file (no re-download)", async () => {
  assert.ok(server);
  const dir = mkdtempSync(join(base, "force-reuse-"));
  const cfg = makeCfg(dir);
  writeFileSync(cfg.osmDownloadFile, "already-downloaded");
  const before = server.pbfRequests;
  const result = await ensureOsExtract(cfg, noop, true);
  assert.equal(result.osmFile, cfg.osmDownloadFile);
  assert.equal(server.pbfRequests, before, "must not re-download when the file already exists");
});

test("two forced build steps download exactly once (the double-download regression)", async () => {
  assert.ok(server);
  const dir = mkdtempSync(join(base, "force-once-"));
  const cfg = makeCfg(dir);
  const before = server.pbfRequests;
  // buildTilesets calls ensureOsExtract once for the basemap and again for the
  // MTB overlay — with a forced re-import. Only ONE of those may download.
  const basemap = await ensureOsExtract(cfg, noop, true);
  const mtb = await ensureOsExtract(cfg, noop, true);
  assert.equal(basemap.osmFile, cfg.osmDownloadFile);
  assert.equal(mtb.osmFile, cfg.osmDownloadFile);
  assert.equal(
    server.pbfRequests,
    before + 1,
    "the MTB step must reuse the basemap step's download, not fetch it again",
  );
  assert.ok(existsSync(cfg.osmDownloadFile));
});

test("normal mode prefers the seed when no download exists", async () => {
  assert.ok(server);
  const dir = mkdtempSync(join(base, "normal-seed-"));
  const cfg = makeCfg(dir);
  writeFileSync(cfg.osmFile, "seed");
  const before = server.pbfRequests;
  const result = await ensureOsExtract(cfg, noop, false);
  assert.equal(result.osmFile, cfg.osmFile);
  assert.equal(server.pbfRequests, before, "must not download when using the seed");
});

test("normal mode prefers a present download over the seed", async () => {
  assert.ok(server);
  const dir = mkdtempSync(join(base, "normal-download-win-"));
  const cfg = makeCfg(dir);
  writeFileSync(cfg.osmFile, "seed");
  writeFileSync(cfg.osmDownloadFile, "download");
  const before = server.pbfRequests;
  const result = await ensureOsExtract(cfg, noop, false);
  assert.equal(result.osmFile, cfg.osmDownloadFile);
  assert.equal(server.pbfRequests, before);
});

test("force mode downloads fresh even when a seed exists", async () => {
  assert.ok(server);
  const dir = mkdtempSync(join(base, "force-seed-"));
  const cfg = makeCfg(dir);
  writeFileSync(cfg.osmFile, "old-seed");
  const before = server.pbfRequests;
  const result = await ensureOsExtract(cfg, noop, true);
  assert.equal(result.osmFile, cfg.osmDownloadFile, "force mode must ignore the seed and download");
  assert.equal(server.pbfRequests, before + 1, "force mode with only a seed must download");
  assert.ok(existsSync(cfg.osmDownloadFile));
});

test("normal mode downloads when neither seed nor download exist", async () => {
  assert.ok(server);
  const dir = mkdtempSync(join(base, "normal-download-"));
  const cfg = makeCfg(dir);
  const before = server.pbfRequests;
  const result = await ensureOsExtract(cfg, noop, false);
  assert.equal(result.osmFile, cfg.osmDownloadFile);
  assert.equal(server.pbfRequests, before + 1);
  assert.ok(existsSync(cfg.osmDownloadFile));
});
