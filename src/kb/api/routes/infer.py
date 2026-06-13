"""Schema inference endpoint — propose a schema from uploaded files."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from kb.config import pipeline
from kb.parse import Element, parse_file
from kb.schema.infer import collect_samples_from_domain, infer_schema
from kb.storage import repo
from kb.storage.objects import put_raw_file

router = APIRouter(prefix="/schemas", tags=["schemas"])


class InferIn(BaseModel):
    project: str = "default"
    domain: str
    sample_texts: list[str] | None = None  # if None, sample from chunks table
    sample_count: int = 12
    save_draft: bool = True


def _sample_texts_from_elements(
    elements: list[Element], *, sample_count: int, max_chars: int = 2400
) -> list[str]:
    samples: list[str] = []
    current: list[str] = []
    current_chars = 0
    for el in elements:
        text = " ".join((el.text or "").split())
        if not text:
            continue
        if current and current_chars + len(text) > max_chars:
            samples.append("\n".join(current))
            if len(samples) >= sample_count:
                return samples
            current = []
            current_chars = 0
        current.append(text)
        current_chars += len(text)
    if current and len(samples) < sample_count:
        samples.append("\n".join(current))
    return samples


@router.post("/infer", summary="Propose a domain schema from sample text chunks")
async def infer(body: InferIn) -> dict:
    samples = body.sample_texts
    if not samples:
        samples = await collect_samples_from_domain(
            body.domain, n=body.sample_count, project=body.project
        )
    if not samples:
        raise HTTPException(400, "no samples available — upload files first or pass sample_texts")
    schema = await infer_schema(domain_hint=body.domain, samples=samples)
    draft = None
    if body.save_draft:
        draft = await repo.save_schema_draft(
            project=body.project,
            domain=schema.domain,
            name=schema.name,
            spec=schema.model_dump(),
            source="sample_text",
            sample_count=len(samples),
        )
    return {
        "domain": schema.domain,
        "name": schema.name,
        "project": body.project,
        "spec": schema.model_dump(),
        "sample_count": len(samples),
        "draft_id": draft["id"] if draft else None,
        "note": "Review + edit, then POST to /schemas to commit.",
    }


@router.post(
    "/infer/files",
    summary="Propose a schema from uploaded representative files",
)
async def infer_from_files(
    domain: str = Form(...),
    project: str = Form("default"),
    sample_count: int = Form(12),
    stage_files: bool = Form(True),
    save_draft: bool = Form(True),
    files: list[UploadFile] = File(...),
) -> dict:
    """Infer a schema from raw docs before a schema exists.

    Files are optionally staged as normal pending files under the requested
    project/kind. Once the user confirms the returned schema, `/ingest/run` can
    process those same files without requiring a second upload.
    """
    if not files:
        raise HTTPException(400, "at least one file is required")

    cfg = pipeline.pipeline_config(domain)
    parse_config = cfg.get("parse") if isinstance(cfg.get("parse"), dict) else None
    staged: list[dict[str, Any]] = []
    samples: list[str] = []
    errors: list[dict[str, str]] = []

    for upload in files:
        filename = upload.filename or "file"
        try:
            blob = await upload.read()
            if not blob:
                raise ValueError("empty file")
            object_key, content_hash = await put_raw_file(
                domain=domain,
                filename=filename,
                blob=blob,
            )
            row: dict[str, Any] | None = None
            if stage_files:
                await repo.upsert_domain(domain, project=project)
                row = await repo.register_file(
                    project=project,
                    domain=domain,
                    filename=filename,
                    mime=upload.content_type,
                    size=len(blob),
                    content_hash=content_hash,
                    object_key=object_key,
                )
                staged.append(row)
            elements = await parse_file(
                file_id=(row or {}).get("id") or f"infer-{content_hash[:12]}",
                content_hash=content_hash,
                object_key=object_key,
                filename=filename,
                mime=upload.content_type,
                parse_config=parse_config,
            )
            remaining = max(sample_count - len(samples), 0)
            if remaining:
                samples.extend(_sample_texts_from_elements(elements, sample_count=remaining))
        except Exception as e:
            errors.append({"filename": filename, "error": str(e)})

    if not samples:
        raise HTTPException(
            400,
            {
                "message": "no text could be parsed from uploaded files",
                "errors": errors,
            },
        )

    schema = await infer_schema(domain_hint=domain, samples=samples[:sample_count])
    draft = None
    if save_draft:
        draft = await repo.save_schema_draft(
            project=project,
            domain=schema.domain,
            name=schema.name,
            spec=schema.model_dump(),
            source="sample_files",
            sample_count=len(samples[:sample_count]),
            staged_file_ids=[str(f["id"]) for f in staged if f.get("id")],
            errors=errors,
        )
    return {
        "domain": schema.domain,
        "name": schema.name,
        "project": project,
        "spec": schema.model_dump(),
        "sample_count": len(samples[:sample_count]),
        "draft_id": draft["id"] if draft else None,
        "staged_files": staged,
        "errors": errors,
        "note": "Review + edit, then POST to /schemas to commit. If files were staged, POST /ingest/run after commit.",
    }
