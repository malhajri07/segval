import { useId, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import type { Funnel, Profile, RuleNode, SegmentDefinition, Trend } from "../api/types";
import { useCatalog } from "../lib/catalog";
import { useAsync } from "../lib/hooks";
import { describe, fmtCompact, fmtNumber, fmtPct } from "../lib/rules";

type Source = { definition?: SegmentDefinition; segmentId?: string };
const body = (s: Source) => (s.segmentId ? { segment_id: s.segmentId } : { definition: s.definition });
const keyOf = (s: Source) => s.segmentId ?? JSON.stringify(s.definition);

// ---- condition funnel ------------------------------------------------------------------
/**
 * How each top-level condition narrows (AND) or widens (OR) the audience.
 * Solid bar = remaining after this step; light bar = what the condition matches on its own.
 * Magnitude job, so one hue (sequential steps), values printed on every row.
 */
export function FunnelChart({ source, segmentNames = {} }: { source: Source; segmentNames?: Record<string, string> }) {
  const catalog = useCatalog();
  const [hover, setHover] = useState<number | null>(null);
  const { data, error, loading } = useAsync<Funnel>((signal) => api.funnel(body(source), signal), [keyOf(source)], 500);
  const rule = source.definition?.rule;
  const children: RuleNode[] = rule && rule.kind === "group" && !rule.negate ? rule.children : rule ? [rule] : [];
  const anchorName = catalog.anchors.find((a) => a.id === data?.anchor)?.display ?? "Base";

  if (error) return <p className="error small">{error.message}</p>;
  if (!data) return <p className="muted small">Counting each condition…</p>;
  if (!data.steps.length) return <p className="muted small">Add conditions to see how each one narrows the audience.</p>;

  const rows = [
    { label: `All ${anchorName.toLowerCase()}`, alone: data.base, cumulative: data.base, delta: 0 },
    ...data.steps.map((s, i) => ({
      label: children[i] ? describe(children[i], catalog, segmentNames) : `Condition ${i + 1}`,
      alone: s.alone,
      cumulative: s.cumulative,
      delta: s.cumulative - (i === 0 ? (data.op === "and" ? data.base : 0) : data.steps[i - 1].cumulative),
    })),
  ];
  return (
    <figure className={`viz funnel${loading ? " refreshing" : ""}`}>
      <figcaption>
        <span className="viz-title">Condition funnel</span>
        <span className="muted small">{data.op === "and" ? "each condition narrows the audience" : "each condition adds to the audience"}</span>
      </figcaption>
      <div className="legend small" aria-hidden>
        <span><i className="sw sw-seg" /> Remaining after the step</span>
        <span><i className="sw sw-ghost" /> Matches the condition alone</span>
      </div>
      <ol className="funnel-rows" onMouseLeave={() => setHover(null)}>
        {rows.map((r, i) => (
          <li key={i} className={`funnel-row${hover === i ? " hot" : ""}${i === 0 ? " base-row" : ""}`}
            tabIndex={0} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)}
            aria-label={`${r.label}: ${fmtNumber(r.cumulative)} remaining, ${fmtPct(r.cumulative / Math.max(1, data.base))} of base`}>
            <div className="funnel-label" title={r.label}>{r.label}</div>
            <div className="funnel-track">
              {i > 0 && <span className="funnel-ghost" style={{ width: `${(r.alone / Math.max(1, data.base)) * 100}%` }} />}
              <span className="funnel-fill" style={{ width: `${(r.cumulative / Math.max(1, data.base)) * 100}%` }} />
            </div>
            <div className="funnel-value">
              <strong>{fmtNumber(r.cumulative)}</strong>
              <span className="muted"> {fmtPct(r.cumulative / Math.max(1, data.base), 0)}</span>
            </div>
            <div className={`funnel-delta${r.delta < 0 ? " neg" : r.delta > 0 ? " pos" : ""}`}>
              {i === 0 ? "" : `${r.delta > 0 ? "+" : r.delta < 0 ? "−" : "±"}${fmtNumber(Math.abs(r.delta))}`}
            </div>
            {hover === i && i > 0 && (
              <div className="tooltip funnel-tip" role="tooltip">
                <span><b>{fmtNumber(r.cumulative)}</b> remaining ({fmtPct(r.cumulative / Math.max(1, data.base))} of base)</span>
                <span><b>{fmtNumber(r.alone)}</b> match this condition alone</span>
                <span><b>{fmtNumber(Math.abs(r.delta))}</b> {r.delta < 0 ? "removed" : "added"} by this step</span>
              </div>
            )}
          </li>
        ))}
      </ol>
    </figure>
  );
}

// ---- drivers ---------------------------------------------------------------------------
interface Driver { field: string; dim: string; value: string; seg: number; base: number; index: number; rawIndex: number }

/** Fields the rule filters on directly (outside related/network filters): their skew is by construction. */
export function ruleFields(rule: RuleNode | undefined): Set<string> {
  const out = new Set<string>();
  const walk = (n: RuleNode | null | undefined) => {
    if (!n) return;
    if (n.kind === "attribute") out.add(n.field);
    if (n.kind === "group") n.children.forEach(walk);
  };
  walk(rule);
  return out;
}

/** The biggest differences from the base across all profile dimensions. */
export function driversFrom(profile: Profile, exclude: Set<string> = new Set(), minShare = 0.05): Driver[] {
  const all: Driver[] = [];
  for (const d of profile.dimensions) {
    if (exclude.has(d.field)) continue;
    for (const r of d.rows) {
      if (r.index === null || r.value === "(none)") continue;
      if (r.segment_pct < minShare && r.base_pct < minShare) continue;
      all.push({ field: d.field, dim: d.display, value: r.value, seg: r.segment_pct, base: r.base_pct,
        index: Math.max(1, r.index), rawIndex: r.index });
    }
  }
  const strength = (x: Driver) => Math.abs(Math.log2(x.index / 100)) * Math.sqrt(Math.max(x.seg, x.base));
  const over = all.filter((x) => x.index >= 120 && x.seg >= minShare).sort((a, b) => strength(b) - strength(a)).slice(0, 6);
  const under = all.filter((x) => x.index <= 80 && x.base >= minShare).sort((a, b) => strength(b) - strength(a)).slice(0, 4);
  return [...over, ...under];
}

/**
 * Diverging bars on a log scale around index 100 (same as base). Polarity job, so the
 * two poles of the diverging pair; the value and the index are always printed.
 */
export function DriversChart({ profile, rule }: { profile: Profile; rule?: RuleNode }) {
  const drivers = useMemo(() => driversFrom(profile, ruleFields(rule)), [profile, rule]);
  const [hover, setHover] = useState<number | null>(null);
  if (!drivers.length) {
    return (
      <figure className="viz">
        <figcaption><span className="viz-title">What makes this segment different</span></figcaption>
        <p className="muted small">Apart from the fields in the rule, no profile value is 20% more or less common than in the base.</p>
      </figure>
    );
  }
  const MAX = 3; // log2 scale cap: 8x over or under
  const pos = (index: number) => Math.max(-MAX, Math.min(MAX, Math.log2(index / 100))) / MAX;
  return (
    <figure className="viz drivers">
      <figcaption>
        <span className="viz-title">What makes this segment different</span>
        <span className="muted small">share in segment vs base; index 100 = same as base; fields used in the rule are left out</span>
      </figcaption>
      <div className="driver-row driver-head" aria-hidden>
        <span className="muted small">Value</span>
        <div className="driver-ticks">
          {[["⅛×", 0], ["½×", 33.3], ["same", 50], ["2×", 66.7], ["8×", 100]].map(([t, left]) => (
            <span key={t as string} style={{ left: `${left}%` }}>{t}</span>
          ))}
        </div>
        <span className="muted small">seg vs base</span>
        <span className="muted small">index</span>
      </div>
      <ul className="drivers-rows" onMouseLeave={() => setHover(null)}>
        {drivers.map((d, i) => {
          const p = pos(d.index);
          return (
            <li key={`${d.field}=${d.value}`} className={`driver-row${hover === i ? " hot" : ""}`} tabIndex={0}
              onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)}
              aria-label={`${d.dim} ${d.value}: ${fmtPct(d.seg)} of segment versus ${fmtPct(d.base)} of base, index ${d.rawIndex}`}>
              <div className="driver-label"><span className="muted">{d.dim}</span> <strong>{d.value}</strong></div>
              <div className="driver-track">
                <span className="driver-mid" />
                <span className={`driver-bar ${p >= 0 ? "up" : "down"}`}
                  style={p >= 0 ? { left: "50%", width: `${p * 50}%` } : { right: "50%", width: `${-p * 50}%` }} />
              </div>
              <div className="driver-value">
                {fmtPct(d.seg, 0)} <span className="muted">vs {fmtPct(d.base, 0)}</span>
              </div>
              <div className={`driver-index ${p >= 0 ? "up" : "down"}`}>{p >= 0 ? "▲" : "▼"} {d.rawIndex}</div>
            </li>
          );
        })}
      </ul>
    </figure>
  );
}

// ---- trend -------------------------------------------------------------------------------
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (iso: string) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(2, 4)}`;

function niceMax(v: number) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

/**
 * Segment vs base per month. The segment is the point (accent); the base is context
 * (neutral) - the emphasis form. Crosshair + one tooltip for both series, end labels.
 */
export function TrendChart({ source }: { source: Source }) {
  const catalog = useCatalog();
  const anchorId = source.definition?.anchor;
  const metrics = catalog.metrics.filter((m) => {
    if (!m.time_property) return false;
    const ent = catalog.entities.find((e) => e.id === m.entity);
    return !anchorId || (ent?.paths[anchorId]?.length ?? 0) > 0;
  });
  const [metric, setMetric] = useState(metrics[0]?.id ?? "");
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const titleId = useId();
  const svgRef = useRef<SVGSVGElement | null>(null);
  const { data, error, loading } = useAsync<Trend | null>(
    (signal) => (metric ? api.trend({ ...body(source), metric }, signal) : Promise.resolve(null)),
    [keyOf(source), metric], 500);

  const W = 560, H = 220, L = 52, R = 76, T = 14, B = 28;
  const pts = data?.points ?? [];
  const yMax = niceMax(Math.max(0, ...pts.flatMap((p) => [p.segment ?? 0, p.base ?? 0])));
  const x = (i: number) => L + (pts.length <= 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (pts.length - 1));
  const y = (v: number) => T + (1 - v / yMax) * (H - T - B);
  const path = (key: "segment" | "base") =>
    pts.map((p, i) => (p[key] === null ? "" : `${i === 0 || pts[i - 1][key] === null ? "M" : "L"}${x(i)},${y(p[key]!)}`)).join("");
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax);
  const last = pts.length - 1;
  // End labels: keep at least 13px apart so "Segment" and "Base" never collide.
  let segLabelY = pts[last]?.segment != null ? y(pts[last].segment!) : null;
  let baseLabelY = pts[last]?.base != null ? y(pts[last].base!) : null;
  if (segLabelY !== null && baseLabelY !== null && Math.abs(segLabelY - baseLabelY) < 13) {
    const mid = (segLabelY + baseLabelY) / 2;
    const segAbove = segLabelY <= baseLabelY;
    segLabelY = mid + (segAbove ? -6.5 : 6.5);
    baseLabelY = mid + (segAbove ? 6.5 : -6.5);
  }
  const unit = data?.unit ? ` ${data.unit}` : "";

  const onMove = (e: React.PointerEvent) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    pts.forEach((_, i) => { if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i; });
    setHover(best);
  };

  return (
    <figure className={`viz trend${loading ? " refreshing" : ""}`} aria-labelledby={titleId}>
      <figcaption>
        <span className="viz-title" id={titleId}>{data?.display ?? "Trend"} per member, by month</span>
        <button type="button" className="link-btn small" onClick={() => setTable(!table)}>{table ? "Chart" : "Table"}</button>
      </figcaption>
      <select className="trend-metric" value={metric} aria-label="Metric" onChange={(e) => setMetric(e.target.value)}>
        {metrics.map((m) => <option key={m.id} value={m.id}>{m.display}{m.unit ? ` (${m.unit})` : ""}</option>)}
      </select>
      {error ? <p className="error small">{error.message}</p> : !data ? <p className="muted small">Loading trend…</p>
        : !pts.length ? <p className="muted small">No activity in this window.</p>
        : table ? (
          <table className="data-table compact">
            <thead><tr><th>Month</th><th className="num">Segment</th><th className="num">Base</th><th className="num">Members active</th></tr></thead>
            <tbody>
              {pts.map((p) => (
                <tr key={p.month}><td>{monthLabel(p.month)}</td><td className="num">{fmtNumber(p.segment, 1)}</td>
                  <td className="num">{fmtNumber(p.base, 1)}</td><td className="num">{fmtNumber(p.segment_n)}</td></tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="trend-plot">
            <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} role="img"
              aria-label={`${data.display}: segment ${fmtCompact(pts[last].segment)}${unit} versus base ${fmtCompact(pts[last].base)}${unit} in ${monthLabel(pts[last].month)}`}
              onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
              {ticks.map((t) => (
                <g key={t}>
                  <line className="grid" x1={L} x2={W - R} y1={y(t)} y2={y(t)} />
                  <text className="tick" x={L - 8} y={y(t)} dy="0.32em" textAnchor="end">{fmtCompact(t)}</text>
                </g>
              ))}
              {pts.map((p, i) => (
                <text key={p.month} className="tick" x={x(i)} y={H - 8} textAnchor="middle">{monthLabel(p.month)}</text>
              ))}
              <path className="line-base" d={path("base")} />
              <path className="line-seg" d={path("segment")} />
              {pts.map((p, i) => (
                <g key={p.month}>
                  {p.base !== null && <circle className="dot-base" cx={x(i)} cy={y(p.base)} r={hover === i ? 5 : 3.5} />}
                  {p.segment !== null && <circle className="dot-seg" cx={x(i)} cy={y(p.segment)} r={hover === i ? 6 : 4} />}
                </g>
              ))}
              {segLabelY !== null && <text className="end-label seg" x={x(last) + 10} y={segLabelY} dy="0.32em">Segment</text>}
              {baseLabelY !== null && <text className="end-label" x={x(last) + 10} y={baseLabelY} dy="0.32em">Base</text>}
              {hover !== null && <line className="crosshair" x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} />}
              <rect x={L} y={T} width={W - L - R} height={H - T - B} fill="transparent" />
            </svg>
            {hover !== null && (
              <div className="tooltip trend-tip" role="tooltip"
                style={{ left: `${(x(hover) / W) * 100}%`, transform: `translateX(${hover > pts.length / 2 ? "-105%" : "5%"})` }}>
                <strong>{monthLabel(pts[hover].month)}</strong>
                <span><i className="key key-seg" /> <b>{fmtNumber(pts[hover].segment, 0)}{unit}</b> segment</span>
                <span><i className="key key-base" /> <b>{fmtNumber(pts[hover].base, 0)}{unit}</b> base</span>
                <span className="muted">{fmtNumber(pts[hover].segment_n)} members active</span>
              </div>
            )}
          </div>
        )}
    </figure>
  );
}
