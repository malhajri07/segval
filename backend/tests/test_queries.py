from segval.dsl.model import SegmentDefinition
from segval.services import queries

from .conftest import AS_OF


def test_bucket_labels():
    assert queries.bucket_labels([18, 25, 35]) == ["< 18", "18 – 25", "25 – 35", "≥ 35"]
    assert queries.bucket_labels([0.2, 0.4]) == ["< 0.2", "0.2 – 0.4", "≥ 0.4"]


def test_bucket_expression_quotes_labels():
    expr = queries.bucket_expression("x.v", [1, 2])
    assert expr.startswith("CASE WHEN x.v IS NULL THEN null WHEN x.v < 1 THEN '< 1'")
    assert expr.endswith("ELSE '≥ 2' END")


def test_field_projection(catalog):
    assert queries.field_projection(catalog, "subscription", "a", "subscription.msisdn") == \
        "a.`msisdn`"
    assert queries.field_projection(catalog, "subscription", "a", "plan.name") == \
        "head([(a)-[:`ON_PLAN`]->(y:`Plan`) | y.`name`])"


def test_count_and_distribution_queries(compiler, catalog):
    cp = compiler.compile(SegmentDefinition(), as_of=AS_OF)
    assert "count(CASE WHEN in_segment THEN 1 END)" in queries.count_query(cp).text
    dq = queries.distribution_query(cp, catalog, "customer.age")
    assert "OPTIONAL MATCH (a)<-[:`OWNS`]-(y:`Customer`)" in dq.text
    assert "CASE WHEN y.`age` IS NULL" in dq.text


def test_materialize_queries_batch(compiler):
    cp = compiler.compile(SegmentDefinition(), as_of=AS_OF)
    clear, fill = queries.materialize_queries(cp, "s1")
    assert "IN TRANSACTIONS" in clear.text and "IN TRANSACTIONS" in fill.text
    assert fill.params["segment_id"] == "s1"
