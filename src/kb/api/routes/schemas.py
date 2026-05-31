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
    project: str = "default"


class SchemaSummary(BaseModel):
    project: str = "default"
    domain: str
    name: str
    version: int
    entity_count: int


@router.get("", response_model=list[SchemaSummary])
async def list_all(project: str = "default") -> list[SchemaSummary]:
    return [SchemaSummary(**r) for r in await list_schemas(project=project)]


@router.get("/{domain}/active")
async def active(domain: str, project: str = "default") -> dict:
    sch = await get_active_schema(domain, project=project)
    if not sch:
        raise HTTPException(404, f"No active schema for domain '{domain}' in project '{project}'")
    return sch


@router.post("", status_code=201)
async def apply_schema(body: SchemaIn) -> dict:
    out = await apply_schema_dict(
        domain=body.domain, name=body.name, spec=body.spec, project=body.project
    )
    return {"project": body.project, "domain": out.domain, "name": out.name, "version": out.version}
