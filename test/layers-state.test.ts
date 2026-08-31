import assert from "node:assert/strict";
import { test } from "node:test";
import {
  defaultLayersState,
  readLayersState,
  writeLayersState,
} from "../web/src/layers-state.js";

const NEW_KEY = "diymtbmap.layers.v1";
const LEGACY_TERRAIN = "diymtbmap.terrain.v1";
const LEGACY_ELEVATION = "diymtbmap.elevation.v1";
const LEGACY_OVERLAY = "diymtbmap.overlay.v1";

// A minimal in-memory localStorage (Node has no localStorage without a flag).
function installStorage(preset: Record<string, string> = {}) {
  const backing = new Map<string, string>(Object.entries(preset));
  const store = {
    getItem: (k: string) => (backing.has(k) ? backing.get(k) : null),
    setItem: (k: string, v: string) => {
      backing.set(k, String(v));
    },
    removeItem: (k: string) => {
      backing.delete(k);
    },
    _backing: backing,
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: store,
    configurable: true,
    writable: true,
  });
  return store;
}

function clearStorage() {
  Object.defineProperty(globalThis, "localStorage", {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

const json = (v: unknown) => JSON.stringify(v);

test("defaultLayersState: 3D view, hillshade + contours ON; trails ON at 50%", () => {
  const s = defaultLayersState();
  assert.equal(s.terrain, true, "3D view defaults ON (new default)");
  assert.equal(s.exaggeration, 1.5);
  assert.equal(s.hillshade, true);
  assert.equal(s.contour, true);
  assert.equal(s.natural, true);
  assert.equal(s.bikepark, true);
  assert.deepEqual(s.opacity, { natural: 0.5, bikepark: 0.5 });
});

test("readLayersState: no storage at all -> defaults, no throw", () => {
  clearStorage();
  assert.deepEqual(readLayersState(), defaultLayersState());
});

test("readLayersState: stored values merge over the defaults", () => {
  installStorage();
  writeLayersState({
    terrain: false,
    exaggeration: 2,
    hillshade: false,
    contour: true,
    natural: false,
    opacity: { natural: 0.2, bikepark: 0.9 },
  });
  const s = readLayersState();
  assert.equal(s.terrain, false);
  assert.equal(s.exaggeration, 2);
  assert.equal(s.hillshade, false);
  assert.equal(s.contour, true);
  assert.equal(s.natural, false);
  assert.equal(s.bikepark, true, "absent group keeps its default (ON)");
  assert.deepEqual(s.opacity, { natural: 0.2, bikepark: 0.9 });
});

test("readLayersState: invalid stored values fall back to defaults per field", () => {
  installStorage();
  writeLayersState({
    terrain: "yes",
    exaggeration: NaN,
    hillshade: 1,
    contour: null,
    natural: "on",
    opacity: { natural: 1.5, bikepark: 0 },
  });
  const s = readLayersState();
  assert.equal(s.terrain, true);
  assert.equal(s.exaggeration, 1.5);
  assert.equal(s.hillshade, true);
  assert.equal(s.contour, true);
  assert.equal(s.natural, true);
  assert.deepEqual(s.opacity, { natural: 0.5, bikepark: 0.5 });
});

test("readLayersState: corrupt stored JSON -> defaults, no throw", () => {
  installStorage({ [NEW_KEY]: "{not json" });
  assert.deepEqual(readLayersState(), defaultLayersState());
});

test("migration: legacy terrain OFF stays OFF; exaggeration preserved", () => {
  const store = installStorage({
    [LEGACY_TERRAIN]: json({ on: false, exaggeration: 2 }),
  });
  const s = readLayersState();
  assert.equal(s.terrain, false, "explicit legacy choice preserved");
  assert.equal(s.exaggeration, 2);
  assert.equal(s.hillshade, true, "no legacy elevation -> new default ON");
  assert.equal(s.contour, true);
  assert.equal(store._backing.has(NEW_KEY), true, "new key written");
  assert.equal(store._backing.has(LEGACY_TERRAIN), false, "legacy key removed");
});

test("migration: legacy terrain ABSENT gets the new default (ON)", () => {
  installStorage();
  const s = readLayersState();
  assert.equal(s.terrain, true, "first-time visitors now get 3D view ON");
});

test("migration: legacy elevation OFF -> BOTH hillshade and contours OFF", () => {
  const store = installStorage({ [LEGACY_ELEVATION]: json({ on: false }) });
  const s = readLayersState();
  assert.equal(s.hillshade, false);
  assert.equal(s.contour, false);
  assert.equal(s.terrain, true, "terrain default is independent of the old toggle");
  assert.equal(store._backing.has(LEGACY_ELEVATION), false);
});

test("migration: legacy elevation ON -> both ON (the new default)", () => {
  installStorage({ [LEGACY_ELEVATION]: json({ on: true }) });
  const s = readLayersState();
  assert.equal(s.hillshade, true);
  assert.equal(s.contour, true);
});

test("migration: legacy overlay choices + opacity preserved", () => {
  const store = installStorage({
    [LEGACY_OVERLAY]: json({ natural: false, opacity: { bikepark: 0.8 } }),
  });
  const s = readLayersState();
  assert.equal(s.natural, false);
  assert.equal(s.bikepark, true);
  assert.equal(s.opacity.natural, 0.5, "no legacy value -> default");
  assert.equal(s.opacity.bikepark, 0.8);
  assert.equal(store._backing.has(LEGACY_OVERLAY), false);
});

test("migration: all three legacy keys together compose one state", () => {
  const store = installStorage({
    [LEGACY_TERRAIN]: json({ on: false }),
    [LEGACY_ELEVATION]: json({ on: false }),
    [LEGACY_OVERLAY]: json({ bikepark: false, opacity: { natural: 0.3 } }),
  });
  const s = readLayersState();
  assert.equal(s.terrain, false);
  assert.equal(s.hillshade, false);
  assert.equal(s.contour, false);
  assert.equal(s.natural, true);
  assert.equal(s.bikepark, false);
  assert.equal(s.opacity.natural, 0.3);
  assert.equal(store._backing.has(NEW_KEY), true);
  assert.equal(store._backing.has(LEGACY_TERRAIN), false);
  assert.equal(store._backing.has(LEGACY_ELEVATION), false);
  assert.equal(store._backing.has(LEGACY_OVERLAY), false);
});

test("migration: a second read returns the stored new key (idempotent)", () => {
  const store = installStorage({ [LEGACY_TERRAIN]: json({ on: false }) });
  const first = readLayersState();
  assert.equal(first.terrain, false);
  const second = readLayersState();
  assert.deepEqual(second, first);
  assert.equal(second.terrain, false);
  // The new key now carries the state; the legacy one is spent.
  assert.equal(store._backing.has(NEW_KEY), true);
  assert.equal(store._backing.has(LEGACY_TERRAIN), false);
});
