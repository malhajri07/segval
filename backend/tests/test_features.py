import networkx as nx
import pytest

from segval.graph.features import compute_features, weighted_pagerank


def test_pagerank_is_a_distribution_and_favours_hubs():
    g = nx.Graph()
    g.add_weighted_edges_from([("hub", x, 1.0) for x in "abcde"] + [("a", "b", 1.0)])
    g.add_node("lonely")
    pr = weighted_pagerank(g)
    assert sum(pr.values()) == pytest.approx(1.0, abs=1e-6)
    assert max(pr, key=pr.get) == "hub"
    assert pr["lonely"] == min(pr.values())


def test_features_from_two_calling_circles():
    lines = [(f"a{i}", "CHURNED" if i < 2 else "ACTIVE") for i in range(4)] + \
            [(f"b{i}", "ACTIVE") for i in range(4)]
    calls = [(f"a{i}", f"a{j}", 20) for i in range(4) for j in range(i + 1, 4)] + \
            [(f"b{i}", f"b{j}", 20) for i in range(4) for j in range(i + 1, 4)] + [("a3", "b0", 1)]
    f = compute_features(lines, calls, ["c1", "c2", "c3", "c4"],
                         [("c1", "c2", "Household"), ("c2", "c3", "Family"), ("c3", "c4", "Corporate")])
    a, b = f.subscriptions["a2"], f.subscriptions["b1"]
    assert a["community_id"] != b["community_id"]
    assert a["community_size"] == b["community_size"] == 4
    # churn rate counts the *other* members only: a2 sees 2 of 3 churned, a0 sees 1 of 3
    assert a["community_churn_rate"] == pytest.approx(0.667, abs=1e-3)
    assert f.subscriptions["a0"]["community_churn_rate"] == pytest.approx(0.333, abs=1e-3)
    assert b["community_churn_rate"] == 0
    assert {v["influence_score"] for v in f.subscriptions.values()} <= set(range(101))
    # corporate links do not form households
    assert f.customers["c1"]["household_size"] == 3
    assert f.customers["c4"]["household_size"] == 1


def test_features_are_deterministic_regardless_of_input_order():
    lines = [(f"x{i}", "ACTIVE") for i in range(30)]
    calls = [(f"x{i}", f"x{(i * 7) % 30}", i % 5 + 1) for i in range(30)]
    one = compute_features(lines, calls, [], [])
    two = compute_features(list(reversed(lines)), list(reversed(calls)), [], [])
    assert one.subscriptions == two.subscriptions


def test_features_do_not_depend_on_python_hash_seed():
    """Louvain iterates over sets; results must not change with PYTHONHASHSEED."""
    import json
    import os
    import subprocess
    import sys

    code = (
        "import json; from segval.graph.features import compute_features;"
        "from segval.seed.generator import generate; ds = generate(300, seed=3);"
        "f = compute_features([(s['msisdn'], s['status']) for s in ds.subscriptions],"
        "[(c['src'], c['dst'], c['calls']) for c in ds.calls], [], []);"
        "print(json.dumps(f.subscriptions, sort_keys=True))"
    )
    outs = {
        subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True,
                       env={**os.environ, "PYTHONHASHSEED": seed}).stdout
        for seed in ("1", "2", "3")
    }
    assert len(outs) == 1
    assert len(json.loads(outs.pop())) > 0
