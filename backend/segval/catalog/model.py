"""Semantic catalog: the business vocabulary that the no-code builder exposes.

The catalog maps business terms (entities, attributes, metrics, networks) onto the
Neo4j graph (labels, relationship types, properties, traversal paths). The DSL
compiler only ever emits identifiers that come from a validated catalog, so users
can never inject arbitrary Cypher.
"""

from __future__ import annotations

import re
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, Field, model_validator

IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def check_ident(value: str, what: str) -> str:
    if not IDENT.match(value):
        raise ValueError(f"invalid {what} identifier: {value!r}")
    return value


class AttrType(StrEnum):
    NUMBER = "number"
    STRING = "string"
    ENUM = "enum"
    BOOLEAN = "boolean"
    DATE = "date"


class Aggregate(StrEnum):
    SUM = "sum"
    AVG = "avg"
    MIN = "min"
    MAX = "max"
    COUNT = "count"


class Hop(BaseModel):
    rel: str
    direction: Literal["out", "in", "both"] = "out"
    label: str
    many: bool = False
    """True when one start node can reach several end nodes through this hop."""

    @model_validator(mode="after")
    def _idents(self) -> Hop:
        check_ident(self.rel, "relationship")
        check_ident(self.label, "label")
        return self


class Attribute(BaseModel):
    id: str
    property: str
    type: AttrType
    display: str
    description: str = ""
    unit: str | None = None
    values: list[str] | None = None
    buckets: list[float] | None = None
    """Ascending bucket edges used to profile numeric attributes."""
    searchable: bool = False
    """Offer distinct-value suggestions in the builder (strings)."""

    @model_validator(mode="after")
    def _check(self) -> Attribute:
        check_ident(self.id, "attribute")
        check_ident(self.property, "property")
        if self.type == AttrType.ENUM and not self.values:
            raise ValueError(f"enum attribute {self.id} needs values")
        if self.buckets and sorted(self.buckets) != self.buckets:
            raise ValueError(f"buckets for {self.id} must be ascending")
        return self


class Entity(BaseModel):
    id: str
    label: str
    display: str
    description: str = ""
    key: str
    attributes: list[Attribute]
    paths: dict[str, list[Hop]] = Field(default_factory=dict)
    """Traversal from each anchor to this entity. An empty list means the entity IS the anchor."""

    @model_validator(mode="after")
    def _check(self) -> Entity:
        check_ident(self.id, "entity")
        check_ident(self.label, "label")
        check_ident(self.key, "key")
        seen: set[str] = set()
        for a in self.attributes:
            if a.id in seen:
                raise ValueError(f"duplicate attribute {self.id}.{a.id}")
            seen.add(a.id)
        return self

    def attribute(self, attr_id: str) -> Attribute | None:
        return next((a for a in self.attributes if a.id == attr_id), None)


class Metric(BaseModel):
    id: str
    display: str
    description: str = ""
    entity: str
    aggregate: Aggregate
    property: str | None = None
    time_property: str | None = None
    unit: str | None = None
    default_window_months: int = 3

    @model_validator(mode="after")
    def _check(self) -> Metric:
        check_ident(self.id, "metric")
        if self.property:
            check_ident(self.property, "property")
        if self.time_property:
            check_ident(self.time_property, "property")
        if self.aggregate != Aggregate.COUNT and not self.property:
            raise ValueError(f"metric {self.id} needs a property for {self.aggregate}")
        return self


class Network(BaseModel):
    id: str
    display: str
    description: str = ""
    anchor: str
    rel: str
    direction: Literal["out", "in", "both"] = "both"
    edge_attributes: list[Attribute] = Field(default_factory=list)

    @model_validator(mode="after")
    def _check(self) -> Network:
        check_ident(self.id, "network")
        check_ident(self.rel, "relationship")
        return self

    def edge_attribute(self, attr_id: str) -> Attribute | None:
        return next((a for a in self.edge_attributes if a.id == attr_id), None)


class Kpi(BaseModel):
    id: str
    display: str
    field: str | None = None
    """entity.attribute averaged across the segment."""
    metric: str | None = None
    window_months: int | None = None
    unit: str | None = None

    @model_validator(mode="after")
    def _check(self) -> Kpi:
        if bool(self.field) == bool(self.metric):
            raise ValueError(f"kpi {self.id} needs exactly one of field/metric")
        return self


class Anchor(BaseModel):
    id: str
    entity: str
    display: str
    description: str = ""
    profile_dimensions: list[str] = Field(default_factory=list)
    kpis: list[Kpi] = Field(default_factory=list)
    sample_fields: list[str] = Field(default_factory=list)


class Catalog(BaseModel):
    domain: str
    display: str
    currency: str = "SAR"
    anchors: list[Anchor]
    entities: list[Entity]
    metrics: list[Metric] = Field(default_factory=list)
    networks: list[Network] = Field(default_factory=list)

    @model_validator(mode="after")
    def _check(self) -> Catalog:
        ents = {e.id: e for e in self.entities}
        if len(ents) != len(self.entities):
            raise ValueError("duplicate entity ids")
        for anchor in self.anchors:
            ent = ents.get(anchor.entity)
            if ent is None:
                raise ValueError(f"anchor {anchor.id} references unknown entity {anchor.entity}")
            if ent.paths.get(anchor.id) != []:
                raise ValueError(f"anchor entity {ent.id} must have an empty path for {anchor.id}")
            for f in anchor.profile_dimensions + anchor.sample_fields:
                self.resolve_field(f)
                if not self.path(anchor.id, f.split(".")[0]) and f.split(".")[0] != ent.id:
                    raise ValueError(f"field {f} is not reachable from anchor {anchor.id}")
            for k in anchor.kpis:
                if k.field:
                    self.resolve_field(k.field)
                elif k.metric and self.metric(k.metric) is None:
                    raise ValueError(f"kpi {k.id} references unknown metric {k.metric}")
        anchor_ids = {a.id for a in self.anchors}
        for e in self.entities:
            for a_id in e.paths:
                if a_id not in anchor_ids:
                    raise ValueError(f"entity {e.id} has a path for unknown anchor {a_id}")
        for m in self.metrics:
            ent = ents.get(m.entity)
            if ent is None:
                raise ValueError(f"metric {m.id} references unknown entity {m.entity}")
            for prop in (m.property, m.time_property):
                if prop and not any(a.property == prop for a in ent.attributes):
                    raise ValueError(f"metric {m.id} property {prop} is not an attribute of {ent.id}")
        for n in self.networks:
            if n.anchor not in anchor_ids:
                raise ValueError(f"network {n.id} references unknown anchor {n.anchor}")
        return self

    # ---- lookups -------------------------------------------------------
    def anchor(self, anchor_id: str) -> Anchor | None:
        return next((a for a in self.anchors if a.id == anchor_id), None)

    def entity(self, entity_id: str) -> Entity | None:
        return next((e for e in self.entities if e.id == entity_id), None)

    def metric(self, metric_id: str) -> Metric | None:
        return next((m for m in self.metrics if m.id == metric_id), None)

    def network(self, network_id: str) -> Network | None:
        return next((n for n in self.networks if n.id == network_id), None)

    def anchor_entity(self, anchor_id: str) -> Entity:
        anchor = self.anchor(anchor_id)
        if anchor is None:
            raise KeyError(anchor_id)
        ent = self.entity(anchor.entity)
        assert ent is not None
        return ent

    def path(self, anchor_id: str, entity_id: str) -> list[Hop] | None:
        """Hops from the anchor to the entity; [] for the anchor itself, None if unreachable."""
        ent = self.entity(entity_id)
        if ent is None:
            return None
        return ent.paths.get(anchor_id)

    def is_multi_valued(self, anchor_id: str, entity_id: str) -> bool:
        return any(h.many for h in self.path(anchor_id, entity_id) or [])

    def resolve_field(self, field: str) -> tuple[Entity, Attribute]:
        entity_id, _, attr_id = field.partition(".")
        ent = self.entity(entity_id)
        if ent is None:
            raise KeyError(f"unknown entity in field {field!r}")
        attr = ent.attribute(attr_id)
        if attr is None:
            raise KeyError(f"unknown attribute in field {field!r}")
        return ent, attr
