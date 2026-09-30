import pytest
from pydantic import ValidationError

from segval.catalog.model import Catalog


def test_catalog_loads(catalog):
    assert catalog.anchor("subscription") is not None
    assert catalog.path("subscription", "subscription") == []
    assert [h.label for h in catalog.path("subscription", "city")] == ["Customer", "City"]


def test_multi_valued(catalog):
    assert not catalog.is_multi_valued("subscription", "device")
    assert catalog.is_multi_valued("subscription", "addon")
    assert catalog.is_multi_valued("customer", "device")


def test_resolve_field(catalog):
    ent, attr = catalog.resolve_field("device.is_5g")
    assert ent.label == "Device" and attr.type == "boolean"
    with pytest.raises(KeyError):
        catalog.resolve_field("device.nope")


def _minimal(**overrides):
    data = {
        "domain": "t", "display": "T",
        "anchors": [{"id": "a", "entity": "e", "display": "A"}],
        "entities": [{
            "id": "e", "label": "E", "display": "E", "key": "k", "paths": {"a": []},
            "attributes": [{"id": "k", "property": "k", "type": "string", "display": "K"}],
        }],
    }
    data.update(overrides)
    return data


def test_rejects_injection_in_identifiers():
    bad = _minimal()
    bad["entities"][0]["label"] = "E`) DETACH DELETE n //"
    with pytest.raises(ValidationError):
        Catalog.model_validate(bad)


def test_rejects_unknown_anchor_entity():
    bad = _minimal(anchors=[{"id": "a", "entity": "missing", "display": "A"}])
    with pytest.raises(ValidationError):
        Catalog.model_validate(bad)


def test_enum_needs_values():
    bad = _minimal()
    bad["entities"][0]["attributes"].append(
        {"id": "x", "property": "x", "type": "enum", "display": "X"}
    )
    with pytest.raises(ValidationError):
        Catalog.model_validate(bad)


def test_link_network_must_exist():
    bad = _minimal(link_network="nope")
    with pytest.raises(ValidationError):
        Catalog.model_validate(bad)


def test_catalog_declares_account_links(catalog):
    net = catalog.network(catalog.link_network)
    assert net is not None and net.anchor == "customer" and net.rel == "LINKED_TO"
