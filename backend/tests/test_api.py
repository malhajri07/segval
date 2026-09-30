"""API tests with an in-memory fake graph client (no database needed)."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from segval.api.app import Container, create_app
from segval.config import Settings


class FakeGraph:
    def __init__(self):
        self.calls: list[tuple[str, dict]] = []

    def read(self, cypher, params=None):
        self.calls.append((cypher, params or {}))
        if "max(u.month)" in cypher:
            return [{"m": "2026-08-01"}]
        if "segment_size" in cypher:
            return [{"segment_size": 3, "base_size": 10}]
        if "AS row" in cypher:
            return [{"row": {"subscription.msisdn": "9665"}}]
        return []

    write = read

    def run_autocommit(self, cypher, params=None):
        self.calls.append((cypher, params or {}))


@pytest.fixture()
def api():
    graph = FakeGraph()
    container = Container.build(Settings(enable_admin=False), client=graph)
    with TestClient(create_app(container)) as client:
        client.graph = graph
        yield client


def test_catalog_exposes_operators(api):
    body = api.get("/api/catalog").json()
    assert body["domain"] == "mobile_b2c"
    assert "between" in body["operators"]["number"]
    addon = next(e for e in body["entities"] if e["id"] == "addon")
    assert addon["multi_valued"] == {"subscription": True, "customer": True}


def test_enum_values_come_from_catalog(api):
    body = api.get("/api/catalog/values", params={"field": "plan.category"}).json()
    assert "Youth" in body["values"]


def test_compile_returns_cypher(api):
    res = api.post("/api/segments/compile", json={
        "anchor": "subscription",
        "rule": {"kind": "attribute", "field": "device.is_5g", "operator": "eq", "value": True},
    })
    assert res.status_code == 200
    body = res.json()
    assert body["cypher"].startswith("MATCH (a:`Subscription`)")
    assert body["params"]["as_of"] == "2026-08-01"


def test_preview(api):
    res = api.post("/api/segments/preview", json={"definition": {"anchor": "subscription"}})
    body = res.json()
    assert (body["segment_size"], body["base_size"], body["share"]) == (3, 10, 0.3)
    assert body["sample"] == [{"subscription.msisdn": "9665"}]


def test_compile_error_is_422_with_path(api):
    res = api.post("/api/segments/preview", json={"definition": {
        "anchor": "subscription",
        "rule": {"kind": "group", "children": [
            {"kind": "attribute", "field": "plan.category", "operator": "gt", "value": 1}]},
    }})
    assert res.status_code == 422
    assert res.json()["path"] == "rule.children[0]"


def test_unknown_segment_is_404(api):
    assert api.get("/api/segments/nope").status_code == 404


def test_templates(api):
    assert len(api.get("/api/templates").json()) >= 10


def test_admin_disabled(api):
    assert api.post("/api/admin/seed", json={}).status_code in (404, 405)
