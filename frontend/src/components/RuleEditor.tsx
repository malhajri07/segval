import { useEffect, useId, useState } from "react";
import { api } from "../api/client";
import type {
  Attribute, AttributeNode, Catalog, EdgeCondition, GroupNode, MetricNode, NetworkNode,
  RelatedNode, RuleNode, Segment, SegmentNode,
} from "../api/types";
import { useCatalog } from "../lib/catalog";
import {
  COUNT_LABELS, KIND_LABELS, LIST_OPS, NO_VALUE_OPS, OPERATOR_LABELS, defaultValue, fieldOptions,
  metricsFor, networksFor, newAttribute, newGroup, newMetric, newNetwork, newRelated,
  newSegmentRef, relatedEntities, resolveField,
} from "../lib/rules";

export interface EditorContext {
  anchor: string;
  segments: Segment[];
  errorPath?: string | null;
  errorMessage?: string | null;
  selfId?: string;
}

interface NodeProps<T extends RuleNode> {
  node: T;
  onChange: (node: T) => void;
  onRemove?: () => void;
  path: string;
  ctx: EditorContext;
  /** Inside a related-record filter: only this entity's fields are allowed. */
  onlyEntity?: string;
  depth: number;
}

export function RuleEditor(props: NodeProps<RuleNode>) {
  const { node, path, ctx } = props;
  const isError = ctx.errorPath === path;
  let body;
  switch (node.kind) {
    case "group": body = <GroupEditor {...(props as NodeProps<GroupNode>)} />; break;
    case "attribute": body = <AttributeEditor {...(props as NodeProps<AttributeNode>)} />; break;
    case "metric": body = <MetricEditor {...(props as NodeProps<MetricNode>)} />; break;
    case "related": body = <RelatedEditor {...(props as NodeProps<RelatedNode>)} />; break;
    case "network": body = <NetworkEditor {...(props as NodeProps<NetworkNode>)} />; break;
    case "segment": body = <SegmentRefEditor {...(props as NodeProps<SegmentNode>)} />; break;
  }
  return (
    <div className={`rule-node kind-${node.kind}${isError ? " has-error" : ""}`}>
      {body}
      {isError && ctx.errorMessage && <div className="node-error" role="alert">{ctx.errorMessage}</div>}
    </div>
  );
}

// ---- shared bits --------------------------------------------------------------------
function NotToggle({ node, onChange }: { node: RuleNode; onChange: (n: RuleNode) => void }) {
  return (
    <button
      type="button"
      className={`chip-toggle${node.negate ? " on" : ""}`}
      aria-pressed={!!node.negate}
      title="Exclude records that match this condition"
      onClick={() => onChange({ ...node, negate: !node.negate })}
    >
      NOT
    </button>
  );
}

function RemoveButton({ onRemove }: { onRemove?: () => void }) {
  if (!onRemove) return null;
  return (
    <button type="button" className="icon-btn" aria-label="Remove condition" title="Remove" onClick={onRemove}>
      ×
    </button>
  );
}

function KindTag({ kind }: { kind: RuleNode["kind"] }) {
  return <span className={`kind-tag kind-tag-${kind}`}>{KIND_LABELS[kind]}</span>;
}

// ---- group ---------------------------------------------------------------------------
function AddMenu({ onAdd, ctx, onlyEntity, depth }: {
  onAdd: (n: RuleNode) => void; ctx: EditorContext; onlyEntity?: string; depth: number;
}) {
  const catalog = useCatalog();
  const [open, setOpen] = useState(false);
  const segs = ctx.segments.filter((s) => s.definition.anchor === ctx.anchor && s.id !== ctx.selfId);
  const items: { label: string; hint: string; make: () => RuleNode; show: boolean }[] = [
    { label: "Attribute", hint: "Compare a field, e.g. plan category or age",
      make: () => newAttribute(catalog, ctx.anchor, onlyEntity), show: true },
    { label: "Usage metric", hint: "Aggregate over time, e.g. avg data last 3 months",
      make: () => newMetric(catalog, ctx.anchor), show: !onlyEntity && metricsFor(catalog, ctx.anchor).length > 0 },
    { label: "Related records", hint: "Count linked records, e.g. has no roaming add-on",
      make: () => newRelated(catalog, ctx.anchor), show: !onlyEntity },
    { label: "Graph network", hint: "Count call-graph contacts matching rules",
      make: () => newNetwork(catalog, ctx.anchor), show: !onlyEntity && networksFor(catalog, ctx.anchor).length > 0 },
    { label: "Segment membership", hint: "In / not in another saved segment",
      make: () => newSegmentRef(segs[0]?.id ?? ""), show: !onlyEntity && segs.length > 0 },
    { label: "Group (AND / OR)", hint: "Nest conditions", make: () => newGroup(), show: depth < 4 },
  ];
  return (
    <div className="add-menu">
      <button type="button" className="btn btn-ghost btn-sm" aria-expanded={open} onClick={() => setOpen(!open)}>
        + Add condition
      </button>
      {open && (
        <div className="menu" role="menu" onMouseLeave={() => setOpen(false)}>
          {items.filter((i) => i.show).map((i) => (
            <button key={i.label} role="menuitem" type="button" className="menu-item"
              onClick={() => { onAdd(i.make()); setOpen(false); }}>
              <strong>{i.label}</strong>
              <span className="muted">{i.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function GroupEditor({ node, onChange, onRemove, path, ctx, onlyEntity, depth }: NodeProps<GroupNode>) {
  const setChild = (i: number, child: RuleNode) =>
    onChange({ ...node, children: node.children.map((c, j) => (j === i ? child : c)) });
  const removeChild = (i: number) =>
    onChange({ ...node, children: node.children.filter((_, j) => j !== i) });
  return (
    <div className={`group depth-${depth % 3}`}>
      <div className="group-head">
        <NotToggle node={node} onChange={(n) => onChange(n as GroupNode)} />
        <div className="seg-control" role="radiogroup" aria-label="Combine conditions with">
          {(["and", "or"] as const).map((op) => (
            <button key={op} type="button" role="radio" aria-checked={node.op === op}
              className={node.op === op ? "on" : ""} onClick={() => onChange({ ...node, op })}>
              {op === "and" ? "ALL of" : "ANY of"}
            </button>
          ))}
        </div>
        <span className="muted small">
          {node.children.length === 0 ? "No conditions: matches everyone" : `${node.children.length} condition${node.children.length > 1 ? "s" : ""}`}
        </span>
        <span className="spacer" />
        <RemoveButton onRemove={onRemove} />
      </div>
      <div className="group-body">
        {node.children.map((child, i) => (
          <div className="group-row" key={i}>
            {i > 0 && <div className="joiner">{node.op.toUpperCase()}</div>}
            <RuleEditor node={child} onChange={(c) => setChild(i, c)} onRemove={() => removeChild(i)}
              path={`${path}.children[${i}]`} ctx={ctx} onlyEntity={onlyEntity} depth={depth + 1} />
          </div>
        ))}
        <AddMenu ctx={ctx} onlyEntity={onlyEntity} depth={depth}
          onAdd={(n) => onChange({ ...node, children: [...node.children, n] })} />
      </div>
    </div>
  );
}

// ---- attribute -----------------------------------------------------------------------
function FieldPicker({ value, onChange, anchor, onlyEntity }: {
  value: string; onChange: (field: string) => void; anchor: string; onlyEntity?: string;
}) {
  const catalog = useCatalog();
  const opts = fieldOptions(catalog, anchor, onlyEntity);
  const groups = new Map<string, typeof opts>();
  for (const o of opts) {
    const list = groups.get(o.entity.display) ?? [];
    list.push(o);
    groups.set(o.entity.display, list);
  }
  return (
    <select className="field-picker" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Field">
      {[...groups].map(([label, list]) => (
        <optgroup key={label} label={list[0].multi ? `${label} (any of)` : label}>
          {list.map((o) => <option key={o.field} value={o.field}>{o.attribute.display}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

function OperatorPicker({ ops, value, onChange }: { ops: string[]; value: string; onChange: (op: string) => void }) {
  return (
    <select className="op-picker" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Operator">
      {ops.map((op) => <option key={op} value={op}>{OPERATOR_LABELS[op] ?? op}</option>)}
    </select>
  );
}

function AttributeEditor({ node, onChange, onRemove, ctx, onlyEntity }: NodeProps<AttributeNode>) {
  const catalog = useCatalog();
  const opt = resolveField(catalog, node.field);
  const attr = opt?.attribute;
  const ops = attr ? catalog.operators[attr.type] : [];
  return (
    <div className="cond">
      <NotToggle node={node} onChange={(n) => onChange(n as AttributeNode)} />
      <KindTag kind="attribute" />
      <FieldPicker value={node.field} anchor={ctx.anchor} onlyEntity={onlyEntity}
        onChange={(field) => {
          const a = resolveField(catalog, field)!.attribute;
          const operator = catalog.operators[a.type].includes(node.operator) && a.type === attr?.type
            ? node.operator : catalog.operators[a.type][0];
          const value = a.type === attr?.type && a.values === attr?.values ? node.value : defaultValue(a, operator);
          onChange({ ...node, field, operator, value });
        }} />
      {attr && (
        <>
          <OperatorPicker ops={ops} value={node.operator}
            onChange={(operator) => onChange({ ...node, operator, value: defaultValue(attr, operator) })} />
          <ValueInput attr={attr} field={node.field} op={node.operator} value={node.value}
            onChange={(value) => onChange({ ...node, value })} />
          {attr.unit && !NO_VALUE_OPS.has(node.operator) && <span className="unit">{attr.unit}</span>}
        </>
      )}
      <span className="spacer" />
      <RemoveButton onRemove={onRemove} />
    </div>
  );
}

export function ValueInput({ attr, field, op, value, onChange }: {
  attr: Attribute; field?: string; op: string; value: unknown; onChange: (v: unknown) => void;
}) {
  const listId = useId();
  const [suggestions, setSuggestions] = useState<string[]>([]);
  useEffect(() => {
    if (!field || !attr.searchable) return;
    let alive = true;
    api.values(field).then((r) => alive && setSuggestions(r.values)).catch(() => {});
    return () => { alive = false; };
  }, [field, attr.searchable]);

  if (NO_VALUE_OPS.has(op)) return null;

  if (op === "within_last_days" || op === "before_last_days") {
    return <input type="number" min={0} className="num" value={String(value ?? "")} aria-label="Days"
      onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} />;
  }

  if (op === "between") {
    const [lo, hi] = Array.isArray(value) ? value : ["", ""];
    const type = attr.type === "date" ? "date" : "number";
    const conv = (v: string) => (type === "number" ? (v === "" ? null : Number(v)) : v);
    return (
      <span className="between">
        <input type={type} className={type === "number" ? "num" : ""} value={String(lo ?? "")} aria-label="From"
          onChange={(e) => onChange([conv(e.target.value), hi])} />
        <span className="muted">and</span>
        <input type={type} className={type === "number" ? "num" : ""} value={String(hi ?? "")} aria-label="To"
          onChange={(e) => onChange([lo, conv(e.target.value)])} />
      </span>
    );
  }

  if (LIST_OPS.has(op)) {
    const list = Array.isArray(value) ? value : [];
    if (attr.values) {
      return (
        <span className="chips" role="group" aria-label="Values">
          {attr.values.map((v) => {
            const on = list.includes(v);
            return (
              <button key={v} type="button" className={`chip${on ? " on" : ""}`} aria-pressed={on}
                onClick={() => onChange(on ? list.filter((x) => x !== v) : [...list, v])}>
                {v}
              </button>
            );
          })}
        </span>
      );
    }
    return <TagInput values={list.map(String)} suggestions={suggestions} numeric={attr.type === "number"}
      onChange={onChange} />;
  }

  switch (attr.type) {
    case "boolean":
      return (
        <select value={String(value)} onChange={(e) => onChange(e.target.value === "true")} aria-label="Value">
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      );
    case "enum":
      return (
        <select value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} aria-label="Value">
          {attr.values!.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
      );
    case "number":
      return <input type="number" className="num" value={value === null || value === undefined ? "" : String(value)}
        aria-label="Value" onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))} />;
    case "date":
      return <input type="date" value={String(value ?? "")} aria-label="Value" onChange={(e) => onChange(e.target.value)} />;
    default:
      return (
        <>
          <input type="text" list={listId} value={String(value ?? "")} aria-label="Value"
            onChange={(e) => onChange(e.target.value)} />
          <datalist id={listId}>{suggestions.map((s) => <option key={s} value={s} />)}</datalist>
        </>
      );
  }
}

function TagInput({ values, suggestions, numeric, onChange }: {
  values: string[]; suggestions: string[]; numeric: boolean; onChange: (v: unknown) => void;
}) {
  const [draft, setDraft] = useState("");
  const listId = useId();
  const commit = () => {
    const parts = draft.split(",").map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return;
    const next = [...values, ...parts.filter((p) => !values.includes(p))];
    onChange(numeric ? next.map(Number) : next);
    setDraft("");
  };
  return (
    <span className="tag-input">
      {values.map((v) => (
        <span key={v} className="chip on">
          {v}
          <button type="button" aria-label={`Remove ${v}`}
            onClick={() => onChange((numeric ? values.map(Number) : values).filter((x) => String(x) !== v))}>×</button>
        </span>
      ))}
      <input list={listId} value={draft} placeholder="type, then Enter" aria-label="Add value"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }}
        onBlur={commit} />
      <datalist id={listId}>{suggestions.map((s) => <option key={s} value={s} />)}</datalist>
    </span>
  );
}

// ---- metric ---------------------------------------------------------------------------
const WINDOWS = [1, 2, 3, 6, 12];

function MetricEditor({ node, onChange, onRemove, ctx }: NodeProps<MetricNode>) {
  const catalog = useCatalog();
  const metrics = metricsFor(catalog, ctx.anchor);
  const m = catalog.metrics.find((x) => x.id === node.metric);
  const numberAttr: Attribute = {
    id: "v", property: "v", type: "number", display: "value", description: "", unit: m?.unit ?? null,
    values: null, buckets: null, searchable: false,
  };
  return (
    <div className="cond">
      <NotToggle node={node} onChange={(n) => onChange(n as MetricNode)} />
      <KindTag kind="metric" />
      <select value={node.metric} aria-label="Metric" onChange={(e) => {
        const next = catalog.metrics.find((x) => x.id === e.target.value)!;
        onChange({ ...node, metric: next.id, window_months: next.time_property ? next.default_window_months : null });
      }}>
        {metrics.map((x) => <option key={x.id} value={x.id}>{x.display}</option>)}
      </select>
      {m?.time_property && (
        <select value={node.window_months ?? m.default_window_months} aria-label="Time window"
          onChange={(e) => onChange({ ...node, window_months: Number(e.target.value) })}>
          {WINDOWS.map((w) => <option key={w} value={w}>last {w} month{w > 1 ? "s" : ""}</option>)}
        </select>
      )}
      <OperatorPicker ops={catalog.metric_operators} value={node.operator}
        onChange={(operator) => onChange({ ...node, operator, value: operator === "between" ? [0, 1000] : 0 })} />
      <ValueInput attr={numberAttr} op={node.operator} value={node.value} onChange={(value) => onChange({ ...node, value })} />
      {m?.unit && <span className="unit">{m.unit}</span>}
      <span className="spacer" />
      <RemoveButton onRemove={onRemove} />
    </div>
  );
}

// ---- related / network -------------------------------------------------------------------
function CountPicker({ op, value, onChange, catalog }: {
  op: string; value: number; onChange: (op: string, value: number) => void; catalog: Catalog;
}) {
  return (
    <>
      <select value={op} aria-label="Count comparison" onChange={(e) => onChange(e.target.value, value)}>
        {catalog.count_operators.map((o) => <option key={o} value={o}>{COUNT_LABELS[o] ?? o}</option>)}
      </select>
      <input type="number" min={0} className="num" value={value} aria-label="Count"
        onChange={(e) => onChange(op, Math.max(0, Number(e.target.value)))} />
    </>
  );
}

function SubRule({ where, onChange, path, ctx, onlyEntity, depth, emptyLabel }: {
  where: RuleNode | null | undefined; onChange: (w: RuleNode | null) => void; path: string;
  ctx: EditorContext; onlyEntity?: string; depth: number; emptyLabel: string;
}) {
  const catalog = useCatalog();
  if (!where) {
    return (
      <button type="button" className="btn btn-ghost btn-sm sub-add"
        onClick={() => onChange({ ...newGroup(), children: [newAttribute(catalog, ctx.anchor, onlyEntity)] })}>
        + {emptyLabel}
      </button>
    );
  }
  return (
    <div className="sub-rule">
      <RuleEditor node={where} onChange={onChange} onRemove={() => onChange(null)} path={path}
        ctx={ctx} onlyEntity={onlyEntity} depth={depth + 1} />
    </div>
  );
}

function RelatedEditor({ node, onChange, onRemove, path, ctx, depth }: NodeProps<RelatedNode>) {
  const catalog = useCatalog();
  const entities = relatedEntities(catalog, ctx.anchor);
  return (
    <div className="cond-block">
      <div className="cond">
        <NotToggle node={node} onChange={(n) => onChange(n as RelatedNode)} />
        <KindTag kind="related" />
        <span>has</span>
        <CountPicker catalog={catalog} op={node.count_operator} value={node.count_value}
          onChange={(count_operator, count_value) => onChange({ ...node, count_operator, count_value })} />
        <select value={node.entity} aria-label="Related entity"
          onChange={(e) => onChange({ ...node, entity: e.target.value, where: null })}>
          {entities.map((e) => <option key={e.id} value={e.id}>{e.display}</option>)}
        </select>
        <span className="spacer" />
        <RemoveButton onRemove={onRemove} />
      </div>
      <SubRule where={node.where} path={`${path}.where`} ctx={ctx} onlyEntity={node.entity} depth={depth}
        emptyLabel={`filter which ${entities.find((e) => e.id === node.entity)?.display ?? "records"} count`}
        onChange={(where) => onChange({ ...node, where })} />
    </div>
  );
}

function NetworkEditor({ node, onChange, onRemove, path, ctx, depth }: NodeProps<NetworkNode>) {
  const catalog = useCatalog();
  const nets = networksFor(catalog, ctx.anchor);
  const net = catalog.networks.find((n) => n.id === node.network);
  const setEdge = (i: number, ec: EdgeCondition) =>
    onChange({ ...node, edge_where: node.edge_where.map((x, j) => (j === i ? ec : x)) });
  return (
    <div className="cond-block">
      <div className="cond">
        <NotToggle node={node} onChange={(n) => onChange(n as NetworkNode)} />
        <KindTag kind="network" />
        <span>has</span>
        <CountPicker catalog={catalog} op={node.count_operator} value={node.count_value}
          onChange={(count_operator, count_value) => onChange({ ...node, count_operator, count_value })} />
        <span>contacts in</span>
        <select value={node.network} aria-label="Network"
          onChange={(e) => onChange({ ...node, network: e.target.value, edge_where: [] })}>
          {nets.map((n) => <option key={n.id} value={n.id}>{n.display}</option>)}
        </select>
        <span className="spacer" />
        <RemoveButton onRemove={onRemove} />
      </div>
      {net && node.edge_where.map((ec, i) => {
        const attr = net.edge_attributes.find((a) => a.id === ec.attribute) ?? net.edge_attributes[0];
        return (
          <div className="cond edge-cond" key={i}>
            <span className="muted small">relationship</span>
            <select value={ec.attribute} aria-label="Relationship attribute"
              onChange={(e) => setEdge(i, { attribute: e.target.value, operator: "gte", value: 1 })}>
              {net.edge_attributes.map((a) => <option key={a.id} value={a.id}>{a.display}</option>)}
            </select>
            <OperatorPicker ops={catalog.operators[attr.type].filter((o) => !LIST_OPS.has(o))} value={ec.operator}
              onChange={(operator) => setEdge(i, { ...ec, operator, value: defaultValue(attr, operator) })} />
            <ValueInput attr={attr} op={ec.operator} value={ec.value} onChange={(value) => setEdge(i, { ...ec, value })} />
            {attr.unit && <span className="unit">{attr.unit}</span>}
            <span className="spacer" />
            <RemoveButton onRemove={() => onChange({ ...node, edge_where: node.edge_where.filter((_, j) => j !== i) })} />
          </div>
        );
      })}
      <div className="sub-actions">
        {net && net.edge_attributes.length > 0 && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange({
            ...node, edge_where: [...node.edge_where, { attribute: net.edge_attributes[0].id, operator: "gte", value: 1 }],
          })}>+ relationship strength</button>
        )}
        {!node.where && (
          <SubRule where={null} path={`${path}.where`} ctx={ctx} depth={depth} emptyLabel="contacts who match…"
            onChange={(where) => onChange({ ...node, where })} />
        )}
      </div>
      {node.where && (
        <>
          <div className="muted small sub-caption">…where the contact matches:</div>
          <SubRule where={node.where} path={`${path}.where`} ctx={ctx} depth={depth} emptyLabel=""
            onChange={(where) => onChange({ ...node, where })} />
        </>
      )}
    </div>
  );
}

// ---- segment reference --------------------------------------------------------------------
function SegmentRefEditor({ node, onChange, onRemove, ctx }: NodeProps<SegmentNode>) {
  const segs = ctx.segments.filter((s) => s.definition.anchor === ctx.anchor && s.id !== ctx.selfId);
  return (
    <div className="cond">
      <NotToggle node={node} onChange={(n) => onChange(n as SegmentNode)} />
      <KindTag kind="segment" />
      <span>is in segment</span>
      <select value={node.segment_id} aria-label="Segment" onChange={(e) => onChange({ ...node, segment_id: e.target.value })}>
        {!segs.some((s) => s.id === node.segment_id) && <option value={node.segment_id}>(choose)</option>}
        {segs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
      <span className="spacer" />
      <RemoveButton onRemove={onRemove} />
    </div>
  );
}
