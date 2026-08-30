import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { messageFor, StageTracker, withOomHint } from "../src/build.js";

const REAL_LOG = "/tmp/planetiler-0.9.3/planet-logs/v0.5.0-planet-c6gd-32gb.txt";

test("messageFor: stage line", () => {
  const m = messageFor("0:05:58 INF [osm_pass2] -  nodes: [ 175M   2%  17M/s ] 78G   ways: [    0   0%    0/s ]");
  assert.ok(m !== null && m.startsWith("osm_pass2: "), m);
  assert.ok(m.includes("17M/s"));
});

test("messageFor: stage summary line", () => {
  assert.equal(
    messageFor("2:37:51 INF - \tlake_centerlines 2s cpu:6s avg:2.6"),
    "lake_centerlines done (2s)",
  );
});

test("messageFor: blank line -> null", () => {
  assert.equal(messageFor("   "), null);
});

test("messageFor: truncates over-long lines", () => {
  const m = messageFor("0:00:00 INF [x] - " + "a".repeat(500));
  assert.ok(m !== null && m.endsWith("...") && m.length <= 300);
});

test("messageFor: continuation lines (cpus:/read(…) -> null", () => {
  assert.equal(messageFor("cpus: 6.4 gc: 2% heap: 1.3G/4.2G direct: 54M"), null);
  assert.equal(messageFor("read( 0%) ->   (11/18) -> process(83% 84% 86%) -> write( 2%)"), null);
});

test("tracker: stage percentage maps onto overall progress", () => {
  const t = new StageTracker();
  t.feed("0:00:01 INF [water_polygons] -  read: [  550   4%   54/s ]");
  // base(download 5 + lake_centerlines 3) + 4% of water_polygons (7) = 8.28 -> 8
  assert.equal(t.overall(), 8);
});

test("tracker: stage summary marks the stage complete", () => {
  const t = new StageTracker();
  t.feed("0:00:01 INF [water_polygons] -  read: [  550   4%   54/s ]");
  t.feed("0:00:02 INF - \twater_polygons 1s cpu:2s avg:2");
  // base 8 + 100% of 7 = 15
  assert.equal(t.overall(), 15);
});

test("tracker: monotonic even if percentages regress", () => {
  const t = new StageTracker();
  t.feed("0:00:01 INF [mbtiles] - 50%");
  const a = t.overall();
  t.feed("0:00:02 INF [mbtiles] - 10%");
  assert.ok(t.overall() >= a, `${t.overall()} < ${a}`);
});

test("tracker: capped at 99", () => {
  const t = new StageTracker();
  t.feed("0:00:01 INF [mbtiles] - 100%");
  t.feed("0:00:02 INF - \tmbtiles 1s cpu:2s avg:2");
  assert.equal(t.overall(), 99);
});

test("withOomHint: adds a heap hint on OutOfMemoryError", () => {
  const msg = "planetiler exited code=1 signal=null — last output:\nCaused by: java.lang.OutOfMemoryError: Java heap space";
  const out = withOomHint(msg, 768);
  assert.ok(out.includes("Increase PLANETILER_HEAP_MB to at least 4096"), out);
});

test("withOomHint: leaves other errors untouched", () => {
  const msg = "planetiler exited code=1 signal=null — last output:\njava.io.FileNotFound: x";
  assert.equal(withOomHint(msg, 768), msg);
});

test("tracker: real planet log stays monotonic in [0, 99]", { skip: !existsSync(REAL_LOG) }, () => {
  const text = readFileSync(REAL_LOG, "utf8");
  const t = new StageTracker();
  let last = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    t.feed(line);
    const p = t.overall();
    assert.ok(p >= 0 && p <= 99, `progress out of range: ${p}`);
    assert.ok(p >= last, `progress went backwards: ${p} < ${last}`);
    last = p;
  }
  assert.ok(last >= 50, `expected substantial progress from a full planet log, got ${last}`);
});
