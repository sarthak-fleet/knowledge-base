"""File upload + lifecycle."""

from __future__ import annotations

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from kb.storage import repo
from kb.storage.objects import put_raw_file
from kb.vector.factory import get_store

router = APIRouter(prefix="/files", tags=["files"])


class FileOut(BaseModel):
    id: str
    project: str = "default"
    domain: str
    filename: str
    content_hash: str
    bytes: int
    mime: str | None
    status: str
    last_error: str | None = None


@router.post("", response_model=FileOut, status_code=201)
async def upload_file(
    domain: str = Form(...),
    project: str = Form("default"),
    file: UploadFile = File(...),
) -> FileOut:
    blob = await file.read()
    if not blob:
        raise HTTPException(400, "empty file")
    object_key, content_hash = await put_raw_file(
        domain=domain, filename=file.filename or "file", blob=blob
    )
    row = await repo.register_file(
        project=project,
        domain=domain,
        filename=file.filename or "file",
        mime=file.content_type,
        size=len(blob),
        content_hash=content_hash,
        object_key=object_key,
    )
    return FileOut(**row)


@router.get("", response_model=list[FileOut])
async def list_files(
    domain: str | None = None,
    project: str = "default",
) -> list[FileOut]:
    return [FileOut(**r) for r in await repo.list_files(domain=domain, project=project)]


@router.get("/{file_id}", response_model=FileOut)
async def get_file(file_id: str) -> FileOut:
    row = await repo.get_file(file_id)
    if not row:
        raise HTTPException(404, "file not found")
    return FileOut(**row)


@router.post("/{file_id}/reprocess")
async def reprocess_file(file_id: str, project: str = "default", force_parse: bool = False) -> dict:
    row = await repo.get_file(file_id)
    if not row or row.get("project") != project:
        raise HTTPException(404, "file not found")
    schema_id = await repo.get_active_schema_id(row["domain"], project=project)
    if not schema_id:
        raise HTTPException(400, f"no active schema for kind '{row['domain']}'")
    await get_store().delete_by_file(row["domain"], file_id)
    await repo.set_file_status(file_id, "pending")
    job = await repo.enqueue_job(
        project=project,
        domain=row["domain"],
        file_id=file_id,
        schema_id=schema_id,
        stage="parse" if force_parse else "extract",
    )
    return {
        "project": project,
        "domain": row["domain"],
        "file_id": file_id,
        "job_id": job["id"],
        "stage": "parse" if force_parse else "extract",
    }


@router.delete("/{file_id}")
async def delete_file(file_id: str, project: str = "default") -> dict:
    row = await repo.get_file(file_id)
    if not row or row.get("project") != project:
        raise HTTPException(404, "file not found")
    await get_store().delete_by_file(row["domain"], file_id)
    deleted = await repo.delete_file(file_id, project=project)
    if not deleted:
        raise HTTPException(404, "file not found")
    return {"deleted": True, "project": project, "domain": row["domain"], "file_id": file_id}
