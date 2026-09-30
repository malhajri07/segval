import pytest

from segval.dsl.compiler import CompileError
from segval.dsl.model import SegmentDefinition, referenced_segments
from segval.templates.loader import load_templates

from .conftest import AS_OF


def compile_rule(compiler, rule, anchor="subscription"):
    return compiler.compile(SegmentDefinition.model_validate({"anchor": anchor, "rule": rule}),
                            as_of=AS_OF)


def test_empty_group_matches_everything(compiler):
    cp = compile_rule(compiler, {"kind": "group", "children": []})
    assert cp.predicate == "true"
    assert cp.params == {"as_of": AS_OF}


def test_anchor_attribute_is_inline_and_parameterised(compiler):
    cp = compile_rule(compiler, {"kind": "attribute", "field": "subscription.payment_type",
                                 "operator": "eq", "value": "POSTPAID"})
    assert cp.predicate == "a.`payment_type` = $p0"
    assert cp.params["p0"] == "POSTPAID"


def test_related_attribute_uses_exists_with_catalog_path(compiler):
    cp = compile_rule(compiler, {"kind": "attribute", "field": "city.region",
                                 "operator": "in", "value": ["Central"]})
    assert cp.predicate == (
        "EXISTS { MATCH (a)<-[:`OWNS`]-(:`Customer`)-[:`LIVES_IN`]->(x1:`City`) "
        "WHERE x1.`region` IN $p0 }"
    )


def test_values_never_reach_query_text(compiler):
    evil = "x' OR 1=1 //`) DETACH DELETE a"
    cp = compile_rule(compiler, {"kind": "attribute", "field": "device.model",
                                 "operator": "contains", "value": evil})
    assert evil.lower() not in cp.predicate
    assert evil.lower() in cp.params.values()


def test_group_or_and_negation(compiler):
    cp = compile_rule(compiler, {
        "kind": "group", "op": "or", "negate": True,
        "children": [
            {"kind": "attribute", "field": "subscription.arpu_3m", "operator": "gt", "value": 5},
            {"kind": "attribute", "field": "subscription.nps", "operator": "is_null"},
        ],
    })
    assert cp.predicate == "NOT (((a.`arpu_3m` > $p0) OR (a.`nps` IS NULL)))"


def test_between_and_dates(compiler):
    cp = compile_rule(compiler, {"kind": "attribute", "field": "subscription.activation_date",
                                 "operator": "between", "value": ["2024-01-01", "2024-12-31"]})
    assert "date($p0)" in cp.predicate and cp.params["p0"] == "2024-01-01"


def test_relative_dates_use_as_of(compiler):
    cp = compile_rule(compiler, {"kind": "attribute", "field": "ticket.opened_at",
                                 "operator": "within_last_days", "value": 90})
    assert "date($as_of) - duration({days: $p0})" in cp.predicate


def test_metric_window(compiler):
    cp = compile_rule(compiler, {"kind": "metric", "metric": "avg_data_mb",
                                 "window_months": 3, "operator": "gt", "value": 1000})
    assert "COLLECT { MATCH (a)-[:`HAS_USAGE`]->(m1:`MonthlyUsage`)" in cp.predicate
    assert "avg(m1.`data_mb`)" in cp.predicate
    assert cp.params["p0"] == 3 and cp.params["p1"] == 1000


def test_metric_default_window(compiler, catalog):
    cp = compile_rule(compiler, {"kind": "metric", "metric": "total_roaming_mb",
                                 "operator": "gt", "value": 0})
    assert cp.params["p0"] == catalog.metric("total_roaming_mb").default_window_months


def test_untimed_count_metric(compiler):
    cp = compile_rule(compiler, {"kind": "metric", "metric": "line_count",
                                 "operator": "gte", "value": 2}, anchor="customer")
    assert "count(m1)" in cp.predicate and "as_of" not in cp.predicate


def test_related_none_uses_not_exists(compiler):
    cp = compile_rule(compiler, {
        "kind": "related", "entity": "addon", "count_operator": "eq", "count_value": 0,
        "where": {"kind": "attribute", "field": "addon.category", "operator": "eq",
                  "value": "Roaming"},
    })
    assert cp.predicate.startswith("NOT EXISTS { MATCH (a)-[:`HAS_ADDON`]->(x1:`Addon`)")
    assert "x1.`category` = $p0" in cp.predicate


def test_related_count(compiler):
    cp = compile_rule(compiler, {"kind": "related", "entity": "ticket",
                                 "count_operator": "gte", "count_value": 3})
    assert "COUNT { MATCH" in cp.predicate and "RETURN DISTINCT x1 } >= $p0" in cp.predicate


def test_related_filter_cannot_escape_entity(compiler):
    with pytest.raises(CompileError) as err:
        compile_rule(compiler, {
            "kind": "related", "entity": "addon",
            "where": {"kind": "attribute", "field": "customer.age", "operator": "gt",
                      "value": 30},
        })
    assert err.value.path == "rule.where"


def test_network_nests_full_rule_language(compiler):
    cp = compile_rule(compiler, {
        "kind": "network", "network": "calls", "count_operator": "gte", "count_value": 2,
        "edge_where": [{"attribute": "minutes", "operator": "gte", "value": 10}],
        "where": {"kind": "group", "children": [
            {"kind": "attribute", "field": "subscription.status", "operator": "eq",
             "value": "CHURNED"},
            {"kind": "attribute", "field": "customer.age", "operator": "lt", "value": 30},
        ]},
    })
    p = cp.predicate
    assert p.startswith("COUNT { MATCH (a)-[r2:`CALLED`]-(n1:`Subscription`)")
    assert "r2.`minutes` >= $p0" in p
    assert "n1.`status` = $p1" in p
    assert "MATCH (n1)<-[:`OWNS`]-(x3:`Customer`)" in p
    assert p.endswith(">= $p3")


def test_network_anchor_mismatch(compiler):
    with pytest.raises(CompileError, match="only applies to subscription"):
        compile_rule(compiler, {"kind": "network", "network": "calls"}, anchor="customer")


def test_segment_membership(compiler):
    rule = {"kind": "segment", "segment_id": "abc", "negate": True}
    cp = compile_rule(compiler, rule)
    assert cp.predicate == "NOT (EXISTS { MATCH (a)-[:`MEMBER_OF`]->(:`Segment` {id: $p0}) })"
    assert referenced_segments(SegmentDefinition.model_validate({"rule": rule}).rule) == {"abc"}


@pytest.mark.parametrize("rule,message", [
    ({"kind": "attribute", "field": "plan.category", "operator": "gt", "value": "x"},
     "not valid for enum"),
    ({"kind": "attribute", "field": "plan.category", "operator": "eq", "value": "Gold"},
     "not a valid"),
    ({"kind": "attribute", "field": "subscription.arpu_3m", "operator": "gt", "value": "abc"},
     "expected a number"),
    ({"kind": "attribute", "field": "subscription.arpu_3m", "operator": "in", "value": []},
     "at least one"),
    ({"kind": "attribute", "field": "nope.x", "operator": "eq", "value": 1}, "unknown entity"),
    ({"kind": "metric", "metric": "nope", "operator": "gt", "value": 1}, "unknown metric"),
    ({"kind": "metric", "metric": "avg_data_mb", "operator": "contains", "value": 1},
     "not valid for metrics"),
    ({"kind": "attribute", "field": "device.is_5g", "operator": "eq", "value": "maybe"},
     "true/false"),
])
def test_validation_errors(compiler, rule, message):
    with pytest.raises(CompileError, match=message):
        compile_rule(compiler, rule)


def test_error_path_points_at_node(compiler):
    with pytest.raises(CompileError) as err:
        compile_rule(compiler, {"kind": "group", "children": [
            {"kind": "attribute", "field": "subscription.status", "operator": "eq",
             "value": "ACTIVE"},
            {"kind": "group", "children": [
                {"kind": "attribute", "field": "plan.category", "operator": "gt", "value": 1},
            ]},
        ]})
    assert err.value.path == "rule.children[1].children[0]"


def test_depth_limit(compiler):
    rule = {"kind": "attribute", "field": "subscription.nps", "operator": "is_null"}
    for _ in range(10):
        rule = {"kind": "group", "children": [rule]}
    with pytest.raises(CompileError, match="nesting"):
        compile_rule(compiler, rule)


def test_all_templates_compile(compiler):
    templates = load_templates("mobile_b2c")
    assert len(templates) >= 10
    for t in templates:
        compiler.compile(t.definition, as_of=AS_OF)


def test_kpi_metric_expression_uses_prefixed_params(compiler):
    expr, params = compiler.metric_expression("avg_data_mb", 3, "subscription", "a",
                                              param_prefix="k0_")
    assert "$k0_0" in expr and params == {"k0_0": 3}
