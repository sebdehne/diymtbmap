import { useEffect, useRef, useState } from "react";
import { Map, NavigationControl, ScaleControl, GeolocateControl, FullscreenControl, Marker, addProtocol } from "maplibre-gl";
// maplibre-contour's default export (the mlcontour namespace with DemSource).
// It is a browser-only bundler entry (Vite resolves the `module` condition), so
// it is imported here in the web bundle — never from the Node test suite.
import mlcontour from "maplibre-contour";
import {
  CONTOUR_SOURCE_ID,
  contourProtocolOptions,
  hillshadeLayerSpec,
  contourLineSpec,
  contourLabelSpec,
  applyHillshadeVisibility,
  applyContourVisibility,
} from "../../shared/elevation.js";
import {
  MTB_MINZOOM,
  MTB_SOURCE,
  DEFAULT_BOUNDS,
  applyOverlayVisibility,
  applyOverlayOpacity,
  bikeParkOverlayLayers,
  mtbOverlayLayers,
  firstSymbolLayerId,
} from "../../shared/mtb-overlay.js";
import { makeInfoControl } from "./components/InfoControl.jsx";
import { makeLayerControl } from "./components/LayerControl.jsx";
import { readLayersState } from "./layers-state.js";
import { DEM_SOURCE, applyTerrain } from "../../shared/terrain.js";
import { parseViewHash, formatViewHash } from "../../shared/view-state.js";

// A failed style load (style.json / base tiles) is fatal. But a failure to
// decode an optional dem raster tile — the native raster-dem hillshade, or the
// maplibre-contour worker's createImageBitmap — only means the elevation layers
// are missing; the basemap and MTB overlays still render. Some browsers (e.g.
// Firefox) reject dem tiles that others decode, so we must not report the whole
// map as failed in that case. Match the browser-thrown image-decode errors.
function isImageDecodeError(ev) {
  const err = ev?.error ?? ev;
  const name = String(err?.name ?? "");
  const msg = String(err?.message ?? "");
  if (name === "InvalidStateError" || name === "EncodingError" || name === "ImageDecodeError") return true;
  return /could not be decoded|image could not|createimagebitmap|failed to decode/i.test(msg);
}

export default function MapView({ status }) {
  const containerRef = useRef(null);
  const [banner, setBanner] = useState({ kind: "loading", text: "Loading basemap…" });

  // The MTB overlay's source id and display minzoom follow the build
  // (MTB_MBTILES_FILE / MTB_MINZOOM), reported in the status snapshot so the
  // display floor always equals the tileset's data floor.
  const mtb = status?.martin?.mtb;
  const overlaySource = mtb?.source ?? MTB_SOURCE;
  const overlayMinzoom = mtb?.minzoom ?? MTB_MINZOOM;

  // The optional 3D-terrain source (step: 3D terrain): present only when a
  // dem.mbtiles was served. Its source id follows DEM_MBTILES_FILE (e.g.
  // "terrain-7"); when absent the layers panel shows no Elevation section and
  // the map is flat and unchanged, so a no-DEM deployment is unaffected.
  const dem = status?.martin?.dem;
  const hasDem = dem !== undefined;
  const demSource = dem?.source ?? DEM_SOURCE;

  // Initial view: a shareable location hash (#zoom/lat/lon) in the URL wins —
  // it restores the pinned dot + zoom (the "share this location" roundtrip,
  // shared/view-state.js). Without one, prefer the auto-detected
  // center/bounds the pipeline read from the tileset (so any country's
  // extract opens on itself); fall back to the default (mainland Norway)
  // extent.
  const urlView = parseViewHash(location.href);
  const statusCenter = status?.center;
  const statusBounds = status?.bounds;
  const initial =
    urlView
      ? { center: [urlView.lng, urlView.lat], zoom: urlView.zoom }
      : statusCenter && Array.isArray(statusCenter) && statusCenter.length === 3
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
      // 3D-terrain tilt: MapLibre caps the camera at 60° by default, which is
      // too shallow to read the relief as 3D. Raise the ceiling to 85° and allow
      // tilting via a two-finger / trackpad drag. The map itself stays top-down
      // (0°) until the visitor tilts it — the terrain toggle (shared/terrain.js)
      // never moves the camera; these options just set the ceiling + gesture.
      maxPitch: 85,
      pitchWithGesture: true,
      ...initial,
    });
    // Debug hook (console / CDP): inspect map state, force zooms, read tiles.
    window.__map = m;

    // Shareable location: a single pinned dot (the "dot" the visitor can
    // share). A click — click-and-release, not a drag: MapLibre's `click`
    // event already excludes drags — places/moves it and writes the OSM-style
    // #zoom/lat/lon hash. The dot IS the shared location (shared/view-state.js):
    // panning leaves the hash alone, and `zoomend` refreshes only its zoom
    // token, so a copied link always carries the latest zoom. Clicking the dot
    // itself removes it and clears the hash (the dot-click vs map-click
    // disambiguation is handled below, since MapLibre's Marker has no
    // captureClicks).
    const dotEl = document.createElement("div");
    dotEl.className = "mtb-dot";
    // MapLibre's Marker has no public getMap(), so track placement locally.
    const marker = new Marker({ element: dotEl });
    let dotOnMap = false;
    const attachDot = () => {
      if (!dotOnMap) {
        marker.addTo(m);
        dotOnMap = true;
      }
    };
    let pinned = urlView;
    if (pinned) {
      marker.setLngLat(pinned);
      attachDot();
    }

    // Best-effort URL write (private-mode edge cases must not break the map):
    // the dot and the view still work without it.
    const setHash = (view) => {
      const hash = view ? formatViewHash(view) : "";
      if (hash === null) return; // invalid location — leave the URL untouched
      try {
        history.replaceState(null, "", location.pathname + location.search + hash);
      } catch {
        // Ignore — sharing is a convenience, not a requirement.
      }
    };
    const placeDot = (lngLat) => {
      pinned = { lng: lngLat.lng, lat: lngLat.lat };
      marker.setLngLat(pinned);
      attachDot();
      setHash({ ...pinned, zoom: m.getZoom() });
    };
    // MapLibre's Marker has no captureClicks: a dot click still bubbles to
    // the canvas container and fires the map `click`, which would re-place the
    // dot we just removed. Stop it at the target (MapLibre binds its click
    // handler on the container, bubble phase) and also ignore dot-originated
    // clicks in the map handler itself — the same `originalEvent.target`
    // check MapLibre uses for marker popups.
    m.on("click", (e) => {
      const t = e.originalEvent?.target;
      if (t && (t === dotEl || dotEl.contains(t))) return;
      placeDot(e.lngLat);
    });
    dotEl.addEventListener("click", (e) => {
      e.stopPropagation();
      marker.remove();
      dotOnMap = false;
      pinned = null;
      setHash(null);
    });
    m.on("zoomend", () => {
      if (pinned) setHash({ ...pinned, zoom: m.getZoom() });
    });

    // Workstream B: the map controls.
    m.addControl(new NavigationControl(), "top-right");
    m.addControl(new GeolocateControl({ positionOptions: { enableHighAccuracy: true } }), "top-right");
    m.addControl(new FullscreenControl(), "top-right");
    // The single layers panel sits right under the fullscreen button: collapsed
    // to a round layers icon, one click opens the panel. It holds the MTB trail
    // toggles + opacity sliders (always) and — only when a dem source was
    // served — the 3D view / hillshade / contour lines toggles.
    m.addControl(makeLayerControl(m, { hasDem, dem }), "top-right");
    m.addControl(new ScaleControl({ maxWidth: 120, unit: "metric" }), "bottom-left");
    // The info panel now carries the status (data date, country, legends).
    m.addControl(makeInfoControl(status), "bottom-right");

    m.on("load", () => {
      // Position the non-symbol overlays (MTB trails, hillshade, contour
      // lines) BETWEEN the basemap content and its labels: insert them before
      // the first symbol (text) layer, so the basemap's text/icons stay on top
      // and readable instead of being covered by the overlay lines. `beforeId`
      // is undefined (→ append last, the old behavior) when the style has no
      // symbol layer. The app's own elevation label layer is added last (on
      // top) so it stays visible.
      const beforeId = firstSymbolLayerId(m.getStyle());
      // Both trail groups are added so the natural/bike-park toggles have
      // layers to show and hide.
      for (const layer of mtbOverlayLayers(overlaySource, overlayMinzoom)) m.addLayer(layer, beforeId);
      for (const layer of bikeParkOverlayLayers(overlaySource, overlayMinzoom)) m.addLayer(layer, beforeId);
      // Restore the visitor's layer choices (defaults: trails ON at half
      // opacity, 3D view ON, hillshade ON, contour lines ON) from the single
      // persisted state the layers panel writes. The layers only exist after
      // `load`, so this is where the persisted state actually takes effect.
      const state = readLayersState();
      applyOverlayVisibility(m, state);
      applyOverlayOpacity(m, state);
      if (hasDem) {
        // 3D terrain state: apply it now that the style document is loaded
        // (the `load` event guarantees that; setTerrain only needs the
        // document, not settled sources). It survives the contour
        // source/layers added below — only a full style reload resets it.
        applyTerrain(m, state.terrain, state.exaggeration, demSource);
        // Elevation overlays: hillshade (native) + contour lines (client-side via
        // maplibre-contour), BOTH derived from the one dem raster-dem source. We
        // reuse the dem source's own tile URL / encoding / maxzoom (read from the
        // served style spec) so the DemSource always matches the artifact — no
        // separate contour tileset is built or fetched.
        const demSpec = m.getSource(demSource);
        const demTileUrl =
          demSpec && Array.isArray(demSpec.tiles) && demSpec.tiles[0] ? demSpec.tiles[0] : undefined;
        if (demTileUrl) {
          const demMaxzoom =
            typeof demSpec.maxzoom === "number" ? demSpec.maxzoom : 11;
          const demSrc = new mlcontour.DemSource({
            url: demTileUrl,
            encoding: demSpec.encoding ?? "mapbox",
            maxzoom: demMaxzoom,
            worker: true,
            cacheSize: 100,
          });
          // Register maplibre-contour's contour protocol on the maplibre module.
          demSrc.setupMaplibre({ addProtocol });
          // The contour vector source: its tiles are the protocol URL, which
          // maplibre-contour serves as MVT isolines computed on the fly.
          m.addSource(CONTOUR_SOURCE_ID, {
            type: "vector",
            tiles: [demSrc.contourProtocolUrl(contourProtocolOptions())],
            // Overzoom the (z<=demMaxzoom) contour tiles a bit past the dem's
            // native range so the map's max zoom stays rendered.
            maxzoom: demMaxzoom + 4,
          });
          // Draw order: hillshade first, then the contour lines — both BELOW
          // the basemap labels (beforeId) so the basemap's text stays readable —
          // then the app's own elevation labels, on top of everything.
          m.addLayer(hillshadeLayerSpec(demSource), beforeId);
          m.addLayer(contourLineSpec(CONTOUR_SOURCE_ID), beforeId);
          m.addLayer(contourLabelSpec(CONTOUR_SOURCE_ID));
          // The elevation layers only exist now: apply their persisted
          // visibility (their helpers only check for the layer, so an early
          // call elsewhere is a safe no-op).
          applyHillshadeVisibility(m, state.hillshade);
          applyContourVisibility(m, state.contour);
        }
      }
      setBanner(null);
    });

    m.on("error", (ev) => {
      // A failed style load is fatal; a dem-tile image-decode failure is not
      // (only the elevation overlays are lost), so surface it as a soft warning
      // rather than "map failed to load" — the basemap + MTB overlay still work.
      if (isImageDecodeError(ev)) {
        setBanner({
          kind: "warn",
          text: "Elevation (3D terrain, hillshade, contour lines) is unavailable in this browser — the map still works.",
        });
        return;
      }
      // Other pre-load errors (e.g. style.json fetch) are a genuine map failure.
      if (!m.isStyleLoaded()) {
        setBanner({
          kind: "fail",
          text: "map failed to load: " + (ev.error?.message ?? "unknown error") + " — see server logs",
        });
        return;
      }
      // Post-load errors are not fatal (basemap works) but must not be silent:
      // e.g. a layer spec that fails MapLibre's style validation makes `addLayer`
      // abort and fires ONLY this error event — logging it keeps "a layer is
      // mysteriously missing" diagnosable from the console.
      console.warn("[diymtbmap] map error:", ev.error?.message ?? String(ev.error ?? ev));
    });

    return () => {
      window.__map = undefined;
      // The marker element (and its dot-click listener) lives in this effect
      // closure; remove it so a StrictMode remount (or a source/dem-driven
      // rebuild) starts from the URL again — never from a stale dot.
      if (dotOnMap) {
        marker.remove();
        dotOnMap = false;
      }
      m.remove();
    };
    // The map is rebuilt only if the overlay source/minzoom or the presence of
    // a dem source changes; the status-driven initial view and info-panel
    // status are fixed for the session (settled before the map mounts, on
    // state === "ready").
  }, [overlaySource, overlayMinzoom, hasDem, demSource]);

  return (
    <>
      <div ref={containerRef} id="map" />
      {banner && <div className={"mapstatus" + (banner.kind === "fail" ? " fail" : banner.kind === "warn" ? " warn" : "")}>{banner.text}</div>}
    </>
  );
}
