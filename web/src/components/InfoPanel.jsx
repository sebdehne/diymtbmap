import { useState } from "react";
import { OVERLAY_GROUPS } from "../../../shared/mtb-overlay.js";
import { DATA_SOURCES } from "../data.js";

// Info panel: collapsed to a round "i" icon so it costs almost no space on
// mobile. One tap opens the whole overlay — every MTB trail-group legend
// (natural + bike-park), the OSM data date, and the data-source credits at
// once, no second click to reveal more. Tapping the icon again closes it.
//
// `status` (optional) carries the country name (workstream D) and the OSM
// data date (workstream A); both degrade to nothing when absent.
export default function InfoPanel({ status = null }) {
  const [open, setOpen] = useState(false);
  const country = status?.name;
  const dataDate = status?.dataDate;

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
