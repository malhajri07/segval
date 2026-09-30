import { Link, useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { useCatalog } from "../lib/catalog";
import { useAsync } from "../lib/hooks";
import { describe, fmtNumber } from "../lib/rules";

export function SegmentsPage() {
  const catalog = useCatalog();
  const navigate = useNavigate();
  const segments = useAsync(() => api.segments(), []);
  const templates = useAsync(() => api.templates(), []);
  const names = Object.fromEntries((segments.data ?? []).map((s) => [s.id, s.name]));
  const anchorName = (id: string) => catalog.anchors.find((a) => a.id === id)?.display ?? id;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Segments</h1>
          <p className="muted">{catalog.display} · build audiences from the customer graph without writing code.</p>
        </div>
        <Link to="/builder" className="btn btn-primary">+ New segment</Link>
      </div>

      <section className="card">
        {segments.loading && !segments.data ? <p className="muted">Loading…</p>
          : segments.error ? <p className="error">{segments.error.message}</p>
          : segments.data && segments.data.length === 0 ? (
            <div className="empty">
              <h3>No saved segments yet</h3>
              <p className="muted">Start from a template below, or build one from scratch.</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr><th>Name</th><th>Unit</th><th className="num">Members</th><th>Status</th><th>Updated</th><th /></tr>
                </thead>
                <tbody>
                  {segments.data?.map((s) => (
                    <tr key={s.id} className="clickable" onClick={() => navigate(`/segments/${s.id}`)}>
                      <td>
                        <Link to={`/segments/${s.id}`} className="strong">{s.name}</Link>
                        <div className="muted small clamp">{describe(s.definition.rule, catalog, names)}</div>
                        {s.tags.length > 0 && <div className="chips">{s.tags.map((t) => <span className="chip" key={t}>{t}</span>)}</div>}
                      </td>
                      <td>{anchorName(s.definition.anchor)}</td>
                      <td className="num">{s.member_count === null ? "–" : fmtNumber(s.member_count)}</td>
                      <td>
                        {s.member_count === null ? <span className="status status-none">○ Not materialized</span>
                          : s.is_stale ? <span className="status status-warn">⚠ Stale (v{s.version})</span>
                          : <span className="status status-ok">✓ Materialized</span>}
                      </td>
                      <td className="small muted">{new Date(s.updated_at).toLocaleString()}</td>
                      <td><Link to={`/builder/${s.id}`} onClick={(e) => e.stopPropagation()} className="btn btn-sm">Edit</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
      </section>

      <h2>Start from a template</h2>
      <div className="template-grid">
        {(templates.data ?? []).map((t) => (
          <Link key={t.id} to={`/builder?template=${t.id}`} className="template">
            <span className="template-cat">{t.category}</span>
            <strong>{t.name}</strong>
            <span className="muted small">{t.description}</span>
            <span className="small template-rule">{describe(t.definition.rule, catalog)}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
