"""Compile segment rule trees into parameterised Cypher.

Design rules:
* Every label, relationship type and property comes from the catalog, and
  identifiers are backtick-quoted. User-supplied values only ever travel as
  query parameters, so the output is injection-safe.
* Each rule node compiles to a boolean Cypher *expression* over the current
  anchor variable. Conditions on related entities use ``EXISTS {}`` /
  ``COUNT {}`` subqueries and metrics use ``COLLECT {}`` subqueries, so nodes
  compose freely under AND / OR / NOT and nest inside network conditions.
* Relative time (metric windows, "within last N days") is resolved against the
  ``$as_of`` parameter, i.e. the latest date loaded into the graph, which keeps
  results reproducible.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from typing import Any

from segval.catalog.model import Aggregate, Attribute, AttrType, Catalog, Hop
from segval.dsl.model import (
    AttributeCondition,
    CountOperator,
    EdgeCondition,
    Group,
    MetricCondition,
    NetworkCondition,
    Operator,
    RelatedCondition,
    Rule,
    SegmentCondition,
    SegmentDefinition,
)

MAX_DEPTH = 6

OPERATORS_BY_TYPE: dict[AttrType, list[Operator]] = {
    AttrType.NUMBER: [
        Operator.EQ, Operator.NEQ, Operator.GT, Operator.GTE, Operator.LT, Operator.LTE,
        Operator.BETWEEN, Operator.IN, Operator.NOT_IN, Operator.IS_NULL, Operator.IS_NOT_NULL,
    ],
    AttrType.STRING: [
        Operator.EQ, Operator.NEQ, Operator.IN, Operator.NOT_IN, Operator.CONTAINS,
        Operator.STARTS_WITH, Operator.ENDS_WITH, Operator.IS_NULL, Operator.IS_NOT_NULL,
    ],
    AttrType.ENUM: [
        Operator.EQ, Operator.NEQ, Operator.IN, Operator.NOT_IN,
        Operator.IS_NULL, Operator.IS_NOT_NULL,
    ],
    AttrType.BOOLEAN: [Operator.EQ, Operator.IS_NULL, Operator.IS_NOT_NULL],
    AttrType.DATE: [
        Operator.EQ, Operator.GT, Operator.GTE, Operator.LT, Operator.LTE, Operator.BETWEEN,
        Operator.WITHIN_LAST_DAYS, Operator.BEFORE_LAST_DAYS,
        Operator.IS_NULL, Operator.IS_NOT_NULL,
    ],
}

METRIC_OPERATORS = [
    Operator.EQ, Operator.NEQ, Operator.GT, Operator.GTE,
    Operator.LT, Operator.LTE, Operator.BETWEEN,
]

_CMP = {
    Operator.EQ: "=", Operator.NEQ: "<>", Operator.GT: ">",
    Operator.GTE: ">=", Operator.LT: "<", Operator.LTE: "<=",
}
_COUNT_CMP = {
    CountOperator.EQ: "=", CountOperator.NEQ: "<>", CountOperator.GT: ">",
    CountOperator.GTE: ">=", CountOperator.LT: "<", CountOperator.LTE: "<=",
}


class CompileError(ValueError):
    def __init__(self, message: str, path: str = "rule"):
        super().__init__(f"{path}: {message}")
        self.message = message
        self.path = path


def q(ident: str) -> str:
    """Backtick-quote an identifier (already validated by the catalog)."""
    return f"`{ident}`"


def hop_pattern(start_var: str, hops: list[Hop], end_var: str) -> str:
    parts = [f"({start_var})"]
    for i, hop in enumerate(hops):
        rel = f"[:{q(hop.rel)}]"
        arrow = {"out": f"-{rel}->", "in": f"<-{rel}-", "both": f"-{rel}-"}[hop.direction]
        node_var = end_var if i == len(hops) - 1 else ""
        parts.append(f"{arrow}({node_var}:{q(hop.label)})")
    return "".join(parts)


@dataclass
class _Params:
    prefix: str = "p"
    values: dict[str, Any] = field(default_factory=dict)

    def add(self, value: Any) -> str:
        name = f"{self.prefix}{len(self.values)}"
        self.values[name] = value
        return f"${name}"


@dataclass
class _State:
    catalog: Catalog
    params: _Params = field(default_factory=_Params)
    var_seq: int = 0
    uses_as_of: bool = False

    def new_var(self, prefix: str = "x") -> str:
        self.var_seq += 1
        return f"{prefix}{self.var_seq}"


@dataclass(frozen=True)
class _Scope:
    """Where a node is being compiled.

    ``anchor``/``var``: the anchor type and variable conditions hang off.
    ``bound``: entity id -> variable already bound in this scope.
    ``restricted``: only entities in ``bound`` may be referenced (inside a
    ``related`` filter, where fields describe the related entity itself).
    """

    anchor: str
    var: str
    bound: dict[str, str]
    restricted: bool = False
    depth: int = 0


@dataclass
class CompiledPredicate:
    anchor: str
    label: str
    var: str
    predicate: str
    params: dict[str, Any]


class Compiler:
    def __init__(self, catalog: Catalog):
        self.catalog = catalog

    # ---- public API ------------------------------------------------------
    def compile(
        self, definition: SegmentDefinition, as_of: date | str | None = None, var: str = "a",
        param_prefix: str = "p",
    ) -> CompiledPredicate:
        anchor = self.catalog.anchor(definition.anchor)
        if anchor is None:
            raise CompileError(f"unknown anchor {definition.anchor!r}", "anchor")
        anchor_entity = self.catalog.anchor_entity(anchor.id)
        state = _State(self.catalog, params=_Params(prefix=param_prefix))
        scope = _Scope(anchor=anchor.id, var=var, bound={anchor_entity.id: var})
        predicate = self._node(definition.rule, scope, state, "rule")
        params = dict(state.params.values)
        params["as_of"] = str(as_of or date.today())
        return CompiledPredicate(
            anchor=anchor.id,
            label=anchor_entity.label,
            var=var,
            predicate=predicate,
            params=params,
        )

    def metric_expression(
        self, metric_id: str, window_months: int | None, anchor: str, var: str,
        param_prefix: str = "k",
    ) -> tuple[str, dict[str, Any]]:
        """Stand-alone metric value expression (used for KPIs).

        Parameters are named ``{param_prefix}N`` so they can be merged with a
        compiled predicate's parameters without clashing.
        """
        if self.catalog.anchor(anchor) is None:
            raise CompileError(f"unknown anchor {anchor!r}", "anchor")
        state = _State(self.catalog, params=_Params(prefix=param_prefix))
        cond = MetricCondition(
            metric=metric_id, window_months=window_months, operator=Operator.GTE, value=0
        )
        scope = _Scope(anchor=anchor, var=var, bound={})
        return self._metric_value(cond, scope, state, "kpi"), state.params.values

    # ---- dispatch --------------------------------------------------------
    def _node(self, node: Rule, scope: _Scope, st: _State, path: str) -> str:
        if scope.depth > MAX_DEPTH:
            raise CompileError(f"rule nesting deeper than {MAX_DEPTH} levels", path)
        if isinstance(node, Group):
            expr = self._group(node, scope, st, path)
        elif isinstance(node, AttributeCondition):
            expr = self._attribute(node, scope, st, path)
        elif isinstance(node, MetricCondition):
            expr = self._metric(node, scope, st, path)
        elif isinstance(node, RelatedCondition):
            expr = self._related(node, scope, st, path)
        elif isinstance(node, NetworkCondition):
            expr = self._network(node, scope, st, path)
        elif isinstance(node, SegmentCondition):
            expr = self._segment(node, scope, st, path)
        else:  # pragma: no cover - guarded by pydantic
            raise CompileError(f"unsupported node {type(node).__name__}", path)
        return f"NOT ({expr})" if node.negate else expr

    def _group(self, node: Group, scope: _Scope, st: _State, path: str) -> str:
        if not node.children:
            return "true"
        child_scope = _Scope(scope.anchor, scope.var, scope.bound, scope.restricted, scope.depth + 1)
        parts = [
            self._node(child, child_scope, st, f"{path}.children[{i}]")
            for i, child in enumerate(node.children)
        ]
        if len(parts) == 1:
            return parts[0]
        joiner = " AND " if node.op == "and" else " OR "
        return "(" + joiner.join(f"({p})" for p in parts) + ")"

    # ---- attribute -------------------------------------------------------
    def _attribute(self, node: AttributeCondition, scope: _Scope, st: _State, path: str) -> str:
        try:
            entity, attr = self.catalog.resolve_field(node.field)
        except KeyError as exc:
            raise CompileError(str(exc.args[0]), path) from None

        if entity.id in scope.bound:
            return self._comparison(
                f"{scope.bound[entity.id]}.{q(attr.property)}", attr, node.operator, node.value,
                st, path,
            )
        if scope.restricted:
            raise CompileError(
                f"field {node.field!r} is not available here; "
                f"use fields of {', '.join(scope.bound)}",
                path,
            )
        hops = self.catalog.path(scope.anchor, entity.id)
        if hops is None:
            raise CompileError(f"{entity.display} is not reachable from {scope.anchor}", path)
        x = st.new_var()
        pred = self._comparison(f"{x}.{q(attr.property)}", attr, node.operator, node.value, st, path)
        return f"EXISTS {{ MATCH {hop_pattern(scope.var, hops, x)} WHERE {pred} }}"

    def _comparison(
        self, expr: str, attr: Attribute, op: Operator, value: Any, st: _State, path: str
    ) -> str:
        allowed = OPERATORS_BY_TYPE[attr.type]
        if op not in allowed:
            raise CompileError(
                f"operator {op.value!r} is not valid for {attr.type.value} field {attr.display!r}",
                path,
            )
        if op == Operator.IS_NULL:
            return f"{expr} IS NULL"
        if op == Operator.IS_NOT_NULL:
            return f"{expr} IS NOT NULL"

        if op in (Operator.WITHIN_LAST_DAYS, Operator.BEFORE_LAST_DAYS):
            days = _as_int(value, path, "number of days")
            st.uses_as_of = True
            p = st.params.add(days)
            cutoff = f"date($as_of) - duration({{days: {p}}})"
            if op == Operator.WITHIN_LAST_DAYS:
                return f"({expr} >= {cutoff} AND {expr} <= date($as_of))"
            return f"{expr} < {cutoff}"

        if op == Operator.BETWEEN:
            if not isinstance(value, list | tuple) or len(value) != 2:
                raise CompileError("between needs [low, high]", path)
            lo = self._value_param(attr, value[0], st, path)
            hi = self._value_param(attr, value[1], st, path)
            return f"({expr} >= {lo} AND {expr} <= {hi})"

        if op in (Operator.IN, Operator.NOT_IN):
            if not isinstance(value, list | tuple) or not value:
                raise CompileError("choose at least one value", path)
            coerced = [_coerce(attr, v, path) for v in value]
            if attr.type == AttrType.DATE:
                p = st.params.add([v.isoformat() for v in coerced])
                inner = f"{expr} IN [d IN {p} | date(d)]"
            else:
                inner = f"{expr} IN {st.params.add(coerced)}"
            return inner if op == Operator.IN else f"NOT {inner}"

        if op in (Operator.CONTAINS, Operator.STARTS_WITH, Operator.ENDS_WITH):
            p = st.params.add(str(_coerce(attr, value, path)).lower())
            kw = {"contains": "CONTAINS", "starts_with": "STARTS WITH", "ends_with": "ENDS WITH"}
            return f"toLower({expr}) {kw[op.value]} {p}"

        p = self._value_param(attr, value, st, path)
        return f"{expr} {_CMP[op]} {p}"

    def _value_param(self, attr: Attribute, value: Any, st: _State, path: str) -> str:
        v = _coerce(attr, value, path)
        if attr.type == AttrType.DATE:
            return f"date({st.params.add(v.isoformat())})"
        return st.params.add(v)

    # ---- metrics -----------------------------------------------------------
    def _metric_value(self, node: MetricCondition, scope: _Scope, st: _State, path: str) -> str:
        metric = self.catalog.metric(node.metric)
        if metric is None:
            raise CompileError(f"unknown metric {node.metric!r}", path)
        hops = self.catalog.path(scope.anchor, metric.entity)
        if not hops:
            raise CompileError(f"metric {metric.display!r} is not available for {scope.anchor}", path)
        x = st.new_var("m")
        where = ""
        if metric.time_property:
            months = node.window_months or metric.default_window_months
            st.uses_as_of = True
            p = st.params.add(months)
            tp = f"{x}.{q(metric.time_property)}"
            where = (
                f" WHERE {tp} > date($as_of) - duration({{months: {p}}})"
                f" AND {tp} <= date($as_of)"
            )
        agg = (
            f"count({x})"
            if metric.aggregate == Aggregate.COUNT
            else f"{metric.aggregate.value}({x}.{q(metric.property or '')})"
        )
        return (
            f"coalesce(head(COLLECT {{ MATCH {hop_pattern(scope.var, hops, x)}{where} "
            f"RETURN {agg} AS v }}), 0)"
        )

    def _metric(self, node: MetricCondition, scope: _Scope, st: _State, path: str) -> str:
        if scope.restricted:
            raise CompileError("metrics cannot be used inside a related-entity filter", path)
        if node.operator not in METRIC_OPERATORS:
            raise CompileError(f"operator {node.operator.value!r} is not valid for metrics", path)
        expr = self._metric_value(node, scope, st, path)
        if node.operator == Operator.BETWEEN:
            if not isinstance(node.value, list | tuple) or len(node.value) != 2:
                raise CompileError("between needs [low, high]", path)
            lo = st.params.add(_as_number(node.value[0], path))
            hi = st.params.add(_as_number(node.value[1], path))
            return f"({expr} >= {lo} AND {expr} <= {hi})"
        p = st.params.add(_as_number(node.value, path))
        return f"{expr} {_CMP[node.operator]} {p}"

    # ---- related entities --------------------------------------------------
    def _related(self, node: RelatedCondition, scope: _Scope, st: _State, path: str) -> str:
        if scope.restricted:
            raise CompileError("related conditions cannot be nested in a related filter", path)
        entity = self.catalog.entity(node.entity)
        if entity is None:
            raise CompileError(f"unknown entity {node.entity!r}", path)
        hops = self.catalog.path(scope.anchor, entity.id)
        if not hops:
            raise CompileError(f"{entity.display} is not related to {scope.anchor}", path)
        x = st.new_var()
        where = ""
        if node.where is not None:
            inner = _Scope(scope.anchor, x, {entity.id: x}, restricted=True, depth=scope.depth + 1)
            where = f" WHERE {self._node(node.where, inner, st, f'{path}.where')}"
        pattern = hop_pattern(scope.var, hops, x)
        return self._count_expr(
            f"COUNT {{ MATCH {pattern}{where} RETURN DISTINCT {x} }}",
            pattern, where, node.count_operator, node.count_value, st,
        )

    # ---- graph network -----------------------------------------------------
    def _network(self, node: NetworkCondition, scope: _Scope, st: _State, path: str) -> str:
        if scope.restricted:
            raise CompileError("network conditions cannot be nested in a related filter", path)
        net = self.catalog.network(node.network)
        if net is None:
            raise CompileError(f"unknown network {node.network!r}", path)
        if net.anchor != scope.anchor:
            raise CompileError(f"network {net.display!r} only applies to {net.anchor}", path)
        n = st.new_var("n")
        r = st.new_var("r")
        label = self.catalog.anchor_entity(scope.anchor).label
        rel = f"[{r}:{q(net.rel)}]"
        arrow = {"out": f"-{rel}->", "in": f"<-{rel}-", "both": f"-{rel}-"}[net.direction]
        pattern = f"({scope.var}){arrow}({n}:{q(label)})"

        preds: list[str] = []
        for i, ec in enumerate(node.edge_where):
            preds.append(self._edge(ec, net, r, st, f"{path}.edge_where[{i}]"))
        if node.where is not None:
            anchor_entity = self.catalog.anchor_entity(scope.anchor)
            inner = _Scope(scope.anchor, n, {anchor_entity.id: n}, depth=scope.depth + 1)
            preds.append(self._node(node.where, inner, st, f"{path}.where"))
        where = f" WHERE {' AND '.join(preds)}" if preds else ""
        return self._count_expr(
            f"COUNT {{ MATCH {pattern}{where} RETURN DISTINCT {n} }}",
            pattern, where, node.count_operator, node.count_value, st,
        )

    def _edge(self, ec: EdgeCondition, net, r: str, st: _State, path: str) -> str:
        attr = net.edge_attribute(ec.attribute)
        if attr is None:
            raise CompileError(f"unknown edge attribute {ec.attribute!r}", path)
        return self._comparison(f"{r}.{q(attr.property)}", attr, ec.operator, ec.value, st, path)

    def _count_expr(
        self, count_sub: str, pattern: str, where: str, op: CountOperator, value: int, st: _State
    ) -> str:
        # Use the cheaper EXISTS form for the common "at least one" / "none" cases.
        if op == CountOperator.GTE and value == 1 or op == CountOperator.GT and value == 0:
            return f"EXISTS {{ MATCH {pattern}{where} }}"
        if op == CountOperator.EQ and value == 0 or op == CountOperator.LT and value == 1:
            return f"NOT EXISTS {{ MATCH {pattern}{where} }}"
        return f"{count_sub} {_COUNT_CMP[op]} {st.params.add(value)}"

    # ---- segment membership --------------------------------------------------
    def _segment(self, node: SegmentCondition, scope: _Scope, st: _State, path: str) -> str:
        if scope.restricted:
            raise CompileError("segment membership cannot be used in a related filter", path)
        p = st.params.add(node.segment_id)
        return f"EXISTS {{ MATCH ({scope.var})-[:`MEMBER_OF`]->(:`Segment` {{id: {p}}}) }}"


# ---- value coercion ---------------------------------------------------------
def _as_number(value: Any, path: str) -> int | float:
    if isinstance(value, bool):
        raise CompileError("expected a number", path)
    if isinstance(value, int | float):
        return value
    try:
        f = float(str(value).strip())
    except (TypeError, ValueError):
        raise CompileError(f"expected a number, got {value!r}", path) from None
    return int(f) if f.is_integer() else f


def _as_int(value: Any, path: str, what: str) -> int:
    n = _as_number(value, path)
    if int(n) != n or n < 0:
        raise CompileError(f"expected a whole {what}", path)
    return int(n)


def _coerce(attr: Attribute, value: Any, path: str) -> Any:
    if value is None:
        raise CompileError(f"a value is required for {attr.display!r}", path)
    if attr.type == AttrType.NUMBER:
        return _as_number(value, path)
    if attr.type == AttrType.BOOLEAN:
        if isinstance(value, bool):
            return value
        if str(value).lower() in ("true", "yes", "1"):
            return True
        if str(value).lower() in ("false", "no", "0"):
            return False
        raise CompileError(f"expected true/false for {attr.display!r}", path)
    if attr.type == AttrType.DATE:
        if isinstance(value, date):
            return value
        try:
            return date.fromisoformat(str(value)[:10])
        except ValueError:
            raise CompileError(f"expected a date (YYYY-MM-DD), got {value!r}", path) from None
    if attr.type == AttrType.ENUM:
        if attr.values and str(value) not in attr.values:
            raise CompileError(
                f"{value!r} is not a valid {attr.display!r}; choose from {attr.values}", path
            )
        return str(value)
    return str(value)
