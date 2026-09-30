// Mirrors backend/segval/catalog/model.py and backend/segval/dsl/model.py

export type AttrType = "number" | "string" | "enum" | "boolean" | "date";

export interface Hop { rel: string; direction: "out" | "in" | "both"; label: string; many: boolean }

export interface Attribute {
  id: string;
  property: string;
  type: AttrType;
  display: string;
  description: string;
  unit: string | null;
  values: string[] | null;
  buckets: number[] | null;
  searchable: boolean;
}

export interface Entity {
  id: string;
  label: string;
  display: string;
  description: string;
  key: string;
  attributes: Attribute[];
  paths: Record<string, Hop[]>;
  multi_valued: Record<string, boolean>;
}

export interface Metric {
  id: string;
  display: string;
  description: string;
  entity: string;
  aggregate: "sum" | "avg" | "min" | "max" | "count";
  property: string | null;
  time_property: string | null;
  unit: string | null;
  default_window_months: number;
}

export interface Network {
  id: string;
  display: string;
  description: string;
  anchor: string;
  rel: string;
  direction: string;
  edge_attributes: Attribute[];
}

export interface Anchor {
  id: string;
  entity: string;
  display: string;
  description: string;
  profile_dimensions: string[];
  sample_fields: string[];
}

export interface Catalog {
  domain: string;
  display: string;
  currency: string;
  anchors: Anchor[];
  entities: Entity[];
  metrics: Metric[];
  networks: Network[];
  operators: Record<AttrType, string[]>;
  metric_operators: string[];
  count_operators: string[];
}

// ---- rule tree ------------------------------------------------------------
interface NodeBase { negate?: boolean; label?: string | null }

export interface GroupNode extends NodeBase { kind: "group"; op: "and" | "or"; children: RuleNode[] }
export interface AttributeNode extends NodeBase {
  kind: "attribute"; field: string; operator: string; value: unknown;
}
export interface MetricNode extends NodeBase {
  kind: "metric"; metric: string; window_months?: number | null; operator: string; value: unknown;
}
export interface RelatedNode extends NodeBase {
  kind: "related"; entity: string; where?: RuleNode | null;
  count_operator: string; count_value: number;
}
export interface EdgeCondition { attribute: string; operator: string; value: unknown }
export interface NetworkNode extends NodeBase {
  kind: "network"; network: string; where?: RuleNode | null; edge_where: EdgeCondition[];
  count_operator: string; count_value: number;
}
export interface SegmentNode extends NodeBase { kind: "segment"; segment_id: string }

export type RuleNode = GroupNode | AttributeNode | MetricNode | RelatedNode | NetworkNode | SegmentNode;

export interface SegmentDefinition { anchor: string; rule: RuleNode }

// ---- API payloads ----------------------------------------------------------
export interface Segment {
  id: string;
  name: string;
  description: string;
  tags: string[];
  owner: string | null;
  definition: SegmentDefinition;
  version: number;
  created_at: string;
  updated_at: string;
  member_count: number | null;
  materialized_at: string | null;
  materialized_version: number | null;
  materialized_as_of: string | null;
  depends_on: string[];
  is_stale: boolean;
}

export interface Template {
  id: string;
  name: string;
  category: string;
  description: string;
  definition: SegmentDefinition;
}

export type Row = Record<string, unknown>;

export interface Preview {
  segment_size: number;
  base_size: number;
  share: number;
  sample_fields: string[];
  sample: Row[];
  as_of: string;
  elapsed_ms: number;
}

export interface Kpi {
  id: string; display: string; unit: string | null;
  segment: number | null; base: number | null; lift: number | null;
}

export interface DistributionRow {
  value: string; segment: number; base: number;
  segment_pct: number; base_pct: number; index: number | null;
}

export interface Dimension {
  field: string; display: string; type: AttrType; unit: string | null;
  multi_valued: boolean; rows: DistributionRow[];
}

export interface Profile {
  anchor: string;
  as_of: string;
  segment_size: number;
  base_size: number;
  share: number;
  kpis: Kpi[];
  dimensions: Dimension[];
}

export interface Overlap {
  segments: { id: string; name: string; size: number }[];
  cells: { a: string; b: string; count: number; jaccard: number }[];
}

export interface MemberView {
  anchor: string;
  key: string;
  entities: Record<string, Row | Row[]>;
  networks: Record<string, (Row & { edge: Row })[]>;
  segments: { id: string; name: string }[];
}
