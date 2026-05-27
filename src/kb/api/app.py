"""FastAPI entrypoint. Route modules are wired in `routes/__init__.py`."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from kb.api.routes import register_routes
from kb.config import get_settings
from kb.storage.db import close_engine, init_engine

logger = logging.getLogger("kb.api")


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()
    await init_engine(settings.postgres_dsn)
    # Pre-create vector collections for every known domain so workers don't race
    # on first ingest. Best-effort: failure here is logged but doesn't block startup.
    try:
        from kb.storage import repo
        from kb.vector.factory import get_store

        store = get_store()
        for d in await repo.list_domains():
            try:
                await store.ensure_collection(d["name"])
            except Exception as e:
                logger.warning("startup ensure_collection(%s) failed: %s", d["name"], e)
    except Exception as e:
        logger.warning("startup vector pre-init skipped: %s", e)
    logger.info("KB API started (vector_store=%s)", settings.vector_store)
    try:
        yield
    finally:
        await close_engine()


def create_app() -> FastAPI:
    app = FastAPI(
        title="Knowledge Base",
        version="0.1.0",
        description="Domain-agnostic KB service: schema-driven ingestion, hybrid retrieval, cited answers.",
        lifespan=_lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
        allow_credentials=False,
    )

    @app.get("/healthz", tags=["meta"], summary="Liveness probe")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/metrics", tags=["meta"], summary="Prometheus metrics")
    async def metrics() -> object:
        from fastapi.responses import PlainTextResponse

        from kb.api.metrics import render_prometheus

        return PlainTextResponse(render_prometheus(), media_type="text/plain; version=0.0.4")

    @app.get("/readyz", tags=["meta"], summary="Readiness — checks DB, vector store, object store")
    async def readyz() -> dict[str, object]:
        from kb.api.health import probe

        return await probe()

    register_routes(app)
    return app


app = create_app()
