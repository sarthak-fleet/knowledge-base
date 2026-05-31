"""Route registration. Each module exposes `router: APIRouter`."""

from __future__ import annotations

from fastapi import FastAPI

from kb.api.routes import (
    domains,
    entities,
    files,
    infer,
    ingest,
    ingest_data,
    projects,
    query,
    schemas,
)


def register_routes(app: FastAPI) -> None:
    app.include_router(projects.router)
    app.include_router(domains.router)
    app.include_router(schemas.router)
    app.include_router(infer.router)
    app.include_router(files.router)
    app.include_router(ingest.router)
    app.include_router(ingest_data.router)  # /ingest/record, /ingest/text
    app.include_router(entities.router)
    app.include_router(query.router)
