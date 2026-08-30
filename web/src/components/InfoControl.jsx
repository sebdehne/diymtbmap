import { createRoot } from "react-dom/client";
import InfoPanel from "./InfoPanel.jsx";

// MapLibre custom control hosting the React info panel (MTB difficulty
// legend + data sources). Collapsed to a round "i" icon by default.
export function makeInfoControl() {
  let root = null;
  return {
    onAdd: () => {
      const el = document.createElement("div");
      el.className = "maplibregl-ctrl";
      root = createRoot(el);
      root.render(<InfoPanel/>);
      return el;
    },
    onRemove: el => {
      root?.unmount();
      root = null;
      el.remove();
    },
  };
}
