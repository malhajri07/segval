import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { DEMO, api } from "../api/client";
import { ProfileView, ShareMeter } from "../components/Charts";
import { MemberDrawer } from "../components/MemberDrawer";
import { useCatalog } from "../lib/catalog";
import { useAsync } from "../lib/hooks";
import { describe } from "../lib/rules";
import { SampleTable } from "./BuilderPage";

const PAGE = 25;

export function SegmentPage() {
  const { id = "" } = useParams();
  const catalog = useCatalog();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [member, setMember] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const seg = useAsync(() => api.segment(id), [id]);
  const all = useAsync(() => api.segments(), []);
  const profile = useAsync(() => api.profile({ segment_id: id }), [id, seg.data?.version, seg.data?.materialized_at]);
  const members = useAsync(() => api.members(id, PAGE, page * PAGE), [id, page, seg.data?.materialized_at]);

  if (seg.error) return <div className="page"><p className="error">{seg.error.message}</p></div>;
  if (!seg.data) return <div className="page muted">Loading…</div>;
  const s = seg.data;
  const names = Object.fromEntries((all.data ?? []).map((x) => [x.id, x.name]));
  const anchor = catalog.anchors.find((a) => a.id === s.definition.anchor)!;

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setActionError(null);
    try { await fn(); } catch (e) { setActionError((e as Error).message); } finally { setBusy(null); }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="muted small"><Link to="/">Segments</Link> / {anchor.display} · v{s.version}</div>
          <h1>{s.name}</h1>
          {s.description && <p className="muted">{s.description}</p>}
        </div>
        <div className="btn-row">
          <Link to={`/builder/${s.id}`} className="btn">Edit rules</Link>
          <button type="button" className="btn" disabled={!!busy}
            onClick={() => run("materialize", async () => { await api.materialize(s.id); seg.reload(); })}>
            {busy === "materialize" ? "Materializing…" : s.member_count === null ? "Materialize" : "Refresh members"}
          </button>
          {!DEMO && (
            <a className={`btn${s.member_count === null ? " disabled" : ""}`} href={api.exportUrl(s.id)}
              aria-disabled={s.member_count === null}>Export CSV</a>
          )}
          {confirmDelete ? (
            <>
              <button type="button" className="btn btn-danger" disabled={!!busy}
                onClick={() => run("delete", async () => { await api.deleteSegment(s.id); navigate("/"); })}>
                {busy === "delete" ? "Deleting…" : "Confirm delete"}
              </button>
              <button type="button" className="btn" onClick={() => setConfirmDelete(false)}>Keep</button>
            </>
          ) : (
            <button type="button" className="btn btn-danger" disabled={!!busy} onClick={() => setConfirmDelete(true)}>
              Delete
            </button>
          )}
        </div>
      </div>
      {actionError && <p className="error" role="alert">{actionError}</p>}

      <div className="detail-grid">
        <section className="card">
          <h3>Definition</h3>
          <p>{anchor.display} where {describe(s.definition.rule, catalog, names)}</p>
          <div className="small muted">
            {s.member_count === null ? "○ Not materialized: counts are computed live."
              : s.is_stale ? `⚠ Rules changed since last materialization (v${s.materialized_version}). Refresh members.`
              : `✓ ${s.member_count.toLocaleString()} members materialized ${new Date(s.materialized_at!).toLocaleString()} (data as of ${s.materialized_as_of})`}
          </div>
          {s.depends_on.length > 0 && (
            <div className="small">Depends on: {s.depends_on.map((d) => <Link key={d} to={`/segments/${d}`} className="chip">{names[d] ?? d}</Link>)}</div>
          )}
        </section>
        <section className="card">
          {profile.data ? <ShareMeter size={profile.data.segment_size} base={profile.data.base_size} share={profile.data.share} />
            : <p className="muted">Counting…</p>}
        </section>
      </div>

      <h2>Insights</h2>
      {profile.data ? <ProfileView profile={profile.data} />
        : profile.error ? <p className="error">{profile.error.message}</p> : <p className="muted">Profiling…</p>}

      <h2>Members <span className="muted small">({members.data?.source ?? "…"})</span></h2>
      <section className="card">
        {members.data && (
          <>
            <SampleTable fields={members.data.fields} rows={members.data.rows}
              onOpen={(r) => setMember(String(r[members.data!.fields[0]]))} />
            <div className="pager">
              <button type="button" className="btn btn-sm" disabled={page === 0} onClick={() => setPage(page - 1)}>← Prev</button>
              <span className="muted small">Page {page + 1}</span>
              <button type="button" className="btn btn-sm" disabled={members.data.rows.length < PAGE} onClick={() => setPage(page + 1)}>Next →</button>
            </div>
          </>
        )}
      </section>
      {member && <MemberDrawer anchor={s.definition.anchor} memberKey={member} onClose={() => setMember(null)} onOpen={setMember} />}
    </div>
  );
}
