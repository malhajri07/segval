/**
 * In-browser segment engine for the offline demo.
 *
 * A line-for-line port of backend/segval/dsl/compiler.py: every rule node
 * produces the same Cypher text and parameters as the Python compiler, plus
 * an evaluator that runs the predicate over an in-memory copy of the graph with
 * Cypher's three-valued (true / false / null) logic, so counts match Neo4j.
 */
import type {
  Attribute, AttributeNode, Catalog, EdgeCondition, Entity, GroupNode, Hop, MetricNode,
  NetworkNode, RelatedNode, RuleNode, SegmentDefinition, SegmentNode,
} from "../api/types";

// ---- in-memory property graph ---------------------------------------------------
export type Props = Record<string, unknown>;
export interface GEdge { other: GNode; props: Props }
export interface GNode {
  label: string;
  key: string;
  props: Props;
  out: Map<string, GEdge[]>;
  in: Map<string, GEdge[]>;
}

export interface Snapshot {
  as_of: string;
  catalog: Catalog;
  templates: unknown[];
  nodes: Record<string, { props: string[]; rows: unknown[][] }>;
  rels: Record<string, { from: string; to: string; props: string[]; rows: unknown[][] }>;
}

export class Graph {
  byLabel = new Map<string, Map<string, GNode>>();

  constructor(snap: Snapshot, keys: Record<string, string>) {
    for (const [label, table] of Object.entries(snap.nodes)) {
      const keyProp = keys[label];
      const nodes = new Map<string, GNode>();
      for (const row of table.rows) {
        const props: Props = {};
        table.props.forEach((p, i) => { if (row[i] !== null && row[i] !== undefined) props[p] = row[i]; });
        const key = String(props[keyProp]);
        nodes.set(key, { label, key, props, out: new Map(), in: new Map() });
      }
      this.byLabel.set(label, nodes);
    }
    for (const [type, rel] of Object.entries(snap.rels)) {
      const from = this.byLabel.get(rel.from)!;
      const to = this.byLabel.get(rel.to)!;
      for (const row of rel.rows) {
        const a = from.get(String(row[0]));
        const b = to.get(String(row[1]));
        if (!a || !b) continue;
        const props: Props = {};
        rel.props.forEach((p, i) => { props[p] = row[i + 2]; });
        push(a.out, type, { other: b, props });
        push(b.in, type, { other: a, props });
      }
    }
  }

  addEdge(type: string, a: GNode, b: GNode, props: Props) {
    push(a.out, type, { other: b, props });
    push(b.in, type, { other: a, props });
  }

  /** Remove every `type` edge between a and b (either direction); returns how many. */
  removeEdges(type: string, a: GNode, b: GNode): number {
    let n = 0;
    for (const [x, y] of [[a, b], [b, a]]) {
      const out = x.out.get(type) ?? [];
      const keep = out.filter((e) => e.other !== y);
      n += out.length - keep.length;
      x.out.set(type, keep);
      y.in.set(type, (y.in.get(type) ?? []).filter((e) => e.other !== x));
    }
    return n;
  }

  nodes(label: string): GNode[] {
    return [...(this.byLabel.get(label)?.values() ?? [])];
  }

  get(label: string, key: string): GNode | undefined {
    return this.byLabel.get(label)?.get(key);
  }
}

function push(map: Map<string, GEdge[]>, k: string, e: GEdge) {
  const list = map.get(k);
  if (list) list.push(e); else map.set(k, [e]);
}

export function edges(node: GNode, rel: string, direction: "out" | "in" | "both"): GEdge[] {
  if (direction === "out") return node.out.get(rel) ?? [];
  if (direction === "in") return node.in.get(rel) ?? [];
  return [...(node.out.get(rel) ?? []), ...(node.in.get(rel) ?? [])];
}

/** Distinct end nodes of a catalog path. */
export function traverse(start: GNode, hops: Hop[]): GNode[] {
  let frontier = [start];
  for (const hop of hops) {
    const next = new Set<GNode>();
    for (const n of frontier) {
      for (const e of edges(n, hop.rel, hop.direction)) if (e.other.label === hop.label) next.add(e.other);
    }
    frontier = [...next];
  }
  return frontier;
}

// ---- three-valued logic -----------------------------------------------------------
export type Tri = boolean | null;
const and3 = (parts: Tri[]): Tri => (parts.includes(false) ? false : parts.includes(null) ? null : true);
const not3 = (v: Tri): Tri => (v === null ? null : !v);

function cmp(v: unknown, op: string, p: unknown): Tri {
  if (v === null || v === undefined || p === null || p === undefined) return null;
  switch (op) {
    case "=": return v === p;
    case "<>": return v !== p;
    case ">": return (v as number) > (p as number);
    case ">=": return (v as number) >= (p as number);
    case "<": return (v as number) < (p as number);
    case "<=": return (v as number) <= (p as number);
  }
  throw new Error(op);
}

// ---- dates (ISO strings compare lexicographically) ----------------------------------
function iso(d: Date) { return d.toISOString().slice(0, 10); }
export function minusDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return iso(d);
}
export function minusMonths(isoDate: string, months: number): string {
  const [y, m, day] = isoDate.split("-").map(Number);
  const total = y * 12 + (m - 1) - months;
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return iso(new Date(Date.UTC(ny, nm, Math.min(day, last))));
}

// ---- compiler --------------------------------------------------------------------------
export const MAX_DEPTH = 6;
const CMP: Record<string, string> = { eq: "=", neq: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=" };

export class CompileError extends Error {
  constructor(public detail: string, public path = "rule") {
    super(`${path}: ${detail}`);
  }
}

type Env = Record<string, GNode | GEdge>;
type Pred = (env: Env) => Tri;
type Val = (env: Env) => unknown;

export interface EvalContext {
  asOf: string;
  /** Materialized members of a saved segment (undefined when not materialized). */
  members: (segmentId: string) => Set<GNode> | undefined;
}

interface Compiled { expr: string; ev: Pred }

interface Scope { anchor: string; v: string; bound: Record<string, string>; restricted: boolean; depth: number }

class State {
  params: Record<string, unknown> = {};
  seq = 0;
  constructor(public prefix = "p") {}
  add(value: unknown): string {
    const name = `${this.prefix}${Object.keys(this.params).length}`;
    this.params[name] = value;
    return `$${name}`;
  }
  newVar(prefix = "x") { this.seq += 1; return `${prefix}${this.seq}`; }
}

const q = (ident: string) => `\`${ident}\``;

export function hopPattern(start: string, hops: Hop[], end: string): string {
  let out = `(${start})`;
  hops.forEach((hop, i) => {
    const rel = `[:${q(hop.rel)}]`;
    const arrow = hop.direction === "out" ? `-${rel}->` : hop.direction === "in" ? `<-${rel}-` : `-${rel}-`;
    out += `${arrow}(${i === hops.length - 1 ? end : ""}:${q(hop.label)})`;
  });
  return out;
}

const pyRepr = (v: unknown) => (typeof v === "string" ? `'${v}'` : JSON.stringify(v));

export interface CompiledPredicate {
  anchor: string;
  label: string;
  predicate: string;
  params: Record<string, unknown>;
  test: (node: GNode) => boolean;
}

export class Compiler {
  constructor(private catalog: Catalog, private ctx: EvalContext) {}

  private entity(id: string) { return this.catalog.entities.find((e) => e.id === id); }
  private anchorEntity(anchor: string): Entity {
    const a = this.catalog.anchors.find((x) => x.id === anchor)!;
    return this.entity(a.entity)!;
  }
  private path(anchor: string, entityId: string): Hop[] | undefined {
    return this.entity(entityId)?.paths[anchor];
  }

  compile(def: SegmentDefinition): CompiledPredicate {
    const anchor = this.catalog.anchors.find((a) => a.id === def.anchor);
    if (!anchor) throw new CompileError(`unknown anchor ${pyRepr(def.anchor)}`, "anchor");
    const ent = this.anchorEntity(anchor.id);
    const st = new State();
    const c = this.node(def.rule, { anchor: anchor.id, v: "a", bound: { [ent.id]: "a" }, restricted: false, depth: 0 }, st, "rule");
    return {
      anchor: anchor.id, label: ent.label, predicate: c.expr,
      params: { ...st.params, as_of: this.ctx.asOf },
      test: (node) => c.ev({ a: node }) === true,
    };
  }

  /** KPI metric value for one anchor node. */
  metricValue(metricId: string, windowMonths: number | null | undefined, anchor: string): (n: GNode) => number {
    const st = new State("k");
    const { ev } = this.metricValueExpr(
      { kind: "metric", metric: metricId, window_months: windowMonths, operator: "gte", value: 0 },
      { anchor, v: "a", bound: {}, restricted: false, depth: 0 }, st, "kpi");
    return (n) => ev({ a: n }) as number;
  }

  private node(node: RuleNode, scope: Scope, st: State, path: string): Compiled {
    if (scope.depth > MAX_DEPTH) throw new CompileError(`rule nesting deeper than ${MAX_DEPTH} levels`, path);
    let c: Compiled;
    switch (node.kind) {
      case "group": c = this.group(node, scope, st, path); break;
      case "attribute": c = this.attribute(node, scope, st, path); break;
      case "metric": c = this.metric(node, scope, st, path); break;
      case "related": c = this.related(node, scope, st, path); break;
      case "network": c = this.network(node, scope, st, path); break;
      case "segment": c = this.segment(node, scope, st, path); break;
      default: throw new CompileError("unsupported node", path);
    }
    if (!node.negate) return c;
    const inner = c.ev;
    return { expr: `NOT (${c.expr})`, ev: (env) => not3(inner(env)) };
  }

  private group(node: GroupNode, scope: Scope, st: State, path: string): Compiled {
    if (!node.children.length) return { expr: "true", ev: () => true };
    const child = { ...scope, depth: scope.depth + 1 };
    const parts = node.children.map((c, i) => this.node(c, child, st, `${path}.children[${i}]`));
    if (parts.length === 1) return parts[0];
    const joiner = node.op === "and" ? " AND " : " OR ";
    const evs = parts.map((p) => p.ev);
    return {
      expr: "(" + parts.map((p) => `(${p.expr})`).join(joiner) + ")",
      ev: node.op === "and"
        ? (env) => { let n = false; for (const e of evs) { const r = e(env); if (r === false) return false; if (r === null) n = true; } return n ? null : true; }
        : (env) => { let n = false; for (const e of evs) { const r = e(env); if (r === true) return true; if (r === null) n = true; } return n ? null : false; },
    };
  }

  // ---- attribute ----------------------------------------------------------------------
  private resolve(field: string, path: string): [Entity, Attribute] {
    const [eid, aid] = field.split(".");
    const ent = this.entity(eid);
    if (!ent) throw new CompileError(`unknown entity in field ${pyRepr(field)}`, path);
    const attr = ent.attributes.find((a) => a.id === aid);
    if (!attr) throw new CompileError(`unknown attribute in field ${pyRepr(field)}`, path);
    return [ent, attr];
  }

  private attribute(node: AttributeNode, scope: Scope, st: State, path: string): Compiled {
    const [ent, attr] = this.resolve(node.field, path);
    if (ent.id in scope.bound) {
      const v = scope.bound[ent.id];
      return this.comparison(`${v}.${q(attr.property)}`, (env) => (env[v] as GNode).props[attr.property], attr, node.operator, node.value, st, path);
    }
    if (scope.restricted) {
      throw new CompileError(`field ${pyRepr(node.field)} is not available here; use fields of ${Object.keys(scope.bound).join(", ")}`, path);
    }
    const hops = this.path(scope.anchor, ent.id);
    if (hops === undefined) throw new CompileError(`${ent.display} is not reachable from ${scope.anchor}`, path);
    const x = st.newVar();
    const pred = this.comparison(`${x}.${q(attr.property)}`, (env) => (env[x] as GNode).props[attr.property], attr, node.operator, node.value, st, path);
    const from = scope.v;
    return {
      expr: `EXISTS { MATCH ${hopPattern(from, hops, x)} WHERE ${pred.expr} }`,
      ev: (env) => traverse(env[from] as GNode, hops).some((n) => pred.ev({ ...env, [x]: n }) === true),
    };
  }

  private comparison(expr: string, get: Val, attr: Attribute, op: string, value: unknown, st: State, path: string): Compiled {
    if (!this.catalog.operators[attr.type].includes(op)) {
      throw new CompileError(`operator '${op}' is not valid for ${attr.type} field '${attr.display}'`, path);
    }
    if (op === "is_null") return { expr: `${expr} IS NULL`, ev: (env) => get(env) == null };
    if (op === "is_not_null") return { expr: `${expr} IS NOT NULL`, ev: (env) => get(env) != null };

    const asOf = this.ctx.asOf;
    if (op === "within_last_days" || op === "before_last_days") {
      const days = asInt(value, path, "number of days");
      const p = st.add(days);
      const cutoffExpr = `date($as_of) - duration({days: ${p}})`;
      const cutoff = minusDays(asOf, days);
      if (op === "within_last_days") {
        return { expr: `(${expr} >= ${cutoffExpr} AND ${expr} <= date($as_of))`,
          ev: (env) => { const v = get(env); return and3([cmp(v, ">=", cutoff), cmp(v, "<=", asOf)]); } };
      }
      return { expr: `${expr} < ${cutoffExpr}`, ev: (env) => cmp(get(env), "<", cutoff) };
    }

    if (op === "between") {
      if (!Array.isArray(value) || value.length !== 2) throw new CompileError("between needs [low, high]", path);
      const [loE, lo] = this.valueParam(attr, value[0], st, path);
      const [hiE, hi] = this.valueParam(attr, value[1], st, path);
      return { expr: `(${expr} >= ${loE} AND ${expr} <= ${hiE})`,
        ev: (env) => { const v = get(env); return and3([cmp(v, ">=", lo), cmp(v, "<=", hi)]); } };
    }

    if (op === "in" || op === "not_in") {
      if (!Array.isArray(value) || !value.length) throw new CompileError("choose at least one value", path);
      const coerced = value.map((v) => coerce(attr, v, path));
      const inner = attr.type === "date"
        ? `${expr} IN [d IN ${st.add(coerced)} | date(d)]`
        : `${expr} IN ${st.add(coerced)}`;
      const test: Pred = (env) => { const v = get(env); return v == null ? null : coerced.includes(v); };
      return op === "in" ? { expr: inner, ev: test } : { expr: `NOT ${inner}`, ev: (env) => not3(test(env)) };
    }

    if (op === "contains" || op === "starts_with" || op === "ends_with") {
      const needle = String(coerce(attr, value, path)).toLowerCase();
      const p = st.add(needle);
      const kw = { contains: "CONTAINS", starts_with: "STARTS WITH", ends_with: "ENDS WITH" }[op];
      return { expr: `toLower(${expr}) ${kw} ${p}`, ev: (env) => {
        const v = get(env);
        if (v == null) return null;
        const s = String(v).toLowerCase();
        return op === "contains" ? s.includes(needle) : op === "starts_with" ? s.startsWith(needle) : s.endsWith(needle);
      } };
    }

    const [pE, p] = this.valueParam(attr, value, st, path);
    const sym = CMP[op];
    return { expr: `${expr} ${sym} ${pE}`, ev: (env) => cmp(get(env), sym, p) };
  }

  private valueParam(attr: Attribute, value: unknown, st: State, path: string): [string, unknown] {
    const v = coerce(attr, value, path);
    return attr.type === "date" ? [`date(${st.add(v)})`, v] : [st.add(v), v];
  }

  // ---- metrics -------------------------------------------------------------------------
  private metricValueExpr(node: MetricNode, scope: Scope, st: State, path: string): { expr: string; ev: Val } {
    const metric = this.catalog.metrics.find((m) => m.id === node.metric);
    if (!metric) throw new CompileError(`unknown metric ${pyRepr(node.metric)}`, path);
    const hops = this.path(scope.anchor, metric.entity);
    if (!hops || !hops.length) throw new CompileError(`metric '${metric.display}' is not available for ${scope.anchor}`, path);
    const x = st.newVar("m");
    let where = "";
    let inWindow = (_: GNode) => true;
    if (metric.time_property) {
      const months = node.window_months || metric.default_window_months;
      const p = st.add(months);
      const tp = `${x}.${q(metric.time_property)}`;
      where = ` WHERE ${tp} > date($as_of) - duration({months: ${p}}) AND ${tp} <= date($as_of)`;
      const cutoff = minusMonths(this.ctx.asOf, months);
      const asOf = this.ctx.asOf;
      const prop = metric.time_property;
      inWindow = (n) => and3([cmp(n.props[prop], ">", cutoff), cmp(n.props[prop], "<=", asOf)]) === true;
    }
    const agg = metric.aggregate === "count" ? `count(${x})` : `${metric.aggregate}(${x}.${q(metric.property ?? "")})`;
    const from = scope.v;
    const prop = metric.property ?? "";
    const aggregate = metric.aggregate;
    return {
      expr: `coalesce(head(COLLECT { MATCH ${hopPattern(from, hops, x)}${where} RETURN ${agg} AS v }), 0)`,
      ev: (env) => {
        const rows = traverse(env[from] as GNode, hops).filter(inWindow);
        if (aggregate === "count") return rows.length;
        const vals = rows.map((r) => r.props[prop]).filter((v): v is number => typeof v === "number");
        if (!vals.length) return 0;
        switch (aggregate) {
          case "sum": return vals.reduce((a, b) => a + b, 0);
          case "avg": return vals.reduce((a, b) => a + b, 0) / vals.length;
          case "min": return Math.min(...vals);
          case "max": return Math.max(...vals);
        }
        return 0;
      },
    };
  }

  private metric(node: MetricNode, scope: Scope, st: State, path: string): Compiled {
    if (scope.restricted) throw new CompileError("metrics cannot be used inside a related-entity filter", path);
    if (!this.catalog.metric_operators.includes(node.operator)) {
      throw new CompileError(`operator '${node.operator}' is not valid for metrics`, path);
    }
    const { expr, ev } = this.metricValueExpr(node, scope, st, path);
    if (node.operator === "between") {
      if (!Array.isArray(node.value) || node.value.length !== 2) throw new CompileError("between needs [low, high]", path);
      const lo = asNumber(node.value[0], path);
      const hi = asNumber(node.value[1], path);
      const loE = st.add(lo);
      const hiE = st.add(hi);
      return { expr: `(${expr} >= ${loE} AND ${expr} <= ${hiE})`,
        ev: (env) => { const v = ev(env); return and3([cmp(v, ">=", lo), cmp(v, "<=", hi)]); } };
    }
    const p = asNumber(node.value, path);
    const sym = CMP[node.operator];
    return { expr: `${expr} ${sym} ${st.add(p)}`, ev: (env) => cmp(ev(env), sym, p) };
  }

  // ---- related -----------------------------------------------------------------------------
  private related(node: RelatedNode, scope: Scope, st: State, path: string): Compiled {
    if (scope.restricted) throw new CompileError("related conditions cannot be nested in a related filter", path);
    const ent = this.entity(node.entity);
    if (!ent) throw new CompileError(`unknown entity ${pyRepr(node.entity)}`, path);
    const hops = this.path(scope.anchor, ent.id);
    if (!hops || !hops.length) throw new CompileError(`${ent.display} is not related to ${scope.anchor}`, path);
    const x = st.newVar();
    let where = "";
    let filter: Pred = () => true;
    if (node.where) {
      const inner = this.node(node.where, { anchor: scope.anchor, v: x, bound: { [ent.id]: x }, restricted: true, depth: scope.depth + 1 }, st, `${path}.where`);
      where = ` WHERE ${inner.expr}`;
      filter = inner.ev;
    }
    const pattern = hopPattern(scope.v, hops, x);
    const from = scope.v;
    const count = (env: Env) => traverse(env[from] as GNode, hops).filter((n) => filter({ ...env, [x]: n }) === true).length;
    return this.countExpr(`COUNT { MATCH ${pattern}${where} RETURN DISTINCT ${x} }`, pattern, where, node.count_operator, node.count_value, st, count);
  }

  // ---- network ------------------------------------------------------------------------------
  private network(node: NetworkNode, scope: Scope, st: State, path: string): Compiled {
    if (scope.restricted) throw new CompileError("network conditions cannot be nested in a related filter", path);
    const net = this.catalog.networks.find((n) => n.id === node.network);
    if (!net) throw new CompileError(`unknown network ${pyRepr(node.network)}`, path);
    if (net.anchor !== scope.anchor) throw new CompileError(`network '${net.display}' only applies to ${net.anchor}`, path);
    const n = st.newVar("n");
    const r = st.newVar("r");
    const ent = this.anchorEntity(scope.anchor);
    const rel = `[${r}:${q(net.rel)}]`;
    const dir = net.direction as "out" | "in" | "both";
    const arrow = dir === "out" ? `-${rel}->` : dir === "in" ? `<-${rel}-` : `-${rel}-`;
    const pattern = `(${scope.v})${arrow}(${n}:${q(ent.label)})`;

    const preds: Compiled[] = node.edge_where.map((ec, i) => this.edge(ec, net, r, st, `${path}.edge_where[${i}]`));
    if (node.where) {
      preds.push(this.node(node.where, { anchor: scope.anchor, v: n, bound: { [ent.id]: n }, restricted: false, depth: scope.depth + 1 }, st, `${path}.where`));
    }
    const where = preds.length ? ` WHERE ${preds.map((p) => p.expr).join(" AND ")}` : "";
    const from = scope.v;
    const count = (env: Env) => {
      const hits = new Set<GNode>();
      for (const e of edges(env[from] as GNode, net.rel, dir)) {
        if (e.other.label !== ent.label || hits.has(e.other)) continue;
        const sub = { ...env, [n]: e.other, [r]: e };
        if (and3(preds.map((p) => p.ev(sub))) === true) hits.add(e.other);
      }
      return hits.size;
    };
    return this.countExpr(`COUNT { MATCH ${pattern}${where} RETURN DISTINCT ${n} }`, pattern, where, node.count_operator, node.count_value, st, count);
  }

  private edge(ec: EdgeCondition, net: Catalog["networks"][number], r: string, st: State, path: string): Compiled {
    const attr = net.edge_attributes.find((a) => a.id === ec.attribute);
    if (!attr) throw new CompileError(`unknown edge attribute ${pyRepr(ec.attribute)}`, path);
    return this.comparison(`${r}.${q(attr.property)}`, (env) => (env[r] as GEdge).props[attr.property], attr, ec.operator, ec.value, st, path);
  }

  private countExpr(sub: string, pattern: string, where: string, op: string, value: number, st: State, count: (env: Env) => number): Compiled {
    if ((op === "gte" && value === 1) || (op === "gt" && value === 0)) {
      return { expr: `EXISTS { MATCH ${pattern}${where} }`, ev: (env) => count(env) > 0 };
    }
    if ((op === "eq" && value === 0) || (op === "lt" && value === 1)) {
      return { expr: `NOT EXISTS { MATCH ${pattern}${where} }`, ev: (env) => count(env) === 0 };
    }
    const sym = CMP[op];
    return { expr: `${sub} ${sym} ${st.add(value)}`, ev: (env) => cmp(count(env), sym, value) };
  }

  // ---- segment membership ----------------------------------------------------------------------
  private segment(node: SegmentNode, scope: Scope, st: State, path: string): Compiled {
    if (scope.restricted) throw new CompileError("segment membership cannot be used in a related filter", path);
    const p = st.add(node.segment_id);
    const v = scope.v;
    const id = node.segment_id;
    return {
      expr: `EXISTS { MATCH (${v})-[:\`MEMBER_OF\`]->(:\`Segment\` {id: ${p}}) }`,
      ev: (env) => this.ctx.members(id)?.has(env[v] as GNode) ?? false,
    };
  }
}

// ---- value coercion (mirrors _coerce / _as_number) --------------------------------------------
function asNumber(value: unknown, path: string): number {
  if (typeof value === "boolean") throw new CompileError("expected a number", path);
  if (typeof value === "number") return value;
  const f = value === null || value === undefined || String(value).trim() === "" ? NaN : Number(String(value).trim());
  if (Number.isNaN(f)) throw new CompileError(`expected a number, got ${value === null || value === undefined ? "None" : pyRepr(value)}`, path);
  return f;
}

function asInt(value: unknown, path: string, what: string): number {
  const n = asNumber(value, path);
  if (!Number.isInteger(n) || n < 0) throw new CompileError(`expected a whole ${what}`, path);
  return n;
}

function coerce(attr: Attribute, value: unknown, path: string): unknown {
  if (value === null || value === undefined) throw new CompileError(`a value is required for '${attr.display}'`, path);
  switch (attr.type) {
    case "number": return asNumber(value, path);
    case "boolean": {
      if (typeof value === "boolean") return value;
      const s = String(value).toLowerCase();
      if (["true", "yes", "1"].includes(s)) return true;
      if (["false", "no", "0"].includes(s)) return false;
      throw new CompileError(`expected true/false for '${attr.display}'`, path);
    }
    case "date": {
      const s = String(value).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) {
        throw new CompileError(`expected a date (YYYY-MM-DD), got ${pyRepr(value)}`, path);
      }
      return s;
    }
    case "enum":
      if (attr.values && !attr.values.includes(String(value))) {
        throw new CompileError(`${pyRepr(value)} is not a valid '${attr.display}'; choose from [${attr.values.map((v) => `'${v}'`).join(", ")}]`, path);
      }
      return String(value);
    default:
      return String(value);
  }
}
