"""Project CRUD — the top-level namespace introduced in migration 05.

A `project` is a workspace holding multiple kinds (each with its own schema).
Today's defaults: every existing single-namespace install runs under the
auto-seeded `default` project.
"""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from kb.storage import repo

router = APIRouter(prefix="/projects", tags=["projects"])


class ProjectIn(BaseModel):
    name: str
    description: str = ""


class ProjectSummary(BaseModel):
    name: str
    description: str = ""
    kind_count: int = 0
    file_count: int = 0


class CorpusStatus(BaseModel):
    domain: str
    state: str
    has_schema: bool = False
    draft_count: int = 0
    file_count: int = 0
    ready_files: int = 0
    failed_files: int = 0
    staged_files: int = 0
    active_files: int = 0
    active_jobs: int = 0
    failed_jobs: int = 0


@router.get("", response_model=list[ProjectSummary])
async def list_all() -> list[ProjectSummary]:
    return [ProjectSummary(**r) for r in await repo.list_projects()]


@router.get("/{project}/status", response_model=list[CorpusStatus])
async def status(project: str) -> list[CorpusStatus]:
    return [CorpusStatus(**r) for r in await repo.corpus_status(project=project)]


@router.post("", status_code=201, response_model=ProjectSummary)
async def create(body: ProjectIn) -> ProjectSummary:
    row = await repo.upsert_project(body.name, body.description)
    return ProjectSummary(name=row["name"], description=row.get("description", ""))
