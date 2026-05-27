"""File upload + lifecycle."""

from __future__ import annotations

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from kb.storage import repo
from kb.storage.objects import put_raw_file

router = APIRouter(prefix="/files", tags=["files"])


class FileOut(BaseModel):
    id: str
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
    file: UploadFile = File(...),
) -> FileOut:
    blob = await file.read()
    if not blob:
        raise HTTPException(400, "empty file")
    object_key, content_hash = await put_raw_file(domain=domain, filename=file.filename or "file", blob=blob)
    row = await repo.register_file(
        domain=domain,
        filename=file.filename or "file",
        mime=file.content_type,
        size=len(blob),
        content_hash=content_hash,
        object_key=object_key,
    )
    return FileOut(**row)


@router.get("", response_model=list[FileOut])
async def list_files(domain: str | None = None) -> list[FileOut]:
    return [FileOut(**r) for r in await repo.list_files(domain=domain)]


@router.get("/{file_id}", response_model=FileOut)
async def get_file(file_id: str) -> FileOut:
    row = await repo.get_file(file_id)
    if not row:
        raise HTTPException(404, "file not found")
    return FileOut(**row)
