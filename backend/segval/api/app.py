"""HTTP API for the no-code segmentation platform."""

from __future__ import annotations

from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, PlainTextResponse
from neo4j.exceptions import Neo4jError, ServiceUnavailable
from pydantic import BaseModel, Field

from segval.catalog.loader import load_catalog
from segval.catalog.model import AttrType, Catalog
from segval.config import Settings, get_settings
from segval.dsl.compiler import METRIC_OPERATORS, OPERATORS_BY_TYPE, CompileError, q
from segval.dsl.model import CountOperator, SegmentDefinition
from segval.graph.client import GraphClient, Neo4jClient, apply_schema
from segval.services.graph import GraphService
from segval.services.insights import InsightsService
from segval.services.segments import Conflict, DataClock, NotFound, SegmentIn, SegmentService
from segval.templates.loader import load_templates


@dataclass
class Container:
    settings: Settings
    catalog: Catalog
    client: GraphClient
    clock: DataClock
    segments: SegmentService
    insights: InsightsService
    graph: GraphService

    @classmethod
    def build(cls, settings: Settings, client: GraphClient | None = None) -> Container:
        catalog = load_catalog(settings.catalog_domain)
        client = client or Neo4jClient(settings)
        clock = DataClock(client)
        segments = SegmentService(catalog, client, clock)
        return cls(settings, catalog, client, clock, segments,
                   InsightsService(catalog, client, segments), GraphService(catalog, client))


def create_app(container: Container | None = None) -> FastAPI:
    settings = container.settings if container else get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if getattr(app.state, "container", None) is None:
            app.state.container = Container.build(settings)
        yield
        close = getattr(app.state.container.client, "close", None)
        if close:
            close()

    app = FastAPI(title="SegVal", version="0.1.0", lifespan=lifespan,
                  description="No-code graph segmentation for telecom, backed by Neo4j.")
    app.state.container = container
    app.add_middleware(
        CORSMiddleware, allow_origins=settings.cors_origins,
        allow_methods=["*"], allow_headers=["*"],
    )
    _register_errors(app)
    _register_routes(app, settings)
    return app


def get_container(request: Request) -> Container:
    return request.app.state.container


def _register_errors(app: FastAPI) -> None:
    @app.exception_handler(CompileError)
    async def _compile(_: Request, exc: CompileError):
        return JSONResponse(status_code=422, content={"detail": exc.message, "path": exc.path})

    @app.exception_handler(NotFound)
    async def _nf(_: Request, exc: NotFound):
        return JSONResponse(status_code=404, content={"detail": f"not found: {exc}"})

    @app.exception_handler(Conflict)
    async def _conflict(_: Request, exc: Conflict):
        return JSONResponse(status_code=409, content={"detail": str(exc)})

    @app.exception_handler(ServiceUnavailable)
    async def _down(_: Request, exc: ServiceUnavailable):
        return JSONResponse(status_code=503, content={"detail": "graph database unavailable"})

    @app.exception_handler(Neo4jError)
    async def _neo(_: Request, exc: Neo4jError):
        return JSONResponse(status_code=500, content={"detail": f"graph query failed: {exc.message}"})


# ---- request models -----------------------------------------------------------
class PreviewRequest(BaseModel):
    definition: SegmentDefinition
    sample_size: int = Field(default=25, ge=0, le=500)


class ProfileRequest(BaseModel):
    definition: SegmentDefinition | None = None
    segment_id: str | None = None
    dimensions: list[str] | None = None


class BreakdownRequest(BaseModel):
    definition: SegmentDefinition | None = None
    segment_id: str | None = None
    field: str


class OverlapRequest(BaseModel):
    segment_ids: list[str] = Field(min_length=1, max_length=12)


class LinkRequest(BaseModel):
    a: str
    b: str
    link_type: str


class LinkGroupRequest(BaseModel):
    accounts: list[str] = Field(min_length=2, max_length=50)
    link_type: str


class SeedRequest(BaseModel):
    customers: int = Field(default=5000, ge=10, le=500_000)
    seed: int = 42


def catalog_payload(catalog: Catalog) -> dict[str, Any]:
    data = catalog.model_dump(mode="json")
    for ent in data["entities"]:
        ent["multi_valued"] = {
            a.id: catalog.is_multi_valued(a.id, ent["id"])
            for a in catalog.anchors if catalog.path(a.id, ent["id"]) is not None
        }
    data["operators"] = {t.value: [o.value for o in ops] for t, ops in OPERATORS_BY_TYPE.items()}
    data["metric_operators"] = [o.value for o in METRIC_OPERATORS]
    data["count_operators"] = [o.value for o in CountOperator]
    return data


def _register_routes(app: FastAPI, settings: Settings) -> None:
    C = Depends(get_container)

    @app.get("/api/health")
    def health(c: Container = C):
        ping = getattr(c.client, "ping", None)
        return {"status": "ok", "graph": ping() if ping else None,
                "catalog": c.catalog.domain}

    # ---- catalog ------------------------------------------------------------------
    @app.get("/api/catalog")
    def catalog(c: Container = C):
        return catalog_payload(c.catalog)

    @app.get("/api/catalog/values")
    def field_values(field: str, prefix: str = "", limit: int = Query(50, le=500),
                     c: Container = C):
        try:
            entity, attr = c.catalog.resolve_field(field)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from None
        if attr.values:
            return {"field": field, "values": attr.values}
        if attr.type != AttrType.STRING:
            raise HTTPException(400, "value suggestions are only available for text fields")
        rows = c.client.read(
            f"MATCH (x:{q(entity.label)}) WHERE x.{q(attr.property)} IS NOT NULL "
            f"AND toLower(x.{q(attr.property)}) STARTS WITH toLower($prefix) "
            f"RETURN x.{q(attr.property)} AS v, count(*) AS n ORDER BY n DESC LIMIT $limit",
            {"prefix": prefix, "limit": limit},
        )
        return {"field": field, "values": [r["v"] for r in rows]}

    @app.get("/api/templates")
    def templates(c: Container = C):
        return [t.model_dump(mode="json") for t in load_templates(c.catalog.domain)]

    # ---- segment authoring --------------------------------------------------------
    @app.post("/api/segments/compile")
    def compile_segment(definition: SegmentDefinition, c: Container = C):
        return c.segments.cypher(definition)

    @app.post("/api/segments/preview")
    def preview(req: PreviewRequest, c: Container = C):
        return c.segments.preview(req.definition, req.sample_size)

    @app.get("/api/segments")
    def list_segments(tag: str | None = None, c: Container = C):
        return [s.model_dump(mode="json") for s in c.segments.list(tag)]

    @app.post("/api/segments", status_code=201)
    def create_segment(body: SegmentIn, c: Container = C):
        return c.segments.create(body).model_dump(mode="json")

    @app.get("/api/segments/{segment_id}")
    def get_segment(segment_id: str, c: Container = C):
        return c.segments.get(segment_id).model_dump(mode="json")

    @app.put("/api/segments/{segment_id}")
    def update_segment(segment_id: str, body: SegmentIn, c: Container = C):
        return c.segments.update(segment_id, body).model_dump(mode="json")

    @app.delete("/api/segments/{segment_id}", status_code=204)
    def delete_segment(segment_id: str, c: Container = C):
        c.segments.delete(segment_id)

    @app.post("/api/segments/{segment_id}/materialize")
    def materialize(segment_id: str, c: Container = C):
        return c.segments.materialize(segment_id).model_dump(mode="json")

    @app.get("/api/segments/{segment_id}/cypher")
    def segment_cypher(segment_id: str, c: Container = C):
        return c.segments.cypher(c.segments.get(segment_id).definition)

    @app.get("/api/segments/{segment_id}/members")
    def members(segment_id: str, limit: int = Query(100, ge=1, le=5000),
                skip: int = Query(0, ge=0), fields: list[str] | None = Query(None),
                c: Container = C):
        try:
            return c.segments.members(segment_id, limit, skip, fields)
        except KeyError as exc:
            raise HTTPException(400, str(exc)) from None

    @app.get("/api/segments/{segment_id}/export.csv", response_class=PlainTextResponse)
    def export_csv(segment_id: str, fields: list[str] | None = Query(None), c: Container = C):
        seg = c.segments.get(segment_id)
        body = c.segments.export_csv(segment_id, fields)
        filename = "".join(ch if ch.isalnum() else "_" for ch in seg.name).strip("_") or "segment"
        return PlainTextResponse(
            body, media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="{filename}.csv"'},
        )

    # ---- insights -------------------------------------------------------------------
    @app.post("/api/insights/profile")
    def profile(req: ProfileRequest, c: Container = C):
        try:
            return c.insights.profile(req.definition, req.segment_id, req.dimensions)
        except (KeyError, ValueError) as exc:
            if isinstance(exc, CompileError):
                raise
            raise HTTPException(400, str(exc)) from None

    @app.post("/api/insights/breakdown")
    def breakdown(req: BreakdownRequest, c: Container = C):
        try:
            return c.insights.breakdown(req.field, req.definition, req.segment_id)
        except (KeyError, ValueError) as exc:
            if isinstance(exc, CompileError):
                raise
            raise HTTPException(400, str(exc)) from None

    @app.post("/api/insights/overlap")
    def overlap(req: OverlapRequest, c: Container = C):
        try:
            return c.insights.overlap(req.segment_ids)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from None

    @app.get("/api/members/{anchor}/{key}")
    def member_view(anchor: str, key: str, c: Container = C):
        return c.insights.member_view(anchor, key)

    # ---- graph workspace -------------------------------------------------------------
    @app.get("/api/graph/search")
    def graph_search(q: str = Query(min_length=1), limit: int = Query(20, le=100), c: Container = C):
        return c.graph.search(q, limit)

    @app.get("/api/graph/start")
    def graph_start(c: Container = C):
        return {"node": c.graph.start_node()}

    @app.get("/api/graph/expand")
    def graph_expand(node: str, limit: int = Query(30, ge=1, le=200), usage: bool = False,
                     c: Container = C):
        try:
            return c.graph.expand(node, limit, usage)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from None

    @app.post("/api/graph/links", status_code=201)
    def graph_link(req: LinkRequest, c: Container = C):
        try:
            return c.graph.link_accounts(req.a, req.b, req.link_type)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from None

    @app.post("/api/graph/links/group", status_code=201)
    def graph_link_group(req: LinkGroupRequest, c: Container = C):
        try:
            return c.graph.link_group(req.accounts, req.link_type)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from None

    @app.delete("/api/graph/links", status_code=204)
    def graph_unlink(a: str, b: str, c: Container = C):
        try:
            c.graph.unlink_accounts(a, b)
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from None

    # ---- admin (dev) ------------------------------------------------------------------
    if settings.enable_admin:
        @app.post("/api/admin/schema")
        def admin_schema(c: Container = C):
            return {"statements": apply_schema(c.client)}

        @app.post("/api/admin/seed")
        def admin_seed(req: SeedRequest, c: Container = C):
            from segval.seed.generator import generate
            from segval.seed.loader import load_dataset

            ds = generate(customers=req.customers, seed=req.seed)
            summary = load_dataset(c.client, ds)
            c.clock.invalidate()
            return {"as_of": ds.as_of.isoformat(), **summary}


app = create_app()
