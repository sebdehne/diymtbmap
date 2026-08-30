import { useEffect, useRef, useState } from "react";
import { Map, NavigationControl, ScaleControl, GeolocateControl, FullscreenControl } from "maplibre-gl";
import {
  MTB_MINZOOM,
  MTB_SOURCE,
  DEFAULT_BOUNDS,
  applyOverlayVisibility,
  applyOverlayOpacity,
  bikeParkOverlayLayers,
  mtbOverlayLayers,
} from "../../shared/mtb-overlay.js";
import { makeInfoControl } from "./components/InfoControl.jsx";
import { makeOverlayControl } from "./components/OverlayControl.jsx";
import { readOverlayState } from "./overlay-state.js";

export default function MapView({ status }) {
  const containerRef = useRef(null);
  const [banner, setBanner] = useState({ kind: "loading", text: "Loading basemap…" });

  // The MTB overlay's source id and display minzoom follow the build
  // (MTB_MBTILES_FILE / MTB_MINZOOM), reported in the status snapshot so the
  // display floor always equals the tileset's data floor.
  const mtb = status?.martin?.mtb;
  const overlaySource = mtb?.source ?? MTB_SOURCE;
  const overlayMinzoom = mtb?.minzoom ?? MTB_MINZOOM;

  // Initial view (workstream D): prefer the auto-detected center/bounds the
  // pipeline read from the tileset (so any country's extract opens on
  // itself); fall back to the default (mainland Norway) extent.
  const statusCenter = status?.center;
  const statusBounds = status?.bounds;
  const initial =
    statusCenter && Array.isArray(statusCenter) && statusCenter.length === 3
      ? { center: [statusCenter[0], statusCenter[1]], zoom: statusCenter[2] }
      : {
          bounds:
            statusBounds && Array.isArray(statusBounds) && statusBounds.length === 4
              ? [
                  [statusBounds[0], statusBounds[1]],
                  [statusBounds[2], statusBounds[3]],
                ]
              : DEFAULT_BOUNDS,
          fitBoundsOptions: { padding: 24, maxZoom: 6.5 },
        };

  useEffect(() => {
    const m = new Map({
      container: containerRef.current,
      style: "style.json",
      attributionControl: false,
      // The tileset data ends at z14, but MapLibre overzooms: beyond z14 it
      // stretches the z14 vector tiles client-side and never requests deeper
      // tiles, so zooming to the default max stays fully rendered.
      maxZoom: 22,
      ...initial,
    });
    // Debug hook (console / CDP): inspect map state, force zooms, read tiles.
    window.__map = m;

    // Workstream B: the map controls.
    m.addControl(new NavigationControl(), "top-right");
    m.addControl(new GeolocateControl({ positionOptions: { enableHighAccuracy: true } }), "top-right");
    m.addControl(new FullscreenControl(), "top-right");
    // The overlay switcher sits right under the fullscreen button: collapsed
    // to a round layers icon, one click opens the choose-overlays panel.
    m.addControl(makeOverlayControl(m), "top-right");
    m.addControl(new ScaleControl({ maxWidth: 120, unit: "metric" }), "bottom-left");
    // The info panel now carries the status (data date, country, legends).
    m.addControl(makeInfoControl(status), "bottom-right");

    m.on("load", () => {
      // Overlay last → above every basemap layer. Both trail groups are added
      // so the natural/bike-park toggles have layers to show and hide.
      for (const layer of mtbOverlayLayers(overlaySource, overlayMinzoom)) m.addLayer(layer);
      for (const layer of bikeParkOverlayLayers(overlaySource, overlayMinzoom)) m.addLayer(layer);
      // Restore the visitor's last choice (defaults: both groups ON at half
      // opacity). The layers only exist after `load`, so this is where the
      // persisted visibility + opacity actually take effect.
      const state = readOverlayState();
      applyOverlayVisibility(m, state);
      applyOverlayOpacity(m, state);
      setBanner(null);
    });

    m.on("error", (ev) => {
      // Tile errors after load are normal-ish; a failed style load is not.
      if (!m.isStyleLoaded()) {
        setBanner({
          kind: "fail",
          text: "map failed to load: " + (ev.error?.message ?? "unknown error") + " — see server logs",
        });
      }
    });

    return () => {
      window.__map = undefined;
      m.remove();
    };
    // The map is rebuilt only if the overlay source/minzoom change; the
    // status-driven initial view and info-panel status are fixed for the
    // session (both are settled before the map mounts, on state === "ready").
  }, [overlaySource, overlayMinzoom]);

  return (
    <>
      <div ref={containerRef} id="map" />
      {banner && <div className={"mapstatus" + (banner.kind === "fail" ? " fail" : "")}>{banner.text}</div>}
    </>
  );
}
