import { createRoot } from "react-dom/client";
import OverlaySwitcher from "./OverlaySwitcher.jsx";

// MapLibre custom control hosting the React overlay switcher (the natural /
// bike-park trail toggles). Collapsed to a round layers icon by default; one
// click opens the choose-overlays panel — the same pattern as the info panel
// with the legends. MapView adds it to the top-right stack right after the
// fullscreen control, so the icon sits directly under it.
export function makeOverlayControl(map) {
  let root = null;
  let container = null;
  return {
    onAdd: () => {
      container = document.createElement("div");
      container.className = "maplibregl-ctrl";
      root = createRoot(container);
      root.render(<OverlaySwitcher map={map} />);
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
