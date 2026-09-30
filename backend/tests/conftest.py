from __future__ import annotations

import os

import pytest

from segval.catalog.loader import load_catalog
from segval.dsl.compiler import Compiler

AS_OF = "2026-08-01"


@pytest.fixture(scope="session")
def catalog():
    return load_catalog("mobile_b2c")


@pytest.fixture(scope="session")
def compiler(catalog):
    return Compiler(catalog)


@pytest.fixture(scope="session")
def neo4j_client():
    """Real Neo4j for integration tests: set SEGVAL_IT=1 (uses SEGVAL_NEO4J_* settings)."""
    if os.environ.get("SEGVAL_IT") != "1":
        pytest.skip("integration tests disabled (set SEGVAL_IT=1)")
    from segval.config import get_settings
    from segval.graph.client import Neo4jClient

    client = Neo4jClient(get_settings())
    if not client.ping():
        pytest.skip("neo4j not reachable")
    yield client
    client.close()
