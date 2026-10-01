# SegVal: no-code graph segmentation for telecom

Build customer segments on a Neo4j graph of the mobile/fixed business without
writing code. Business users compose rules visually. SegVal compiles them to safe,
parameterised Cypher, shows live counts, profiles the segment against the base and
materializes it for activation.

* **Visual rule builder**: attributes, time-windowed usage metrics, related records
  ("no roaming add-on"), **graph network conditions** ("≥2 frequent call contacts
  who churned") and segment-of-segments, with AND / OR / NOT nesting.
* **Live preview**: segment size, share of base, sample, plain-language summary and
  the generated Cypher.
* **Insights**:
  * a condition funnel showing how each rule narrows the audience;
  * "what makes this segment different", ranked over- and under-represented traits that leave out the rule's own fields;
  * monthly segment-vs-base trends;
  * KPI lift, distributions with an index, overlap matrix and a 360° member view.
* **Graph intelligence**: graph algorithms computed from the call graph and account links, all usable as ordinary segment attributes:
  * call-graph influence (PageRank percentile);
  * calling communities (recursive Louvain), with community size and community churn rate;
  * household size.
* **Control groups**: hold out a share of each segment (deterministic, stable across
  refreshes). Exports contain only the contact group, so campaign lift can be measured.
* **Graph workspace**: explore customers, lines, plans, devices and call contacts as a
  graph; drag one customer onto another to link the accounts (Household, Family,
  Corporate, Same person), or shift-click several and link them as a group. Links are
  `LINKED_TO` relationships and are immediately usable in segments ("linked to a
  household member who churned").
* **Semantic catalog**: the business vocabulary is YAML (`backend/segval/catalog/`);
  the UI is generated from it.
* **11 templates** for mobile B2C: retention, churn contagion, influencers, 5G upsell,
  prepaid→postpaid, roaming/international cross-sell, device upgrade, care detractors…

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and the roadmap, and
[docs/RESEARCH.md](docs/RESEARCH.md) for the research behind the latest features.
To start and smoke-test the stack in a container, use the project skill at
`.claude/skills/run-segval/` (`up.sh`, then `drive.mjs`).

## Quick start (Docker)

```bash
docker compose up -d --build
docker compose exec api segval-seed --customers 5000   # synthetic mobile base
open http://localhost:8080                             # UI
open http://localhost:8000/docs                        # API docs
open http://localhost:7474                             # Neo4j Browser (neo4j / segval-dev-pw)
```

## Local development

```bash
# Neo4j
docker run -d --name segval-neo4j -p 7474:7474 -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/segval-dev-pw neo4j:5-community

# Backend
cd backend
python -m venv .venv && . .venv/bin/activate
pip install -e '.[dev]'
segval-seed --customers 5000
uvicorn segval.api.app:app --reload --port 8000

# Frontend
cd frontend
npm install
npm run dev          # http://localhost:5173 (proxies /api to :8000)
```

Configuration uses `SEGVAL_*` environment variables (see `backend/segval/config.py`):
`SEGVAL_NEO4J_URI`, `SEGVAL_NEO4J_USER`, `SEGVAL_NEO4J_PASSWORD`,
`SEGVAL_NEO4J_DATABASE`, `SEGVAL_ENABLE_ADMIN` (turn off in production).

## Tests

```bash
cd backend && pytest                       # unit + API tests
SEGVAL_IT=1 pytest                         # + integration tests against Neo4j (reloads data)
cd frontend && npm test && npm run build
```

## Example: a segment definition

```json
{
  "anchor": "subscription",
  "rule": {
    "kind": "group", "op": "and",
    "children": [
      { "kind": "attribute", "field": "subscription.status", "operator": "eq", "value": "ACTIVE" },
      { "kind": "network", "network": "calls", "count_operator": "gte", "count_value": 2,
        "edge_where": [{ "attribute": "calls", "operator": "gte", "value": 5 }],
        "where": { "kind": "attribute", "field": "subscription.status", "operator": "eq", "value": "CHURNED" } }
    ]
  }
}
```

compiles to:

```cypher
MATCH (a:`Subscription`)
WHERE ((a.`status` = $p0) AND (COUNT { MATCH (a)-[r2:`CALLED`]-(n1:`Subscription`)
       WHERE r2.`calls` >= $p1 AND n1.`status` = $p2 RETURN DISTINCT n1 } >= $p3))
RETURN a
```

## Offline demo (no server)

`npm run build:demo` in `frontend/` produces `dist-demo/index.html`: one self-contained
page with the full UI, a bundled synthetic dataset (2,000 customers) and an in-browser
engine that is a line-for-line port of the Cypher compiler. `src/demo/parity.test.ts`
checks it against the Python compiler and real Neo4j counts. Regenerate the data with
`npm run demo:data` (the parity fixture comes from a live Neo4j run).
