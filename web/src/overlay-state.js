// Persistence + defaults for the MTB overlay state (web only).
//
// The state is a plain object keyed by the OVERLAY_GROUPS id
// ({ natural: bool, bikepark: bool, ... }) PLUS an `opacity` sub-object
// ({ opacity: { natural: number, bikepark: number, ... } }), stored in
// localStorage so a visitor's choice of which trail groups to show — and how
// strongly each renders — survives a reload. Both groups default to ON at
// half opacity (MTB_LINE_OPACITY), so first-time visitors see the trails the
// way they always have.
//
// Back-compat: the persisted value may predate the `opacity` key (it was
// visibility-only). readOverlayState merges over the defaults, so an old
// value simply lacks `opacity` and falls back to the default 0.5 per group.

import { MTB_LINE_OPACITY, OVERLAY_GROUPS } from "../../shared/mtb-overlay.js";

const STORAGE_KEY = "diymtbmap.overlay.v1";

/** Every group ON at the default line opacity (the fallback state). */
export function defaultOverlayState() {
  const state = { opacity: {} };
  for (const g of OVERLAY_GROUPS) {
    state[g.id] = true;
    state.opacity[g.id] = MTB_LINE_OPACITY;
  }
  return state;
}

/**
 * Reads the persisted overlay state, merging it over the defaults so a
 * missing/corrupt/partial value (or a group added later) still yields a
 * complete, valid state. Returns the default state when nothing is stored.
 * Opacity values are only accepted when they are a finite number in (0, 1].
 */
export function readOverlayState() {
  const state = defaultOverlayState();
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        for (const g of OVERLAY_GROUPS) {
          if (typeof parsed[g.id] === "boolean") state[g.id] = parsed[g.id];
          const op = parsed.opacity?.[g.id];
          if (typeof op === "number" && Number.isFinite(op) && op > 0 && op <= 1) {
            state.opacity[g.id] = op;
          }
        }
      }
    }
  } catch {
    // Corrupt storage — fall back to the defaults.
  }
  return state;
}

/** Persists the overlay state (best-effort; a full/private-mode quota is ignored). */
export function writeOverlayState(state) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore — persistence is a convenience, not a requirement.
  }
}
