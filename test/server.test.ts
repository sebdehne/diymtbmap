import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, after } from "node:test";
import express from "express";
import http from "node:http";
import { createReimportRouter, ReimportApi } from "../src/reimport-api.js";
import { reconcileReimportOnBoot } from "../src/reimport.js";
import { readLastReimport, writeLastReimport } from "../src/reimport-state.js";

const base = mkdtempSync(join(tmpdir(), "server-"));
after(() => rmSync(base, { recursive: true, force: true }));

function localToday(): string {
  const d = new Date();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

function startRouter(api: ReimportApi): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(createReimportRouter(api));
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr === null || typeof addr === "string") throw new Error("no address");
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

test("GET /api/reimport returns the re-import state", async () => {
  const api: ReimportApi = {
    martinReady: () => true,
    trigger: async () => {
      throw new Error("not called");
    },
    state: () => ({ state: "idle" }),
  };
  const server = await startRouter(api);
  try {
    const res = await fetch(`${server.url}/api/reimport`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { state: "idle" });
  } finally {
    await server.close();
  }
});

test("POST /api/reimport: started -> 202", async () => {
  const api: ReimportApi = {
    martinReady: () => true,
    trigger: async () => ({ decision: { kind: "started", latestDate: "2026-02-02" } }),
    state: () => ({ state: "idle" }),
  };
  const server = await startRouter(api);
  try {
    const res = await fetch(`${server.url}/api/reimport`, { method: "POST" });
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), { started: true, latestDate: "2026-02-02" });
  } finally {
    await server.close();
  }
});

test("POST /api/reimport: already-running -> 409", async () => {
  const api: ReimportApi = {
    martinReady: () => true,
    trigger: async () => ({ decision: { kind: "rejected", error: "already-running" } }),
    state: () => ({ state: "idle" }),
  };
  const server = await startRouter(api);
  try {
    const res = await fetch(`${server.url}/api/reimport`, { method: "POST" });
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: "already-running" });
  } finally {
    await server.close();
  }
});

test("POST /api/reimport: already-attempted-today -> 409", async () => {
  const api: ReimportApi = {
    martinReady: () => true,
    trigger: async () => ({ decision: { kind: "rejected", error: "already-attempted-today" } }),
    state: () => ({ state: "idle" }),
  };
  const server = await startRouter(api);
  try {
    const res = await fetch(`${server.url}/api/reimport`, { method: "POST" });
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: "already-attempted-today" });
  } finally {
    await server.close();
  }
});

test("POST /api/reimport: no-newer-dataset -> 409", async () => {
  const api: ReimportApi = {
    martinReady: () => true,
    trigger: async () => ({ decision: { kind: "rejected", error: "no-newer-dataset" } }),
    state: () => ({ state: "idle" }),
  };
  const server = await startRouter(api);
  try {
    const res = await fetch(`${server.url}/api/reimport`, { method: "POST" });
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { error: "no-newer-dataset" });
  } finally {
    await server.close();
  }
});

test("POST /api/reimport: upstream-error -> 502", async () => {
  const api: ReimportApi = {
    martinReady: () => true,
    trigger: async () => ({ decision: { kind: "upstream-error" } }),
    state: () => ({ state: "idle" }),
  };
  const server = await startRouter(api);
  try {
    const res = await fetch(`${server.url}/api/reimport`, { method: "POST" });
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: "cannot-determine-latest" });
  } finally {
    await server.close();
  }
});

test("POST /api/reimport: martin not ready -> 503", async () => {
  const api: ReimportApi = {
    martinReady: () => false,
    trigger: async () => {
      throw new Error("not called");
    },
    state: () => ({ state: "idle" }),
  };
  const server = await startRouter(api);
  try {
    const res = await fetch(`${server.url}/api/reimport`, { method: "POST" });
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "tile-server-not-ready" });
  } finally {
    await server.close();
  }
});

test("POST /api/reimport: trigger throws -> 500", async () => {
  const api: ReimportApi = {
    martinReady: () => true,
    trigger: async () => {
      throw new Error("boom");
    },
    state: () => ({ state: "idle" }),
  };
  const server = await startRouter(api);
  try {
    const res = await fetch(`${server.url}/api/reimport`, { method: "POST" });
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /boom/);
  } finally {
    await server.close();
  }
});

test("reconcileReimportOnBoot: crashed running record -> error + staging removed", () => {
  const dir = mkdtempSync(join(base, "boot-"));
  const stateFile = join(dir, "last-reimport.json");
  writeLastReimport(stateFile, {
    date: localToday(),
    latestDate: "2026-02-02",
    result: "running",
    dataDate: "2026-01-01",
  });
  writeFileSync(join(dir, "openmaptiles.staging.mbtiles"), "staging");
  writeFileSync(join(dir, "openmaptiles.mbtiles"), "live");

  reconcileReimportOnBoot(dir, stateFile);

  const rec = readLastReimport(stateFile);
  assert.equal(rec?.result, "error");
  assert.match(rec?.message ?? "", /interrupted/);
  assert.equal(existsSync(join(dir, "openmaptiles.staging.mbtiles")), false);
  assert.equal(existsSync(join(dir, "openmaptiles.mbtiles")), true);
});

test("reconcileReimportOnBoot: old running record is left untouched", () => {
  const dir = mkdtempSync(join(base, "boot-old-"));
  const stateFile = join(dir, "last-reimport.json");
  writeLastReimport(stateFile, {
    date: "2000-01-01",
    latestDate: null,
    result: "running",
    dataDate: "2000-01-01",
  });

  reconcileReimportOnBoot(dir, stateFile);

  const rec = readLastReimport(stateFile);
  assert.equal(rec?.result, "running");
});
