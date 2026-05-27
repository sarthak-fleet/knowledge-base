"""Schema CRUD + versioning."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from kb.schema.loader import apply_schema_dict, get_active_schema, list_schemas

router = APIRouter(prefix="/schemas", tags=["schemas"])


class SchemaIn(BaseModel):
    domain: str
    name: str
    spec: dict  # raw schema YAML deserialized


class SchemaSummary(BaseModel):
    domain: str
    name: str
    version: int
    entity_count: int


@router.get("", response_model=list[SchemaSummary])
async def list_all() -> list[SchemaSummary]:
    return [SchemaSummary(**r) for r in await list_schemas()]


@router.get("/{domain}/active")
async def active(domain: str) -> dict:
    sch = await get_active_schema(domain)
    if not sch:
        raise HTTPException(404, f"No active schema for domain '{domain}'")
    return sch


@router.post("", status_code=201)
async def apply_schema(body: SchemaIn) -> dict:
    out = await apply_schema_dict(domain=body.domain, name=body.name, spec=body.spec)
    return {"domain": out.domain, "name": out.name, "version": out.version}
