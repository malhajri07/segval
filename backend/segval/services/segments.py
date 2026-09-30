"""Segment lifecycle: preview, save, version, materialize, export."""

from __future__ import annotations

import csv
import io
import json
import time
import uuid
from datetime import UTC, date, datetime
from typing import Any

from pydantic import BaseModel, Field, computed_field

from segval.catalog.model import Catalog
from segval.dsl.compiler import CompiledPredicate, CompileError, Compiler
from segval.dsl.model import SegmentDefinition, referenced_segments
from segval.graph.client import GraphClient
from segval.services import queries


class NotFound(LookupError):
    pass


class Conflict(RuntimeError):
    pass


class SegmentIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = ""
    tags: list[str] = Field(default_factory=list)
    definition: SegmentDefinition
    owner: str | None = None


class Segment(SegmentIn):
    id: str
    version: int = 1
    created_at: str
    updated_at: str
    member_count: int | None = None
    materialized_at: str | None = None
    materialized_version: int | None = None
    materialized_as_of: str | None = None
    depends_on: list[str] = Field(default_factory=list)

    @computed_field  # type: ignore[prop-decorator]
    @property
    def is_stale(self) -> bool:
        """True when the definition changed since the last materialization."""
        return self.materialized_version != self.version


class DataClock:
    """Resolves the "as of" date (latest month of usage loaded) with a short cache."""

    def __init__(self, client: GraphClient, ttl_s: float = 300.0):
        self._client = client
        self._ttl = ttl_s
        self._value: date | None = None
        self._at = 0.0

    def as_of(self) -> date:
        if self._value is None or time.monotonic() - self._at > self._ttl:
            rows = self._client.read("MATCH (u:MonthlyUsage) RETURN max(u.month) AS m")
            raw = rows[0]["m"] if rows else None
            self._value = date.fromisoformat(raw) if raw else date.today().replace(day=1)
            self._at = time.monotonic()
        return self._value

    def invalidate(self) -> None:
        self._value = None


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _to_segment(props: dict[str, Any]) -> Segment:
    data = dict(props)
    data["definition"] = json.loads(data.pop("definition_json"))
    data["tags"] = data.get("tags") or []
    data["depends_on"] = data.get("depends_on") or []
    data.pop("is_stale", None)
    return Segment.model_validate(data)


class SegmentService:
    def __init__(self, catalog: Catalog, client: GraphClient, clock: DataClock):
        self.catalog = catalog
        self.client = client
        self.clock = clock
        self.compiler = Compiler(catalog)

    # ---- compile & preview ---------------------------------------------------
    def compile(self, definition: SegmentDefinition) -> CompiledPredicate:
        return self.compiler.compile(definition, as_of=self.clock.as_of())

    def check_references(self, definition: SegmentDefinition, self_id: str | None = None) -> None:
        refs = referenced_segments(definition.rule)
        if not refs:
            return
        if self_id and self_id in refs:
            raise CompileError("a segment cannot reference itself", "rule")
        found = {s.id: s for s in self._get_many(list(refs))}
        for ref in refs:
            seg = found.get(ref)
            if seg is None:
                raise CompileError(f"referenced segment {ref!r} does not exist", "rule")
            if seg.definition.anchor != definition.anchor:
                raise CompileError(
                    f"segment {seg.name!r} is a {seg.definition.anchor} segment; "
                    f"expected {definition.anchor}", "rule",
                )
            if self_id and self_id in self._dependency_closure(ref):
                raise CompileError(f"segment {seg.name!r} depends on this segment (cycle)", "rule")

    def cypher(self, definition: SegmentDefinition) -> dict[str, Any]:
        cp = self.compile(definition)
        return {
            "cypher": f"{queries.anchor_match(cp)}\nWHERE {cp.predicate}\nRETURN {cp.var}",
            "params": cp.params,
        }

    def preview(self, definition: SegmentDefinition, sample_size: int = 25) -> dict[str, Any]:
        self.check_references(definition)
        cp = self.compile(definition)
        started = time.perf_counter()
        counts = self.client.read(*_q(queries.count_query(cp)))[0]
        anchor = self.catalog.anchor(cp.anchor)
        assert anchor is not None
        sample = []
        if sample_size > 0 and counts["segment_size"]:
            mq = queries.members_query(cp, self.catalog, anchor.sample_fields, sample_size)
            sample = [r["row"] for r in self.client.read(*_q(mq))]
        base = counts["base_size"] or 0
        return {
            "segment_size": counts["segment_size"],
            "base_size": base,
            "share": (counts["segment_size"] / base) if base else 0.0,
            "sample_fields": anchor.sample_fields,
            "sample": sample,
            "as_of": cp.params["as_of"],
            "elapsed_ms": round((time.perf_counter() - started) * 1000, 1),
        }

    # ---- CRUD -------------------------------------------------------------------
    def list(self, tag: str | None = None) -> list[Segment]:
        rows = self.client.read(
            "MATCH (s:Segment) WHERE $tag IS NULL OR $tag IN s.tags "
            "RETURN s{.*} AS s ORDER BY s.updated_at DESC",
            {"tag": tag},
        )
        return [_to_segment(r["s"]) for r in rows]

    def get(self, segment_id: str) -> Segment:
        found = self._get_many([segment_id])
        if not found:
            raise NotFound(segment_id)
        return found[0]

    def _get_many(self, ids: list[str]) -> list[Segment]:
        rows = self.client.read(
            "MATCH (s:Segment) WHERE s.id IN $ids RETURN s{.*} AS s", {"ids": ids}
        )
        return [_to_segment(r["s"]) for r in rows]

    def create(self, data: SegmentIn) -> Segment:
        self.check_references(data.definition)
        self.compile(data.definition)  # validate
        now = _now()
        props = {
            "id": uuid.uuid4().hex[:12],
            "name": data.name,
            "description": data.description,
            "tags": data.tags,
            "owner": data.owner,
            "definition_json": data.definition.model_dump_json(),
            "depends_on": sorted(referenced_segments(data.definition.rule)),
            "version": 1,
            "created_at": now,
            "updated_at": now,
        }
        rows = self.client.write("CREATE (s:Segment) SET s = $props RETURN s{.*} AS s",
                                 {"props": props})
        return _to_segment(rows[0]["s"])

    def update(self, segment_id: str, data: SegmentIn) -> Segment:
        current = self.get(segment_id)
        self.check_references(data.definition, self_id=segment_id)
        self.compile(data.definition)
        definition_changed = (
            current.definition.model_dump() != data.definition.model_dump()
        )
        rows = self.client.write(
            "MATCH (s:Segment {id: $id}) "
            "SET s.name = $name, s.description = $description, s.tags = $tags, "
            "    s.owner = $owner, s.definition_json = $definition_json, "
            "    s.depends_on = $depends_on, s.updated_at = $now, "
            "    s.version = s.version + CASE WHEN $bump THEN 1 ELSE 0 END "
            "RETURN s{.*} AS s",
            {
                "id": segment_id, "name": data.name, "description": data.description,
                "tags": data.tags, "owner": data.owner,
                "definition_json": data.definition.model_dump_json(),
                "depends_on": sorted(referenced_segments(data.definition.rule)),
                "now": _now(), "bump": definition_changed,
            },
        )
        return _to_segment(rows[0]["s"])

    def delete(self, segment_id: str) -> None:
        self.get(segment_id)
        dependants = self.client.read(
            "MATCH (s:Segment) WHERE $id IN s.depends_on RETURN s.name AS name", {"id": segment_id}
        )
        if dependants:
            names = ", ".join(r["name"] for r in dependants)
            raise Conflict(f"segment is used by: {names}")
        self.client.run_autocommit(
            "MATCH (:Segment {id: $id})<-[r:MEMBER_OF]-() "
            "CALL (r) { DELETE r } IN TRANSACTIONS OF 10000 ROWS",
            {"id": segment_id},
        )
        self.client.write("MATCH (s:Segment {id: $id}) DETACH DELETE s", {"id": segment_id})

    def _dependency_closure(self, segment_id: str) -> set[str]:
        rows = self.client.read(
            "MATCH (s:Segment {id: $id}) RETURN s.depends_on AS deps", {"id": segment_id}
        )
        seen: set[str] = set()
        frontier = list(rows[0]["deps"] or []) if rows else []
        while frontier:
            nxt = frontier.pop()
            if nxt in seen:
                continue
            seen.add(nxt)
            r = self.client.read(
                "MATCH (s:Segment {id: $id}) RETURN s.depends_on AS deps", {"id": nxt}
            )
            if r:
                frontier.extend(r[0]["deps"] or [])
        return seen

    # ---- materialization ---------------------------------------------------------
    def materialize(self, segment_id: str, _visiting: set[str] | None = None) -> Segment:
        """(Re)build MEMBER_OF edges. Stale dependencies are materialized first."""
        visiting = _visiting or set()
        if segment_id in visiting:
            raise CompileError("segment dependency cycle detected", "rule")
        visiting.add(segment_id)
        seg = self.get(segment_id)
        for dep in self._get_many(seg.depends_on):
            if dep.is_stale or dep.member_count is None:
                self.materialize(dep.id, visiting)
        cp = self.compile(seg.definition)
        for mq in queries.materialize_queries(cp, segment_id):
            self.client.run_autocommit(mq.text, mq.params)
        rows = self.client.write(
            "MATCH (s:Segment {id: $id}) "
            "SET s.member_count = COUNT { (s)<-[:MEMBER_OF]-() }, "
            "    s.materialized_at = $now, s.materialized_version = s.version, "
            "    s.materialized_as_of = $as_of "
            "RETURN s{.*} AS s",
            {"id": segment_id, "now": _now(), "as_of": cp.params["as_of"]},
        )
        return _to_segment(rows[0]["s"])

    def members(self, segment_id: str, limit: int = 100, skip: int = 0,
                fields: list[str] | None = None) -> dict[str, Any]:
        seg = self.get(segment_id)
        anchor = self.catalog.anchor(seg.definition.anchor)
        assert anchor is not None
        fields = fields or anchor.sample_fields
        for f in fields:
            self.catalog.resolve_field(f)
        cp = self.compile(seg.definition)
        materialized = seg.member_count is not None
        mq = queries.members_query(
            cp, self.catalog, fields, limit, skip,
            materialized_segment_id=segment_id if materialized else None,
        )
        return {
            "fields": fields,
            "rows": [r["row"] for r in self.client.read(*_q(mq))],
            "source": "materialized" if materialized else "live",
        }

    def export_csv(self, segment_id: str, fields: list[str] | None = None,
                   max_rows: int = 1_000_000) -> str:
        page = self.members(segment_id, limit=max_rows, fields=fields)
        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=page["fields"], extrasaction="ignore")
        writer.writeheader()
        writer.writerows(page["rows"])
        return buf.getvalue()


def _q(cq: queries.CypherQuery) -> tuple[str, dict[str, Any]]:
    return cq.text, cq.params
