/**
 * Offline stand-in for the SegVal API, used by the demo build (VITE_DEMO=1).
 * Mirrors backend/segval/services/{segments,insights}.py over the in-memory graph.
 */
import { ApiError } from "../api/errors";
import type {
  Catalog, Dimension, Expansion, GraphEdge, GraphNode, Kpi, MemberView, Overlap, Preview, Profile,
  Row, Segment, SegmentDefinition, SegmentInput, Template,
} from "../api/types";

import { CompileError, Compiler, Graph, edges, traverse, type GNode, type Snapshot } from "./engine";
import raw from "./data.json";

const STORE_KEY = "segval-demo-v1";
const SEED_TEMPLATES = ["five_g_upsell", "churn_contagion", "social_influencers", "high_value_at_risk"];

interface LinkOp { op: "link" | "unlink"; a: string; b: string; type?: string; at?: string }
interface Stored { segments: Segment[]; members: Record<string, string[]>; linkOps?: LinkOp[] }

const CAPTION_PROPS = ["full_name", "name", "model", "msisdn", "category", "month"];
const REL_PRIORITY = ["LINKED_TO", "OWNS", "ON_PLAN", "USES_DEVICE", "LIVES_IN", "HAS_ADDON", "RAISED", "CALLED"];

export function bucketLabels(edgesList: number[]): string[] {
  const fmt = (v: number) => String(v);
  const labels = [`< ${fmt(edgesList[0])}`];
  for (let i = 0; i + 1 < edgesList.length; i++) labels.push(`${fmt(edgesList[i])} – ${fmt(edgesList[i + 1])}`);
  labels.push(`≥ ${fmt(edgesList[edgesList.length - 1])}`);
  return labels;
}

/** Python's round(): halves go to the even neighbour. */
function pyRound(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

const pct = (part: number, whole: number) => (whole ? part / whole : 0);
const now = () => new Date().toISOString().slice(0, 19) + "+00:00";

export class DemoService {
  readonly catalog: Catalog;
  readonly templates: Template[];
  readonly asOf: string;
  readonly graph: Graph;
  private segs = new Map<string, Segment>();
  private members = new Map<string, Set<GNode>>();
  private linkOps: LinkOp[] = [];
  private compiler: Compiler;

  constructor(snap: Snapshot) {
    this.catalog = snap.catalog;
    this.templates = snap.templates as Template[];
    this.asOf = snap.as_of;
    const keys: Record<string, string> = { MonthlyUsage: "usage_id" };
    for (const e of this.catalog.entities) keys[e.label] = e.key;
    this.graph = new Graph(snap, keys);
    this.compiler = new Compiler(this.catalog, {
      asOf: this.asOf,
      members: (id) => this.members.get(id),
    });
    if (!this.load()) this.seed();
  }

  // ---- persistence (per-viewer convenience only) ------------------------------------------
  private load(): boolean {
    try {
      const text = localStorage.getItem(STORE_KEY);
      if (!text) return false;
      const data = JSON.parse(text) as Stored;
      for (const s of data.segments) this.segs.set(s.id, s);
      for (const op of data.linkOps ?? []) {
        try { op.op === "link" ? this.link(op.a, op.b, op.type!, false, op.at) : this.unlink(op.a, op.b, false); }
        catch { /* the account may no longer exist */ }
      }
      for (const [id, keys] of Object.entries(data.members)) {
        const s = this.segs.get(id);
        if (!s) continue;
        const label = this.anchorLabel(s.definition.anchor);
        this.members.set(id, new Set(keys.map((k) => this.graph.get(label, k)).filter((n): n is GNode => !!n)));
      }
      return true;
    } catch {
      return false;
    }
  }

  private save() {
    try {
      const members: Record<string, string[]> = {};
      for (const [id, set] of this.members) members[id] = [...set].map((n) => n.key);
      localStorage.setItem(STORE_KEY, JSON.stringify({ segments: [...this.segs.values()], members, linkOps: this.linkOps }));
    } catch { /* storage unavailable: keep state in memory */ }
  }

  private seed() {
    for (const tid of SEED_TEMPLATES) {
      const t = this.templates.find((x) => x.id === tid);
      if (!t) continue;
      const s = this.create({ name: t.name, description: t.description, tags: [t.category.toLowerCase()], definition: t.definition });
      this.materialize(s.id);
    }
  }

  reset() {
    this.segs.clear();
    this.members.clear();
    this.seed();
  }

  // ---- helpers ---------------------------------------------------------------------------------
  private anchorEntity(anchor: string) {
    const a = this.catalog.anchors.find((x) => x.id === anchor);
    if (!a) throw new ApiError(404, `not found: ${anchor}`);
    return this.catalog.entities.find((e) => e.id === a.entity)!;
  }
  private anchorLabel(anchor: string) { return this.anchorEntity(anchor).label; }

  private compile(def: SegmentDefinition) {
    try {
      return this.compiler.compile(def);
    } catch (e) {
      if (e instanceof CompileError) throw new ApiError(422, e.detail, e.path);
      throw e;
    }
  }

  private resolveField(field: string) {
    const [eid, aid] = field.split(".");
    const entity = this.catalog.entities.find((e) => e.id === eid);
    const attr = entity?.attributes.find((a) => a.id === aid);
    if (!entity || !attr) throw new ApiError(400, `unknown field ${field}`);
    return { entity, attr };
  }

  private project(node: GNode, anchor: string, field: string): unknown {
    const { entity, attr } = this.resolveField(field);
    const hops = entity.paths[anchor];
    if (!hops) throw new ApiError(400, `${field} is not reachable from ${anchor}`);
    if (!hops.length) return node.props[attr.property] ?? null;
    return traverse(node, hops)[0]?.props[attr.property] ?? null;
  }

  private rows(nodes: GNode[], anchor: string, fields: string[]): Row[] {
    return nodes.map((n) => Object.fromEntries(fields.map((f) => [f, this.project(n, anchor, f)])));
  }

  private matching(def: SegmentDefinition) {
    const cp = this.compile(def);
    const base = this.graph.nodes(cp.label);
    const inSeg = new Set(base.filter(cp.test));
    return { cp, base, inSeg };
  }

  private sortByKey(nodes: GNode[]) {
    return [...nodes].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  private checkReferences(def: SegmentDefinition, selfId?: string) {
    const refs = new Set<string>();
    const walk = (n: SegmentDefinition["rule"] | null | undefined) => {
      if (!n) return;
      if (n.kind === "segment") refs.add(n.segment_id);
      if (n.kind === "group") n.children.forEach(walk);
      if (n.kind === "related" || n.kind === "network") walk(n.where);
    };
    walk(def.rule);
    for (const ref of refs) {
      if (selfId && ref === selfId) throw new ApiError(422, "a segment cannot reference itself", "rule");
      const seg = this.segs.get(ref);
      if (!seg) throw new ApiError(422, `referenced segment '${ref}' does not exist`, "rule");
      if (seg.definition.anchor !== def.anchor) {
        throw new ApiError(422, `segment '${seg.name}' is a ${seg.definition.anchor} segment; expected ${def.anchor}`, "rule");
      }
      if (selfId && this.closure(ref).has(selfId)) throw new ApiError(422, `segment '${seg.name}' depends on this segment (cycle)`, "rule");
    }
    return [...refs].sort();
  }

  private closure(id: string): Set<string> {
    const seen = new Set<string>();
    const frontier = [...(this.segs.get(id)?.depends_on ?? [])];
    while (frontier.length) {
      const next = frontier.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      frontier.push(...(this.segs.get(next)?.depends_on ?? []));
    }
    return seen;
  }

  private get(id: string): Segment {
    const s = this.segs.get(id);
    if (!s) throw new ApiError(404, `not found: ${id}`);
    return { ...s, is_stale: s.materialized_version !== s.version };
  }

  // ---- API surface ---------------------------------------------------------------------------
  values(field: string, prefix = "") {
    const { entity, attr } = this.resolveField(field);
    if (attr.values) return { values: attr.values };
    if (attr.type !== "string") throw new ApiError(400, "value suggestions are only available for text fields");
    const counts = new Map<string, number>();
    for (const n of this.graph.nodes(entity.label)) {
      const v = n.props[attr.property];
      if (v == null || !String(v).toLowerCase().startsWith(prefix.toLowerCase())) continue;
      counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
    }
    return { values: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 50).map(([v]) => v) };
  }

  cypher(def: SegmentDefinition) {
    const cp = this.compile(def);
    return { cypher: `MATCH (a:\`${cp.label}\`)\nWHERE ${cp.predicate}\nRETURN a`, params: cp.params };
  }

  preview(def: SegmentDefinition, sampleSize = 25): Preview {
    this.checkReferences(def);
    const started = performance.now();
    const { cp, base, inSeg } = this.matching(def);
    const anchor = this.catalog.anchors.find((a) => a.id === cp.anchor)!;
    const sample = sampleSize > 0 ? this.rows(this.sortByKey([...inSeg]).slice(0, sampleSize), cp.anchor, anchor.sample_fields) : [];
    return {
      segment_size: inSeg.size, base_size: base.length, share: pct(inSeg.size, base.length),
      sample_fields: anchor.sample_fields, sample, as_of: this.asOf,
      elapsed_ms: Math.round((performance.now() - started) * 10) / 10,
    };
  }

  list(): Segment[] {
    return [...this.segs.keys()].map((id) => this.get(id))
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
  }

  segment(id: string) { return this.get(id); }

  create(body: SegmentInput): Segment {
    if (!body.name.trim()) throw new ApiError(422, "name is required");
    const deps = this.checkReferences(body.definition);
    this.compile(body.definition);
    const ts = now();
    const s: Segment = {
      id: Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join(""),
      name: body.name, description: body.description, tags: body.tags, owner: null,
      definition: body.definition, version: 1, created_at: ts, updated_at: ts,
      member_count: null, materialized_at: null, materialized_version: null, materialized_as_of: null,
      depends_on: deps, is_stale: true,
    };
    this.segs.set(s.id, s);
    this.save();
    return this.get(s.id);
  }

  update(id: string, body: SegmentInput): Segment {
    const cur = this.get(id);
    const deps = this.checkReferences(body.definition, id);
    this.compile(body.definition);
    const changed = JSON.stringify(cur.definition) !== JSON.stringify(body.definition);
    this.segs.set(id, {
      ...cur, name: body.name, description: body.description, tags: body.tags,
      definition: body.definition, depends_on: deps, updated_at: now(),
      version: cur.version + (changed ? 1 : 0),
    });
    this.save();
    return this.get(id);
  }

  delete(id: string) {
    this.get(id);
    const dependants = [...this.segs.values()].filter((s) => s.depends_on.includes(id));
    if (dependants.length) throw new ApiError(409, `segment is used by: ${dependants.map((s) => s.name).join(", ")}`);
    this.segs.delete(id);
    this.members.delete(id);
    this.save();
  }

  materialize(id: string, visiting = new Set<string>()): Segment {
    if (visiting.has(id)) throw new ApiError(422, "segment dependency cycle detected", "rule");
    visiting.add(id);
    const seg = this.get(id);
    for (const dep of seg.depends_on) {
      const d = this.segs.get(dep);
      if (d && (d.materialized_version !== d.version || d.member_count === null)) this.materialize(dep, visiting);
    }
    const { inSeg } = this.matching(seg.definition);
    this.members.set(id, inSeg);
    this.segs.set(id, {
      ...this.segs.get(id)!, member_count: inSeg.size, materialized_at: now(),
      materialized_version: seg.version, materialized_as_of: this.asOf,
    });
    this.save();
    return this.get(id);
  }

  membersPage(id: string, limit: number, skip: number) {
    const seg = this.get(id);
    const anchor = this.catalog.anchors.find((a) => a.id === seg.definition.anchor)!;
    const materialized = seg.member_count !== null && this.members.has(id);
    const nodes = materialized ? [...this.members.get(id)!] : [...this.matching(seg.definition).inSeg];
    return {
      fields: anchor.sample_fields,
      rows: this.rows(this.sortByKey(nodes).slice(skip, skip + limit), seg.definition.anchor, anchor.sample_fields),
      source: materialized ? "materialized" : "live",
    };
  }

  // ---- insights ------------------------------------------------------------------------------
  profile(body: { definition?: SegmentDefinition; segment_id?: string; dimensions?: string[] }): Profile {
    const def = body.segment_id ? this.get(body.segment_id).definition : body.definition;
    if (!def) throw new ApiError(400, "provide a definition or a segment_id");
    this.checkReferences(def);
    const { cp, base, inSeg } = this.matching(def);
    const anchor = this.catalog.anchors.find((a) => a.id === cp.anchor)!;
    return {
      anchor: cp.anchor, as_of: this.asOf,
      segment_size: inSeg.size, base_size: base.length, share: pct(inSeg.size, base.length),
      kpis: this.kpis(cp.anchor, base, inSeg),
      dimensions: (body.dimensions ?? anchor.profile_dimensions).map((f) => this.breakdown(cp.anchor, f, base, inSeg)),
    };
  }

  private valueOf(attr: Catalog["entities"][number]["attributes"][number], v: unknown): string | null {
    if (v === null || v === undefined) return null;
    if (attr.type === "number" && attr.buckets) {
      const labels = bucketLabels(attr.buckets);
      const i = attr.buckets.findIndex((edge) => (v as number) < edge);
      return labels[i === -1 ? labels.length - 1 : i];
    }
    if (attr.type === "date") return `${String(v).slice(0, 7)}-01`;
    return String(v);
  }

  private breakdown(anchor: string, field: string, base: GNode[], inSeg: Set<GNode>): Dimension {
    const { entity, attr } = this.resolveField(field);
    const hops = entity.paths[anchor];
    if (!hops) throw new ApiError(400, `${field} is not reachable from ${anchor}`);
    const groups = new Map<string | null, { seg: Set<GNode>; base: Set<GNode> }>();
    for (const n of base) {
      const targets = hops.length ? traverse(n, hops) : [n];
      const values = targets.length ? targets.map((t) => this.valueOf(attr, t.props[attr.property])) : [null];
      for (const v of values) {
        const g = groups.get(v) ?? { seg: new Set(), base: new Set() };
        g.base.add(n);
        if (inSeg.has(n)) g.seg.add(n);
        groups.set(v, g);
      }
    }
    let rows = [...groups].map(([value, g]) => {
      const segPct = pct(g.seg.size, inSeg.size);
      const basePct = pct(g.base.size, base.length);
      return {
        value: value ?? "(none)", segment: g.seg.size, base: g.base.size,
        segment_pct: segPct, base_pct: basePct, index: basePct ? pyRound((100 * segPct) / basePct) : null,
      };
    }).sort((a, b) => b.base - a.base).slice(0, 60);
    if (attr.buckets) {
      const order = new Map(bucketLabels(attr.buckets).map((l, i) => [l, i]));
      rows = rows.sort((a, b) => (order.get(a.value) ?? order.size) - (order.get(b.value) ?? order.size));
    } else if (attr.values) {
      const order = new Map(attr.values.map((v, i) => [v, i]));
      rows = rows.sort((a, b) => (order.get(a.value) ?? order.size) - (order.get(b.value) ?? order.size) || b.base - a.base);
    }
    return {
      field, display: hops.length ? `${entity.display} · ${attr.display}` : attr.display,
      type: attr.type, unit: attr.unit, multi_valued: !!entity.multi_valued[anchor], rows,
    };
  }

  private kpis(anchor: string, base: GNode[], inSeg: Set<GNode>): Kpi[] {
    const spec = this.catalog.anchors.find((a) => a.id === anchor)?.kpis ?? [];
    return spec.map((k) => {
      const value = k.field
        ? (n: GNode) => this.project(n, anchor, k.field!) as number | null
        : this.compiler.metricValue(k.metric!, k.window_months, anchor);
      const avg = (nodes: Iterable<GNode>) => {
        let sum = 0; let count = 0;
        for (const n of nodes) { const v = value(n); if (typeof v === "number") { sum += v; count += 1; } }
        return count ? sum / count : null;
      };
      const seg = avg(inSeg);
      const b = avg(base);
      return { id: k.id, display: k.display, unit: k.unit, segment: seg, base: b, lift: seg !== null && b ? seg / b : null };
    });
  }

  overlap(ids: string[]): Overlap {
    const segs = ids.map((id) => this.segs.get(id)).filter((s): s is Segment => !!s);
    const missing = ids.filter((id) => !this.segs.has(id));
    if (missing.length) throw new ApiError(404, `not found: ${missing.sort().join(", ")}`);
    const notReady = segs.filter((s) => s.member_count === null).map((s) => s.name);
    if (notReady.length) throw new ApiError(400, `materialize these segments first: ${notReady.join(", ")}`);
    const cells = [];
    for (const a of segs) {
      for (const b of segs) {
        const ma = this.members.get(a.id) ?? new Set();
        const mb = this.members.get(b.id) ?? new Set();
        let count = 0;
        for (const n of ma) if (mb.has(n)) count += 1;
        const union = (a.member_count ?? 0) + (b.member_count ?? 0) - count;
        cells.push({ a: a.id, b: b.id, count, jaccard: pct(count, union) });
      }
    }
    return { segments: segs.map((s) => ({ id: s.id, name: s.name, size: s.member_count ?? 0 })), cells };
  }

  member(anchor: string, key: string): MemberView {
    const ent = this.anchorEntity(anchor);
    const node = this.graph.get(ent.label, key);
    if (!node) throw new ApiError(404, `not found: ${key}`);
    const entities: MemberView["entities"] = { [ent.id]: { ...node.props } };
    for (const other of this.catalog.entities) {
      const hops = other.paths[anchor];
      if (!hops || !hops.length) continue;
      let list = traverse(node, hops);
      const timeAttr = other.attributes.find((a) => a.type === "date");
      if (timeAttr) {
        const p = timeAttr.property;
        list = list.sort((x, y) => {
          const a = x.props[p] as string | undefined; const b = y.props[p] as string | undefined;
          if (a == null) return b == null ? 0 : -1; // Cypher sorts null first in DESC
          if (b == null) return 1;
          return a < b ? 1 : a > b ? -1 : 0;
        });
      }
      entities[other.id] = list.slice(0, 24).map((n) => ({ ...n.props }));
    }
    const networks: MemberView["networks"] = {};
    for (const net of this.catalog.networks) {
      if (net.anchor !== anchor) continue;
      const weight = net.edge_attributes[0]?.property;
      const rows = edges(node, net.rel, net.direction as "out" | "in" | "both")
        .filter((e) => e.other.label === ent.label)
        .map((e) => ({ ...e.other.props, edge: { ...e.props } }));
      if (weight) rows.sort((a, b) => ((b.edge[weight] as number) ?? 0) - ((a.edge[weight] as number) ?? 0));
      networks[net.id] = rows.slice(0, 25);
    }
    const segments = [...this.segs.values()]
      .filter((s) => this.members.get(s.id)?.has(node))
      .map((s) => ({ id: s.id, name: s.name }));
    return { anchor, key, entities, networks, segments };
  }

  // ---- graph workspace ------------------------------------------------------------------------
  private linkConfig() {
    const net = this.catalog.networks.find((n) => n.id === this.catalog.link_network);
    if (!net) throw new ApiError(400, "this catalog has no link network");
    const account = this.anchorEntity(net.anchor);
    const attr = net.edge_attributes.find((a) => a.type === "enum")!;
    return { net, account, attr };
  }

  private entityByLabel(label: string) {
    const ent = this.catalog.entities.find((e) => e.label === label);
    if (!ent) throw new ApiError(404, `not found: label ${label}`);
    return ent;
  }

  private degree(n: GNode) {
    let d = 0;
    for (const list of n.out.values()) d += list.length;
    for (const list of n.in.values()) d += list.length;
    return d;
  }

  private toGraphNode(n: GNode, withDegree = true): GraphNode {
    const ent = this.entityByLabel(n.label);
    const caption = CAPTION_PROPS.map((p) => n.props[p]).find((v) => v !== undefined && v !== null);
    return {
      id: `${n.label}:${n.key}`, label: n.label, key: n.key, caption: caption === undefined ? n.key : String(caption),
      entity: ent.id, props: { ...n.props }, ...(withDegree ? { degree: this.degree(n) } : {}),
    };
  }

  private nodeById(id: string): GNode {
    const i = id.indexOf(":");
    if (i <= 0 || i === id.length - 1) throw new ApiError(400, "node ids look like Label:key, e.g. Customer:C0000001");
    this.entityByLabel(id.slice(0, i));
    const n = this.graph.get(id.slice(0, i), id.slice(i + 1));
    if (!n) throw new ApiError(404, `not found: ${id}`);
    return n;
  }

  graphStart(): string | null {
    const { net, account } = this.linkConfig();
    let best: GNode | null = null;
    let bestN = 0;
    for (const n of this.graph.nodes(account.label)) {
      const c = edges(n, net.rel, "both").length;
      if (c > bestN || (c === bestN && c > 0 && best && n.key < best.key)) { best = n; bestN = c; }
    }
    return best ? `${account.label}:${best.key}` : null;
  }

  graphSearch(text: string, limit: number): GraphNode[] {
    const t = text.trim();
    if (!t) return [];
    const out: GraphNode[] = [];
    for (const anchor of this.catalog.anchors) {
      const ent = this.anchorEntity(anchor.id);
      const names = ent.attributes.filter((a) => a.type === "string" && a.property !== ent.key).map((a) => a.property);
      let found = 0;
      for (const n of this.graph.nodes(ent.label)) {
        if (found >= limit) break;
        const hit = n.key.startsWith(t) || names.some((p) => String(n.props[p] ?? "").toLowerCase().includes(t.toLowerCase()));
        if (hit) { out.push(this.toGraphNode(n, false)); found += 1; }
      }
    }
    return out.slice(0, limit);
  }

  graphExpand(nodeId: string, limit: number): Expansion {
    const center = this.nodeById(nodeId);
    const rank = (t: string) => { const i = REL_PRIORITY.indexOf(t); return i === -1 ? 99 : i; };
    const rows: { type: string; outgoing: boolean; e: { other: GNode; props: Record<string, unknown> } }[] = [];
    for (const [type, list] of center.out) for (const e of list) rows.push({ type, outgoing: true, e });
    for (const [type, list] of center.in) for (const e of list) rows.push({ type, outgoing: false, e });
    const picked = rows.filter((r) => r.e.other.label !== "MonthlyUsage")
      .sort((x, y) => rank(x.type) - rank(y.type) || ((y.e.props.calls as number) ?? 0) - ((x.e.props.calls as number) ?? 0))
      .slice(0, limit);
    const c = this.toGraphNode(center);
    const nodes = [c];
    const edgesOut: GraphEdge[] = [];
    for (const r of picked) {
      const other = this.toGraphNode(r.e.other);
      nodes.push(other);
      const [src, dst] = r.outgoing ? [c.id, other.id] : [other.id, c.id];
      edgesOut.push({ id: `${r.type}|${src}|${dst}`, type: r.type, source: src, target: dst, props: { ...r.e.props } });
    }
    return { center: c.id, nodes, edges: edgesOut, truncated: this.degree(center) > edgesOut.length };
  }

  link(a: string, b: string, type: string, persist = true, at?: string): GraphEdge {
    const { net, account, attr } = this.linkConfig();
    if (!attr.values?.includes(type)) throw new ApiError(400, `link type must be one of [${attr.values?.map((v) => `'${v}'`).join(", ")}]`);
    if (a === b) throw new ApiError(400, "an account cannot be linked to itself");
    const na = this.graph.get(account.label, a);
    const nb = this.graph.get(account.label, b);
    if (!na || !nb) throw new ApiError(404, `not found: account ${a} or ${b}`);
    const existing = edges(na, net.rel, "out").find((e) => e.other === nb);
    const reverse = existing ? null : edges(nb, net.rel, "out").find((e) => e.other === na);
    const created_at = at ?? now();
    const props = { [attr.property]: type, source: "user", created_at };
    let forward = true;
    if (existing) Object.assign(existing.props, props);
    else if (reverse) { Object.assign(reverse.props, props); forward = false; }
    else this.graph.addEdge(net.rel, na, nb, props);
    // Keep the mirrored "in" entry's props in sync (same object for new edges).
    const [src, dst] = forward ? [na, nb] : [nb, na];
    const inEntry = (dst.in.get(net.rel) ?? []).find((e) => e.other === src);
    const outEntry = (src.out.get(net.rel) ?? []).find((e) => e.other === dst);
    if (inEntry && outEntry && inEntry.props !== outEntry.props) Object.assign(inEntry.props, outEntry.props);
    if (persist) { this.linkOps.push({ op: "link", a, b, type, at: created_at }); this.save(); }
    const s = `${account.label}:${src.key}`;
    const d = `${account.label}:${dst.key}`;
    return { id: `${net.rel}|${s}|${d}`, type: net.rel, source: s, target: d, props: { ...(outEntry?.props ?? props) } };
  }

  linkGroup(accounts: string[], type: string): GraphEdge[] {
    const unique = [...new Set(accounts)];
    if (unique.length < 2) throw new ApiError(400, "choose at least two accounts");
    return unique.slice(1).map((other) => this.link(unique[0], other, type));
  }

  unlink(a: string, b: string, persist = true): void {
    const { net, account } = this.linkConfig();
    const na = this.graph.get(account.label, a);
    const nb = this.graph.get(account.label, b);
    if (!na || !nb || !this.graph.removeEdges(net.rel, na, nb)) throw new ApiError(404, `not found: link between ${a} and ${b}`);
    if (persist) { this.linkOps.push({ op: "unlink", a, b }); this.save(); }
  }
}

// ---- graph workspace (mirrors backend/segval/services/graph.py) -------------------------------
export interface GraphOps {
  graphStart(): string | null;
  graphSearch(text: string, limit: number): GraphNode[];
  graphExpand(nodeId: string, limit: number): Expansion;
  link(a: string, b: string, type: string, persist?: boolean, at?: string): GraphEdge;
  linkGroup(accounts: string[], type: string): GraphEdge[];
  unlink(a: string, b: string, persist?: boolean): void;
}

let instance: DemoService | null = null;
export function demoService(): DemoService {
  instance ??= new DemoService(raw as unknown as Snapshot);
  return instance;
}
