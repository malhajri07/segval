"""End-to-end tests against a real Neo4j loaded with synthetic data.

Run with:  SEGVAL_IT=1 pytest tests/test_integration.py
"""

from __future__ import annotations

import pytest

from segval.dsl.model import SegmentDefinition
from segval.seed.generator import generate
from segval.seed.loader import load_dataset
from segval.services.insights import InsightsService
from segval.services.segments import Conflict, DataClock, SegmentIn, SegmentService
from segval.templates.loader import load_templates


@pytest.fixture(scope="module")
def services(neo4j_client, catalog):
    ds = generate(customers=400, seed=7)
    load_dataset(neo4j_client, ds)
    neo4j_client.write("MATCH (s:Segment) DETACH DELETE s")
    clock = DataClock(neo4j_client)
    segs = SegmentService(catalog, neo4j_client, clock)
    return segs, InsightsService(catalog, neo4j_client, segs), ds


def test_as_of_is_latest_usage_month(services):
    segs, _, ds = services
    assert segs.clock.as_of() == ds.as_of


@pytest.mark.parametrize("template", load_templates("mobile_b2c"), ids=lambda t: t.id)
def test_templates_execute(services, template):
    segs, _, _ = services
    res = segs.preview(template.definition, sample_size=3)
    assert 0 <= res["segment_size"] <= res["base_size"]


def test_empty_rule_selects_whole_base(services):
    segs, _, ds = services
    res = segs.preview(SegmentDefinition(anchor="subscription"), sample_size=0)
    assert res["segment_size"] == res["base_size"] == len(ds.subscriptions)


def test_attribute_filter_matches_python(services):
    segs, _, ds = services
    expected = sum(1 for s in ds.subscriptions if s["payment_type"] == "POSTPAID")
    res = segs.preview(SegmentDefinition.model_validate({"rule": {
        "kind": "attribute", "field": "subscription.payment_type", "operator": "eq",
        "value": "POSTPAID"}}), sample_size=0)
    assert res["segment_size"] == expected


def test_negation_partitions_base(services):
    segs, _, _ = services
    rule = {"kind": "attribute", "field": "device.is_5g", "operator": "eq", "value": True}
    pos = segs.preview(SegmentDefinition.model_validate({"rule": rule}), 0)["segment_size"]
    neg = segs.preview(SegmentDefinition.model_validate({"rule": {**rule, "negate": True}}),
                       0)["segment_size"]
    assert pos + neg == segs.preview(SegmentDefinition(), 0)["base_size"]


def test_segment_lifecycle(services):
    segs, insights, _ = services
    postpaid = segs.create(SegmentIn(name="Postpaid", definition=SegmentDefinition.model_validate(
        {"rule": {"kind": "attribute", "field": "subscription.payment_type", "operator": "eq",
                  "value": "POSTPAID"}})))
    heavy = segs.create(SegmentIn(name="Heavy postpaid", definition=SegmentDefinition.model_validate(
        {"rule": {"kind": "group", "children": [
            {"kind": "segment", "segment_id": postpaid.id},
            {"kind": "metric", "metric": "avg_data_mb", "operator": "gt", "value": 5000}]}})))
    assert heavy.depends_on == [postpaid.id]

    # materializing the dependant materializes its dependency first
    heavy = segs.materialize(heavy.id)
    assert segs.get(postpaid.id).member_count is not None
    assert 0 < heavy.member_count <= segs.get(postpaid.id).member_count
    assert not heavy.is_stale

    ov = insights.overlap([postpaid.id, heavy.id])
    cell = next(c for c in ov["cells"] if c["a"] == postpaid.id and c["b"] == heavy.id)
    assert cell["count"] == heavy.member_count

    prof = insights.profile(segment_id=heavy.id)
    assert prof["segment_size"] == heavy.member_count
    payment = next(d for d in prof["dimensions"] if d["field"] == "subscription.payment_type")
    assert {r["value"]: r["segment"] for r in payment["rows"]}["PREPAID"] == 0

    members = segs.members(heavy.id, limit=5)
    assert members["source"] == "materialized" and len(members["rows"]) <= 5
    view = insights.member_view("subscription", members["rows"][0]["subscription.msisdn"])
    assert {s["id"] for s in view["segments"]} >= {heavy.id}

    with pytest.raises(Conflict):
        segs.delete(postpaid.id)
    segs.delete(heavy.id)
    segs.delete(postpaid.id)


def test_customer_anchor_kpis(services):
    _, insights, _ = services
    prof = insights.profile(SegmentDefinition.model_validate({"anchor": "customer", "rule": {
        "kind": "metric", "metric": "line_count", "operator": "gte", "value": 2}}))
    lines = next(k for k in prof["kpis"] if k["id"] == "lines")
    assert lines["segment"] >= 2


def test_graph_workspace_linking(services, neo4j_client, catalog):
    from segval.services.graph import GraphService
    from segval.services.segments import NotFound

    graph = GraphService(catalog, neo4j_client)
    start = graph.start_node()
    assert start and start.startswith("Customer:")

    hits = graph.search("C00000", limit=5)
    assert hits and all(h["label"] in ("Customer", "Subscription") for h in hits)

    exp = graph.expand("Customer:C0000001", limit=10)
    assert exp["center"] == "Customer:C0000001"
    assert {e["type"] for e in exp["edges"]} >= {"OWNS", "LIVES_IN"}
    assert all("MonthlyUsage" != n["label"] for n in exp["nodes"])

    linked_to_3 = SegmentDefinition.model_validate({"anchor": "customer", "rule": {
        "kind": "network", "network": "account_links",
        "where": {"kind": "attribute", "field": "customer.customer_id", "operator": "eq",
                  "value": "C0000003"}}})
    before = services[0].preview(linked_to_3, 0)
    edge = graph.link_accounts("C0000001", "C0000003", "Household")
    assert edge["props"]["link_type"] == "Household" and edge["props"]["source"] == "user"
    # re-linking updates the type instead of duplicating the relationship
    graph.link_accounts("C0000003", "C0000001", "Family")
    rels = neo4j_client.read(
        "MATCH (:Customer {customer_id:'C0000001'})-[l:LINKED_TO]-(:Customer {customer_id:'C0000003'}) "
        "RETURN l.link_type AS t")
    assert [r["t"] for r in rels] == ["Family"]
    after = services[0].preview(linked_to_3, 0)
    assert after["segment_size"] == before["segment_size"] + (0 if before["segment_size"] else 1)

    group = graph.link_group(["C0000010", "C0000011", "C0000012", "C0000011"], "Corporate")
    assert len(group) == 2

    with pytest.raises(ValueError):
        graph.link_accounts("C0000001", "C0000001", "Household")
    with pytest.raises(ValueError):
        graph.link_accounts("C0000001", "C0000002", "Neighbours")
    with pytest.raises(NotFound):
        graph.link_accounts("C0000001", "NOPE", "Household")

    assert graph.unlink_accounts("C0000003", "C0000001") == 1
    with pytest.raises(NotFound):
        graph.unlink_accounts("C0000003", "C0000001")
