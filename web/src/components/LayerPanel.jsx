import { useEffect, useState } from "react";
import {
  OVERLAY_GROUPS,
  applyOverlayVisibility,
  applyOverlayOpacity,
} from "../../../shared/mtb-overlay.js";
import {
  applyHillshadeVisibility,
  applyContourVisibility,
} from "../../../shared/elevation.js";
import { DEM_SOURCE, applyTerrain } from "../../../shared/terrain.js";
import { readLayersState, writeLayersState } from "../layers-state.js";

// The single layers panel: one round layers icon (collapsed) that expands into
// a panel with ALL the map-layer toggles —
//   MTB trails:   one checkbox + opacity slider per trail group (natural /
//                 bike-park),
//   Elevation:    3D view (default ON), hillshade (default ON) and contour
//                 lines (default ON) — this section renders only when a `dem`
//                 source is served (hasDem); a no-DEM deployment shows the
//                 panel with just the trails section.
// Collapsed to a round layers icon by default (hosted as a MapLibre control
// right under the fullscreen button, see LayerControl); one click opens the
// panel — the same pattern as the info panel with the legends.
//
// Every toggle + slider writes through the ONE persisted state object
// (layers-state.js), so the panel is the single source of truth for all of it
// — applied to the map here (on change) and by MapView on load.
export default function LayerPanel({ map, dem, hasDem }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState(() => readLayersState());
  const source = dem?.source ?? DEM_SOURCE;

  useEffect(() => {
    writeLayersState(state);
    if (map) {
      applyOverlayVisibility(map, state);
      applyOverlayOpacity(map, state);
      if (hasDem) {
        // applyTerrain is a safe no-op before the style document has loaded
        // (it swallows MapLibre's "Style is not done loading." error), so this
        // first effect call before `load` is harmless; MapView re-applies the
        // state on `load` for real.
        applyTerrain(map, state.terrain, state.exaggeration, source);
        applyHillshadeVisibility(map, state.hillshade);
        applyContourVisibility(map, state.contour);
      }
    }
  }, [state, map, hasDem, source]);

  // A row is ON unless its flag is explicitly false (a missing flag means
  // "default ON"), the same semantics as the MTB group toggles.
  const isOn = (value) => value !== false;
  const flip = (key) => setState((s) => ({ ...s, [key]: !isOn(s[key]) }));
  const setOpacity = (id, value) =>
    setState((s) => ({ ...s, opacity: { ...s.opacity, [id]: value } }));

  return (
    <div className={"layer-panel" + (open ? " open" : "")}>
      <button
        type="button"
        className="layer-panel-toggle"
        aria-expanded={open}
        aria-label={open ? "Hide map layers" : "Show map layers"}
        title={open ? "Hide map layers" : "Show map layers"}
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
        <div className="layer-panel-body">
          <div className="layer-panel-title">MTB trails</div>
          {OVERLAY_GROUPS.map((g) => {
            const opacity = state.opacity?.[g.id] ?? 0.5;
            const off = !isOn(state[g.id]);
            return (
              <div className="layer-group" key={g.id}>
                <label className="layer-row">
                  <input
                    type="checkbox"
                    checked={isOn(state[g.id])}
                    onChange={() => flip(g.id)}
                  />
                  <span className="layer-label">{g.label}</span>
                </label>
                <div className={"layer-opacity" + (off ? " off" : "")}>
                  <input
                    type="range"
                    className="layer-opacity-slider"
                    min="1"
                    max="100"
                    step="1"
                    value={Math.round(opacity * 100)}
                    disabled={off}
                    aria-label={`Opacity for ${g.label}`}
                    onChange={(e) => setOpacity(g.id, Number(e.target.value) / 100)}
                  />
                  <span className="layer-opacity-value">
                    {Math.round(opacity * 100)}%
                  </span>
                </div>
              </div>
            );
          })}
          {hasDem && (
            <>
              <hr className="layer-panel-divider" />
              <div className="layer-panel-title">Elevation</div>
              <label className="layer-row">
                <input
                  type="checkbox"
                  checked={isOn(state.terrain)}
                  onChange={() => flip("terrain")}
                />
                <span className="layer-label">3D view</span>
              </label>
              <label className="layer-row">
                <input
                  type="checkbox"
                  checked={isOn(state.hillshade)}
                  onChange={() => flip("hillshade")}
                />
                <span className="layer-label">Hillshade</span>
              </label>
              <label className="layer-row">
                <input
                  type="checkbox"
                  checked={isOn(state.contour)}
                  onChange={() => flip("contour")}
                />
                <span className="layer-label">Contour lines</span>
              </label>
            </>
          )}
        </div>
      )}
    </div>
  );
}
