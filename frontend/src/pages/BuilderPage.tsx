import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ApiError, api } from "../api/client";
import type { Row, RuleNode, Segment, SegmentDefinition } from "../api/types";
import { ProfileView, ShareMeter } from "../components/Charts";
import { MemberDrawer } from "../components/MemberDrawer";
import { RuleEditor } from "../components/RuleEditor";
import { useCatalog } from "../lib/catalog";
import { useAsync } from "../lib/hooks";
import { countConditions, describe, fmtNumber, newGroup } from "../lib/rules";

type Tab = "preview" | "insights" | "cypher";

export function BuilderPage() {
  const catalog = useCatalog();
  const { id } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();

  const [anchor, setAnchor] = useState(catalog.anchors[0].id);
  const [rule, setRule] = useState<RuleNode>(newGroup());
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [holdout, setHoldout] = useState(0);
  const [tab, setTab] = useState<Tab>("preview");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [member, setMember] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Segment | null>(null);

  const segments = useAsync(() => api.segments(), []);

  // Load an existing segment or a template.
  useEffect(() => {
    const templateId = search.get("template");
    if (id) {
      api.segment(id).then((s) => {
        setLoaded(s);
        setAnchor(s.definition.anchor);
        setRule(s.definition.rule);
        setName(s.name);
        setDescription(s.description);
        setTags(s.tags.join(", "));
        setHoldout(s.holdout_pct ?? 0);
      });
    } else if (templateId) {
      api.templates().then((ts) => {
        const t = ts.find((x) => x.id === templateId);
        if (!t) return;
        setAnchor(t.definition.anchor);
        setRule(t.definition.rule);
        setName(t.name);
        setDescription(t.description);
        setTags(t.category.toLowerCase());
      });
    }
  }, [id, search]);

  const definition: SegmentDefinition = useMemo(() => ({ anchor, rule }), [anchor, rule]);
  const defKey = JSON.stringify(definition);

  const preview = useAsync((signal) => api.preview(definition, 25, signal), [defKey], 450);
  const cypher = useAsync(
    (signal) => (tab === "cypher" ? api.compile(definition, signal) : Promise.resolve(null)), [defKey, tab], 300);
  const profile = useAsync(
    (signal) => (tab === "insights" ? api.profile({ definition }, signal) : Promise.resolve(null)), [defKey, tab], 600);

  const err = preview.error instanceof ApiError ? preview.error : null;
  const segmentNames = Object.fromEntries((segments.data ?? []).map((s) => [s.id, s.name]));
  const anchorInfo = catalog.anchors.find((a) => a.id === anchor)!;

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    const body = {
      name: name.trim(), description,
      tags: tags.split(",").map((t) => t.trim()).filter(Boolean), definition,
      holdout_pct: holdout,
    };
    try {
      const seg = id ? await api.updateSegment(id, body) : await api.createSegment(body);
      navigate(`/segments/${seg.id}`);
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const keyField = anchorInfo.sample_fields[0];

  return (
    <div className="builder">
      <section className="builder-main">
        <div className="page-head">
          <div>
            <div className="muted small">{id ? `Editing v${loaded?.version ?? ""}` : "New segment"}</div>
            <input className="title-input" placeholder="Segment name" value={name} aria-label="Segment name"
              onChange={(e) => setName(e.target.value)} />
          </div>
        </div>
        <div className="meta-row">
          <label>
            <span className="muted small">Segment</span>
            <select value={anchor} disabled={!!id} onChange={(e) => { setAnchor(e.target.value); setRule(newGroup()); }}>
              {catalog.anchors.map((a) => <option key={a.id} value={a.id}>{a.display}</option>)}
            </select>
          </label>
          <label className="grow">
            <span className="muted small">Description</span>
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this segment for?" />
          </label>
          <label title="Members held out of the campaign so its lift can be measured">
            <span className="muted small">Control group</span>
            <span className="holdout-input">
              <input id="holdout" type="number" className="num" min={0} max={50} step={1} value={holdout}
                onChange={(e) => setHoldout(Math.max(0, Math.min(50, Number(e.target.value) || 0)))} />
              <span className="muted">%</span>
            </span>
          </label>
          <label>
            <span className="muted small">Tags</span>
            <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="retention, q4" />
          </label>
        </div>

        <div className="summary" aria-live="polite">
          <span className="muted small">In plain words · {countConditions(rule)} condition(s)</span>
          <p>{anchorInfo.display} where {describe(rule, catalog, segmentNames)}</p>
        </div>

        <RuleEditor node={rule} onChange={setRule} path="rule" depth={0}
          ctx={{ anchor, segments: segments.data ?? [], errorPath: err?.path, errorMessage: err?.message, selfId: id }} />

        <div className="actions">
          {saveError && <span className="error">{saveError}</span>}
          <button type="button" className="btn" onClick={() => navigate(-1)}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!name.trim() || saving || !!err} onClick={save}>
            {saving ? "Saving…" : id ? "Save new version" : "Save segment"}
          </button>
        </div>
      </section>

      <aside className="builder-side">
        <div className="card">
          {preview.data && !err ? (
            <ShareMeter size={preview.data.segment_size} base={preview.data.base_size} share={preview.data.share} />
          ) : err ? (
            <div className="error" role="alert">
              <strong>Fix the highlighted condition</strong>
              <div className="small">{err.message}</div>
            </div>
          ) : preview.error ? (
            <div className="error">{preview.error.message}</div>
          ) : <div className="muted">Counting…</div>}
          <div className="muted small side-meta">
            {preview.loading ? "Updating…" : preview.data ? `as of ${preview.data.as_of} · ${preview.data.elapsed_ms} ms` : ""}
          </div>
        </div>

        <div className="tabs" role="tablist">
          {(["preview", "insights", "cypher"] as Tab[]).map((t) => (
            <button key={t} role="tab" type="button" aria-selected={tab === t} className={tab === t ? "on" : ""}
              onClick={() => setTab(t)}>
              {t === "preview" ? "Sample" : t === "insights" ? "Insights" : "Cypher"}
            </button>
          ))}
        </div>

        {tab === "preview" && preview.data && (
          <SampleTable compact fields={preview.data.sample_fields} rows={preview.data.sample}
            onOpen={(r) => setMember(String(r[keyField]))} />
        )}
        {tab === "insights" && (
          profile.data ? <ProfileView profile={profile.data} definition={definition} segmentNames={segmentNames} />
            : profile.error ? <p className="error">{profile.error.message}</p>
            : <p className="muted">Profiling segment against the base…</p>
        )}
        {tab === "cypher" && (
          cypher.data ? (
            <div className="cypher">
              <p className="muted small">Generated, parameterised Cypher. Run it as-is in Neo4j Browser.</p>
              <pre><code>{cypher.data.cypher}</code></pre>
              <pre className="params"><code>{`// params\n${JSON.stringify(cypher.data.params, null, 2)}`}</code></pre>
            </div>
          ) : cypher.error ? <p className="error">{cypher.error.message}</p> : <p className="muted">Compiling…</p>
        )}
      </aside>
      {member && (
        <MemberDrawer anchor={anchor} memberKey={member} onClose={() => setMember(null)} onOpen={setMember} />
      )}
    </div>
  );
}

export function SampleTable({ fields, rows, onOpen, compact }: {
  fields: string[]; rows: Row[]; onOpen?: (row: Row) => void; compact?: boolean;
}) {
  const catalog = useCatalog();
  const header = (f: string) => {
    if (f === "group") return "Group";
    const [e, a] = f.split(".");
    return catalog.entities.find((x) => x.id === e)?.attributes.find((x) => x.id === a)?.display ?? f;
  };
  if (!rows.length) return <p className="muted">No matching records.</p>;
  return (
    <div className="table-wrap">
      <table className={`data-table${compact ? " compact" : ""}`}>
        <thead><tr>{fields.map((f) => <th key={f}>{header(f)}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={onOpen ? "clickable" : ""} onClick={() => onOpen?.(r)}>
              {fields.map((f, j) => (
                <td key={f} className={typeof r[f] === "number" ? "num" : ""}>
                  {j === 0 && onOpen ? <button type="button" className="link-btn">{String(r[f])}</button>
                    : typeof r[f] === "number" ? fmtNumber(r[f], 2) : String(r[f] ?? "–")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
