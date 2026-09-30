"""Load a generated dataset into Neo4j with batched UNWIND statements."""

from __future__ import annotations

from collections.abc import Callable, Iterator
from typing import Any

from segval.graph.client import GraphClient, apply_schema
from segval.seed.generator import ADDONS, CITIES, DEVICES, PLANS, Dataset

BATCH = 2000


def _batches(rows: list[dict[str, Any]], size: int = BATCH) -> Iterator[list[dict[str, Any]]]:
    for i in range(0, len(rows), size):
        yield rows[i:i + size]


def _clean(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{k: v for k, v in r.items() if not k.startswith("_")} for r in rows]


def reset_graph(client: GraphClient) -> None:
    """Delete all business data. Segment definitions are kept; memberships go with the data."""
    client.run_autocommit(
        "MATCH (n) WHERE NOT n:Segment "
        "CALL (n) { DETACH DELETE n } IN TRANSACTIONS OF 10000 ROWS"
    )
    client.write("MATCH (s:Segment) SET s.member_count = null, s.materialized_at = null")


def load_dataset(
    client: GraphClient, ds: Dataset, reset: bool = True,
    progress: Callable[[str], None] | None = None,
) -> dict[str, int]:
    say = progress or (lambda _msg: None)
    apply_schema(client)
    if reset:
        say("resetting graph")
        reset_graph(client)

    say("reference data")
    client.write(
        "UNWIND $rows AS r MERGE (c:City {name: r[0]}) SET c.region = r[1]",
        {"rows": [list(c[:2]) for c in CITIES]},
    )
    client.write(
        "UNWIND $rows AS r MERGE (p:Plan {plan_id: r[0]}) "
        "SET p.name = r[1], p.category = r[2], p.monthly_fee = r[3], "
        "p.data_allowance_gb = r[4], p.is_unlimited = r[5]",
        {"rows": [list(p) for p in PLANS]},
    )
    client.write(
        "UNWIND $rows AS r MERGE (d:Device {tac: r[0]}) "
        "SET d.brand = r[1], d.model = r[2], d.os = r[3], d.is_5g = r[4], "
        "d.price_tier = r[5], d.release_year = r[6]",
        {"rows": [list(d) for d in DEVICES]},
    )
    client.write(
        "UNWIND $rows AS r MERGE (a:Addon {addon_id: r[0]}) "
        "SET a.name = r[1], a.category = r[2], a.price = r[3]",
        {"rows": [list(a) for a in ADDONS]},
    )

    say(f"{len(ds.customers)} customers")
    for rows in _batches(_clean(ds.customers)):
        client.write(
            "UNWIND $rows AS r "
            "MERGE (c:Customer {customer_id: r.customer_id}) "
            "SET c += r { .full_name, .gender, .age, .nationality_group, .credit_class, "
            "             .tenure_months, .digital_app_user, .preferred_language, .value_tier } "
            "WITH c, r MATCH (city:City {name: r.city}) MERGE (c)-[:LIVES_IN]->(city)",
            {"rows": rows},
        )

    say(f"{len(ds.subscriptions)} subscriptions")
    for rows in _batches(_clean(ds.subscriptions)):
        client.write(
            "UNWIND $rows AS r "
            "MERGE (s:Subscription {msisdn: r.msisdn}) "
            "SET s.payment_type = r.payment_type, s.status = r.status, "
            "    s.activation_date = date(r.activation_date), s.tenure_months = r.tenure_months, "
            "    s.arpu_3m = r.arpu_3m, s.churn_score = r.churn_score, s.nps = r.nps, "
            "    s.last_recharge_date = CASE WHEN r.last_recharge_date IS NULL THEN null "
            "                           ELSE date(r.last_recharge_date) END "
            "WITH s, r "
            "MATCH (c:Customer {customer_id: r.customer_id}) MERGE (c)-[:OWNS]->(s) "
            "WITH s, r "
            "MATCH (p:Plan {plan_id: r.plan_id}) MERGE (s)-[:ON_PLAN]->(p) "
            "WITH s, r "
            "MATCH (d:Device {tac: r.tac}) MERGE (s)-[:USES_DEVICE]->(d)",
            {"rows": rows},
        )

    say(f"{len(ds.addons)} add-on links")
    for rows in _batches(ds.addons):
        client.write(
            "UNWIND $rows AS r "
            "MATCH (s:Subscription {msisdn: r.msisdn}), (a:Addon {addon_id: r.addon_id}) "
            "MERGE (s)-[:HAS_ADDON]->(a)",
            {"rows": rows},
        )

    say(f"{len(ds.usage)} usage records")
    for rows in _batches(ds.usage, 5000):
        client.write(
            "UNWIND $rows AS r "
            "MATCH (s:Subscription {msisdn: r.msisdn}) "
            "MERGE (u:MonthlyUsage {usage_id: r.usage_id}) "
            "SET u.month = date(r.month), u.data_mb = r.data_mb, u.voice_min = r.voice_min, "
            "    u.sms_count = r.sms_count, u.roaming_mb = r.roaming_mb, u.intl_min = r.intl_min, "
            "    u.revenue = r.revenue, u.recharge_count = r.recharge_count "
            "MERGE (s)-[:HAS_USAGE]->(u)",
            {"rows": rows},
        )

    say(f"{len(ds.calls)} call edges")
    for rows in _batches(ds.calls, 5000):
        client.write(
            "UNWIND $rows AS r "
            "MATCH (a:Subscription {msisdn: r.src}), (b:Subscription {msisdn: r.dst}) "
            "MERGE (a)-[c:CALLED]->(b) SET c.calls = r.calls, c.minutes = r.minutes",
            {"rows": rows},
        )

    say(f"{len(ds.tickets)} tickets")
    for rows in _batches(ds.tickets):
        client.write(
            "UNWIND $rows AS r "
            "MATCH (c:Customer {customer_id: r.customer_id}) "
            "MERGE (t:Ticket {ticket_id: r.ticket_id}) "
            "SET t.category = r.category, t.status = r.status, t.severity = r.severity, "
            "    t.opened_at = date(r.opened_at) "
            "MERGE (c)-[:RAISED]->(t)",
            {"rows": rows},
        )
    return ds.summary()
