import {
  forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation,
  type Simulation, type SimulationLinkDatum, type SimulationNodeDatum,
} from "d3-force";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { api } from "../api/client";
import type { Expansion, GraphEdge, GraphNode } from "../api/types";
import { MemberDrawer } from "../components/MemberDrawer";
import { useCatalog } from "../lib/catalog";
import { fmtNumber } from "../lib/rules";

type SimNode = GraphNode & SimulationNodeDatum;
type SimLink = Omit<GraphEdge, "source" | "target"> & SimulationLinkDatum<SimNode> & { source: string | SimNode; target: string | SimNode };

interface Drag {
  id: string;
  pointerId: number;
  startScreen: [number, number];
  startPos: [number, number];
  moved: boolean;
}
interface Pan { pointerId: number; start: [number, number]; origin: [number, number] }
interface LinkDraft { a: string; b: string; type: string; at: [number, number] }

const RADIUS: Record<string, number> = { Customer: 20, Subscription: 14 };
const baseRadius = (label: string) => RADIUS[label] ?? 10;
/** With the influence lens on, a line's size grows with its call-graph influence (0-100). */
const nodeRadius = (n: GraphNode, influence: boolean) => {
  const score = n.props.influence_score;
  return influence && n.label === "Subscription" && typeof score === "number" ? 8 + (score / 100) * 18 : baseRadius(n.label);
};
const LABEL_ORDER = ["Customer", "Subscription", "Plan", "Device", "Addon", "City", "Ticket", "MonthlyUsage"];
const DROP_DISTANCE = 34;

const endId = (end: string | SimNode) => (typeof end === "string" ? end : end.id);
const short = (s: string, n = 18) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function GraphPage() {
  const catalog = useCatalog();
  const linkNet = catalog.networks.find((n) => n.id === catalog.link_network);
  const accountLabel = linkNet
    ? catalog.entities.find((e) => e.id === catalog.anchors.find((a) => a.id === linkNet.anchor)?.entity)?.label
    : undefined;
  const linkAttr = linkNet?.edge_attributes.find((a) => a.type === "enum");
  const linkTypes = linkAttr?.values ?? [];

  const nodes = useRef(new Map<string, SimNode>());
  const links = useRef(new Map<string, SimLink>());
  const expanded = useRef(new Set<string>());
  const sim = useRef<Simulation<SimNode, SimLink> | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [, setFrame] = useState(0);
  const frameReq = useRef(0);
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;

  const [focus, setFocus] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [hover, setHover] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [draft, setDraft] = useState<LinkDraft | null>(null);
  const [groupType, setGroupType] = useState(linkTypes[0] ?? "");
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [influence, setInfluence] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<GraphNode[]>([]);
  const [member, setMember] = useState<{ anchor: string; key: string } | null>(null);
  const drag = useRef<Drag | null>(null);
  const pan = useRef<Pan | null>(null);

  const redraw = useCallback(() => {
    if (frameReq.current) return;
    frameReq.current = requestAnimationFrame(() => { frameReq.current = 0; setFrame((f) => f + 1); });
  }, []);

  // ---- simulation --------------------------------------------------------------------------
  useEffect(() => {
    const s = forceSimulation<SimNode, SimLink>([])
      .force("link", forceLink<SimNode, SimLink>([]).id((d) => d.id)
        .distance((l) => (l.type === linkNet?.rel ? 150 : 80)).strength((l) => (l.type === linkNet?.rel ? 0.4 : 0.8)))
      .force("charge", forceManyBody<SimNode>().strength((d) => (d.label === accountLabel ? -520 : -220)))
      .force("collide", forceCollide<SimNode>((d) => nodeRadius(d, true) + 14))
      .force("center", forceCenter(0, 0).strength(0.03))
      .on("tick", redraw);
    sim.current = s;
    return () => { s.stop(); };
  }, [redraw, linkNet?.rel, accountLabel]);

  const syncSim = useCallback((heat = 0.7) => {
    const s = sim.current;
    if (!s) return;
    s.nodes([...nodes.current.values()]);
    (s.force("link") as ReturnType<typeof forceLink<SimNode, SimLink>>).links([...links.current.values()]);
    s.alpha(heat).restart();
  }, []);

  const addExpansion = useCallback((exp: Expansion) => {
    const center = nodes.current.get(exp.center);
    const cx = center?.x ?? 0;
    const cy = center?.y ?? 0;
    exp.nodes.forEach((n, i) => {
      const cur = nodes.current.get(n.id);
      if (cur) { Object.assign(cur, { ...n, x: cur.x, y: cur.y }); return; }
      const angle = (i / Math.max(1, exp.nodes.length)) * Math.PI * 2;
      nodes.current.set(n.id, { ...n, x: cx + Math.cos(angle) * 60, y: cy + Math.sin(angle) * 60 });
    });
    for (const e of exp.edges) if (!links.current.has(e.id)) links.current.set(e.id, { ...e });
    expanded.current.add(exp.center);
    syncSim();
  }, [syncSim]);

  const expand = useCallback(async (id: string, limit = 30) => {
    setBusy(true);
    try {
      addExpansion(await api.graphExpand(id, limit));
    } catch (e) {
      setStatus({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  }, [addExpansion]);

  // Open on a real linked household so the canvas shows what linking looks like.
  useEffect(() => {
    let alive = true;
    (async () => {
      if (nodes.current.size) return;
      const { node } = await api.graphStart();
      if (!alive || !node) return;
      const first = await api.graphExpand(node, 30);
      if (!alive) return;
      addExpansion(first);
      const linked = first.edges.filter((e) => e.type === linkNet?.rel)
        .map((e) => (e.source === node ? e.target : e.source));
      for (const id of linked.slice(0, 6)) {
        const exp = await api.graphExpand(id, 8);
        if (!alive) return;
        addExpansion(exp);
      }
      setFocus(node);
    })().catch((e) => setStatus({ text: (e as Error).message, error: true }));
    return () => { alive = false; };
  }, [addExpansion, linkNet?.rel]);

  // ---- coordinates ---------------------------------------------------------------------------
  const toGraph = (clientX: number, clientY: number): [number, number] => {
    const rect = svgRef.current!.getBoundingClientRect();
    const v = viewRef.current;
    return [(clientX - rect.left - rect.width / 2 - v.x) / v.k, (clientY - rect.top - rect.height / 2 - v.y) / v.k];
  };
  const toScreen = (x: number, y: number): [number, number] => {
    const rect = svgRef.current?.getBoundingClientRect();
    const v = viewRef.current;
    return [(rect?.width ?? 0) / 2 + v.x + x * v.k, (rect?.height ?? 0) / 2 + v.y + y * v.k];
  };

  const fit = useCallback(() => {
    const list = [...nodes.current.values()];
    const rect = svgRef.current?.getBoundingClientRect();
    if (!list.length || !rect) return;
    const xs = list.map((n) => n.x ?? 0);
    const ys = list.map((n) => n.y ?? 0);
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const k = Math.max(0.2, Math.min(1.6, Math.min((rect.width - 80) / (maxX - minX + 1), (rect.height - 80) / (maxY - minY + 1))));
    setView({ k, x: -((minX + maxX) / 2) * k, y: -((minY + maxY) / 2) * k });
  }, []);

  // ---- pointer handling ----------------------------------------------------------------------
  const isAccount = (id: string | null) => !!id && nodes.current.get(id)?.label === accountLabel;

  const onNodeDown = (e: RPointerEvent, id: string) => {
    e.stopPropagation();
    const n = nodes.current.get(id)!;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = { id, pointerId: e.pointerId, startScreen: [e.clientX, e.clientY], startPos: [n.x ?? 0, n.y ?? 0], moved: false };
  };

  const onPointerMove = (e: RPointerEvent) => {
    const d = drag.current;
    if (d && d.pointerId === e.pointerId) {
      if (!d.moved && Math.hypot(e.clientX - d.startScreen[0], e.clientY - d.startScreen[1]) < 4) return;
      if (!d.moved) { d.moved = true; sim.current?.alphaTarget(0.15).restart(); }
      const n = nodes.current.get(d.id)!;
      const [gx, gy] = toGraph(e.clientX, e.clientY);
      n.fx = gx; n.fy = gy;
      let target: string | null = null;
      if (isAccount(d.id)) {
        let best = DROP_DISTANCE / viewRef.current.k + baseRadius(n.label);
        for (const other of nodes.current.values()) {
          if (other.id === d.id || other.label !== accountLabel) continue;
          const dist = Math.hypot((other.x ?? 0) - gx, (other.y ?? 0) - gy);
          if (dist < best) { best = dist; target = other.id; }
        }
      }
      setDropTarget(target);
      redraw();
      return;
    }
    const p = pan.current;
    if (p && p.pointerId === e.pointerId) {
      setView((v) => ({ ...v, x: p.origin[0] + e.clientX - p.start[0], y: p.origin[1] + e.clientY - p.start[1] }));
    }
  };

  const onPointerUp = (e: RPointerEvent) => {
    const d = drag.current;
    if (d && d.pointerId === e.pointerId) {
      drag.current = null;
      sim.current?.alphaTarget(0);
      const n = nodes.current.get(d.id)!;
      if (!d.moved) {
        n.fx = null; n.fy = null;
        if (e.shiftKey || e.metaKey || e.ctrlKey) {
          if (isAccount(d.id)) setSelected((s) => (s.includes(d.id) ? s.filter((x) => x !== d.id) : [...s, d.id]));
        } else {
          setFocus(d.id);
        }
      } else if (dropTarget) {
        // Dropped onto another account: ask how to link, and put the node back.
        [n.fx, n.fy] = d.startPos;
        n.x = d.startPos[0]; n.y = d.startPos[1];
        const tgt = nodes.current.get(dropTarget)!;
        setDraft({ a: d.id, b: dropTarget, type: linkTypes[0], at: toScreen(tgt.x ?? 0, tgt.y ?? 0) });
        setTimeout(() => { n.fx = null; n.fy = null; sim.current?.alpha(0.3).restart(); }, 50);
      }
      setDropTarget(null);
      redraw();
      return;
    }
    if (pan.current && pan.current.pointerId === e.pointerId) pan.current = null;
  };

  const onBackgroundDown = (e: RPointerEvent) => {
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    pan.current = { pointerId: e.pointerId, start: [e.clientX, e.clientY], origin: [viewRef.current.x, viewRef.current.y] };
    setDraft(null);
  };

  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      setView((v) => {
        const k = Math.max(0.2, Math.min(3, v.k * Math.exp(-e.deltaY * 0.0015)));
        const cx = e.clientX - rect.left - rect.width / 2;
        const cy = e.clientY - rect.top - rect.height / 2;
        return { k, x: cx - ((cx - v.x) * k) / v.k, y: cy - ((cy - v.y) * k) / v.k };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // ---- linking ---------------------------------------------------------------------------------
  const keyOf = (id: string) => id.slice(id.indexOf(":") + 1);
  const caption = (id: string) => nodes.current.get(id)?.caption ?? id;

  const addEdges = (list: GraphEdge[]) => {
    for (const e of list) {
      for (const old of links.current.values()) {
        const same = old.type === e.type && ((endId(old.source) === e.source && endId(old.target) === e.target)
          || (endId(old.source) === e.target && endId(old.target) === e.source));
        if (same) links.current.delete(old.id);
      }
      links.current.set(e.id, { ...e });
    }
    syncSim(0.4);
  };

  const createLink = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const edge = await api.link(keyOf(draft.a), keyOf(draft.b), draft.type);
      addEdges([edge]);
      setStatus({ text: `Linked ${caption(draft.a)} and ${caption(draft.b)} as ${draft.type}.` });
      setDraft(null);
    } catch (e) {
      setStatus({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };

  const linkSelected = async () => {
    setBusy(true);
    try {
      const created = await api.linkGroup(selected.map(keyOf), groupType);
      addEdges(created);
      setStatus({ text: `Linked ${selected.length} accounts as ${groupType}, with ${caption(selected[0])} as the main account.` });
      setSelected([]);
    } catch (e) {
      setStatus({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };

  const removeLink = async (edge: SimLink) => {
    const a = endId(edge.source);
    const b = endId(edge.target);
    setBusy(true);
    try {
      await api.unlink(keyOf(a), keyOf(b));
      links.current.delete(edge.id);
      syncSim(0.3);
      setStatus({ text: `Removed the link between ${caption(a)} and ${caption(b)}.` });
    } catch (e) {
      setStatus({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
    }
  };

  const hide = (id: string) => {
    nodes.current.delete(id);
    for (const [lid, l] of links.current) if (endId(l.source) === id || endId(l.target) === id) links.current.delete(lid);
    expanded.current.delete(id);
    setSelected((s) => s.filter((x) => x !== id));
    if (focus === id) setFocus(null);
    syncSim(0.2);
  };

  const clear = () => {
    nodes.current.clear();
    links.current.clear();
    expanded.current.clear();
    setSelected([]);
    setFocus(null);
    syncSim(0);
  };

  // ---- search -------------------------------------------------------------------------------------
  useEffect(() => {
    if (!query.trim()) { setResults([]); return; }
    let alive = true;
    const t = setTimeout(() => {
      api.graphSearch(query).then((r) => alive && setResults(r)).catch(() => {});
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [query]);

  const addFromSearch = async (n: GraphNode) => {
    if (!nodes.current.has(n.id)) {
      const v = viewRef.current;
      nodes.current.set(n.id, { ...n, x: -v.x / v.k + (Math.random() - 0.5) * 80, y: -v.y / v.k + (Math.random() - 0.5) * 80 });
    }
    setFocus(n.id);
    setQuery("");
    await expand(n.id, 20);
  };

  // ---- render ------------------------------------------------------------------------------------
  const nodeList = [...nodes.current.values()];
  const linkList = [...links.current.values()];
  const focusNode = focus ? nodes.current.get(focus) : undefined;
  const neighbourhood = useMemo(() => {
    const set = new Set<string>();
    const id = hover ?? focus;
    if (!id) return set;
    set.add(id);
    for (const l of links.current.values()) {
      if (endId(l.source) === id) set.add(endId(l.target));
      if (endId(l.target) === id) set.add(endId(l.source));
    }
    return set;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hover, focus, linkList.length]);

  const counts = new Map<string, number>();
  for (const n of nodeList) counts.set(n.label, (counts.get(n.label) ?? 0) + 1);
  const accountLinks = focusNode
    ? linkList.filter((l) => l.type === linkNet?.rel && (endId(l.source) === focusNode.id || endId(l.target) === focusNode.id))
    : [];
  const visibleEdges = focusNode ? linkList.filter((l) => endId(l.source) === focusNode.id || endId(l.target) === focusNode.id).length : 0;
  const anchorFor = (label: string) => catalog.anchors.find((a) => catalog.entities.find((e) => e.id === a.entity)?.label === label)?.id;
  const dragId = drag.current?.moved ? drag.current.id : null;

  return (
    <div className="graph-page">
      <aside className="graph-side">
        <div>
          <h1>Graph</h1>
          <p className="muted small">
            Explore the customer graph. Drag one customer onto another to link the accounts.
            Double-click a node to expand it. Shift-click customers to link several at once.
          </p>
        </div>

        <div className="graph-search">
          <label htmlFor="graph-search" className="muted small">Find a customer or line</label>
          <input id="graph-search" type="search" placeholder="Name, customer ID or MSISDN" value={query}
            onChange={(e) => setQuery(e.target.value)} autoComplete="off" />
          {results.length > 0 && (
            <ul className="graph-results" role="listbox" aria-label="Search results">
              {results.map((r) => (
                <li key={r.id}>
                  <button type="button" onClick={() => addFromSearch(r)}>
                    <i className={`dot node-${r.label}`} aria-hidden /> <span>{r.caption}</span>
                    <span className="muted small">{r.label} · {r.key}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {linkNet && (
          <section className="graph-card">
            <h3>Link several accounts</h3>
            {selected.length === 0 ? (
              <p className="muted small">Shift-click customers on the canvas to select them.</p>
            ) : (
              <>
                <ol className="sel-list">
                  {selected.map((id, i) => (
                    <li key={id}>
                      <span>{caption(id)}</span>
                      {i === 0 && <span className="pill">main</span>}
                      <button type="button" className="icon-btn" aria-label={`Remove ${caption(id)} from selection`}
                        onClick={() => setSelected((s) => s.filter((x) => x !== id))}>×</button>
                    </li>
                  ))}
                </ol>
                <div className="chips" role="radiogroup" aria-label="Link type">
                  {linkTypes.map((t) => (
                    <button key={t} type="button" role="radio" aria-checked={groupType === t}
                      className={`chip${groupType === t ? " on" : ""}`} onClick={() => setGroupType(t)}>{t}</button>
                  ))}
                </div>
                <div className="btn-row">
                  <button type="button" className="btn btn-primary btn-sm" disabled={selected.length < 2 || busy} onClick={linkSelected}>
                    Link {selected.length} accounts
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => setSelected([])}>Clear</button>
                </div>
              </>
            )}
          </section>
        )}

        {focusNode ? (
          <section className="graph-card">
            <div className="focus-head">
              <i className={`dot node-${focusNode.label}`} aria-hidden />
              <div>
                <h3>{focusNode.caption}</h3>
                <div className="muted small">{focusNode.label} · {focusNode.key}</div>
              </div>
            </div>
            <div className="btn-row">
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => expand(focusNode.id, 60)}>
                Expand{focusNode.degree !== undefined && focusNode.degree > visibleEdges ? ` (+${fmtNumber(focusNode.degree - visibleEdges)})` : ""}
              </button>
              {anchorFor(focusNode.label) && (
                <button type="button" className="btn btn-sm" onClick={() => setMember({ anchor: anchorFor(focusNode.label)!, key: focusNode.key })}>
                  360° view
                </button>
              )}
              <button type="button" className="btn btn-sm" onClick={() => hide(focusNode.id)}>Hide</button>
            </div>
            {focusNode.label === accountLabel && (
              <div>
                <div className="muted small">Linked accounts on canvas</div>
                {accountLinks.length === 0 ? <p className="muted small">None yet. Drag this customer onto another one.</p> : (
                  <ul className="link-list">
                    {accountLinks.map((l) => {
                      const other = endId(l.source) === focusNode.id ? endId(l.target) : endId(l.source);
                      return (
                        <li key={l.id}>
                          <button type="button" className="link-btn" onClick={() => setFocus(other)}>{caption(other)}</button>
                          <span className="pill">{String(l.props[linkAttr?.property ?? "link_type"] ?? "")}</span>
                          <button type="button" className="btn btn-sm btn-danger" disabled={busy} onClick={() => removeLink(l)}>Unlink</button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
            <dl className="kv compact-kv">
              {Object.entries(focusNode.props).slice(0, 12).map(([k, v]) => (
                <div key={k}><dt>{k}</dt><dd>{typeof v === "boolean" ? (v ? "Yes" : "No") : String(v ?? "–")}</dd></div>
              ))}
            </dl>
          </section>
        ) : (
          <section className="graph-card muted small">Click a node to see its details.</section>
        )}
      </aside>

      <section className="graph-canvas-wrap">
        <div className="graph-toolbar">
          <div className="legend small">
            {LABEL_ORDER.filter((l) => counts.has(l)).map((l) => (
              <span key={l}><i className={`dot node-${l}`} aria-hidden /> {l} <span className="muted">{counts.get(l)}</span></span>
            ))}
            {linkNet && <span><i className="line-swatch" aria-hidden /> {linkNet.display}</span>}
          </div>
          <div className="btn-row">
            <button type="button" className={`btn btn-sm${influence ? " on" : ""}`} aria-pressed={influence}
              title="Size lines by call-graph influence" onClick={() => setInfluence(!influence)}>Influence</button>
            <button type="button" className="btn btn-sm" onClick={fit}>Fit</button>
            <button type="button" className="btn btn-sm" onClick={() => setView((v) => ({ ...v, k: Math.min(3, v.k * 1.25) }))} aria-label="Zoom in">+</button>
            <button type="button" className="btn btn-sm" onClick={() => setView((v) => ({ ...v, k: Math.max(0.2, v.k / 1.25) }))} aria-label="Zoom out">−</button>
            <button type="button" className="btn btn-sm" onClick={clear}>Clear</button>
          </div>
        </div>
        <svg ref={svgRef} className={`graph-canvas${dragId ? " dragging" : ""}`} role="application"
          aria-label="Customer graph canvas" onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
          <rect className="graph-bg" x="-50%" y="-50%" width="200%" height="200%" onPointerDown={onBackgroundDown} />
          <g transform={`translate(${(svgRef.current?.clientWidth ?? 0) / 2 + view.x},${(svgRef.current?.clientHeight ?? 0) / 2 + view.y}) scale(${view.k})`}>
            {linkList.map((l) => {
              const s = typeof l.source === "string" ? nodes.current.get(l.source) : l.source;
              const t = typeof l.target === "string" ? nodes.current.get(l.target) : l.target;
              if (!s || !t) return null;
              const isLink = l.type === linkNet?.rel;
              const lit = neighbourhood.has(s.id) && neighbourhood.has(t.id) && (neighbourhood.size > 0);
              const mx = ((s.x ?? 0) + (t.x ?? 0)) / 2;
              const my = ((s.y ?? 0) + (t.y ?? 0)) / 2;
              return (
                <g key={l.id} className={`edge${isLink ? " edge-account" : ""}${lit ? " lit" : ""}`}>
                  <line x1={s.x} y1={s.y} x2={t.x} y2={t.y} />
                  {(isLink || lit) && (
                    <text x={mx} y={my - 4} textAnchor="middle" className="edge-label">
                      {isLink ? String(l.props[linkAttr?.property ?? "link_type"] ?? "") : l.type}
                    </text>
                  )}
                </g>
              );
            })}
            {dragId && dropTarget && (() => {
              const a = nodes.current.get(dragId)!;
              const b = nodes.current.get(dropTarget)!;
              return <line className="drop-preview" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
            })()}
            {nodeList.map((n) => {
              const r = nodeRadius(n, influence);
              const hidden = n.degree !== undefined ? n.degree - linkList.filter((l) => endId(l.source) === n.id || endId(l.target) === n.id).length : 0;
              const cls = [
                "node", `node-${n.label}`,
                focus === n.id ? "focused" : "",
                selected.includes(n.id) ? "selected" : "",
                dropTarget === n.id ? "drop-target" : "",
                dragId === n.id ? "dragged" : "",
                neighbourhood.size && !neighbourhood.has(n.id) ? "dim" : "",
              ].join(" ");
              return (
                <g key={n.id} className={cls} transform={`translate(${n.x ?? 0},${n.y ?? 0})`}
                  onPointerDown={(e) => onNodeDown(e, n.id)} onDoubleClick={() => expand(n.id)}
                  onPointerEnter={() => setHover(n.id)} onPointerLeave={() => setHover(null)}
                  tabIndex={0} role="button"
                  aria-label={`${n.label} ${n.caption}${selected.includes(n.id) ? ", selected" : ""}`}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") setFocus(n.id);
                    if (e.key === " " && n.label === accountLabel) {
                      e.preventDefault();
                      setSelected((s) => (s.includes(n.id) ? s.filter((x) => x !== n.id) : [...s, n.id]));
                    }
                    if (e.key === "e") expand(n.id);
                  }}>
                  <circle className="halo" r={r + 7} />
                  <circle className="body" r={r} />
                  <text className="glyph" textAnchor="middle" dy="0.35em">{n.label.slice(0, n.label === "Subscription" ? 3 : 2).toUpperCase()}</text>
                  <text className="caption" textAnchor="middle" y={r + 14}>{short(n.caption)}</text>
                  {hidden > 0 && !expanded.current.has(n.id) && (
                    <text className="more" textAnchor="middle" y={-r - 6}>+{hidden}</text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>

        {draft && (
          <div className="link-dialog" role="dialog" aria-label="Link accounts"
            style={{ left: Math.min(draft.at[0] + 20, (svgRef.current?.clientWidth ?? 400) - 300), top: Math.max(8, draft.at[1] - 40) }}
            onKeyDown={(e) => e.key === "Escape" && setDraft(null)}>
            <strong>Link accounts</strong>
            <p className="small">{caption(draft.a)} ↔ {caption(draft.b)}</p>
            <div className="chips" role="radiogroup" aria-label="Link type">
              {linkTypes.map((t) => (
                <button key={t} type="button" role="radio" aria-checked={draft.type === t}
                  className={`chip${draft.type === t ? " on" : ""}`} onClick={() => setDraft({ ...draft, type: t })}>{t}</button>
              ))}
            </div>
            <div className="btn-row">
              <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={createLink} autoFocus>Link</button>
              <button type="button" className="btn btn-sm" onClick={() => setDraft(null)}>Cancel</button>
            </div>
          </div>
        )}
        {status && (
          <div className={`graph-status${status.error ? " error" : ""}`} role="status">
            {status.text}
            <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setStatus(null)}>×</button>
          </div>
        )}
        {nodeList.length === 0 && !busy && (
          <div className="graph-empty muted">Search for a customer to start exploring.</div>
        )}
      </section>
      {member && <MemberDrawer anchor={member.anchor} memberKey={member.key} onClose={() => setMember(null)}
        onOpen={(key) => setMember({ anchor: member.anchor, key })} />}
    </div>
  );
}
