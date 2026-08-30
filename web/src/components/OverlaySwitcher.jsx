import { useEffect, useState } from "react";
import {
  OVERLAY_GROUPS,
  applyOverlayVisibility,
  applyOverlayOpacity,
} from "../../../shared/mtb-overlay.js";
import { readOverlayState, writeOverlayState } from "../overlay-state.js";

// The choose-overlays panel: one checkbox + one opacity slider per
// OVERLAY_GROUP (natural / bike-park), so the two trail sets can be turned on
// and off independently AND faded in/out independently. Collapsed to a round
// layers icon by default (hosted as a MapLibre control right under the
// fullscreen button, see OverlayControl); one click opens the panel — the same
// pattern as the info panel with the legends. The choice is persisted to
// localStorage and applied to the map by flipping each group's layers
// visible/none and setting each group's line-opacity. Both groups default to
// ON at half opacity, so first-time visitors see the trails (MapView also
// applies the same state when the map loads).
export default function OverlaySwitcher({ map }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState(() => readOverlayState());

  useEffect(() => {
    writeOverlayState(state);
    if (map) {
      applyOverlayVisibility(map, state);
      applyOverlayOpacity(map, state);
    }
  }, [state, map]);

  const toggle = (id) =>
    setState((s) => ({ ...s, [id]: !(s[id] !== false) }));

  const setOpacity = (id, value) =>
    setState((s) => ({ ...s, opacity: { ...s.opacity, [id]: value } }));

  return (
    <div className={"mtb-overlay" + (open ? " open" : "")}>
      <button
        type="button"
        className="mtb-overlay-toggle"
        aria-expanded={open}
        aria-label={open ? "Hide map overlays" : "Show map overlays"}
        onClick={() => setOpen(!open)}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polygon points="12 2 2 7 12 12 22 7 12 2" />
          <polyline points="2 12 12 17 22 12" />
          <polyline points="2 17 12 22 22 17" />
        </svg>
      </button>
      {open && (
        <div className="mtb-overlay-body">
          <div className="mtb-overlay-title">MTB trails</div>
          {OVERLAY_GROUPS.map((g) => {
            const opacity = state.opacity?.[g.id] ?? 0.5;
            const off = state[g.id] === false;
            return (
              <div className="overlay-group" key={g.id}>
                <label className="overlay-row">
                  <input
                    type="checkbox"
                    checked={state[g.id] !== false}
                    onChange={() => toggle(g.id)}
                  />
                  <span className="overlay-label">{g.label}</span>
                </label>
                <div className={"overlay-opacity" + (off ? " off" : "")}>
                  <input
                    type="range"
                    className="overlay-opacity-slider"
                    min="1"
                    max="100"
                    step="1"
                    value={Math.round(opacity * 100)}
                    disabled={off}
                    aria-label={`Opacity for ${g.label}`}
                    onChange={(e) => setOpacity(g.id, Number(e.target.value) / 100)}
                  />
                  <span className="overlay-opacity-value">
                    {Math.round(opacity * 100)}%
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
