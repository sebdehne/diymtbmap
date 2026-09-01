import assert from "node:assert/strict";
import http from "node:http";
import { test, before, after } from "node:test";
import {
  parseLatestDate,
  parseLatestDataset,
  isNewer,
  getLatestDatasetDate,
  getLatestDatasetUrl,
} from "../src/upstream.js";

// A representative Geofabrik listing: undated entries plus several dated
// extracts. The newest dated file is norway-260831.osm.pbf (2026-08-31).
const SAMPLE_HTML = `
<html><body>
  <a href="norway-latest.osm.pbf">Norway (latest)</a>
  <a href="norway-freeform.osm.pbf">freeform</a>
  <a href="norway-240101.osm.pbf">2024-01-01</a>
  <a href="norway-260829.osm.pbf">2026-08-29</a>
  <a href="norway-260831.osm.pbf">2026-08-31</a>
  <a href="norway-260830.osm.pbf">2026-08-30</a>
</body></html>
`;

interface TestServer {
  url: string;
  close: () => Promise<void>;
}

/** A tiny local server: serves SAMPLE_HTML, and 404s on /missing.html. */
function startServer(): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      if (req.url === "/missing.html") {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      if (req.url === "/nodate.html") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end('<a href="norway-latest.osm.pbf">latest</a>');
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(SAMPLE_HTML);
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

test("parseLatestDate: returns the newest dated file", () => {
  assert.equal(parseLatestDate(SAMPLE_HTML), "2026-08-31");
});

test("parseLatestDate: ignores undated entries (latest/freeform)", () => {
  const html =
    '<a href="norway-latest.osm.pbf">x</a><a href="norway-freeform.osm.pbf">y</a>';
  assert.equal(parseLatestDate(html), null);
});

test("parseLatestDate: no .osm.pbf files -> null", () => {
  assert.equal(parseLatestDate("<html><body>nothing here</body></html>"), null);
});

test("parseLatestDate: rejects invalid calendar dates", () => {
  const html =
    '<a href="norway-261332.osm.pbf">bad</a><a href="norway-260230.osm.pbf">feb 30</a>';
  assert.equal(parseLatestDate(html), null);
});

test("parseLatestDate: keeps valid dates among invalid ones", () => {
  const html =
    '<a href="norway-261332.osm.pbf">bad</a><a href="norway-260831.osm.pbf">good</a>';
  assert.equal(parseLatestDate(html), "2026-08-31");
});

test("isNewer: strictly newer -> true", () => {
  assert.equal(isNewer("2026-09-01", "2026-08-31"), true);
});

test("isNewer: equal -> false", () => {
  assert.equal(isNewer("2026-08-31", "2026-08-31"), false);
});

test("isNewer: older -> false", () => {
  assert.equal(isNewer("2026-08-30", "2026-08-31"), false);
});

test("isNewer: null latest -> false (cannot determine provider date)", () => {
  assert.equal(isNewer(null, "2026-08-31"), false);
});

test("isNewer: null current -> true (assume an update is available)", () => {
  assert.equal(isNewer("2026-08-31", null), true);
});

test("isNewer: both null -> false", () => {
  assert.equal(isNewer(null, null), false);
});

test("getLatestDatasetDate: parses the newest date from a served listing", async () => {
  assert.ok(server, "server not started");
  assert.equal(await getLatestDatasetDate(`${server.url}/listing.html`), "2026-08-31");
});

test("getLatestDatasetDate: throws on a non-2xx response", async () => {
  assert.ok(server, "server not started");
  await assert.rejects(
    () => getLatestDatasetDate(`${server.url}/missing.html`),
    /HTTP 404/,
  );
});

test("parseLatestDataset: returns the newest dated link resolved against the base URL", () => {
  const result = parseLatestDataset(SAMPLE_HTML, "https://provider.example/europe/norway.html");
  assert.deepEqual(result, {
    date: "2026-08-31",
    url: "https://provider.example/europe/norway-260831.osm.pbf",
  });
});

test("parseLatestDataset: ignores undated entries", () => {
  const html =
    '<a href="norway-latest.osm.pbf">x</a><a href="norway-freeform.osm.pbf">y</a>';
  assert.equal(parseLatestDataset(html, "https://provider.example/"), null);
});

test("parseLatestDataset: keeps an absolute href verbatim", () => {
  const html = '<a href="https://files.example.com/norway-260831.osm.pbf">x</a>';
  const result = parseLatestDataset(html, "https://provider.example/norway.html");
  assert.equal(result?.url, "https://files.example.com/norway-260831.osm.pbf");
});

test("getLatestDatasetUrl: resolves the newest dated link from a served listing", async () => {
  assert.ok(server, "server not started");
  assert.equal(
    await getLatestDatasetUrl(`${server.url}/listing.html`),
    `${server.url}/norway-260831.osm.pbf`,
  );
});

test("getLatestDatasetUrl: returns null when the listing has no dated file", async () => {
  assert.ok(server, "server not started");
  assert.equal(await getLatestDatasetUrl(`${server.url}/nodate.html`), null);
});
