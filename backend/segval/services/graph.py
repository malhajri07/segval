"""Graph exploration and account linking for the visual graph workspace."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from segval.catalog.model import AttrType, Catalog, Entity
from segval.dsl.compiler import q
from segval.graph.client import GraphClient
from segval.services.segments import NotFound

CAPTION_PROPS = ["full_name", "name", "model", "msisdn", "category", "month"]
# Relationship types shown first when a node has more neighbours than the limit.
REL_PRIORITY = ["LINKED_TO", "OWNS", "ON_PLAN", "USES_DEVICE", "LIVES_IN", "HAS_ADDON", "RAISED", "CALLED"]


class GraphService:
    def __init__(self, catalog: Catalog, client: GraphClient):
        self.catalog = catalog
        self.client = client
        self.by_label: dict[str, Entity] = {e.label: e for e in catalog.entities}
        self.link = catalog.network(catalog.link_network) if catalog.link_network else None
        self.account = catalog.anchor_entity(self.link.anchor) if self.link else None
        self.link_attr = (
            next(a for a in self.link.edge_attributes if a.type == AttrType.ENUM) if self.link else None
        )

    # ---- node helpers -------------------------------------------------------------
    def _entity(self, label: str) -> Entity:
        ent = self.by_label.get(label)
        if ent is None:
            raise NotFound(f"label {label}")
        return ent

    def parse_id(self, node_id: str) -> tuple[Entity, str]:
        label, sep, key = node_id.partition(":")
        if not sep or not key:
            raise ValueError("node ids look like Label:key, e.g. Customer:C0000001")
        return self._entity(label), key

    def _node(self, label: str, props: dict[str, Any], degree: int | None = None) -> dict[str, Any]:
        ent = self._entity(label)
        key = str(props.get(ent.key))
        caption = next((str(props[p]) for p in CAPTION_PROPS if props.get(p) is not None), key)
        out = {"id": f"{label}:{key}", "label": label, "key": key, "caption": caption,
               "entity": ent.id, "props": props}
        if degree is not None:
            out["degree"] = degree
        return out

    # ---- queries -----------------------------------------------------------------------
    def search(self, text: str, limit: int = 20) -> list[dict[str, Any]]:
        text = text.strip()
        if not text:
            return []
        parts = []
        for anchor in self.catalog.anchors:
            ent = self.catalog.anchor_entity(anchor.id)
            names = [a.property for a in ent.attributes
                     if a.type == AttrType.STRING and a.property != ent.key]
            cond = " OR ".join(
                [f"x.{q(ent.key)} STARTS WITH $text"]
                + [f"toLower(x.{q(p)}) CONTAINS toLower($text)" for p in names]
            )
            parts.append(
                f"MATCH (x:{q(ent.label)}) WHERE {cond} "
                f"RETURN properties(x) AS props, '{ent.label}' AS label LIMIT $limit"
            )
        rows = self.client.read(
            "CALL () { " + " UNION ALL ".join(parts) + " } RETURN props, label LIMIT $limit",
            {"text": text, "limit": limit},
        )
        return [self._node(r["label"], r["props"]) for r in rows]

    def expand(self, node_id: str, limit: int = 30, include_usage: bool = False) -> dict[str, Any]:
        ent, key = self.parse_id(node_id)
        allowed = [lbl for lbl in self.by_label if include_usage or lbl != "MonthlyUsage"]
        rank = "CASE type(r) " + " ".join(
            f"WHEN '{t}' THEN {i}" for i, t in enumerate(REL_PRIORITY)) + " ELSE 99 END"
        rows = self.client.read(
            f"MATCH (n:{q(ent.label)} {{{q(ent.key)}: $key}})\n"
            "CALL (n) {\n"
            "  MATCH (n)-[r]-(m) WHERE labels(m)[0] IN $allowed\n"
            f"  RETURN r, m ORDER BY {rank}, coalesce(r.calls, 0) DESC LIMIT $limit\n"
            "}\n"
            "RETURN properties(n) AS props, COUNT { (n)--() } AS degree,\n"
            "  collect({type: type(r), outgoing: startNode(r) = n, props: properties(r),\n"
            "           label: labels(m)[0], node: properties(m), degree: COUNT { (m)--() }}) AS nbrs",
            {"key": key, "allowed": allowed, "limit": limit},
        )
        if not rows:
            raise NotFound(node_id)
        row = rows[0]
        center = self._node(ent.label, row["props"], row["degree"])
        nodes, edges = [center], []
        for nb in row["nbrs"]:
            other = self._node(nb["label"], nb["node"], nb["degree"])
            nodes.append(other)
            src, dst = (center["id"], other["id"]) if nb["outgoing"] else (other["id"], center["id"])
            edges.append({"id": f"{nb['type']}|{src}|{dst}", "type": nb["type"],
                          "source": src, "target": dst, "props": nb["props"]})
        return {"center": center["id"], "nodes": nodes, "edges": edges,
                "truncated": row["degree"] > len(edges)}

    def start_node(self) -> str | None:
        """A good first view: the account with the most links."""
        if not (self.link and self.account):
            return None
        rows = self.client.read(
            f"MATCH (a:{q(self.account.label)}) "
            f"WITH a, COUNT {{ (a)-[:{q(self.link.rel)}]-() }} AS n WHERE n > 0 "
            f"RETURN a.{q(self.account.key)} AS key ORDER BY n DESC, key LIMIT 1"
        )
        return f"{self.account.label}:{rows[0]['key']}" if rows else None

    # ---- account links -------------------------------------------------------------------
    def _require_links(self):
        if not (self.link and self.account and self.link_attr):
            raise ValueError("this catalog has no link network")
        return self.link, self.account, self.link_attr

    def _check_type(self, link_type: str) -> None:
        _, _, attr = self._require_links()
        if link_type not in (attr.values or []):
            raise ValueError(f"link type must be one of {attr.values}")

    def link_accounts(self, a: str, b: str, link_type: str) -> dict[str, Any]:
        net, acc, attr = self._require_links()
        self._check_type(link_type)
        if a == b:
            raise ValueError("an account cannot be linked to itself")
        rows = self.client.write(
            f"MATCH (a:{q(acc.label)} {{{q(acc.key)}: $a}}), (b:{q(acc.label)} {{{q(acc.key)}: $b}})\n"
            f"MERGE (a)-[l:{q(net.rel)}]-(b)\n"
            f"SET l.{q(attr.property)} = $type, l.source = 'user', l.created_at = $now\n"
            "RETURN startNode(l) = a AS forward, properties(l) AS props",
            {"a": a, "b": b, "type": link_type, "now": datetime.now(UTC).isoformat(timespec="seconds")},
        )
        if not rows:
            raise NotFound(f"account {a} or {b}")
        src, dst = (a, b) if rows[0]["forward"] else (b, a)
        s, d = f"{acc.label}:{src}", f"{acc.label}:{dst}"
        return {"id": f"{net.rel}|{s}|{d}", "type": net.rel, "source": s, "target": d,
                "props": rows[0]["props"]}

    def link_group(self, accounts: list[str], link_type: str) -> list[dict[str, Any]]:
        """Link every account to the first one (e.g. the household head)."""
        unique = list(dict.fromkeys(accounts))
        if len(unique) < 2:
            raise ValueError("choose at least two accounts")
        self._check_type(link_type)
        return [self.link_accounts(unique[0], other, link_type) for other in unique[1:]]

    def unlink_accounts(self, a: str, b: str) -> int:
        net, acc, _ = self._require_links()
        rows = self.client.write(
            f"MATCH (:{q(acc.label)} {{{q(acc.key)}: $a}})-[l:{q(net.rel)}]-"
            f"(:{q(acc.label)} {{{q(acc.key)}: $b}})\n"
            "DELETE l RETURN count(*) AS n",
            {"a": a, "b": b},
        )
        removed = rows[0]["n"] if rows else 0
        if not removed:
            raise NotFound(f"link between {a} and {b}")
        return removed
