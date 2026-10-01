# Research notes: taking SegVal to the next level

Desk research (October 2026) on graph features for telecom marketing, segmentation-tool
capabilities, household mapping, and constraints. **Caveat:** most publisher sites were
blocked from the research environment, so figures come from abstracts and search
snippets. Verify any number against the source before quoting it externally.

## What we acted on

| # | Recommendation | Status |
|---|---|---|
| 1 | Churn-contagion network features (churned neighbours, tie strength, community churn) | **Shipped:** call-graph communities (recursive Louvain), `community_churn_rate`, network conditions with edge filters |
| 2 | Holdout / control groups so campaign lift can be proven | **Shipped:** per-segment holdout %, deterministic assignment, target-only export |
| 3 | Condition-level count breakdown (funnel) | **Shipped:** condition funnel on every segment |
| 6 | Segment trends | **Partly shipped:** monthly segment-vs-base metric trends. Membership history needs scheduling (roadmap) |
| 8 | Influencer seeding for viral and upsell campaigns | **Shipped:** `influence_score` (weighted PageRank percentile), influence lens in the graph view, template |
| 4 | Consent / purpose tags enforced at activation (Saudi PDPL) | Roadmap: next priority |
| 5 | Suggested-match queue for account links (entity resolution) | Roadmap |
| 7 | Predictive churn score with graph features as inputs | Roadmap |

## Key findings

**Graph features have measured value in telecom.**
- Churn is contagious through **outgoing** ties to contacts who churned **recently** (about 5 weeks) — Haenlein, IJRM 2013 ([link](https://www.sciencedirect.com/science/article/abs/pii/S0167811613000402)). A natural next feature is "recently churned neighbours, weighted by minutes", which needs a churn date per line.
- Adding social-network features to a churn model raised AUC from 84% to 93.3% at SyriaTel ([J Big Data 2019](https://link.springer.com/article/10.1186/s40537-019-0191-6)).
- Network neighbours of adopters took up a telecom service at 3–5× the rate of the firm's best target groups ([Hill, Provost & Volinsky, Stat. Sci. 2006](https://projecteuclid.org/euclid.ss/1154979826)).
- Louvain was first validated on a 2.6M-customer Belgian mobile network ([Blondel 2008](https://perso.uclouvain.be/vincent.blondel/publications/08BG.pdf)). We found its default resolution merges calling circles into city-sized groups. Recursive Louvain (re-split communities above 40 lines) recovered the synthetic circles with 0.85 purity, against 0.11 at default resolution.
- Typical parameters: PageRank damping 0.85; minutes- or calls-weighted undirected edges; prune to reciprocal or strong ties at scale ([Neo4j GDS](https://neo4j.com/docs/graph-data-science/current/algorithms/page-rank/)).

**What segmentation and CDP tools offer that matters most for a telco**, ranked by judgement, not measurement:
1. Holdout and control groups ([Optimove](https://academy.optimove.com/hc/en-us/articles/8698903745309-Using-Control-Groups), [Hightouch](https://hightouch.com/docs/customer-studio/splits)).
2. Consent and data-usage policy enforcement ([Adobe](https://experienceleague.adobe.com/en/docs/experience-platform/segmentation/tutorials/governance)).
3. Condition-level counts and priority (waterfall) segments ([Salesforce](https://help.salesforce.com/s/articleView?language=en_US&id=data.c360_a_segments.htm&type=5), [Hightouch](https://hightouch.com/docs/customer-studio/priority-lists)).
4. Predictive audiences ([Braze](https://www.braze.com/docs/user_guide/brazeai/predictive_suite/predictive_churn)).
5. Segment history ([Braze](https://braze.com/docs/user_guide/audience/segments/segment_data)).
6. Lookalikes ([Adobe](https://experienceleague.adobe.com/en/docs/experience-platform/segmentation/types/lookalike-audiences)).

**Households and FMC.** Account mapping usually works in four stages:
1. Deterministic rules: national ID, billing account, address.
2. Graph signals: shared device or address, dense mutual calling.
3. Similarity scoring: GDS Node Similarity, then WCC.
4. A steward queue with accept/reject decisions and merge/split history ([Reltio](https://docs.reltio.com/en/model/consolidate-data/configure-match-rules-overview/review-potential-matches-overview), [Informatica](https://docs.informatica.com/master-data-management/multidomain-mdm/10-4-hotfix-3/data-steward-guide/consolidating-data/merging-records/matched-data.html), [Neo4j](https://neo4j.com/blog/graph-data-science/graph-data-science-use-cases-entity-resolution/)).

Vodafone Germany scored about 30M mobile and 7.5M household subscribers to find about 17M households for convergence ([Teradata](https://www.teradata.com/Customers/Vodafone-Germany-Convergence)). Reported FMC churn benefits vary from "up to ~50% lower" to "modest" ([Oliver Wyman](https://www.oliverwyman.de/content/dam/oliver-wyman/europe/germany/de/insights/publications/2015/july/2015_OliverWyman_Fixed_mobile_convergence_final_digital.pdf), [Analysys Mason](https://www.analysysmason.com/research/content/articles/fixed-churn-fmc-rdcs0-rdmb0/)).

**Regulatory constraints (get legal review).**
- Saudi PDPL has been enforceable since September 2024. It requires opt-in consent for direct marketing, and it treats location data as sensitive, which must not be used for marketing ([DLA Piper](https://www.dlapiperdataprotection.com/?c=SA)).
- CST requires prior opt-in for promotional SMS and calls.
- We found no CST rule specific to marketing use of CDRs. Confirm this with the operator's regulatory team.

Design implications:
- Compute call-graph features only for consented subscribers.
- Never expose neighbour identities in exports or messaging.
- Gate activation on consent tags.

**Scale.** One Saudi operator likely has 10–25M subscriptions (KSA total ≈ 54M, 2024). To handle that:
- aggregate CDRs to monthly `CALLED` edges outside Neo4j;
- prune weak ties;
- compute graph features in batch and write them back as properties, which is what `segval.graph.features` does.
