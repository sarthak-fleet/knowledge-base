"""Ingest job control."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from kb.jobs import enqueue
from kb.storage import repo

router = APIRouter(prefix="/ingest", tags=["ingest"])


class RunIn(BaseModel):
    domain: str
    file_ids: list[str] | None = None  # None = all pending in domain
    force: bool = False  # re-run even if already indexed


class RunOut(BaseModel):
    enqueued: int


@router.post("/run", response_model=RunOut)
async def run(body: RunIn) -> RunOut:
    n = await enqueue.enqueue_files(domain=body.domain, file_ids=body.file_ids, force=body.force)
    return RunOut(enqueued=n)


@router.get("/jobs")
async def list_jobs(domain: str | None = None, status: str | None = None) -> list[dict]:
    return await repo.list_jobs(domain=domain, status=status)


@router.get("/jobs/{job_id}")
async def get_job(job_id: str) -> dict:
    row = await repo.get_job(job_id)
    if not row:
        raise HTTPException(404, "job not found")
    return row
