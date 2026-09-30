import { useEffect } from "react";
import { api } from "../api/client";
import type { Row } from "../api/types";
import { useCatalog } from "../lib/catalog";
import { useAsync } from "../lib/hooks";
import { fmtNumber } from "../lib/rules";

function cell(v: unknown) {
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : fmtNumber(v, 2);
  return v === null || v === undefined ? "–" : String(v);
}

function RowsTable({ rows }: { rows: Row[] }) {
  if (!rows.length) return <p className="muted small">None</p>;
  const cols = Object.keys(rows[0]).filter((c) => c !== "edge");
  return (
    <div className="table-wrap">
      <table className="data-table compact">
        <thead><tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => <tr key={i}>{cols.map((c) => <td key={c}>{cell(r[c])}</td>)}</tr>)}
        </tbody>
      </table>
    </div>
  );
}

/** 360° view of one anchor record: everything reachable in the graph. */
export function MemberDrawer({ anchor, memberKey, onClose, onOpen }: {
  anchor: string; memberKey: string; onClose: () => void; onOpen: (key: string) => void;
}) {
  const catalog = useCatalog();
  const { data, error, loading } = useAsync(() => api.member(anchor, memberKey), [anchor, memberKey]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const anchorEntity = catalog.anchors.find((a) => a.id === anchor)?.entity;
  const keyProp = catalog.entities.find((e) => e.id === anchorEntity)?.key ?? "id";

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-label="Member 360 view" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <div>
            <div className="muted small">360° graph view</div>
            <h2>{memberKey}</h2>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">×</button>
        </header>
        {loading && <p className="muted">Loading…</p>}
        {error && <p className="error">{error.message}</p>}
        {data && (
          <div className="drawer-body">
            {data.segments.length > 0 && (
              <section>
                <h3>Segments</h3>
                <div className="chips">{data.segments.map((s) => <span key={s.id} className="chip on">{s.name}</span>)}</div>
              </section>
            )}
            {catalog.entities.filter((e) => e.id in data.entities).map((e) => {
              const v = data.entities[e.id];
              return (
                <section key={e.id}>
                  <h3>{e.display}{Array.isArray(v) ? ` (${v.length})` : ""}</h3>
                  {Array.isArray(v) ? <RowsTable rows={v} /> : (
                    <dl className="kv">
                      {Object.entries(v).map(([k, val]) => (
                        <div key={k}><dt>{k}</dt><dd>{cell(val)}</dd></div>
                      ))}
                    </dl>
                  )}
                </section>
              );
            })}
            {Object.entries(data.networks).map(([nid, rows]) => {
              const net = catalog.networks.find((n) => n.id === nid);
              const edgeCols = net?.edge_attributes ?? [];
              return (
                <section key={nid}>
                  <h3>{net?.display ?? nid} ({rows.length})</h3>
                  {rows.length === 0 ? <p className="muted small">No connections</p> : (
                    <div className="table-wrap">
                      <table className="data-table compact">
                        <thead>
                          <tr>
                            <th>Connected {anchor}</th><th>Status</th>
                            {edgeCols.map((a) => <th key={a.id} className={a.type === "number" ? "num" : ""}>{a.display}</th>)}
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r, i) => (
                            <tr key={`${String(r[keyProp])}-${i}`}>
                              <td><button type="button" className="link-btn" onClick={() => onOpen(String(r[keyProp]))}>
                                {String(r.full_name ?? r[keyProp])}
                              </button></td>
                              <td>{cell(r.status ?? r.value_tier)}</td>
                              {edgeCols.map((a) => <td key={a.id} className={a.type === "number" ? "num" : ""}>{cell(r.edge?.[a.property])}</td>)}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </aside>
    </div>
  );
}
