"""Domain CRUD."""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from kb.storage import repo

router = APIRouter(prefix="/domains", tags=["domains"])


class DomainIn(BaseModel):
    name: str
    description: str | None = None


class DomainOut(BaseModel):
    name: str
    description: str | None = None
    schema_version: int | None = None


@router.get("", response_model=list[DomainOut])
async def list_domains() -> list[DomainOut]:
    rows = await repo.list_domains()
    return [DomainOut(**r) for r in rows]


@router.post("", response_model=DomainOut, status_code=201)
async def create_domain(body: DomainIn) -> DomainOut:
    row = await repo.upsert_domain(body.name, body.description)
    return DomainOut(**row)
