import { useState } from "react";
import type { Dimension, Kpi, Profile, SegmentDefinition } from "../api/types";
import { DriversChart, FunnelChart, TrendChart } from "./InsightCharts";
import { fmtCompact, fmtNumber, fmtPct } from "../lib/rules";

/** Share of base: a single-series meter with the value as text beside it. */
export function ShareMeter({ size, base, share }: { size: number; base: number; share: number }) {
  return (
    <div className="share">
      <div className="hero-number">{fmtNumber(size)}</div>
      <div className="muted">of {fmtNumber(base)} in base · <strong className="ink">{fmtPct(share)}</strong></div>
      <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)}
        aria-label="Share of base">
        <div className="meter-fill" style={{ width: `${Math.min(100, share * 100)}%` }} />
      </div>
    </div>
  );
}

export function KpiTiles({ kpis }: { kpis: Kpi[] }) {
  return (
    <div className="kpis">
      {kpis.map((k) => {
        const lift = k.lift;
        const dir = lift === null ? "" : lift >= 1.05 ? "up" : lift <= 0.95 ? "down" : "flat";
        return (
          <div className="kpi" key={k.id}>
            <div className="kpi-label">{k.display}</div>
            <div className="kpi-value">
              {fmtCompact(k.segment)}{k.unit && <span className="kpi-unit"> {k.unit}</span>}
            </div>
            <div className="kpi-foot muted small">
              base {fmtCompact(k.base)}
              {lift !== null && (
                <span className={`lift lift-${dir}`} title="Segment average divided by base average">
                  {dir === "up" ? "▲" : dir === "down" ? "▼" : "●"} {lift.toFixed(2)}×
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Segment vs. base distribution. The segment share is the bar (series 1); the base
 * share is a reference tick (neutral ink) so the gap reads at a glance. The index
 * (100 = same as base) is printed as text, never encoded by color alone.
 */
export function DimensionChart({ dim }: { dim: Dimension }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const max = Math.max(0.0001, ...dim.rows.flatMap((r) => [r.segment_pct, r.base_pct]));
  return (
    <figure className="dim-chart">
      <figcaption>
        <span className="dim-title">{dim.display}{dim.unit ? ` (${dim.unit})` : ""}</span>
        {dim.multi_valued && <span className="muted small" title="A member can appear in several rows"> · multi-valued</span>}
        <button type="button" className="link-btn small" onClick={() => setTable(!table)}>
          {table ? "Chart" : "Table"}
        </button>
      </figcaption>
      {table ? (
        <table className="data-table compact">
          <thead><tr><th>Value</th><th className="num">Segment</th><th className="num">Seg %</th><th className="num">Base %</th><th className="num">Index</th></tr></thead>
          <tbody>
            {dim.rows.map((r) => (
              <tr key={r.value}>
                <td>{r.value}</td><td className="num">{fmtNumber(r.segment)}</td>
                <td className="num">{fmtPct(r.segment_pct)}</td><td className="num">{fmtPct(r.base_pct)}</td>
                <td className="num">{r.index ?? "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="bars" onMouseLeave={() => setHover(null)}>
          {dim.rows.slice(0, 12).map((r, i) => (
            <div key={r.value} className={`bar-row${hover === i ? " hot" : ""}`} onMouseEnter={() => setHover(i)}
              onFocus={() => setHover(i)} tabIndex={0}
              aria-label={`${r.value}: segment ${fmtPct(r.segment_pct)}, base ${fmtPct(r.base_pct)}, index ${r.index ?? "n/a"}`}>
              <span className="bar-label" title={r.value}>{r.value}</span>
              <span className="bar-track">
                <span className="bar-fill" style={{ width: `${(r.segment_pct / max) * 100}%` }} />
                <span className="bar-base" style={{ left: `${(r.base_pct / max) * 100}%` }} />
              </span>
              <span className="bar-value">{fmtPct(r.segment_pct, 0)}</span>
              <span className={`bar-index${r.index !== null && r.index >= 120 ? " hi" : r.index !== null && r.index <= 80 ? " lo" : ""}`}>
                {r.index ?? "–"}
              </span>
              {hover === i && (
                <span className="tooltip" role="tooltip">
                  <strong>{r.value}</strong>
                  <span>Segment <b>{fmtNumber(r.segment)}</b> ({fmtPct(r.segment_pct)})</span>
                  <span>Base <b>{fmtNumber(r.base)}</b> ({fmtPct(r.base_pct)})</span>
                  <span>Index <b>{r.index ?? "–"}</b> (100 = same as base)</span>
                </span>
              )}
            </div>
          ))}
          {dim.rows.length > 12 && <div className="muted small">+{dim.rows.length - 12} more (see table)</div>}
        </div>
      )}
    </figure>
  );
}

export function ProfileView({ profile, definition, segmentId, segmentNames, wide = false }: {
  profile: Profile; definition?: SegmentDefinition; segmentId?: string;
  segmentNames?: Record<string, string>; wide?: boolean;
}) {
  const source = { definition, segmentId };
  return (
    <div className="profile">
      <KpiTiles kpis={profile.kpis} />
      <div className={`insight-grid${wide ? " wide" : ""}`}>
        {definition && <FunnelChart source={source} segmentNames={segmentNames} />}
        {definition && <TrendChart source={source} />}
        <DriversChart profile={profile} rule={definition?.rule} />
      </div>
      <h3 className="dims-title">Profile by dimension</h3>
      <div className="legend small" aria-hidden>
        <span><i className="sw sw-seg" /> Segment share</span>
        <span><i className="sw sw-base" /> Base share</span>
        <span className="muted">Index: 100 = same as base, ≥120 over-represented, ≤80 under-represented</span>
      </div>
      <div className="dims">
        {profile.dimensions.map((d) => <DimensionChart key={d.field} dim={d} />)}
      </div>
    </div>
  );
}
