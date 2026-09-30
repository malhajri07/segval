"""Thin wrapper over the Neo4j driver so services can be tested with a fake."""

from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path
from typing import Any, Protocol

import neo4j
from neo4j import GraphDatabase, Query
from neo4j.time import Date, DateTime

from segval.config import Settings

SCHEMA_FILE = Path(__file__).parent / "schema.cypher"


class GraphClient(Protocol):
    def read(self, cypher: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]: ...

    def write(self, cypher: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]: ...

    def run_autocommit(self, cypher: str, params: dict[str, Any] | None = None) -> None: ...


def to_python(value: Any) -> Any:
    if isinstance(value, Date | DateTime):
        return value.iso_format()
    if isinstance(value, neo4j.graph.Node):
        return {k: to_python(v) for k, v in value.items()}
    if isinstance(value, dict):
        return {k: to_python(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [to_python(v) for v in value]
    return value


class Neo4jClient:
    def __init__(self, settings: Settings):
        self._settings = settings
        self._driver = GraphDatabase.driver(
            settings.neo4j_uri, auth=(settings.neo4j_user, settings.neo4j_password)
        )

    def close(self) -> None:
        self._driver.close()

    def _query(self, cypher: str) -> Query:
        return Query(cypher, timeout=self._settings.query_timeout_s)

    def read(self, cypher: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        records, _, _ = self._driver.execute_query(
            self._query(cypher), params or {},
            database_=self._settings.neo4j_database, routing_="r",
        )
        return [{k: to_python(v) for k, v in r.items()} for r in records]

    def write(self, cypher: str, params: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        records, _, _ = self._driver.execute_query(
            self._query(cypher), params or {}, database_=self._settings.neo4j_database,
        )
        return [{k: to_python(v) for k, v in r.items()} for r in records]

    def run_autocommit(self, cypher: str, params: dict[str, Any] | None = None) -> None:
        """For CALL {} IN TRANSACTIONS, which needs an implicit transaction."""
        with self._driver.session(database=self._settings.neo4j_database) as session:
            session.run(Query(cypher), params or {}).consume()

    def ping(self) -> bool:
        try:
            self._driver.verify_connectivity()
            return True
        except Exception:  # noqa: BLE001
            return False


def schema_statements() -> Iterable[str]:
    text = "\n".join(
        line for line in SCHEMA_FILE.read_text().splitlines() if not line.strip().startswith("//")
    )
    return [s.strip() for s in text.split(";") if s.strip()]


def apply_schema(client: GraphClient) -> int:
    count = 0
    for stmt in schema_statements():
        client.write(stmt)
        count += 1
    return count
