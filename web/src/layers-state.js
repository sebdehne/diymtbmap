// Persistence + defaults for the single layers panel state (web only).
//
// The one panel (web/src/components/LayerPanel.jsx) drives five things, and
// this module persists all of them in ONE object so a visitor's choices
// survive a reload:
//   - terrain:      3D view on/off (default ON) + vertical exaggeration
//   - hillshade:    the native hillshade layer (default ON)
//   - contour:      the contour lines + elevation labels (default ON)
//   - <group id>:   each MTB trail group on/off (default ON), e.g. natural/bikepark
//   - opacity:      each trail group's line opacity (default MTB_LINE_OPACITY)
//
// The terrain / hillshade / contour rows only render when a `dem` source is
// served (no-DEM deployments never mount them), but their values are always
// persisted: a visitor who toggles them on a dem-capable browser keeps the
// choice if the same browser later sees a dem source.
//
// Back-compat: this module supersedes the three older state modules
// (diymtbmap.terrain.v1, diymtbmap.elevation.v1, diymtbmap.overlay.v1). The
// first read after the upgrade SYNTHESIZES the new state from the legacy
// values (a visitor's explicit choices are preserved), writes the new key,
// and removes the legacy keys. A visitor who explicitly turned 3D terrain
// OFF (the old default was OFF) stays OFF; everyone else gets the new
// default (ON). A visitor who turned the old combined "elevation" toggle OFF
// gets BOTH the hillshade and contour rows OFF (the closest equivalent);
// everyone else gets both ON.

import { DEFAULT_TERRAIN_EXAGGERATION } from "../../shared/terrain.js";
import { MTB_LINE_OPACITY, OVERLAY_GROUPS } from "../../shared/mtb-overlay.js";

const STORAGE_KEY = "diymtbmap.layers.v1";

const LEGACY_TERRAIN_KEY = "diymtbmap.terrain.v1";
const LEGACY_ELEVATION_KEY = "diymtbmap.elevation.v1";
const LEGACY_OVERLAY_KEY = "diymtbmap.overlay.v1";

function isBool(v) {
  return typeof v === "boolean";
}

function isOpacity(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1;
}

function isExaggeration(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/**
 * The default state: 3D view ON (1.5×), hillshade ON, contour lines ON, every
 * trail group ON at the default line opacity.
 */
export function defaultLayersState() {
  const state = {
    terrain: true,
    exaggeration: DEFAULT_TERRAIN_EXAGGERATION,
    hillshade: true,
    contour: true,
    opacity: {},
  };
  for (const g of OVERLAY_GROUPS) {
    state[g.id] = true;
    state.opacity[g.id] = MTB_LINE_OPACITY;
  }
  return state;
}

function storage() {
  const ls = globalThis.localStorage;
  if (!ls || typeof ls.getItem !== "function") return null;
  return ls;
}

function readJson(ls, key) {
  try {
    const raw = ls.getItem(key);
    if (raw === null || raw === undefined) return undefined;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    // Corrupt storage — treat as absent.
    return undefined;
  }
}

/**
 * Reads the persisted layers state, merging it over the defaults so a
 * missing/corrupt/partial value still yields a complete, valid state.
 *
 * First run after the merge from three panels: the new key is absent, so the
 * state is synthesized from the legacy keys (preserving every explicit
 * visitor choice), the new key is written, and the legacy keys are removed.
 */
export function readLayersState() {
  const state = defaultLayersState();
  const ls = storage();
  if (!ls) return state;

  const current = readJson(ls, STORAGE_KEY);
  if (current) {
    mergeState(state, current);
    return state;
  }

  // Migrate from the three legacy state modules (first read after upgrade).
  const overlay = readJson(ls, LEGACY_OVERLAY_KEY);
  if (overlay) {
    for (const g of OVERLAY_GROUPS) {
      if (isBool(overlay[g.id])) state[g.id] = overlay[g.id];
      if (isOpacity(overlay.opacity?.[g.id])) state.opacity[g.id] = overlay.opacity[g.id];
    }
  }
  const terrain = readJson(ls, LEGACY_TERRAIN_KEY);
  if (terrain) {
    if (isBool(terrain.on)) state.terrain = terrain.on;
    if (isExaggeration(terrain.exaggeration)) state.exaggeration = terrain.exaggeration;
  }
  // The old combined "elevation" toggle: OFF meant BOTH hillshade + contours
  // were hidden; ON (the old default) maps to both ON — the new default.
  const elevation = readJson(ls, LEGACY_ELEVATION_KEY);
  if (elevation && elevation.on === false) {
    state.hillshade = false;
    state.contour = false;
  }

  writeLayersState(state);
  for (const key of [LEGACY_TERRAIN_KEY, LEGACY_ELEVATION_KEY, LEGACY_OVERLAY_KEY]) {
    try {
      ls.removeItem(key);
    } catch {
      // Ignore — the new key is already written, the legacy values are spent.
    }
  }
  return state;
}

function mergeState(state, parsed) {
  if (isBool(parsed.terrain)) state.terrain = parsed.terrain;
  if (isExaggeration(parsed.exaggeration)) state.exaggeration = parsed.exaggeration;
  if (isBool(parsed.hillshade)) state.hillshade = parsed.hillshade;
  if (isBool(parsed.contour)) state.contour = parsed.contour;
  for (const g of OVERLAY_GROUPS) {
    if (isBool(parsed[g.id])) state[g.id] = parsed[g.id];
    if (isOpacity(parsed.opacity?.[g.id])) state.opacity[g.id] = parsed.opacity[g.id];
  }
}

/** Persists the layers state (best-effort; a full/private-mode quota is ignored). */
export function writeLayersState(state) {
  const ls = storage();
  if (!ls) return;
  try {
    ls.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore — persistence is a convenience, not a requirement.
  }
}
