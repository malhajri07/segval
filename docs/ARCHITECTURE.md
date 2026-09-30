# SegVal architecture

SegVal is a no-code segmentation platform for telecom (mobile and fixed) built on a
Neo4j property graph. Business users build segments visually. The platform compiles
them into Cypher, runs them against the customer graph and returns insights. Nobody
writes queries by hand.

```
 ┌────────────────────────── Web UI (React) ───────────────────────────┐
 │ Rule builder · live count · plain-language summary · Cypher view    │
 │ Segment library · insights (profile vs. base, KPIs) · overlap · 360 │
 └──────────────────────────────┬───────────────────────────────────────┘
                                │ JSON rule tree  (SegmentDefinition)
 ┌──────────────────────────────▼───────────────── API (FastAPI) ──────┐
 │ Semantic catalog ──► DSL compiler ──► query builders ──► services   │
 │ (YAML: entities,     (rule tree →      (count, profile,  (segments,  │
 │  paths, metrics,      parameterised     members,          insights,  │
 │  networks, KPIs)      Cypher predicate) materialize)      templates) │
 └──────────────────────────────┬───────────────────────────────────────┘
                                │ Bolt, parameterised queries only
 ┌──────────────────────────────▼───────────────────────────────────────┐
 │ Neo4j 5: customer graph + (:Segment) definitions + [:MEMBER_OF] edges │
 └───────────────────────────────────────────────────────────────────────┘
```

## 1. The graph model (mobile B2C)

```
(:City)<-[:LIVES_IN]-(:Customer)-[:RAISED]->(:Ticket)
                         │
                       [:OWNS]
                         ▼
(:Plan)<-[:ON_PLAN]-(:Subscription)-[:USES_DEVICE]->(:Device)
                      │    │    ╲
         [:HAS_ADDON] │    │     [:CALLED {calls, minutes}]──►(:Subscription)
                      ▼    ▼
                 (:Addon) (:MonthlyUsage {month, data_mb, voice_min, roaming_mb, …})
```

Materialized segments live in the same graph: `(:Subscription)-[:MEMBER_OF]->(:Segment)`.
That makes them reusable as building blocks ("in segment X") and cheap to overlap.

## 2. Semantic catalog: the no-code vocabulary

`backend/segval/catalog/mobile_b2c.yaml` is the only place that knows graph
labels, relationship types and property names. It declares:

| Concept | Meaning | Example |
|---|---|---|
| **Anchor** | The unit being segmented | `subscription` (MSISDN), `customer` |
| **Entity** | A node type plus the **path** from each anchor to it | `city`: `(a)<-[:OWNS]-(:Customer)-[:LIVES_IN]->(:City)` |
| **Attribute** | A typed property (`number`, `enum`, `boolean`, `date`, `string`) | `device.is_5g`, `customer.age` (with profile buckets) |
| **Metric** | A time-windowed aggregate over a related entity | `avg_data_mb = avg(usage.data_mb)` over the last *N* months |
| **Network** | A relationship between anchors, used for graph conditions | `calls` over `[:CALLED]` with edge attributes |
| **KPIs / profile dimensions** | What the insights view compares against the base | ARPU, churn score, avg data… |

Adding a new business term is a YAML change. Adding a new domain (for example fixed
broadband) is a new catalog file. The UI is generated from `GET /api/catalog`.

## 3. Segment definition language

A segment is a JSON rule tree (`backend/segval/dsl/model.py`):

| Node | Meaning | Compiles to |
|---|---|---|
| `group` | AND / OR of children, optional NOT | `(… AND …)` |
| `attribute` | Compare a field on the anchor or any reachable entity | inline predicate, or `EXISTS { MATCH path WHERE … }` |
| `metric` | Time-windowed aggregate compared to a value | `coalesce(head(COLLECT { MATCH … RETURN avg(…) }), 0) > $p` |
| `related` | Count related records that match a nested filter | `COUNT { MATCH … WHERE … }` (or `EXISTS` / `NOT EXISTS`) |
| `network` | Count graph neighbours matching a **full nested rule**, with edge filters | `COUNT { MATCH (a)-[r:CALLED]-(n) WHERE r.calls >= $p AND <rule on n> }` |
| `segment` | Membership of another saved segment | `EXISTS { (a)-[:MEMBER_OF]->(:Segment {id:$p}) }` |

Every node compiles to a boolean expression, so nodes compose freely and nest. For
example: "active lines with ≥2 frequent contacts who churned **and** who were on a
prepaid plan".

**Safety.** Identifiers come only from the validated catalog (regex-checked and
backtick-quoted). User values travel only as query parameters. The compiler
rejects type and operator mismatches, unknown fields, out-of-scope references
and excessive nesting. Each error carries a `path` (for example
`rule.children[1].where`) that the UI uses to highlight the offending node.

**Reproducibility.** Relative time ("last 3 months", "within 90 days") resolves
against `$as_of`, the latest month loaded into the graph, not the wall clock.

## 4. Services

* **Preview**: counts the segment and base in one pass and returns a sample.
* **Segments**: create and update (versioned; the version only increments when
  rules change), delete (refused while other segments depend on it), and
  materialize. Materializing rebuilds `MEMBER_OF` edges in batched
  transactions, building stale dependencies first, with cycle detection.
* **Insights**:
  * the profile compares each dimension's segment share with its base share and
    reports an index (100 = same as the base);
  * KPI averages with lift;
  * an overlap matrix across materialized segments;
  * a 360° member view with every entity reachable from the member, plus its top
    call contacts.
* **Templates**: 11 ready-made B2C segments (retention, churn contagion,
  influencers, 5G upsell, roaming cross-sell…).

## 5. Scaling notes

* Predicates run once per anchor node. With indexes on the most selective
  anchor properties (payment type, status) Neo4j prunes early. For bases of tens
  of millions of lines, add pre-aggregated usage properties (for example
  `s.avg_data_3m`), refreshed by the ingestion job, and expose them as attributes.
  The catalog makes that swap invisible to users.
* Profile queries scan the base once per dimension. Cache the base
  distribution per `as_of` (it only changes on data load) to halve the cost.
* Materialization uses `CALL {} IN TRANSACTIONS` batches, so it is safe for
  millions of members.

## 6. Roadmap to the full platform

The current MVP (≈6K lines) is the core that everything else plugs into. A
realistic path to the full platform (≈100K lines) is to grow in modules, each
shippable on its own:

| # | Module | What it adds |
|---|---|---|
| 1 | **Fixed & enterprise catalogs** | `fixed_broadband.yaml` (Household, Address, Service, Coverage, speed tiers), `enterprise.yaml` (Account hierarchy, Site, Contract, SLA). Multi-catalog routing in the API. |
| 2 | **Convergence (FMC)** | Household/Account anchors spanning mobile and fixed; cross-domain metrics; "has mobile but no fibre at a covered address". |
| 3 | **Data ingestion** | Connectors from the DWH/lake (JDBC, Parquet, Kafka) into the graph, incremental daily loads, data-quality checks, `as_of` snapshots. |
| 4 | **Graph data science** | Neo4j GDS jobs (PageRank influence, Louvain communities, node similarity), written back as catalog attributes, e.g. `community_churn_rate`. |
| 5 | **Security & governance** | SSO/OIDC, RBAC per domain, PII masking in samples/exports, audit log of every query and export, approval flow for activation. |
| 6 | **Scheduling & activation** | Scheduled refresh, segment history/trends, push to CRM/campaign tools (CSV/SFTP, REST, Kafka), control groups. |
| 7 | **Advanced analytics** | Segment trend over time, Sankey of segment migration between refreshes, uplift of campaigns vs. control. |
| 8 | **Natural-language builder** | "Postpaid customers in Riyadh with a 5G phone but no unlimited plan" → rule tree (LLM constrained by the catalog; output always reviewed in the visual builder). |
| 9 | **Catalog admin UI** | Let data stewards add attributes/metrics without editing YAML; catalog versioning. |

Each module reuses the same catalog → DSL → Cypher core, which keeps the growth
consistent instead of turning it into 100K lines of one-off queries.
