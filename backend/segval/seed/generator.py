"""Deterministic synthetic mobile B2C data, shaped so the sample segments return
meaningful results (personas, churn contagion in the call graph, influencers…)."""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from datetime import date, timedelta
from typing import Any

CITIES = [
    ("Riyadh", "Central", 26), ("Jeddah", "Western", 18), ("Mecca", "Western", 8),
    ("Medina", "Western", 6), ("Dammam", "Eastern", 8), ("Khobar", "Eastern", 5),
    ("Buraidah", "Central", 4), ("Tabuk", "Northern", 4), ("Hail", "Northern", 3),
    ("Abha", "Southern", 5), ("Jizan", "Southern", 4), ("Taif", "Western", 5),
    ("Al Ahsa", "Eastern", 4),
]

PLANS = [
    ("PP-BASIC-30", "Prepaid Basic 30", "Prepaid Basic", 30, 2, False),
    ("PP-BASIC-50", "Prepaid Basic 50", "Prepaid Basic", 50, 5, False),
    ("PP-DATA-75", "Prepaid Data 75", "Prepaid Data", 75, 25, False),
    ("PP-DATA-120", "Prepaid Data 120", "Prepaid Data", 120, 60, False),
    ("PP-YOUTH-45", "Shabab 45", "Youth", 45, 20, False),
    ("PO-CORE-99", "Postpaid Core 99", "Postpaid Core", 99, 15, False),
    ("PO-CORE-149", "Postpaid Core 149", "Postpaid Core", 149, 40, False),
    ("PO-UNL-249", "Postpaid Unlimited 249", "Postpaid Unlimited", 249, 0, True),
    ("PO-UNL-399", "Postpaid Unlimited Max 399", "Postpaid Unlimited", 399, 0, True),
    ("PO-YOUTH-89", "Shabab Postpaid 89", "Youth", 89, 30, False),
]

DEVICES = [
    # tac, brand, model, os, 5g, tier, year
    ("35391110", "Apple", "iPhone 11", "iOS", False, "High", 2019),
    ("35328111", "Apple", "iPhone 12", "iOS", True, "High", 2020),
    ("35392112", "Apple", "iPhone 13", "iOS", True, "High", 2021),
    ("35167714", "Apple", "iPhone 14 Pro", "iOS", True, "Premium", 2022),
    ("35620315", "Apple", "iPhone 15 Pro Max", "iOS", True, "Premium", 2023),
    ("35990116", "Apple", "iPhone 16", "iOS", True, "Premium", 2024),
    ("35404317", "Apple", "iPhone 17 Pro", "iOS", True, "Premium", 2025),
    ("35248710", "Samsung", "Galaxy A10", "Android", False, "Low", 2019),
    ("35873521", "Samsung", "Galaxy A32", "Android", False, "Mid", 2021),
    ("35273123", "Samsung", "Galaxy A54 5G", "Android", True, "Mid", 2023),
    ("35890122", "Samsung", "Galaxy S21", "Android", True, "High", 2021),
    ("35912324", "Samsung", "Galaxy S24 Ultra", "Android", True, "Premium", 2024),
    ("35600125", "Samsung", "Galaxy S25", "Android", True, "Premium", 2025),
    ("86743020", "Huawei", "P30", "Android", False, "Mid", 2019),
    ("86112322", "Huawei", "Nova 11", "Android", False, "Mid", 2023),
    ("86400121", "Xiaomi", "Redmi Note 10", "Android", False, "Low", 2021),
    ("86566223", "Xiaomi", "Redmi Note 13 5G", "Android", True, "Low", 2023),
    ("86990224", "Xiaomi", "14T Pro", "Android", True, "High", 2024),
    ("86211920", "Oppo", "A53", "Android", False, "Low", 2020),
    ("86345223", "Oppo", "Reno 10", "Android", True, "Mid", 2023),
    ("86772122", "Honor", "X8", "Android", False, "Low", 2022),
    ("86120024", "Honor", "Magic 6 Pro", "Android", True, "High", 2024),
    ("35700018", "Nokia", "105", "Other", False, "Low", 2018),
]

ADDONS = [
    ("AD-ROAM-GCC", "GCC Roaming Pass", "Roaming", 60),
    ("AD-ROAM-WORLD", "World Roaming 5GB", "Roaming", 150),
    ("AD-DATA-10", "Extra Data 10GB", "Data", 35),
    ("AD-DATA-NIGHT", "Night Unlimited", "Data", 25),
    ("AD-ENT-STREAM", "Streaming Pack", "Entertainment", 30),
    ("AD-ENT-GAMING", "Gaming Pass", "Entertainment", 40),
    ("AD-INTL-ASIA", "Asia Calling 100min", "International Calls", 25),
    ("AD-INTL-ARAB", "Arab Countries 150min", "International Calls", 30),
    ("AD-SOC-UNL", "Social Unlimited", "Social", 20),
]

PERSONAS = {
    # weight, payment postpaid prob, age range, data MB, voice min, plans, device tiers, addons
    "basic_prepaid": (22, 0.05, (25, 70), (300, 3000), (60, 300),
                      ["PP-BASIC-30", "PP-BASIC-50"], ["Low", "Mid"], ["AD-SOC-UNL"]),
    "data_heavy": (16, 0.45, (18, 45), (15000, 60000), (50, 250),
                   ["PP-DATA-75", "PP-DATA-120", "PO-CORE-149", "PO-UNL-249"],
                   ["Mid", "High", "Premium"], ["AD-DATA-10", "AD-ENT-STREAM", "AD-ENT-GAMING"]),
    "traveler": (8, 0.8, (28, 60), (4000, 20000), (150, 500),
                 ["PO-CORE-149", "PO-UNL-249", "PO-UNL-399"], ["High", "Premium"],
                 ["AD-ROAM-GCC", "AD-ROAM-WORLD"]),
    "expat_caller": (16, 0.2, (22, 55), (1500, 8000), (200, 700),
                     ["PP-BASIC-50", "PP-DATA-75", "PO-CORE-99"], ["Low", "Mid"],
                     ["AD-INTL-ASIA", "AD-INTL-ARAB"]),
    "family_postpaid": (18, 0.9, (30, 60), (5000, 18000), (200, 600),
                        ["PO-CORE-99", "PO-CORE-149", "PO-UNL-249"], ["Mid", "High", "Premium"],
                        ["AD-ENT-STREAM", "AD-DATA-10"]),
    "youth_social": (14, 0.25, (18, 26), (8000, 30000), (40, 200),
                     ["PP-YOUTH-45", "PO-YOUTH-89", "PP-DATA-75"], ["Low", "Mid", "High"],
                     ["AD-SOC-UNL", "AD-ENT-GAMING", "AD-DATA-NIGHT"]),
    "senior_voice": (6, 0.5, (58, 80), (100, 1500), (400, 1200),
                     ["PP-BASIC-50", "PO-CORE-99"], ["Low", "Mid"], []),
}

FIRST_M = ["Abdullah", "Mohammed", "Fahad", "Khalid", "Saud", "Omar", "Ali", "Faisal", "Rakan",
           "Ahmed", "Yousef", "Turki", "Rajesh", "Arjun", "Imran", "Jose", "Bilal", "Hassan"]
FIRST_F = ["Noura", "Sara", "Reem", "Lama", "Hessa", "Maha", "Aisha", "Fatimah", "Dana",
           "Priya", "Maria", "Amina", "Layla", "Joud", "Ghada", "Shahd"]
LAST = ["Al-Harbi", "Al-Qahtani", "Al-Otaibi", "Al-Ghamdi", "Al-Zahrani", "Al-Dosari",
        "Al-Shehri", "Al-Mutairi", "Al-Anazi", "Khan", "Sharma", "Santos", "Hussain", "Ali"]


def month_start(d: date) -> date:
    return d.replace(day=1)


def add_months(d: date, n: int) -> date:
    y, m = divmod(d.month - 1 + n, 12)
    return date(d.year + y, m + 1, 1)


@dataclass
class Dataset:
    as_of: date
    customers: list[dict[str, Any]] = field(default_factory=list)
    subscriptions: list[dict[str, Any]] = field(default_factory=list)
    usage: list[dict[str, Any]] = field(default_factory=list)
    addons: list[dict[str, Any]] = field(default_factory=list)  # {msisdn, addon_id}
    calls: list[dict[str, Any]] = field(default_factory=list)
    tickets: list[dict[str, Any]] = field(default_factory=list)
    links: list[dict[str, Any]] = field(default_factory=list)  # {a, b, link_type}

    def summary(self) -> dict[str, int]:
        return {
            "customers": len(self.customers),
            "subscriptions": len(self.subscriptions),
            "usage_records": len(self.usage),
            "addon_links": len(self.addons),
            "call_edges": len(self.calls),
            "tickets": len(self.tickets),
            "account_links": len(self.links),
        }


def generate(customers: int = 5000, seed: int = 42, as_of: date | None = None,
             months: int = 6) -> Dataset:
    rng = random.Random(seed)
    as_of = month_start(as_of or add_months(month_start(date.today()), -1))
    ds = Dataset(as_of=as_of)
    month_list = [add_months(as_of, -i) for i in range(months - 1, -1, -1)]
    persona_names = list(PERSONAS)
    persona_weights = [PERSONAS[p][0] for p in persona_names]
    city_names = [c[0] for c in CITIES]
    city_weights = [c[2] for c in CITIES]
    devices_by_tier: dict[str, list[tuple]] = {}
    for d in DEVICES:
        devices_by_tier.setdefault(d[5], []).append(d)
    plan_by_id = {p[0]: p for p in PLANS}

    msisdn_seq = 0
    for ci in range(customers):
        persona = rng.choices(persona_names, persona_weights)[0]
        _, post_p, age_rng, *_ = PERSONAS[persona]
        gender = rng.choice("MF")
        expat = persona == "expat_caller" or rng.random() < 0.18
        first = rng.choice(FIRST_M if gender == "M" else FIRST_F)
        cust = {
            "customer_id": f"C{ci + 1:07d}",
            "full_name": f"{first} {rng.choice(LAST)}",
            "gender": gender,
            "age": rng.randint(*age_rng),
            "nationality_group": "Expat" if expat else "Local",
            "credit_class": rng.choices("ABCD", [30, 35, 25, 10])[0],
            "tenure_months": rng.randint(1, 180),
            "digital_app_user": rng.random() < (0.85 if persona == "youth_social" else 0.55),
            "preferred_language": "English" if expat and rng.random() < 0.7 else "Arabic",
            "city": rng.choices(city_names, city_weights)[0],
            "_persona": persona,
        }
        n_lines = rng.choices([1, 2, 3, 4], [70, 18, 8, 4])[0]
        if persona == "family_postpaid":
            n_lines = rng.choices([1, 2, 3, 4, 5], [25, 30, 25, 12, 8])[0]
        total_rev = 0.0
        for li in range(n_lines):
            msisdn_seq += 1
            line_persona = persona if li == 0 else rng.choices(persona_names, persona_weights)[0]
            sub = _subscription(rng, cust, line_persona, msisdn_seq, as_of, devices_by_tier,
                                plan_by_id)
            ds.subscriptions.append(sub)
            total_rev += sub["_monthly_rev"]
        cust["value_tier"] = (
            "Platinum" if total_rev >= 400 else "Gold" if total_rev >= 200
            else "Silver" if total_rev >= 90 else "Bronze"
        )
        ds.customers.append(cust)

    _call_graph(rng, ds)
    _churn_and_usage(rng, ds, month_list, plan_by_id)
    _tickets(rng, ds, as_of)
    # Separate stream so adding links never changes the rest of the dataset.
    _account_links(random.Random(seed + 1), ds)
    return ds


def _subscription(rng, cust, persona, seq, as_of, devices_by_tier, plan_by_id) -> dict:
    _, post_p, _, _, _, plans, tiers, addons = PERSONAS[persona]
    postpaid = rng.random() < post_p
    prefix = "PO" if postpaid else "PP"
    candidates = [p for p in plans if p.startswith(prefix)] or [
        p for p in plan_by_id if p.startswith(prefix)
    ]
    plan_id = rng.choice(candidates)
    device = rng.choice(devices_by_tier[rng.choice(tiers)])
    tenure = rng.randint(1, max(2, min(cust["tenure_months"], 150)))
    fee = plan_by_id[plan_id][3]
    sub = {
        "msisdn": f"9665{seq:08d}",
        "customer_id": cust["customer_id"],
        "payment_type": "POSTPAID" if postpaid else "PREPAID",
        "plan_id": plan_id,
        "tac": device[0],
        "activation_date": (as_of - timedelta(days=30 * tenure)).isoformat(),
        "tenure_months": tenure,
        "nps": rng.choices(range(11), [2, 1, 1, 2, 3, 6, 8, 12, 18, 22, 25])[0],
        "addons": [a for a in addons if rng.random() < 0.35],
        "_persona": persona,
        "_monthly_rev": fee * rng.uniform(0.9, 1.3),
        "_city": cust["city"],
    }
    if persona == "traveler" and not sub["addons"] and rng.random() < 0.3:
        sub["addons"] = ["AD-ROAM-GCC"]
    return sub


def _call_graph(rng: random.Random, ds: Dataset) -> None:
    by_city: dict[str, list[dict]] = {}
    for s in ds.subscriptions:
        by_city.setdefault(s["_city"], []).append(s)
    edges: dict[tuple[str, str], list[int]] = {}

    def link(a: dict, b: dict, weight: float = 1.0) -> None:
        if a is b:
            return
        key = (a["msisdn"], b["msisdn"])
        calls = max(1, int(rng.expovariate(1 / (12 * weight))))
        cur = edges.setdefault(key, [0, 0])
        cur[0] += calls
        cur[1] += int(calls * rng.uniform(1.0, 6.0))

    community_id = 0
    for members in by_city.values():
        rng.shuffle(members)
        i = 0
        while i < len(members):
            size = rng.randint(4, 25)
            comm = members[i:i + size]
            i += size
            community_id += 1
            at_risk = rng.random() < 0.12
            for s in comm:
                s["_community"] = community_id
                s["_community_risk"] = at_risk
                for _ in range(rng.randint(1, 5)):
                    link(s, rng.choice(comm), 1.5)
                if rng.random() < 0.35:
                    link(s, rng.choice(members))
        # influencers: a few very connected lines per city
        for s in rng.sample(members, max(1, len(members) // 40)):
            s["_influencer"] = True
            for t in rng.sample(members, min(len(members), rng.randint(20, 45))):
                link(s, t, 0.7)
    ds.calls = [
        {"src": a, "dst": b, "calls": c, "minutes": m} for (a, b), (c, m) in edges.items()
    ]


def _churn_and_usage(rng, ds: Dataset, month_list: list[date], plan_by_id) -> None:
    for s in ds.subscriptions:
        persona = s["_persona"]
        base_churn = 0.25 if s["_community_risk"] else 0.03
        if s["payment_type"] == "PREPAID":
            base_churn *= 1.6
        r = rng.random()
        status = "CHURNED" if r < base_churn else "SUSPENDED" if r < base_churn + 0.03 else "ACTIVE"
        s["status"] = status
        churn_score = (
            0.15 + (0.35 if s["_community_risk"] else 0) + (0.15 if s["tenure_months"] < 6 else 0)
            + (0.1 if s["nps"] <= 6 else 0) + rng.gauss(0, 0.1)
        )
        if status == "CHURNED":
            churn_score += 0.3
        s["churn_score"] = round(min(0.99, max(0.01, churn_score)), 3)

        _, _, _, data_rng, voice_rng, *_ = PERSONAS[persona]
        active_months = month_list
        if status == "CHURNED":
            active_months = month_list[: len(month_list) - rng.randint(1, 3)]
        fee = plan_by_id[s["plan_id"]][3]
        revenues = []
        last_recharge = None
        for mi, m in enumerate(active_months):
            trend = 1 + 0.04 * mi
            data = int(rng.uniform(*data_rng) * trend)
            roaming = 0
            if persona == "traveler" and rng.random() < 0.45:
                roaming = int(rng.uniform(200, 4000))
            elif rng.random() < 0.04:
                roaming = int(rng.uniform(50, 600))
            intl = int(rng.uniform(60, 600)) if persona == "expat_caller" else (
                int(rng.uniform(0, 40)) if rng.random() < 0.2 else 0)
            rev = fee + roaming * 0.05 + intl * 0.15 + (len(s["addons"]) * 20)
            rev *= rng.uniform(0.9, 1.15)
            recharges = rng.randint(1, 5) if s["payment_type"] == "PREPAID" else 0
            if recharges:
                last_recharge = m + timedelta(days=rng.randint(0, 27))
            revenues.append(rev)
            ds.usage.append({
                "usage_id": f"{s['msisdn']}-{m.strftime('%Y%m')}",
                "msisdn": s["msisdn"],
                "month": m.isoformat(),
                "data_mb": data,
                "voice_min": int(rng.uniform(*voice_rng)),
                "sms_count": rng.randint(0, 60),
                "roaming_mb": roaming,
                "intl_min": intl,
                "revenue": round(rev, 2),
                "recharge_count": recharges,
            })
        last3 = revenues[-3:]
        s["arpu_3m"] = round(sum(last3) / len(last3), 2) if last3 else 0.0
        s["last_recharge_date"] = last_recharge.isoformat() if last_recharge else None
        for a in s["addons"]:
            ds.addons.append({"msisdn": s["msisdn"], "addon_id": a})


def _tickets(rng, ds: Dataset, as_of: date) -> None:
    risk_by_customer: dict[str, bool] = {}
    for s in ds.subscriptions:
        risk_by_customer[s["customer_id"]] = (
            risk_by_customer.get(s["customer_id"], False) or s["_community_risk"]
        )
    seq = 0
    for c in ds.customers:
        lam = 1.6 if risk_by_customer.get(c["customer_id"]) else 0.4
        n = min(8, int(rng.expovariate(1 / lam)))
        for _ in range(n):
            seq += 1
            opened = as_of + timedelta(days=27) - timedelta(days=rng.randint(0, 200))
            ds.tickets.append({
                "ticket_id": f"T{seq:08d}",
                "customer_id": c["customer_id"],
                "category": rng.choices(
                    ["Billing", "Network", "Device", "Plan Change", "Other"], [30, 30, 12, 18, 10]
                )[0],
                "status": "OPEN" if rng.random() < 0.2 else "RESOLVED",
                "severity": rng.choices(["Low", "Medium", "High"], [50, 35, 15])[0],
                "opened_at": opened.isoformat(),
            })


LINK_TYPES = ["Household", "Family", "Corporate", "Same person"]


def _account_links(rng: random.Random, ds: Dataset) -> None:
    """Map some accounts together: families sharing a surname in a city, a few
    corporate groups and duplicate registrations of the same person."""
    by_family: dict[tuple[str, str], list[dict]] = {}
    for c in ds.customers:
        by_family.setdefault((c["city"], c["full_name"].split()[-1]), []).append(c)
    seen: set[tuple[str, str]] = set()

    def link(a: dict, b: dict, link_type: str) -> None:
        key = tuple(sorted((a["customer_id"], b["customer_id"])))
        if a is b or key in seen:
            return
        seen.add(key)
        ds.links.append({"a": key[0], "b": key[1], "link_type": link_type})

    for members in by_family.values():
        if len(members) < 2:
            continue
        rng.shuffle(members)
        i = 0
        while i < len(members):
            size = rng.choice([2, 2, 3, 4])
            group = members[i:i + size]
            i += size
            if len(group) < 2 or rng.random() > 0.35:
                continue
            link_type = "Household" if rng.random() < 0.6 else "Family"
            for other in group[1:]:
                link(group[0], other, link_type)
    for _ in range(max(1, len(ds.customers) // 250)):
        group = rng.sample(ds.customers, rng.randint(3, 6))
        for other in group[1:]:
            link(group[0], other, "Corporate")
    for a, b in zip(rng.sample(ds.customers, len(ds.customers) // 200),
                    rng.sample(ds.customers, len(ds.customers) // 200), strict=True):
        link(a, b, "Same person")
