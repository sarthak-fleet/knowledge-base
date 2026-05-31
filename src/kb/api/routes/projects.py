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


@router.get("", response_model=list[ProjectSummary])
async def list_all() -> list[ProjectSummary]:
    return [ProjectSummary(**r) for r in await repo.list_projects()]


@router.post("", status_code=201, response_model=ProjectSummary)
async def create(body: ProjectIn) -> ProjectSummary:
    row = await repo.upsert_project(body.name, body.description)
    return ProjectSummary(name=row["name"], description=row.get("description", ""))
