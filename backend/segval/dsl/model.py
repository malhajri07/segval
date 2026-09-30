"""Segment definition language: a JSON rule tree produced by the no-code builder.

Example::

    {
      "anchor": "subscription",
      "rule": {
        "kind": "group", "op": "and",
        "children": [
          {"kind": "attribute", "field": "subscription.payment_type",
           "operator": "eq", "value": "POSTPAID"},
          {"kind": "metric", "metric": "avg_data_mb", "window_months": 3,
           "operator": "gt", "value": 20000},
          {"kind": "network", "network": "calls", "count_operator": "gte", "count_value": 2,
           "where": {"kind": "attribute", "field": "subscription.status",
                     "operator": "eq", "value": "CHURNED"}}
        ]
      }
    }
"""

from __future__ import annotations

from enum import StrEnum
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field


class Operator(StrEnum):
    EQ = "eq"
    NEQ = "neq"
    GT = "gt"
    GTE = "gte"
    LT = "lt"
    LTE = "lte"
    BETWEEN = "between"
    IN = "in"
    NOT_IN = "not_in"
    CONTAINS = "contains"
    STARTS_WITH = "starts_with"
    ENDS_WITH = "ends_with"
    IS_NULL = "is_null"
    IS_NOT_NULL = "is_not_null"
    WITHIN_LAST_DAYS = "within_last_days"
    BEFORE_LAST_DAYS = "before_last_days"


class CountOperator(StrEnum):
    EQ = "eq"
    NEQ = "neq"
    GT = "gt"
    GTE = "gte"
    LT = "lt"
    LTE = "lte"


class _Node(BaseModel):
    negate: bool = False
    label: str | None = None
    """Optional business-friendly caption shown in the builder."""


class AttributeCondition(_Node):
    kind: Literal["attribute"] = "attribute"
    field: str
    operator: Operator
    value: Any = None


class MetricCondition(_Node):
    kind: Literal["metric"] = "metric"
    metric: str
    window_months: int | None = Field(default=None, ge=1, le=36)
    operator: Operator
    value: Any = None


class RelatedCondition(_Node):
    """Count related entities (e.g. add-ons, tickets) matching an optional filter."""

    kind: Literal["related"] = "related"
    entity: str
    where: Rule | None = None
    count_operator: CountOperator = CountOperator.GTE
    count_value: int = Field(default=1, ge=0)


class EdgeCondition(BaseModel):
    attribute: str
    operator: Operator
    value: Any = None


class NetworkCondition(_Node):
    """Count graph neighbours (e.g. call contacts) that themselves match a rule."""

    kind: Literal["network"] = "network"
    network: str
    where: Rule | None = None
    edge_where: list[EdgeCondition] = Field(default_factory=list)
    count_operator: CountOperator = CountOperator.GTE
    count_value: int = Field(default=1, ge=0)


class SegmentCondition(_Node):
    """Membership of another (materialized) segment."""

    kind: Literal["segment"] = "segment"
    segment_id: str


class Group(_Node):
    kind: Literal["group"] = "group"
    op: Literal["and", "or"] = "and"
    children: list[Rule] = Field(default_factory=list)


Rule = Annotated[
    Group
    | AttributeCondition
    | MetricCondition
    | RelatedCondition
    | NetworkCondition
    | SegmentCondition,
    Field(discriminator="kind"),
]

for _m in (Group, RelatedCondition, NetworkCondition):
    _m.model_rebuild()


class SegmentDefinition(BaseModel):
    anchor: str = "subscription"
    rule: Rule = Field(default_factory=Group)


def iter_nodes(rule: Rule):
    """Depth-first walk over every node of a rule tree."""
    yield rule
    if isinstance(rule, Group):
        for child in rule.children:
            yield from iter_nodes(child)
    elif isinstance(rule, RelatedCondition | NetworkCondition) and rule.where is not None:
        yield from iter_nodes(rule.where)


def referenced_segments(rule: Rule) -> set[str]:
    return {n.segment_id for n in iter_nodes(rule) if isinstance(n, SegmentCondition)}
