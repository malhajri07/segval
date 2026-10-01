"""Build frontend/src/demo/parity.fixture.json from the Python compiler and a live Neo4j.

Loads the 2,000-customer demo dataset into Neo4j (replacing its data), compiles each case
with the Python compiler and records the Neo4j count. Run from backend/:

    python tools/make_demo_fixture.py
"""
import json

from segval.catalog.loader import load_catalog
from segval.config import get_settings
from segval.dsl.compiler import CompileError, Compiler
from segval.dsl.model import SegmentDefinition
from segval.graph.client import Neo4jClient
from segval.seed.generator import generate
from segval.seed.loader import load_dataset
from segval.services import queries
from segval.services.insights import InsightsService
from segval.services.segments import DataClock, SegmentService
from segval.templates.loader import load_templates

client = Neo4jClient(get_settings())
ds = generate(customers=2000, seed=42)
load_dataset(client, ds)
client.write("MATCH (s:Segment) DETACH DELETE s")
comp = Compiler(load_catalog())
def A(f, op, v=None, **k): return {"kind": "attribute", "field": f, "operator": op, "value": v, **k}
extra = [
  ("contains", "subscription", A("device.model", "contains", "GALAXY")),
  ("starts_with", "subscription", A("plan.name", "starts_with", "post")),
  ("ends_with_neg", "subscription", A("device.model", "ends_with", "pro", negate=True)),
  ("not_in", "subscription", A("customer.value_tier", "not_in", ["Bronze", "Silver"])),
  ("is_null", "subscription", A("subscription.last_recharge_date", "is_null")),
  ("is_not_null_or", "subscription", {"kind": "group", "op": "or", "children": [
      A("subscription.last_recharge_date", "is_not_null"), A("subscription.nps", "gte", 9)]}),
  ("date_between", "subscription", A("subscription.activation_date", "between", ["2024-01-01", "2025-06-30"])),
  ("before_days", "subscription", A("subscription.last_recharge_date", "before_last_days", 20)),
  ("date_eq", "subscription", A("usage.month", "eq", "2026-03-01")),
  ("bool_false", "subscription", A("device.is_5g", "eq", False)),
  ("not_with_nulls", "subscription", {"kind": "group", "negate": True, "op": "and", "children": [
      A("subscription.last_recharge_date", "gt", "2026-08-10")]}),
  ("metric_between", "subscription", {"kind": "metric", "metric": "avg_voice_min", "window_months": 2, "operator": "between", "value": [100, 300]}),
  ("metric_max", "subscription", {"kind": "metric", "metric": "max_data_mb", "window_months": 6, "operator": "lt", "value": 2000}),
  ("metric_count_tickets", "subscription", {"kind": "metric", "metric": "ticket_count", "window_months": 1, "operator": "gte", "value": 1}),
  ("related_count", "subscription", {"kind": "related", "entity": "addon", "count_operator": "gte", "count_value": 2}),
  ("related_none", "subscription", {"kind": "related", "entity": "ticket", "count_operator": "eq", "count_value": 0}),
  ("related_lt", "customer", {"kind": "related", "entity": "subscription", "count_operator": "lt", "count_value": 2,
      "where": A("subscription.payment_type", "eq", "POSTPAID")}),
  ("nested_network", "subscription", {"kind": "network", "network": "calls", "count_operator": "gte", "count_value": 3,
      "edge_where": [{"attribute": "minutes", "operator": "between", "value": [20, 400]}],
      "where": {"kind": "group", "op": "or", "children": [
          {"kind": "network", "network": "calls", "count_operator": "gt", "count_value": 10},
          A("customer.age", "lt", 25)]}}),
  ("links_any", "customer", {"kind": "network", "network": "account_links", "count_operator": "gte", "count_value": 2}),
  ("links_typed_nested", "customer", {"kind": "network", "network": "account_links", "count_operator": "gte", "count_value": 1,
      "edge_where": [{"attribute": "link_type", "operator": "eq", "value": "Corporate"}],
      "where": A("customer.value_tier", "in", ["Gold", "Platinum"])}),
  ("customer_metric", "customer", {"kind": "group", "children": [
      {"kind": "metric", "metric": "line_count", "operator": "gte", "value": 2},
      {"kind": "metric", "metric": "total_revenue", "window_months": 3, "operator": "gt", "value": 600}]}),
]
cases = [(t.id, t.definition.anchor, t.definition.rule.model_dump(mode="json")) for t in load_templates()] + extra
out = []
for cid, anchor, rule in cases:
    d = SegmentDefinition.model_validate({"anchor": anchor, "rule": rule})
    cp = comp.compile(d, as_of=ds.as_of)
    n = client.read(queries.count_query(cp).text, cp.params)[0]["segment_size"]
    out.append({"id": cid, "definition": d.model_dump(mode="json"), "predicate": cp.predicate, "params": cp.params, "count": n})
errors = []
for cid, rule in [("bad_op", A("plan.category", "gt", 1)), ("bad_enum", A("plan.category", "eq", "Gold")),
                  ("bad_num", A("subscription.arpu_3m", "gt", "abc")),
                  ("restricted", {"kind": "related", "entity": "addon", "where": A("customer.age", "gt", 3)})]:
    try:
        comp.compile(SegmentDefinition.model_validate({"rule": rule}), as_of=ds.as_of)
    except CompileError as e:
        errors.append({"id": cid, "rule": rule, "message": e.message, "path": e.path})
segs = SegmentService(load_catalog(), client, DataClock(client))
insights = InsightsService(load_catalog(), client, segs)
by_id = {c["id"]: c["definition"] for c in out}
analytics = []
for cid in ["prepaid_to_postpaid", "network_detractors", "household_fmc", "influencers_in_churning_communities"]:
    d = SegmentDefinition.model_validate(by_id[cid])
    analytics.append({
        "id": cid, "definition": by_id[cid],
        "funnel": insights.funnel(d),
        "trend": insights.trend("avg_data_mb" if d.anchor == "subscription" else "total_revenue", d),
        "tickets": insights.trend("ticket_count", d),
    })
json.dump({"as_of": ds.as_of.isoformat(), "cases": out, "errors": errors, "analytics": analytics},
          open("../frontend/src/demo/parity.fixture.json", "w"), indent=1)
print(len(out), "cases:", " ".join(f"{c['id']}={c['count']}" for c in out))
