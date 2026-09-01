import { useEffect, useRef, useState } from "react";
import { OVERLAY_GROUPS } from "../../../shared/mtb-overlay.js";
import { DATA_SOURCES } from "../data.js";

const REIMPORT_POLL_MS = 5000;

// Info panel: collapsed to a round "i" icon so it costs almost no space on
// mobile. One tap opens the whole overlay — every MTB trail-group legend
// (natural + bike-park), the OSM data date, and the data-source credits at
// once, no second click to reveal more. Tapping the icon again closes it.
//
// `status` (optional) carries the country name (workstream D) and the OSM
// data date (workstream A); both degrade to nothing when absent.
export default function InfoPanel({ status = null }) {
  const [open, setOpen] = useState(false);
  const [reimport, setReimport] = useState("idle");
  const pollTimer = useRef(null);
  const reloadTimer = useRef(null);
  const mounted = useRef(true);

  const country = status?.name;
  const dataDate = status?.dataDate;

  const stopPolling = () => {
    if (pollTimer.current !== null) {
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }
  };

  const startPolling = () => {
    if (pollTimer.current !== null) return;
    pollTimer.current = setInterval(async () => {
      try {
        const res = await fetch("api/reimport", { cache: "no-store" });
        const s = await res.json();
        if (mounted.current) applyServerState(s.state);
      } catch {
        // A transient network error while polling is ignored; the next tick
        // (or the user reloading) will pick the real state back up.
      }
    }, REIMPORT_POLL_MS);
  };

  const scheduleReload = () => {
    if (reloadTimer.current !== null) return;
    reloadTimer.current = setTimeout(() => window.location.reload(), 800);
  };

  const applyServerState = (serverState) => {
    if (serverState === "running") {
      setReimport("running");
      startPolling();
      return;
    }

    const wasPolling = pollTimer.current !== null;
    stopPolling();

    if (serverState === "success") {
      setReimport("success");
      if (wasPolling) scheduleReload();
    } else if (serverState === "error") {
      setReimport("error");
    } else if (serverState === "no-newer-dataset") {
      setReimport("no-newer-dataset");
    } else {
      setReimport("idle");
    }
  };

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    fetch("api/reimport", { cache: "no-store" })
      .then((res) => res.json())
      .then((s) => {
        if (!cancelled && mounted.current) applyServerState(s.state);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      mounted.current = false;
      stopPolling();
      if (reloadTimer.current !== null) clearTimeout(reloadTimer.current);
    };
  }, []);

  const triggerReimport = async () => {
    if (reimport !== "idle") return;
    setReimport("pending");
    try {
      const res = await fetch("api/reimport", { method: "POST" });
      const body = await res.json().catch(() => ({}));

      if (res.status === 202) {
        setReimport("running");
        startPolling();
        return;
      }
      if (res.status === 409 && body.error === "no-newer-dataset") {
        setReimport("no-newer-dataset");
        return;
      }
      if (res.status === 409 && body.error === "already-running") {
        setReimport("running");
        startPolling();
        return;
      }
      if (res.status === 409 && body.error === "already-attempted-today") {
        // The day is already consumed; reflect whatever the server recorded.
        const state = await fetch("api/reimport", { cache: "no-store" })
          .then((r) => r.json())
          .catch(() => null);
        if (state?.state) applyServerState(state.state);
        else setReimport("no-newer-dataset");
        return;
      }
      setReimport("error");
    } catch {
      setReimport("error");
    }
  };

  const reimportMessage = {
    pending: "Checking…",
    running: "Reimport running, it might take a while",
    success: "",
    error: "Reimport failed — contact admin.",
    "no-newer-dataset": "Data is already up to date.",
  }[reimport];

  const reimportLabel = {
    idle: "Update data",
    pending: "Checking…",
    running: "Running…",
    success: "Done",
    error: "Failed",
    "no-newer-dataset": "Up to date",
  }[reimport];

  return (
    <div className={"mtb-info" + (open ? " open" : "")}>
      <button
        type="button"
        className="mtb-info-toggle"
        aria-expanded={open}
        aria-label={open ? "Hide map information" : "Show map information"}
        onClick={() => setOpen(!open)}
      >
        ⓘ
      </button>
      {open && (
        <div className="mtb-info-body">
          <div className="mtb-info-title">
            {country ? `${country} MTB` : "MTB trails"}
          </div>

          {OVERLAY_GROUPS.map((g) => (
            <div key={g.id} className="mtb-legend">
              <div className="mtb-info-section">
                {g.label} · {g.key}
              </div>
              {Object.entries(g.labels).map(([level, label]) => (
                <div className="mtb-legend-row" key={level}>
                  <span className="mtb-swatch" style={{ background: g.colors[level] }} />
                  <span className="mtb-level">{level}</span>
                  <span className="mtb-name">{label}</span>
                </div>
              ))}
              <div className="mtb-info-note">{g.note}</div>
            </div>
          ))}

          {dataDate && (
            <div className="mtb-info-date">OSM data as of {dataDate}</div>
          )}

          <div className="mtb-reimport">
            <button
              type="button"
              className="mtb-reimport-button"
              disabled={reimport !== "idle"}
              onClick={triggerReimport}
            >
              {reimportLabel}
            </button>
            {reimportMessage && (
              <div
                className={
                  "mtb-reimport-msg" +
                  (reimport === "error"
                    ? " error"
                    : reimport === "success"
                      ? " success"
                      : reimport === "no-newer-dataset"
                        ? " info"
                        : "")
                }
              >
                {reimportMessage}
              </div>
            )}
          </div>

          <hr className="mtb-info-divider" />
          <div className="mtb-info-section">Data sources</div>
          {DATA_SOURCES.map((s) => (
            <div className="mtb-info-src" key={s.name}>
              <a href={s.url} target="_blank" rel="noopener">
                {s.name}
              </a>{" "}
              — {s.note}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
