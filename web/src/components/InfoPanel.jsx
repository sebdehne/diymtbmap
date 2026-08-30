import { useState } from "react";
import { MTB_COLORS, MTB_LABELS } from "../../../shared/mtb-overlay.js";
import { DATA_SOURCES } from "../data.js";

// Info panel: collapsed to a round "i" icon so it costs almost no space on
// mobile. One tap opens the whole overlay — the MTB difficulty legend AND the
// data-source credits at once, no second click to reveal more. Tapping the
// icon again closes it.
export default function InfoPanel() {
  const [open, setOpen] = useState(false);

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
          <div className="mtb-info-title">MTB difficulty · mtb:scale</div>
          {Object.entries(MTB_LABELS).map(([level, label]) => (
            <div className="mtb-legend-row" key={level}>
              <span className="mtb-swatch" style={{ background: MTB_COLORS[level] }} />
              <span className="mtb-level">{level}</span>
              <span className="mtb-name">{label}</span>
            </div>
          ))}
          <div className="mtb-info-note">+ / − variants use the base level&#39;s color</div>
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
