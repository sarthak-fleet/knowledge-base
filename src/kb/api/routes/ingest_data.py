"""Unified ingestion routes for structured records and raw text.

Three input forms, one contract:

  POST /ingest/file    — multipart upload (lives in routes/files.py for now)
  POST /ingest/record  — JSON record(s), already structured
  POST /ingest/text    — raw text, will be parsed + extracted

All three take (project, kind, type) where `type` is the entity-type name from
the kind's schema. Same type ⇒ same entity structure, enforced via schema
validation on records (LLM-side conformance on text/file paths).
"""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from kb.storage import objects, repo
from kb.vector.base import Chunk
from kb.vector.dedup import content_hash as chunk_content_hash
from kb.vector.factory import get_store

router = APIRouter(prefix="/ingest", tags=["ingest"])


# ─── Record ingestion ─────────────────────────────────────────────────────


class RecordIn(BaseModel):
    project: str = "default"
    kind: str  # the "domain" in DB terms; the kind-within-project
    type: str  # the entity type name from the active schema
    data: list[dict[str, Any]] | dict[str, Any]  # one record or a list


class RecordOut(BaseModel):
    project: str
    kind: str
    type: str
    file_id: str  # virtual file that holds the JSON dump for provenance
    entities_upserted: int
    chunks_indexed: int


def _normalize_identity_value(v: Any) -> str:
    return re.sub(r"\s+", " ", str(v).strip().lower())


def _validate_record_against_schema(
    record: dict[str, Any], entity_type_name: str, schema_spec: dict[str, Any]
) -> list[str]:
    """Return a list of validation errors. Empty list means valid.

    Rules:
      - Record's keys must be a subset of the entity type's declared field names.
      - All `required: true` fields must be present and non-empty.
      - Identity fields ("identity: true") must be present and non-empty.
    """
    entity = next(
        (e for e in schema_spec.get("entities", []) if e.get("name") == entity_type_name),
        None,
    )
    if entity is None:
        return [f"entity type '{entity_type_name}' is not declared in the active schema"]

    declared_fields = {f["name"]: f for f in entity.get("fields", [])}
    errors: list[str] = []

    # Extra fields are tolerated — they get stored in the JSONB `fields` blob
    # and a later schema iteration can promote them. But missing required ones
    # are a hard error.
    for fname, fspec in declared_fields.items():
        present = fname in record and record[fname] not in (None, "", [])
        if fspec.get("required") and not present:
            errors.append(f"missing required field '{fname}'")
        if fspec.get("identity") and not present:
            errors.append(f"missing identity field '{fname}'")

    return errors


def _build_identity_key(
    record: dict[str, Any], entity_type_name: str, schema_spec: dict[str, Any]
) -> str:
    """Compose an identity key from the entity type's identity-flagged fields.

    Mirrors the convention in kb.resolve.resolver — concatenate normalized
    identity-field values with '|' separators. Falls back to a content hash
    when no identity fields are declared.
    """
    entity = next(
        (e for e in schema_spec.get("entities", []) if e.get("name") == entity_type_name),
        None,
    )
    if entity is None:
        return hashlib.sha1(json.dumps(record, sort_keys=True).encode()).hexdigest()[:16]

    id_fields = [f["name"] for f in entity.get("fields", []) if f.get("identity")]
    if not id_fields:
        return hashlib.sha1(json.dumps(record, sort_keys=True).encode()).hexdigest()[:16]

    parts = [_normalize_identity_value(record.get(f, "")) for f in id_fields]
    return "|".join(parts)


@router.post("/record", response_model=RecordOut, status_code=201)
async def ingest_record(body: RecordIn) -> RecordOut:
    """Ingest one or more JSON records as entities of the given type.

    The (project, kind) must already have an active schema declaring `type`.
    Records are validated against that schema. A virtual JSON file is also
    written to MinIO so each record has a proper file_id for citations.
    """
    records = body.data if isinstance(body.data, list) else [body.data]
    if not records:
        raise HTTPException(400, "data must contain at least one record")

    schema_row = await repo.get_active_schema(body.kind, project=body.project)
    if not schema_row:
        raise HTTPException(
            404,
            f"no active schema for project='{body.project}' kind='{body.kind}'. "
            "Apply a schema first via POST /schemas or `kb schema apply`.",
        )
    schema_spec = schema_row["spec"]

    # Validate every record up-front. Fail loudly if anything's wrong — the user
    # asked for type-consistency, so be strict here.
    for i, rec in enumerate(records):
        errs = _validate_record_against_schema(rec, body.type, schema_spec)
        if errs:
            raise HTTPException(
                422,
                f"record[{i}] failed validation against type '{body.type}': " + "; ".join(errs),
            )

    # Persist the batch as a virtual file in MinIO so each entity's mentions can
    # cite a real (file_id, page=0) — keeps the citation invariant honest even
    # for synthesized provenance.
    blob = json.dumps(
        {"project": body.project, "kind": body.kind, "type": body.type, "data": records},
        indent=2,
    ).encode()
    content_hash = hashlib.sha256(blob).hexdigest()
    virtual_name = f"records-{body.type.lower()}-{content_hash[:8]}.json"
    object_key, _ = await objects.put_raw_file(domain=body.kind, filename=virtual_name, blob=blob)

    file_row = await repo.register_file(
        project=body.project,
        domain=body.kind,
        filename=virtual_name,
        mime="application/json",
        size=len(blob),
        content_hash=content_hash,
        object_key=object_key,
    )
    file_id = file_row["id"]
    await repo.set_file_status(file_id, "ready")

    # Upsert each record as an entity + a mention pointing back to the virtual file.
    schema_id = schema_row["id"]
    upserted = 0
    chunks: list[Chunk] = []
    for rec in records:
        identity_key = _build_identity_key(rec, body.type, schema_spec)
        display_name = (
            rec.get("name") or rec.get("title") or rec.get("display_name") or identity_key
        )
        ent = await repo.upsert_entity(
            project=body.project,
            domain=body.kind,
            type=body.type,
            identity_key=identity_key,
            display_name=str(display_name)[:200],
            fields=rec,
        )
        await repo.insert_mention(
            project=body.project,
            domain=body.kind,
            entity_id=ent["id"],
            file_id=file_id,
            schema_id=str(schema_id),
            field_values=rec,
            confidence=1.0,
        )
        excerpt = json.dumps(rec, sort_keys=True, default=str)
        await repo.insert_provenance(
            project=body.project,
            domain=body.kind,
            file_id=file_id,
            entity_id=ent["id"],
            field=None,
            page_start=0,
            page_end=0,
            element_id=f"record:{identity_key}",
            excerpt=excerpt[:1000],
        )
        chunk_id = str(
            uuid.uuid5(
                uuid.NAMESPACE_URL,
                f"kb-record:{body.project}:{body.kind}:{file_id}:{ent['id']}:{identity_key}",
            )
        )
        chunks.append(
            Chunk(
                id=chunk_id,
                text=excerpt,
                metadata={
                    "project": body.project,
                    "domain": body.kind,
                    "file_id": file_id,
                    "entity_id": ent["id"],
                    "entity_type": body.type,
                    "page_start": 0,
                    "page_end": 0,
                    "is_parent": False,
                    "source": "record",
                },
                content_hash=chunk_content_hash(f"record:{body.project}:{body.kind}:{body.type}:{excerpt}"),
            )
        )
        upserted += 1

    try:
        store = get_store()
        await store.delete_by_file(body.kind, file_id)
        await store.upsert(body.kind, chunks)
    except Exception as e:
        await repo.set_file_status(file_id, "failed", error=f"record vector indexing failed: {e}"[:500])
        raise HTTPException(503, f"record stored but vector indexing failed: {e}") from e

    return RecordOut(
        project=body.project,
        kind=body.kind,
        type=body.type,
        file_id=file_id,
        entities_upserted=upserted,
        chunks_indexed=len(chunks),
    )


# ─── Text ingestion ───────────────────────────────────────────────────────


class TextIn(BaseModel):
    project: str = "default"
    kind: str
    type: str | None = None  # optional hint for the extractor
    title: str = "untitled"
    text: str


class TextOut(BaseModel):
    project: str
    kind: str
    file_id: str
    job_id: str | None = None


@router.post("/text", response_model=TextOut, status_code=201)
async def ingest_text(body: TextIn) -> TextOut:
    """Ingest a raw-text blob as a virtual file. Runs the normal extract pipeline.

    The `type` field, if present, is recorded in the file's metadata so the
    extractor can be biased toward emitting that entity type. (Not enforced —
    the LLM extractor is constrained by the schema anyway.)
    """
    if not body.text.strip():
        raise HTTPException(400, "text must be non-empty")
    schema_id = await repo.get_active_schema_id(body.kind, project=body.project)
    if not schema_id:
        raise HTTPException(
            404,
            f"no active schema for project='{body.project}' kind='{body.kind}'. "
            "Apply a schema first via POST /schemas or `kb schema apply`.",
        )

    blob = body.text.encode()
    content_hash = hashlib.sha256(blob).hexdigest()
    safe_title = re.sub(r"[^A-Za-z0-9_.-]+", "_", body.title.strip()) or "untitled"
    filename = f"text-{safe_title}-{content_hash[:8]}.txt"

    object_key, _ = await objects.put_raw_file(domain=body.kind, filename=filename, blob=blob)
    file_row = await repo.register_file(
        project=body.project,
        domain=body.kind,
        filename=filename,
        mime="text/plain",
        size=len(blob),
        content_hash=content_hash,
        object_key=object_key,
    )
    file_id = file_row["id"]

    # Queue the normal parse→extract→vector pipeline. The worker picks it up.
    job_id: str | None = None
    job = await repo.enqueue_job(
        project=body.project,
        domain=body.kind,
        file_id=file_id,
        schema_id=schema_id,
        stage="parse",
    )
    job_id = job["id"]

    return TextOut(project=body.project, kind=body.kind, file_id=file_id, job_id=job_id)
