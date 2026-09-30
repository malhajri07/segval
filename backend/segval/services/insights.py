"""Segment analytics: profile vs. base, KPIs, overlap and 360° member views."""

from __future__ import annotations

from typing import Any

from segval.catalog.model import Catalog
from segval.dsl.compiler import CompiledPredicate, hop_pattern, q
from segval.dsl.model import SegmentDefinition
from segval.graph.client import GraphClient
from segval.services import queries
from segval.services.segments import NotFound, SegmentService


def _pct(part: float, whole: float) -> float:
    return part / whole if whole else 0.0


class InsightsService:
    def __init__(self, catalog: Catalog, client: GraphClient, segments: SegmentService):
        self.catalog = catalog
        self.client = client
        self.segments = segments

    def _resolve(self, definition: SegmentDefinition | None, segment_id: str | None):
        if segment_id:
            definition = self.segments.get(segment_id).definition
        if definition is None:
            raise ValueError("provide a definition or a segment_id")
        self.segments.check_references(definition)
        return definition, self.segments.compile(definition)

    # ---- profile ----------------------------------------------------------------
    def profile(
        self, definition: SegmentDefinition | None = None, segment_id: str | None = None,
        dimensions: list[str] | None = None,
    ) -> dict[str, Any]:
        definition, cp = self._resolve(definition, segment_id)
        anchor = self.catalog.anchor(cp.anchor)
        assert anchor is not None
        counts = self.client.read(*_q(queries.count_query(cp)))[0]
        seg_n, base_n = counts["segment_size"], counts["base_size"]
        dims = [self.breakdown_for(cp, f, seg_n, base_n)
                for f in (dimensions or anchor.profile_dimensions)]
        return {
            "anchor": cp.anchor,
            "as_of": cp.params["as_of"],
            "segment_size": seg_n,
            "base_size": base_n,
            "share": _pct(seg_n, base_n),
            "kpis": self.kpis(cp),
            "dimensions": dims,
        }

    def breakdown(
        self, field: str, definition: SegmentDefinition | None = None,
        segment_id: str | None = None,
    ) -> dict[str, Any]:
        _, cp = self._resolve(definition, segment_id)
        counts = self.client.read(*_q(queries.count_query(cp)))[0]
        return self.breakdown_for(cp, field, counts["segment_size"], counts["base_size"])

    def breakdown_for(
        self, cp: CompiledPredicate, field: str, seg_n: int, base_n: int
    ) -> dict[str, Any]:
        entity, attr = self.catalog.resolve_field(field)
        hops = self.catalog.path(cp.anchor, entity.id)
        rows = self.client.read(*_q(queries.distribution_query(cp, self.catalog, field)))
        out = []
        for r in rows:
            seg_pct, base_pct = _pct(r["segment"], seg_n), _pct(r["base"], base_n)
            out.append({
                "value": r["value"] if r["value"] is not None else "(none)",
                "segment": r["segment"],
                "base": r["base"],
                "segment_pct": seg_pct,
                "base_pct": base_pct,
                "index": round(100 * seg_pct / base_pct) if base_pct else None,
            })
        if attr.buckets:
            order = {label: i for i, label in enumerate(queries.bucket_labels(attr.buckets))}
            out.sort(key=lambda row: order.get(row["value"], len(order)))
        elif attr.values:
            order = {v: i for i, v in enumerate(attr.values)}
            out.sort(key=lambda row: (order.get(row["value"], len(order)), -row["base"]))
        return {
            "field": field,
            "display": f"{entity.display} · {attr.display}" if hops else attr.display,
            "type": attr.type.value,
            "unit": attr.unit,
            "multi_valued": self.catalog.is_multi_valued(cp.anchor, entity.id),
            "rows": out,
        }

    # ---- KPIs ---------------------------------------------------------------------
    def kpis(self, cp: CompiledPredicate) -> list[dict[str, Any]]:
        anchor = self.catalog.anchor(cp.anchor)
        assert anchor is not None
        if not anchor.kpis:
            return []
        params = dict(cp.params)
        exprs = []
        for i, k in enumerate(anchor.kpis):
            if k.field:
                exprs.append(queries.field_projection(self.catalog, cp.anchor, cp.var, k.field))
            else:
                expr, p = self.segments.compiler.metric_expression(
                    k.metric or "", k.window_months, cp.anchor, cp.var, param_prefix=f"k{i}_"
                )
                exprs.append(expr)
                params.update(p)
        projections = ", ".join(f"{e} AS k{i}" for i, e in enumerate(exprs))
        returns = ", ".join(
            f"avg(CASE WHEN in_segment THEN k{i} END) AS seg{i}, avg(k{i}) AS base{i}"
            for i in range(len(exprs))
        )
        # The anchor variable must stay in the projection: Neo4j treats aggregates
        # inside COLLECT {} subqueries as projection aggregates needing a grouping key.
        text = (
            f"{queries.anchor_match(cp)}\n"
            f"WITH {cp.var}, coalesce({cp.predicate}, false) AS in_segment\n"
            f"WITH {cp.var}, in_segment, {projections}\nRETURN {returns}"
        )
        row = self.client.read(text, params)[0]
        out = []
        for i, k in enumerate(anchor.kpis):
            seg, base = row[f"seg{i}"], row[f"base{i}"]
            out.append({
                "id": k.id, "display": k.display, "unit": k.unit,
                "segment": seg, "base": base,
                "lift": (seg / base) if seg is not None and base else None,
            })
        return out

    # ---- overlap -------------------------------------------------------------------
    def overlap(self, segment_ids: list[str]) -> dict[str, Any]:
        segs = self.segments._get_many(segment_ids)
        missing = set(segment_ids) - {s.id for s in segs}
        if missing:
            raise NotFound(", ".join(sorted(missing)))
        not_ready = [s.name for s in segs if s.member_count is None]
        if not_ready:
            raise ValueError(f"materialize these segments first: {', '.join(not_ready)}")
        rows = self.client.read(
            "MATCH (s1:Segment)<-[:MEMBER_OF]-(m)-[:MEMBER_OF]->(s2:Segment) "
            "WHERE s1.id IN $ids AND s2.id IN $ids "
            "RETURN s1.id AS a, s2.id AS b, count(m) AS n",
            {"ids": segment_ids},
        )
        matrix = {(r["a"], r["b"]): r["n"] for r in rows}
        for s in segs:  # a pattern never reuses a relationship, so fill the diagonal
            matrix[(s.id, s.id)] = s.member_count or 0
        return {
            "segments": [{"id": s.id, "name": s.name, "size": s.member_count} for s in segs],
            "cells": [
                {"a": a.id, "b": b.id, "count": matrix.get((a.id, b.id), 0),
                 "jaccard": _pct(matrix.get((a.id, b.id), 0),
                                 (a.member_count or 0) + (b.member_count or 0)
                                 - matrix.get((a.id, b.id), 0))}
                for a in segs for b in segs
            ],
        }

    # ---- member 360 -----------------------------------------------------------------
    def member_view(self, anchor_id: str, key: str) -> dict[str, Any]:
        anchor = self.catalog.anchor(anchor_id)
        if anchor is None:
            raise NotFound(anchor_id)
        ent = self.catalog.anchor_entity(anchor_id)
        parts = [f"{ent.id}: a{{.*}}"]
        for other in self.catalog.entities:
            hops = self.catalog.path(anchor_id, other.id)
            if not hops:
                continue
            order = ""
            time_attr = next((at for at in other.attributes if at.type.value == "date"), None)
            if time_attr:
                order = f" ORDER BY y.{q(time_attr.property)} DESC"
            parts.append(
                f"{other.id}: COLLECT {{ MATCH {hop_pattern('a', hops, 'y')} "
                f"RETURN DISTINCT y{{.*}} AS y{order} LIMIT 24 }}"
            )
        net_parts = []
        for net in self.catalog.networks:
            if net.anchor != anchor_id:
                continue
            rel = f"[r:{q(net.rel)}]"
            arrow = {"out": f"-{rel}->", "in": f"<-{rel}-", "both": f"-{rel}-"}[net.direction]
            weight = net.edge_attributes[0].property if net.edge_attributes else None
            order = f" ORDER BY r.{q(weight)} DESC" if weight else ""
            net_parts.append(
                f"{net.id}: COLLECT {{ MATCH (a){arrow}(n:{q(ent.label)}) "
                f"RETURN n{{.*, edge: r{{.*}}}} AS n{order} LIMIT 25 }}"
            )
        networks = "{" + ", ".join(net_parts) + "}" if net_parts else "{}"
        rows = self.client.read(
            f"MATCH (a:{q(ent.label)} {{{q(ent.key)}: $key}})\n"
            f"RETURN {{{', '.join(parts)}}} AS entities, {networks} AS networks, "
            f"[(a)-[:MEMBER_OF]->(s:Segment) | s{{.id, .name}}] AS segments",
            {"key": key},
        )
        if not rows:
            raise NotFound(key)
        return {"anchor": anchor_id, "key": key, **rows[0]}


def _q(cq: queries.CypherQuery) -> tuple[str, dict[str, Any]]:
    return cq.text, cq.params
