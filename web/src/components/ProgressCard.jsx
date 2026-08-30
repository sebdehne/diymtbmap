const STATE_LABELS = {
  checking: "Checking toolchain + tileset",
  downloading: "Downloading OSM extract",
  building: "Building tileset (Planetiler)",
  starting: "Starting tile server",
  ready: "Ready",
  error: "Error",
};

export default function ProgressCard({ status, fetchError }) {
  const state = status?.state;
  const pct = Math.max(0, Math.min(100, status?.progress ?? 0));
  const isError = fetchError || state === "error";
  const msg = fetchError
    ? "cannot reach api/status — is the server running?"
    : status
      ? status.message + (status.elapsed !== undefined ? `  (${status.elapsed}s elapsed)` : "")
      : "Connecting…";

  const country = status?.name ?? "Norway";
  return (
    <div className="card">
      <h1>{country} MTB Map</h1>
      <div className="state">{state ? (STATE_LABELS[state] ?? state) : "…"}</div>
      <div className="bar">
        <div style={{ width: pct + "%" }} />
      </div>
      <div className="pct">{Math.round(pct)}%</div>
      <div className={isError ? "msg error" : "msg"}>{msg}</div>
      {state === "error" && status.error && (
        <details className="errbox">
          <summary>details</summary>
          <pre className="errmsg">{status.error}</pre>
        </details>
      )}
      <p className="credit">
        ©{" "}
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">
          OpenStreetMap
        </a>{" "}
        contributors (ODbL) · data ©{" "}
        <a href="https://www.geofabrik.de/" target="_blank" rel="noopener">
          Geofabrik
        </a>{" "}
        · basemap{" "}
        <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">
          OpenMapTiles
        </a>
      </p>
    </div>
  );
}
