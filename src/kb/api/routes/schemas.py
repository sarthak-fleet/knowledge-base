"""Schema CRUD + versioning."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from kb.schema.loader import apply_schema_dict, get_active_schema, list_schemas
from kb.schema.migrate import reindex_domain_with_schema
from kb.storage import repo

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


class ReprocessIn(BaseModel):
    project: str = "default"
    file_ids: list[str] | None = None


class SchemaDraftOut(BaseModel):
    id: str
    project: str = "default"
    domain: str
    name: str
    spec: dict
    source: str
    sample_count: int = 0
    staged_file_ids: list[str] = Field(default_factory=list)
    errors: list[dict] = Field(default_factory=list)
    status: str


class ApplyDraftIn(BaseModel):
    project: str = "default"
    spec: dict | None = None
    ingest_staged_files: bool = True


class DraftProjectIn(BaseModel):
    project: str = "default"


@router.get("", response_model=list[SchemaSummary])
async def list_all(project: str = "default") -> list[SchemaSummary]:
    return [SchemaSummary(**r) for r in await list_schemas(project=project)]


@router.get("/drafts", response_model=list[SchemaDraftOut])
async def list_drafts(
    project: str = "default",
    domain: str | None = None,
    status: str | None = "pending",
) -> list[SchemaDraftOut]:
    return [
        SchemaDraftOut(**r)
        for r in await repo.list_schema_drafts(project=project, domain=domain, status=status)
    ]


@router.get("/drafts/{draft_id}", response_model=SchemaDraftOut)
async def get_draft(draft_id: str, project: str = "default") -> SchemaDraftOut:
    row = await repo.get_schema_draft(draft_id, project=project)
    if not row:
        raise HTTPException(404, "schema draft not found")
    return SchemaDraftOut(**row)


@router.post("/drafts/{draft_id}/apply")
async def apply_draft(draft_id: str, body: ApplyDraftIn | None = None) -> dict:
    body = body or ApplyDraftIn()
    draft = await repo.get_schema_draft(draft_id, project=body.project)
    if not draft:
        raise HTTPException(404, "schema draft not found")
    if draft["status"] != "pending":
        raise HTTPException(400, f"schema draft is {draft['status']}, not pending")

    spec = body.spec or draft["spec"]
    domain = str(spec.get("domain") or draft["domain"])
    name = str(spec.get("name") or draft["name"])
    out = await apply_schema_dict(domain=domain, name=name, spec=spec, project=body.project)
    marked = await repo.update_schema_draft_status(draft_id, project=body.project, status="applied")
    enqueued = 0
    if body.ingest_staged_files and draft.get("staged_file_ids"):
        from kb.jobs.enqueue import enqueue_files

        enqueued = await enqueue_files(
            project=body.project,
            domain=domain,
            file_ids=draft["staged_file_ids"],
            force=False,
        )
    return {
        "project": body.project,
        "domain": out.domain,
        "name": out.name,
        "version": out.version,
        "draft_id": draft_id,
        "draft_status": (marked or {}).get("status", "applied"),
        "enqueued": enqueued,
    }


@router.post("/drafts/{draft_id}/discard")
async def discard_draft(draft_id: str, body: DraftProjectIn | None = None) -> dict:
    body = body or DraftProjectIn()
    row = await repo.update_schema_draft_status(draft_id, project=body.project, status="discarded")
    if not row:
        raise HTTPException(404, "schema draft not found")
    return row


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


@router.post("/{domain}/reprocess")
async def reprocess_for_active_schema(domain: str, body: ReprocessIn | None = None) -> dict:
    body = body or ReprocessIn()
    sch = await get_active_schema(domain, project=body.project)
    if not sch:
        raise HTTPException(
            404, f"No active schema for domain '{domain}' in project '{body.project}'"
        )
    enqueued = await reindex_domain_with_schema(
        project=body.project,
        domain=domain,
        schema_id=str(sch["id"]),
        file_ids=body.file_ids,
    )
    return {
        "project": body.project,
        "domain": domain,
        "schema_id": str(sch["id"]),
        "schema_version": sch["version"],
        "enqueued": enqueued,
        "stage": "extract",
    }
