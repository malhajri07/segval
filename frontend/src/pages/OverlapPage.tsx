import { useState } from "react";
import { api } from "../api/client";
import type { Overlap } from "../api/types";
import { useAsync } from "../lib/hooks";
import { fmtNumber, fmtPct } from "../lib/rules";

// Sequential blue ramp (light -> dark) from the reference palette; magnitude = % of row segment.
const RAMP = ["#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec", "#5598e7", "#3987e5", "#2a78d6", "#256abf", "#1c5cab", "#184f95", "#104281"];

export function OverlapPage() {
  const segments = useAsync(() => api.segments(), []);
  const [selected, setSelected] = useState<string[]>([]);
  const [result, setResult] = useState<Overlap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ready = (segments.data ?? []).filter((s) => s.member_count !== null);
  const anchors = new Set(ready.filter((s) => selected.includes(s.id)).map((s) => s.definition.anchor));

  const compute = async () => {
    setBusy(true);
    setError(null);
    try { setResult(await api.overlap(selected)); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Segment overlap</h1>
          <p className="muted">How much do audiences collide? Pick materialized segments of the same unit.</p>
        </div>
      </div>
      <section className="card">
        {ready.length === 0 ? <p className="muted">Materialize at least two segments first.</p> : (
          <div className="chips">
            {ready.map((s) => {
              const on = selected.includes(s.id);
              return (
                <button type="button" key={s.id} className={`chip${on ? " on" : ""}`} aria-pressed={on}
                  onClick={() => setSelected(on ? selected.filter((x) => x !== s.id) : [...selected, s.id])}>
                  {s.name} <span className="muted">({fmtNumber(s.member_count)})</span>
                </button>
              );
            })}
          </div>
        )}
        <div className="actions">
          {anchors.size > 1 && <span className="error small">Selected segments have different units, so they can't overlap.</span>}
          <button type="button" className="btn btn-primary" disabled={selected.length < 2 || busy || anchors.size > 1} onClick={compute}>
            {busy ? "Computing…" : "Compute overlap"}
          </button>
        </div>
        {error && <p className="error">{error}</p>}
      </section>

      {result && (
        <section className="card">
          <p className="muted small">Cell = members of the <b>row</b> segment that are also in the <b>column</b> segment (% of row).</p>
          <div className="table-wrap">
            <table className="heatmap">
              <thead>
                <tr><th />{result.segments.map((s) => <th key={s.id} className="col-head"><span>{s.name}</span></th>)}</tr>
              </thead>
              <tbody>
                {result.segments.map((row) => (
                  <tr key={row.id}>
                    <th className="row-head">{row.name}<div className="muted small">{fmtNumber(row.size)}</div></th>
                    {result.segments.map((col) => {
                      const c = result.cells.find((x) => x.a === row.id && x.b === col.id)!;
                      const pct = row.size ? c.count / row.size : 0;
                      const step = Math.min(RAMP.length - 1, Math.floor(pct * RAMP.length));
                      return (
                        <td key={col.id} style={{ background: pct === 0 ? undefined : RAMP[step], color: step >= 6 ? "#fff" : undefined }}
                          title={`${row.name} ∩ ${col.name}: ${fmtNumber(c.count)} (${fmtPct(pct)} of row, Jaccard ${c.jaccard.toFixed(2)})`}>
                          <div className="strong">{fmtPct(pct, 0)}</div>
                          <div className="small">{fmtNumber(c.count)}</div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
