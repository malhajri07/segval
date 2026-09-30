"""Export a synthetic dataset, the catalog and templates as one JSON file.

The web UI's offline demo build evaluates segments in the browser over this
snapshot. It mirrors exactly what ``loader.load_dataset`` writes to Neo4j.

    python -m segval.seed.demo_export --customers 2000 --out ../frontend/src/demo/data.json
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

from segval.api.app import catalog_payload
from segval.catalog.loader import load_catalog
from segval.seed.generator import ADDONS, CITIES, DEVICES, PLANS, Dataset, generate
from segval.templates.loader import load_templates


def _table(props: list[str], rows: list[dict[str, Any]]) -> dict[str, Any]:
    return {"props": props, "rows": [[r.get(p) for p in props] for r in rows]}


def snapshot(ds: Dataset) -> dict[str, Any]:
    nodes = {
        "City": _table(["name", "region"], [{"name": c[0], "region": c[1]} for c in CITIES]),
        "Plan": _table(
            ["plan_id", "name", "category", "monthly_fee", "data_allowance_gb", "is_unlimited"],
            [dict(zip(["plan_id", "name", "category", "monthly_fee", "data_allowance_gb",
                       "is_unlimited"], p, strict=True)) for p in PLANS],
        ),
        "Device": _table(
            ["tac", "brand", "model", "os", "is_5g", "price_tier", "release_year"],
            [dict(zip(["tac", "brand", "model", "os", "is_5g", "price_tier", "release_year"], d,
                      strict=True)) for d in DEVICES],
        ),
        "Addon": _table(
            ["addon_id", "name", "category", "price"],
            [dict(zip(["addon_id", "name", "category", "price"], a, strict=True)) for a in ADDONS],
        ),
        "Customer": _table(
            ["customer_id", "full_name", "gender", "age", "nationality_group", "credit_class",
             "tenure_months", "digital_app_user", "preferred_language", "value_tier"],
            ds.customers,
        ),
        "Subscription": _table(
            ["msisdn", "payment_type", "status", "activation_date", "tenure_months", "arpu_3m",
             "churn_score", "nps", "last_recharge_date"],
            ds.subscriptions,
        ),
        "MonthlyUsage": _table(
            ["usage_id", "month", "data_mb", "voice_min", "sms_count", "roaming_mb", "intl_min",
             "revenue", "recharge_count"],
            ds.usage,
        ),
        "Ticket": _table(
            ["ticket_id", "category", "status", "severity", "opened_at"], ds.tickets
        ),
    }

    def rel(from_label, to_label, pairs, props=()):
        return {"from": from_label, "to": to_label, "props": list(props), "rows": pairs}

    rels = {
        "LIVES_IN": rel("Customer", "City", [[c["customer_id"], c["city"]] for c in ds.customers]),
        "OWNS": rel("Customer", "Subscription",
                    [[s["customer_id"], s["msisdn"]] for s in ds.subscriptions]),
        "ON_PLAN": rel("Subscription", "Plan", [[s["msisdn"], s["plan_id"]] for s in ds.subscriptions]),
        "USES_DEVICE": rel("Subscription", "Device",
                           [[s["msisdn"], s["tac"]] for s in ds.subscriptions]),
        "HAS_ADDON": rel("Subscription", "Addon", [[a["msisdn"], a["addon_id"]] for a in ds.addons]),
        "HAS_USAGE": rel("Subscription", "MonthlyUsage",
                         [[u["msisdn"], u["usage_id"]] for u in ds.usage]),
        "RAISED": rel("Customer", "Ticket", [[t["customer_id"], t["ticket_id"]] for t in ds.tickets]),
        "CALLED": rel("Subscription", "Subscription",
                      [[c["src"], c["dst"], c["calls"], c["minutes"]] for c in ds.calls],
                      ("calls", "minutes")),
    }
    catalog = load_catalog("mobile_b2c")
    return {
        "as_of": ds.as_of.isoformat(),
        "catalog": catalog_payload(catalog),
        "templates": [t.model_dump(mode="json") for t in load_templates("mobile_b2c")],
        "nodes": nodes,
        "rels": rels,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--customers", type=int, default=2000)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    ds = generate(customers=args.customers, seed=args.seed)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(snapshot(ds), separators=(",", ":")), encoding="utf-8")
    print(f"wrote {args.out} ({args.out.stat().st_size / 1e6:.1f} MB) {ds.summary()}")


if __name__ == "__main__":
    main()
