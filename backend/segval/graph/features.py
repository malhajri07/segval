"""Graph-derived features, written back as ordinary node properties.

Business users cannot run graph algorithms, but they can filter on their results.
This job turns the call graph and account links into segmentable attributes:

* ``Subscription.influence_score``: weighted PageRank on the call graph, as a
  0-100 percentile (100 = most central line).
* ``Subscription.community_id`` / ``community_size``: Louvain communities of the
  call graph (who talks to whom).
* ``Subscription.community_churn_rate``: share of the *other* lines in the same
  community that have churned (excluding the line itself avoids leaking its own label).
* ``Customer.household_size``: accounts in the same household/family cluster of
  ``LINKED_TO`` links, including the customer.

``compute_features`` is a pure function over sorted edge lists, so the Neo4j job
and the offline demo export produce identical values for the same data.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass

import networkx as nx
from networkx.algorithms.community import louvain_communities

from segval.graph.client import GraphClient

HOUSEHOLD_LINK_TYPES = ("Household", "Family")
SEED = 42
# Louvain at the default resolution merges small calling circles into city-sized blobs
# (the modularity resolution limit). Recursive Louvain re-splits any community above
# this size. A fixed higher resolution also helps on large graphs but shatters small
# ones into singletons; the recursive split behaves well at every scale. On the
# synthetic data it recovers the generated circles with ~0.85 purity (0.11 at default).
MAX_COMMUNITY_SIZE = 40
MAX_DEPTH = 6


@dataclass
class Features:
    subscriptions: dict[str, dict[str, float | int]]
    customers: dict[str, dict[str, int]]

    def summary(self) -> dict[str, int]:
        communities = {f["community_id"] for f in self.subscriptions.values()}
        multi = sum(1 for f in self.customers.values() if f["household_size"] > 1)
        return {"lines": len(self.subscriptions), "communities": len(communities),
                "customers_in_households": multi}


def weighted_pagerank(g: nx.Graph, damping: float = 0.85, tol: float = 1e-10,
                      max_iter: int = 200) -> dict[str, float]:
    """Power-iteration PageRank on an undirected weighted graph (dangling mass spread evenly).
    Kept dependency-free (networkx's version needs numpy/scipy) and deterministic."""
    nodes = sorted(g.nodes)
    n = len(nodes)
    if not n:
        return {}
    strength = {v: sum(d.get("weight", 1.0) for _, _, d in g.edges(v, data=True)) for v in nodes}
    rank = dict.fromkeys(nodes, 1.0 / n)
    for _ in range(max_iter):
        dangling = sum(rank[v] for v in nodes if strength[v] == 0)
        base = (1 - damping) / n + damping * dangling / n
        nxt = dict.fromkeys(nodes, base)
        for v in nodes:
            if strength[v] == 0:
                continue
            share = damping * rank[v] / strength[v]
            for _, u, d in g.edges(v, data=True):
                nxt[u] += share * d.get("weight", 1.0)
        if sum(abs(nxt[v] - rank[v]) for v in nodes) < tol:
            return nxt
        rank = nxt
    return rank


def recursive_louvain(g: nx.Graph, depth: int = 0) -> list[list[int]]:
    """Louvain, then Louvain again inside any community larger than MAX_COMMUNITY_SIZE."""
    if not g.number_of_nodes():
        return []
    out: list[list[int]] = []
    for community in louvain_communities(g, weight="weight", seed=SEED):
        members = sorted(community)
        if len(members) > MAX_COMMUNITY_SIZE and depth < MAX_DEPTH:
            sub = g.subgraph(members)
            if len(louvain_communities(sub, weight="weight", seed=SEED)) > 1:
                out.extend(recursive_louvain(sub, depth + 1))
                continue
        out.append(members)
    return out


def compute_features(
    lines: Iterable[tuple[str, str]],
    calls: Iterable[tuple[str, str, float]],
    customers: Iterable[str],
    links: Iterable[tuple[str, str, str]],
) -> Features:
    """lines: (msisdn, status); calls: (a, b, calls); links: (a, b, link_type)."""
    status = dict(sorted(lines))
    g = nx.Graph()
    g.add_nodes_from(sorted(status))
    weights: dict[tuple[str, str], float] = {}
    for a, b, w in calls:
        if a == b or a not in status or b not in status:
            continue
        key = (a, b) if a < b else (b, a)
        weights[key] = weights.get(key, 0.0) + float(w or 0)
    g.add_weighted_edges_from((a, b, w) for (a, b), w in sorted(weights.items()))

    pagerank = weighted_pagerank(g)
    ordered = sorted(pagerank, key=lambda n: (pagerank[n], n))
    denom = max(1, len(ordered) - 1)
    influence = {n: round(100 * i / denom) for i, n in enumerate(ordered)}

    # Louvain iterates over sets; string hashing is randomised per process
    # (PYTHONHASHSEED), so run it on integer labels to get the same communities everywhere.
    ids = sorted(g.nodes)
    as_int = nx.relabel_nodes(g, {n: i for i, n in enumerate(ids)})
    int_graph = nx.Graph()
    int_graph.add_nodes_from(range(len(ids)))
    int_graph.add_weighted_edges_from(sorted((a, b, d["weight"]) for a, b, d in as_int.edges(data=True)))
    communities = sorted(([ids[i] for i in c] for c in recursive_louvain(int_graph)), key=lambda c: c[0])
    subs: dict[str, dict[str, float | int]] = {}
    for cid, members in enumerate(communities, start=1):
        churned = sum(1 for m in members if status[m] == "CHURNED")
        for m in members:
            others = len(members) - 1
            own = 1 if status[m] == "CHURNED" else 0
            subs[m] = {
                "influence_score": influence[m],
                "community_id": cid,
                "community_size": len(members),
                "community_churn_rate": round((churned - own) / others, 3) if others else 0.0,
            }

    h = nx.Graph()
    h.add_nodes_from(sorted(set(customers)))
    h.add_edges_from(sorted((a, b) for a, b, t in links if t in HOUSEHOLD_LINK_TYPES and a in h and b in h))
    custs = {n: {"household_size": len(comp)} for comp in nx.connected_components(h) for n in comp}
    return Features(subs, custs)


def compute_from_graph(client: GraphClient) -> Features:
    lines = [(r["k"], r["s"]) for r in client.read(
        "MATCH (s:Subscription) RETURN s.msisdn AS k, s.status AS s")]
    calls = [(r["a"], r["b"], r["w"]) for r in client.read(
        "MATCH (a:Subscription)-[c:CALLED]->(b:Subscription) "
        "RETURN a.msisdn AS a, b.msisdn AS b, c.calls AS w")]
    customers = [r["k"] for r in client.read("MATCH (c:Customer) RETURN c.customer_id AS k")]
    links = [(r["a"], r["b"], r["t"]) for r in client.read(
        "MATCH (a:Customer)-[l:LINKED_TO]->(b:Customer) "
        "RETURN a.customer_id AS a, b.customer_id AS b, l.link_type AS t")]
    return compute_features(lines, calls, customers, links)


def write_features(client: GraphClient, features: Features, batch: int = 5000) -> None:
    subs = [{"k": k, **v} for k, v in features.subscriptions.items()]
    for i in range(0, len(subs), batch):
        client.write(
            "UNWIND $rows AS r MATCH (s:Subscription {msisdn: r.k}) "
            "SET s.influence_score = r.influence_score, s.community_id = r.community_id, "
            "    s.community_size = r.community_size, s.community_churn_rate = r.community_churn_rate",
            {"rows": subs[i:i + batch]},
        )
    custs = [{"k": k, **v} for k, v in features.customers.items()]
    for i in range(0, len(custs), batch):
        client.write(
            "UNWIND $rows AS r MATCH (c:Customer {customer_id: r.k}) "
            "SET c.household_size = r.household_size",
            {"rows": custs[i:i + batch]},
        )


def refresh_features(client: GraphClient, progress: Callable[[str], None] | None = None) -> dict[str, int]:
    say = progress or (lambda _m: None)
    say("computing graph features")
    features = compute_from_graph(client)
    say("writing graph features")
    write_features(client, features)
    return features.summary()
