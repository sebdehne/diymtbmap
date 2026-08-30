import { useEffect, useRef, useState } from "react";
import { Map, NavigationControl } from "maplibre-gl";
import { MTB_MINZOOM, MTB_SOURCE, NORWAY_BOUNDS, mtbOverlayLayers } from "../../shared/mtb-overlay.js";
import { makeInfoControl } from "./components/InfoControl.jsx";

export default function MapView({ status }) {
  const containerRef = useRef(null);
  const [zoom, setZoom] = useState(null);
  const [banner, setBanner] = useState({ kind: "loading", text: "Loading basemap…" });

  // The MTB overlay's source id and display minzoom follow the build
  // (MTB_MBTILES_FILE / MTB_MINZOOM), reported in the status snapshot so the
  // display floor always equals the tileset's data floor.
  const mtb = status?.martin?.mtb;
  const overlaySource = mtb?.source ?? MTB_SOURCE;
  const overlayMinzoom = mtb?.minzoom ?? MTB_MINZOOM;

  useEffect(() => {
    const m = new Map({
      container: containerRef.current,
      style: "style.json",
      bounds: NORWAY_BOUNDS,
      fitBoundsOptions: { padding: 24, maxZoom: 6.5 },
      attributionControl: false,
      // The tileset data ends at z14, but MapLibre overzooms: beyond z14 it
      // stretches the z14 vector tiles client-side and never requests deeper
      // tiles, so zooming to the default max stays fully rendered.
      maxZoom: 22,
    });
    // Debug hook (console / CDP): inspect map state, force zooms, read tiles.
    window.__map = m;

    m.on("move", () => setZoom(m.getZoom()));
    setZoom(m.getZoom());

    m.addControl(new NavigationControl(), "top-right");
    m.addControl(makeInfoControl(), "bottom-right");

    m.on("load", () => {
      // Overlay last → above every basemap layer.
      for (const layer of mtbOverlayLayers(overlaySource, overlayMinzoom)) m.addLayer(layer);
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
  }, [overlaySource, overlayMinzoom]);

  return (
    <>
      <div ref={containerRef} id="map" />
      {banner && <div className={"mapstatus" + (banner.kind === "fail" ? " fail" : "")}>{banner.text}</div>}
      {zoom !== null && <div className="zoomchip">z {zoom.toFixed(1)}</div>}
    </>
  );
}
