import { createRoot } from "react-dom/client";
import LayerPanel from "./LayerPanel.jsx";

// MapLibre custom control hosting the React layers panel (MTB trail toggles +
// opacity sliders, and — when a dem source is served — the 3D-view / hillshade
// / contour-lines toggles). Collapsed to a round layers icon by default; one
// click opens the panel — the same pattern as the info panel with the
// legends. MapView adds it to the top-right stack right after the fullscreen
// control, so the icon sits directly under it. It is always mounted (the
// trails section is always relevant); the elevation section inside renders
// only when `hasDem`.
export function makeLayerControl(map, { hasDem, dem }) {
  let root = null;
  let container = null;
  return {
    onAdd: () => {
      container = document.createElement("div");
      container.className = "maplibregl-ctrl";
      root = createRoot(container);
      root.render(<LayerPanel map={map} hasDem={hasDem} dem={dem ?? null} />);
      return container;
    },
    // MapLibre calls onRemove(map) — the arg is the Map, not a DOM node.
    // Remove our own container (per the IControl contract); never call
    // .remove() on the passed Map, which would re-enter Map.remove().
    onRemove: () => {
      container?.remove();
      container = null;
      // Defer the React unmount out of the parent tree's commit phase; calling
      // root.unmount() synchronously here triggers React's "unmount a root
      // while rendering" race warning under StrictMode's double-invoke.
      const r = root;
      root = null;
      if (r) setTimeout(() => r.unmount(), 0);
    },
  };
}
