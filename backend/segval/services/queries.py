"""Pure Cypher query builders on top of compiled predicates (no I/O here)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from segval.catalog.model import Attribute, AttrType, Catalog
from segval.dsl.compiler import CompiledPredicate, hop_pattern, q


@dataclass
class CypherQuery:
    text: str
    params: dict[str, Any]


def anchor_match(cp: CompiledPredicate) -> str:
    return f"MATCH ({cp.var}:{q(cp.label)})"


def count_query(cp: CompiledPredicate) -> CypherQuery:
    return CypherQuery(
        f"{anchor_match(cp)}\nWITH {cp.var}, coalesce({cp.predicate}, false) AS in_segment\n"
        f"RETURN count(CASE WHEN in_segment THEN 1 END) AS segment_size, "
        f"count(*) AS base_size",
        cp.params,
    )


def field_projection(catalog: Catalog, anchor: str, var: str, field: str) -> str:
    """Scalar expression for ``entity.attribute`` relative to the anchor (first value)."""
    entity, attr = catalog.resolve_field(field)
    hops = catalog.path(anchor, entity.id)
    if hops is None:
        raise ValueError(f"{field} is not reachable from {anchor}")
    if not hops:
        return f"{var}.{q(attr.property)}"
    return f"head([{hop_pattern(var, hops, 'y')} | y.{q(attr.property)}])"


def row_projection(catalog: Catalog, anchor: str, var: str, fields: list[str]) -> str:
    items = ", ".join(f"`{f}`: {field_projection(catalog, anchor, var, f)}" for f in fields)
    return "{" + items + "}"


def members_query(
    cp: CompiledPredicate, catalog: Catalog, fields: list[str], limit: int, skip: int = 0,
    materialized_segment_id: str | None = None, group: str | None = None,
) -> CypherQuery:
    params = dict(cp.params)
    params.update({"limit": limit, "skip": skip})
    key = catalog.anchor_entity(cp.anchor).key
    if materialized_segment_id:
        params["segment_id"] = materialized_segment_id
        params["group"] = group
        head = (
            f"MATCH ({cp.var}:{q(cp.label)})-[m:`MEMBER_OF`]->(:`Segment` {{id: $segment_id}})\n"
            "WHERE $group IS NULL OR coalesce(m.group, 'target') = $group"
        )
        grp = "coalesce(m.group, 'target')"
    else:
        head = f"{anchor_match(cp)}\nWHERE {cp.predicate}"
        grp = "null"
    return CypherQuery(
        f"{head}\nWITH {cp.var}, {grp} AS grp ORDER BY {cp.var}.{q(key)} SKIP $skip LIMIT $limit\n"
        f"RETURN {row_projection(catalog, cp.anchor, cp.var, fields)} AS row, grp AS group",
        params,
    )


def bucket_labels(edges: list[float]) -> list[str]:
    def fmt(v: float) -> str:
        return str(int(v)) if float(v).is_integer() else f"{v:g}"

    labels = [f"< {fmt(edges[0])}"]
    for lo, hi in zip(edges, edges[1:], strict=False):
        labels.append(f"{fmt(lo)} – {fmt(hi)}")
    labels.append(f"≥ {fmt(edges[-1])}")
    return labels


def bucket_expression(expr: str, edges: list[float]) -> str:
    labels = bucket_labels(edges)
    parts = [f"CASE WHEN {expr} IS NULL THEN null"]
    for edge, label in zip(edges, labels, strict=False):
        parts.append(f"WHEN {expr} < {edge!r} THEN {_lit(label)}")
    parts.append(f"ELSE {_lit(labels[-1])} END")
    return " ".join(parts)


def _lit(s: str) -> str:
    return "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'"


def value_expression(attr: Attribute, var: str) -> str:
    expr = f"{var}.{q(attr.property)}"
    if attr.type == AttrType.NUMBER and attr.buckets:
        return bucket_expression(expr, attr.buckets)
    if attr.type == AttrType.DATE:
        return f"toString(date.truncate('month', {expr}))"
    return f"toString({expr})"


def distribution_query(cp: CompiledPredicate, catalog: Catalog, field: str) -> CypherQuery:
    """Segment vs. base distribution of one dimension, in a single pass."""
    entity, attr = catalog.resolve_field(field)
    hops = catalog.path(cp.anchor, entity.id)
    if hops is None:
        raise ValueError(f"{field} is not reachable from {cp.anchor}")
    v = cp.var
    lines = [anchor_match(cp), f"WITH {v}, coalesce({cp.predicate}, false) AS in_segment"]
    if hops:
        lines.append(f"OPTIONAL MATCH {hop_pattern(v, hops, 'y')}")
        value = value_expression(attr, "y")
    else:
        value = value_expression(attr, v)
    lines.append(f"WITH {v}, in_segment, {value} AS value")
    lines.append(
        f"RETURN value, count(DISTINCT CASE WHEN in_segment THEN {v} END) AS segment, "
        f"count(DISTINCT {v}) AS base ORDER BY base DESC LIMIT 60"
    )
    return CypherQuery("\n".join(lines), cp.params)


def materialize_queries(cp: CompiledPredicate, segment_id: str) -> list[CypherQuery]:
    params = dict(cp.params)
    params["segment_id"] = segment_id
    clear = CypherQuery(
        "MATCH (:`Segment` {id: $segment_id})<-[r:`MEMBER_OF`]-(m) "
        "CALL (r) { DELETE r } IN TRANSACTIONS OF 10000 ROWS",
        {"segment_id": segment_id},
    )
    fill = CypherQuery(
        f"MATCH (seg:`Segment` {{id: $segment_id}})\n{anchor_match(cp)}\nWHERE {cp.predicate}\n"
        f"CALL ({cp.var}, seg) {{ MERGE ({cp.var})-[:`MEMBER_OF`]->(seg) }} "
        f"IN TRANSACTIONS OF 5000 ROWS",
        params,
    )
    return [clear, fill]
