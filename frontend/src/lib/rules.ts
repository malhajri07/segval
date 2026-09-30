import type {
  Attribute, AttributeNode, Catalog, Entity, GroupNode, MetricNode, NetworkNode, RelatedNode,
  RuleNode, SegmentNode,
} from "../api/types";

export const OPERATOR_LABELS: Record<string, string> = {
  eq: "is", neq: "is not", gt: ">", gte: "≥", lt: "<", lte: "≤",
  between: "between", in: "is any of", not_in: "is none of",
  contains: "contains", starts_with: "starts with", ends_with: "ends with",
  is_null: "is empty", is_not_null: "is set",
  within_last_days: "within last (days)", before_last_days: "more than (days) ago",
};

export const COUNT_LABELS: Record<string, string> = {
  gte: "at least", gt: "more than", eq: "exactly", neq: "not exactly", lte: "at most", lt: "fewer than",
};

export const KIND_LABELS: Record<RuleNode["kind"], string> = {
  group: "Group",
  attribute: "Attribute",
  metric: "Usage metric",
  related: "Related records",
  network: "Graph network",
  segment: "Segment membership",
};

export const NO_VALUE_OPS = new Set(["is_null", "is_not_null"]);
export const LIST_OPS = new Set(["in", "not_in"]);

export interface FieldOption {
  field: string;
  entity: Entity;
  attribute: Attribute;
  multi: boolean;
}

/** Fields selectable in a scope: everything reachable from the anchor, or one entity only. */
export function fieldOptions(catalog: Catalog, anchor: string, onlyEntity?: string): FieldOption[] {
  const out: FieldOption[] = [];
  for (const entity of catalog.entities) {
    if (onlyEntity ? entity.id !== onlyEntity : !(anchor in entity.paths)) continue;
    for (const attribute of entity.attributes) {
      out.push({
        field: `${entity.id}.${attribute.id}`, entity, attribute,
        multi: !onlyEntity && !!entity.multi_valued[anchor],
      });
    }
  }
  return out;
}

export function resolveField(catalog: Catalog, field: string): FieldOption | null {
  const [eid, aid] = field.split(".");
  const entity = catalog.entities.find((e) => e.id === eid);
  const attribute = entity?.attributes.find((a) => a.id === aid);
  if (!entity || !attribute) return null;
  return { field, entity, attribute, multi: false };
}

export function defaultValue(attr: Attribute, op: string): unknown {
  if (NO_VALUE_OPS.has(op)) return null;
  if (LIST_OPS.has(op)) return attr.values ? [attr.values[0]] : [];
  if (op === "between") return attr.type === "date" ? ["", ""] : [0, 100];
  if (op === "within_last_days" || op === "before_last_days") return 30;
  switch (attr.type) {
    case "boolean": return true;
    case "enum": return attr.values?.[0] ?? "";
    case "number": return 0;
    default: return "";
  }
}

export function newGroup(op: "and" | "or" = "and"): GroupNode {
  return { kind: "group", op, children: [] };
}

export function newAttribute(catalog: Catalog, anchor: string, onlyEntity?: string): AttributeNode {
  const opt = fieldOptions(catalog, anchor, onlyEntity).find((o) => o.attribute.type !== "string")
    ?? fieldOptions(catalog, anchor, onlyEntity)[0];
  const operator = catalog.operators[opt.attribute.type][0];
  return { kind: "attribute", field: opt.field, operator, value: defaultValue(opt.attribute, operator) };
}

export function metricsFor(catalog: Catalog, anchor: string) {
  return catalog.metrics.filter((m) => {
    const ent = catalog.entities.find((e) => e.id === m.entity);
    return !!ent && anchor in ent.paths && ent.paths[anchor].length > 0;
  });
}

export function newMetric(catalog: Catalog, anchor: string): MetricNode {
  const m = metricsFor(catalog, anchor)[0];
  return {
    kind: "metric", metric: m.id,
    window_months: m.time_property ? m.default_window_months : null, operator: "gt", value: 0,
  };
}

export function relatedEntities(catalog: Catalog, anchor: string) {
  return catalog.entities.filter((e) => anchor in e.paths && e.paths[anchor].length > 0);
}

export function newRelated(catalog: Catalog, anchor: string): RelatedNode {
  const ent = relatedEntities(catalog, anchor).find((e) => e.multi_valued[anchor])
    ?? relatedEntities(catalog, anchor)[0];
  return { kind: "related", entity: ent.id, where: null, count_operator: "gte", count_value: 1 };
}

export function networksFor(catalog: Catalog, anchor: string) {
  return catalog.networks.filter((n) => n.anchor === anchor);
}

export function newNetwork(catalog: Catalog, anchor: string): NetworkNode {
  return {
    kind: "network", network: networksFor(catalog, anchor)[0].id, where: null, edge_where: [],
    count_operator: "gte", count_value: 1,
  };
}

export function newSegmentRef(segmentId = ""): SegmentNode {
  return { kind: "segment", segment_id: segmentId };
}

export function countConditions(node: RuleNode | null | undefined): number {
  if (!node) return 0;
  if (node.kind === "group") return node.children.reduce((n, c) => n + countConditions(c), 0);
  if (node.kind === "related" || node.kind === "network") return 1 + countConditions(node.where);
  return 1;
}

// ---- plain-language description ------------------------------------------------
function fmtValue(v: unknown): string {
  if (Array.isArray(v)) return v.map(fmtValue).join(v.length === 2 && typeof v[0] !== "string" ? " and " : ", ");
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (typeof v === "number") return v.toLocaleString();
  return String(v ?? "");
}

export function describe(
  node: RuleNode, catalog: Catalog, segmentNames: Record<string, string> = {},
): string {
  const not = node.negate ? "NOT " : "";
  switch (node.kind) {
    case "group": {
      if (!node.children.length) return node.negate ? "nothing" : "everyone";
      const parts = node.children.map((c) => describe(c, catalog, segmentNames));
      const body = parts.length > 1 ? `(${parts.join(node.op === "and" ? " AND " : " OR ")})` : parts[0];
      return not + body;
    }
    case "attribute": {
      const f = resolveField(catalog, node.field);
      const name = f ? `${f.entity.display} ${f.attribute.display.toLowerCase()}` : node.field;
      const val = NO_VALUE_OPS.has(node.operator) ? "" : ` ${fmtValue(node.value)}`;
      return `${not}${name} ${OPERATOR_LABELS[node.operator] ?? node.operator}${val}`;
    }
    case "metric": {
      const m = catalog.metrics.find((x) => x.id === node.metric);
      const win = m?.time_property ? ` (last ${node.window_months ?? m.default_window_months}m)` : "";
      return `${not}${m?.display ?? node.metric}${win} ${OPERATOR_LABELS[node.operator]} ${fmtValue(node.value)}${m?.unit ? " " + m.unit : ""}`;
    }
    case "related": {
      const e = catalog.entities.find((x) => x.id === node.entity);
      const w = node.where ? ` where ${describe(node.where, catalog, segmentNames)}` : "";
      return `${not}has ${COUNT_LABELS[node.count_operator]} ${node.count_value} ${e?.display ?? node.entity}${w}`;
    }
    case "network": {
      const n = catalog.networks.find((x) => x.id === node.network);
      const w = node.where ? ` who are ${describe(node.where, catalog, segmentNames)}` : "";
      return `${not}${COUNT_LABELS[node.count_operator]} ${node.count_value} contacts in ${n?.display ?? node.network}${w}`;
    }
    case "segment":
      return `${node.negate ? "not " : ""}in segment “${segmentNames[node.segment_id] ?? node.segment_id}”`;
  }
}

// ---- formatting ----------------------------------------------------------------
export function fmtNumber(v: unknown, digits = 0): string {
  if (v === null || v === undefined || v === "") return "–";
  if (typeof v !== "number") return String(v);
  return v.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

export function fmtPct(v: number, digits = 1): string {
  return `${(v * 100).toFixed(digits)}%`;
}

export function fmtCompact(v: number | null | undefined): string {
  if (v === null || v === undefined) return "–";
  const abs = Math.abs(v);
  if (abs >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (abs >= 1e4) return `${(v / 1e3).toFixed(1)}k`;
  if (abs >= 100) return v.toFixed(0);
  if (abs >= 10) return v.toFixed(1);
  return v.toFixed(2);
}
