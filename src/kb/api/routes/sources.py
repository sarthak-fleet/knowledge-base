"""Source connector import endpoints."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from kb.jobs.enqueue import enqueue_files
from kb.sources.registry import build_source, sources
from kb.storage import repo
from kb.storage.objects import put_raw_file

router = APIRouter(prefix="/sources", tags=["sources"])


class SourceImportIn(BaseModel):
    project: str = "default"
    domain: str
    source: str
    config: dict[str, Any] = Field(default_factory=dict)
    auto_ingest: bool = True


@router.get("")
async def list_sources() -> dict[str, list[str]]:
    return {"sources": sources()}


@router.post("/import")
async def import_source(body: SourceImportIn) -> dict[str, Any]:
    try:
        source = build_source(body.source, **body.config)
    except KeyError as e:
        raise HTTPException(400, str(e)) from e

    files: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    try:
        async for doc in source.fetch():
            object_key, content_hash = await put_raw_file(
                domain=body.domain,
                filename=doc.filename,
                blob=doc.bytes_,
            )
            row = await repo.register_file(
                project=body.project,
                domain=body.domain,
                filename=doc.filename,
                mime=doc.mime,
                size=len(doc.bytes_),
                content_hash=content_hash,
                object_key=object_key,
            )
            files.append(row)
    except Exception as e:
        errors.append({"filename": body.source, "error": str(e)[:500]})

    enqueued = 0
    if body.auto_ingest and files:
        enqueued = await enqueue_files(
            project=body.project,
            domain=body.domain,
            file_ids=[f["id"] for f in files],
            force=True,
        )

    return {
        "project": body.project,
        "domain": body.domain,
        "source": body.source,
        "files": files,
        "file_count": len(files),
        "enqueued": enqueued,
        "errors": errors,
    }
