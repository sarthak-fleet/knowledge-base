"""Raw SQL repository. Kept SQL-first; no ORM models, just dicts in/out.

This keeps the schema obvious to a reviewer and keeps row shapes flexible for
the schema-driven `fields` JSONB column.
"""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy import text

from kb.storage.db import session


# ─── Domains ──────────────────────────────────────────────────────────────
async def list_domains() -> list[dict[str, Any]]:
    async with session() as s:
        rows = (
            await s.execute(
                text(
                    """
                    SELECT d.name, d.description,
                           (SELECT MAX(version) FROM schemas s WHERE s.domain = d.name AND s.is_active) AS schema_version
                    FROM domains d
                    ORDER BY d.name
                    """
                )
            )
        ).mappings().all()
        return [dict(r) for r in rows]


async def upsert_domain(name: str, description: str | None = None) -> dict[str, Any]:
    async with session() as s:
        row = (
            await s.execute(
                text(
                    """
                    INSERT INTO domains (name, description)
                    VALUES (:name, :description)
                    ON CONFLICT (name) DO UPDATE SET
                      description = COALESCE(EXCLUDED.description, domains.description),
                      updated_at = now()
                    RETURNING name, description,
                              (SELECT MAX(version) FROM schemas s WHERE s.domain = domains.name AND s.is_active) AS schema_version
                    """
                ),
                {"name": name, "description": description},
            )
        ).mappings().one()
        await s.commit()
        return dict(row)


# ─── Schemas ──────────────────────────────────────────────────────────────
async def insert_schema_version(*, domain: str, name: str, spec: dict[str, Any]) -> dict[str, Any]:
    async with session() as s:
        next_version = (
            await s.execute(
                text("SELECT COALESCE(MAX(version), 0) + 1 AS v FROM schemas WHERE domain = :d AND name = :n"),
                {"d": domain, "n": name},
            )
        ).scalar_one()
        spec = {**spec, "version": next_version}
        await s.execute(
            text("UPDATE schemas SET is_active = FALSE WHERE domain = :d"),
            {"d": domain},
        )
        row = (
            await s.execute(
                text(
                    """
                    INSERT INTO schemas (domain, name, version, spec, is_active)
                    VALUES (:domain, :name, :version, CAST(:spec AS jsonb), TRUE)
                    RETURNING id, domain, name, version
                    """
                ),
                {"domain": domain, "name": name, "version": next_version, "spec": json.dumps(spec)},
            )
        ).mappings().one()
        await s.commit()
        return dict(row)


async def list_schemas() -> list[dict[str, Any]]:
    async with session() as s:
        rows = (
            await s.execute(
                text(
                    """
                    SELECT domain, name, version, jsonb_array_length(spec->'entities') AS entity_count
                    FROM schemas
                    WHERE is_active
                    ORDER BY domain, name
                    """
                )
            )
        ).mappings().all()
        return [dict(r) for r in rows]


async def get_active_schema(domain: str) -> dict[str, Any] | None:
    async with session() as s:
        row = (
            await s.execute(
                text("SELECT id, domain, name, version, spec FROM schemas WHERE domain = :d AND is_active LIMIT 1"),
                {"d": domain},
            )
        ).mappings().first()
        return dict(row) if row else None


async def get_active_schema_id(domain: str) -> str | None:
    async with session() as s:
        row = (
            await s.execute(
                text("SELECT id::text AS id FROM schemas WHERE domain = :d AND is_active LIMIT 1"),
                {"d": domain},
            )
        ).first()
        return row[0] if row else None


# ─── Files ────────────────────────────────────────────────────────────────
async def register_file(
    *,
    domain: str,
    filename: str,
    mime: str | None,
    size: int,
    content_hash: str,
    object_key: str,
) -> dict[str, Any]:
    async with session() as s:
        row = (
            await s.execute(
                text(
                    """
                    INSERT INTO files (domain, filename, mime, bytes, content_hash, object_key)
                    VALUES (:domain, :filename, :mime, :bytes, :content_hash, :object_key)
                    ON CONFLICT (domain, content_hash) DO UPDATE SET
                      filename = EXCLUDED.filename,
                      mime = COALESCE(EXCLUDED.mime, files.mime),
                      object_key = EXCLUDED.object_key,
                      updated_at = now()
                    RETURNING id::text, domain, filename, content_hash, bytes, mime, status, last_error
                    """
                ),
                {
                    "domain": domain,
                    "filename": filename,
                    "mime": mime,
                    "bytes": size,
                    "content_hash": content_hash,
                    "object_key": object_key,
                },
            )
        ).mappings().one()
        await s.commit()
        return dict(row)


async def list_files(domain: str | None = None) -> list[dict[str, Any]]:
    async with session() as s:
        q = "SELECT id::text, domain, filename, content_hash, bytes, mime, status, last_error FROM files"
        params: dict[str, Any] = {}
        if domain:
            q += " WHERE domain = :domain"
            params["domain"] = domain
        q += " ORDER BY uploaded_at DESC"
        rows = (await s.execute(text(q), params)).mappings().all()
        return [dict(r) for r in rows]


async def get_file(file_id: str) -> dict[str, Any] | None:
    async with session() as s:
        row = (
            await s.execute(
                text(
                    "SELECT id::text, domain, filename, content_hash, bytes, mime, status, last_error, object_key FROM files WHERE id = :id"
                ),
                {"id": file_id},
            )
        ).mappings().first()
        return dict(row) if row else None


async def set_file_status(file_id: str, status: str, *, error: str | None = None) -> None:
    async with session() as s:
        await s.execute(
            text(
                "UPDATE files SET status = :status, last_error = :err, updated_at = now() WHERE id = :id"
            ),
            {"status": status, "err": error, "id": file_id},
        )
        await s.commit()


# ─── Parse artifacts ──────────────────────────────────────────────────────
async def get_parse_artifact(content_hash: str) -> dict[str, Any] | None:
    async with session() as s:
        row = (
            await s.execute(
                text("SELECT * FROM parse_artifacts WHERE content_hash = :h"),
                {"h": content_hash},
            )
        ).mappings().first()
        return dict(row) if row else None


async def put_parse_artifact(
    *, content_hash: str, parser: str, parser_version: str | None, object_key: str, page_count: int | None
) -> None:
    async with session() as s:
        await s.execute(
            text(
                """
                INSERT INTO parse_artifacts (content_hash, parser, parser_version, object_key, page_count)
                VALUES (:h, :p, :pv, :ok, :pc)
                ON CONFLICT (content_hash) DO UPDATE SET
                  parser = EXCLUDED.parser, parser_version = EXCLUDED.parser_version,
                  object_key = EXCLUDED.object_key, page_count = EXCLUDED.page_count
                """
            ),
            {"h": content_hash, "p": parser, "pv": parser_version, "ok": object_key, "pc": page_count},
        )
        await s.commit()


# ─── Entities ─────────────────────────────────────────────────────────────
async def upsert_entity(
    *,
    domain: str,
    type: str,
    identity_key: str,
    display_name: str | None,
    fields: dict[str, Any],
    parent_id: str | None = None,
) -> dict[str, Any]:
    async with session() as s:
        row = (
            await s.execute(
                text(
                    """
                    INSERT INTO entities (domain, type, identity_key, display_name, fields, parent_id)
                    VALUES (:domain, :type, :ik, :dn, CAST(:f AS jsonb), :pid)
                    ON CONFLICT (domain, type, identity_key) DO UPDATE SET
                      display_name = COALESCE(EXCLUDED.display_name, entities.display_name),
                      fields = entities.fields || EXCLUDED.fields,
                      parent_id = COALESCE(EXCLUDED.parent_id, entities.parent_id),
                      updated_at = now()
                    RETURNING id::text, type, identity_key, display_name, parent_id::text, fields
                    """
                ),
                {
                    "domain": domain,
                    "type": type,
                    "ik": identity_key,
                    "dn": display_name,
                    "f": json.dumps(fields),
                    "pid": parent_id,
                },
            )
        ).mappings().one()
        await s.commit()
        return dict(row)


async def find_entity(domain: str, type: str, identity_key: str) -> dict[str, Any] | None:
    async with session() as s:
        row = (
            await s.execute(
                text(
                    "SELECT id::text, type, identity_key, display_name, fields, parent_id::text "
                    "FROM entities WHERE domain = :d AND type = :t AND identity_key = :k"
                ),
                {"d": domain, "t": type, "k": identity_key},
            )
        ).mappings().first()
        return dict(row) if row else None


async def list_entities(
    *, domain: str, type: str | None, q: str | None, limit: int
) -> list[dict[str, Any]]:
    sql = """
        SELECT id::text, domain, type, identity_key, display_name, fields, parent_id::text
        FROM entities
        WHERE domain = :domain
    """
    params: dict[str, Any] = {"domain": domain, "limit": limit}
    if type:
        sql += " AND type = :type"
        params["type"] = type
    if q:
        sql += " AND (display_name ILIKE :q OR identity_key ILIKE :q)"
        params["q"] = f"%{q}%"
    sql += " ORDER BY updated_at DESC LIMIT :limit"
    async with session() as s:
        rows = (await s.execute(text(sql), params)).mappings().all()
        return [dict(r) for r in rows]


async def get_entity(entity_id: str) -> dict[str, Any] | None:
    async with session() as s:
        row = (
            await s.execute(
                text(
                    "SELECT id::text, domain, type, identity_key, display_name, fields, parent_id::text "
                    "FROM entities WHERE id = :id"
                ),
                {"id": entity_id},
            )
        ).mappings().first()
        return dict(row) if row else None


async def get_entity_lineage(entity_id: str) -> dict[str, Any]:
    """Recursive parent walk + child counts + mention list."""
    async with session() as s:
        ancestors = (
            await s.execute(
                text(
                    """
                    WITH RECURSIVE anc(id, type, display_name, parent_id, depth) AS (
                      SELECT id, type, display_name, parent_id, 0 FROM entities WHERE id = :id
                      UNION ALL
                      SELECT e.id, e.type, e.display_name, e.parent_id, anc.depth + 1
                      FROM entities e JOIN anc ON e.id = anc.parent_id
                    )
                    SELECT id::text, type, display_name, depth FROM anc ORDER BY depth DESC
                    """
                ),
                {"id": entity_id},
            )
        ).mappings().all()
        children = (
            await s.execute(
                text(
                    "SELECT id::text, type, display_name FROM entities WHERE parent_id = :id ORDER BY type, display_name"
                ),
                {"id": entity_id},
            )
        ).mappings().all()
        mentions = (
            await s.execute(
                text(
                    """
                    SELECT m.file_id::text, f.filename, m.confidence, m.field_values
                    FROM entity_mentions m JOIN files f ON f.id = m.file_id
                    WHERE m.entity_id = :id
                    ORDER BY m.created_at DESC
                    """
                ),
                {"id": entity_id},
            )
        ).mappings().all()
        return {
            "ancestors": [dict(r) for r in ancestors],
            "children": [dict(r) for r in children],
            "mentions": [dict(r) for r in mentions],
        }


async def get_entity_relationships(entity_id: str) -> list[dict[str, Any]]:
    async with session() as s:
        rows = (
            await s.execute(
                text(
                    """
                    SELECT id::text, rel_type,
                           src_id::text, dst_id::text,
                           (SELECT display_name FROM entities WHERE id = src_id) AS src_name,
                           (SELECT display_name FROM entities WHERE id = dst_id) AS dst_name
                    FROM entity_relationships
                    WHERE src_id = :id OR dst_id = :id
                    ORDER BY created_at DESC
                    """
                ),
                {"id": entity_id},
            )
        ).mappings().all()
        return [dict(r) for r in rows]


async def insert_mention(
    *,
    entity_id: str,
    file_id: str,
    schema_id: str,
    field_values: dict[str, Any],
    confidence: float,
) -> None:
    async with session() as s:
        await s.execute(
            text(
                """
                INSERT INTO entity_mentions (entity_id, file_id, schema_id, field_values, confidence)
                VALUES (:e, :f, :s, CAST(:fv AS jsonb), :c)
                ON CONFLICT (entity_id, file_id, schema_id) DO UPDATE SET
                  field_values = EXCLUDED.field_values, confidence = EXCLUDED.confidence
                """
            ),
            {"e": entity_id, "f": file_id, "s": schema_id, "fv": json.dumps(field_values), "c": confidence},
        )
        await s.commit()


async def insert_provenance(
    *,
    file_id: str,
    entity_id: str | None,
    field: str | None,
    page_start: int,
    page_end: int,
    element_id: str | None,
    excerpt: str,
    bbox: list[float] | None = None,
) -> None:
    async with session() as s:
        await s.execute(
            text(
                """
                INSERT INTO provenance_spans (file_id, entity_id, field, page_start, page_end, element_id, excerpt, bbox)
                VALUES (:fid, :eid, :field, :ps, :pe, :el, :ex, :bb)
                """
            ),
            {
                "fid": file_id,
                "eid": entity_id,
                "field": field,
                "ps": page_start,
                "pe": page_end,
                "el": element_id,
                "ex": excerpt,
                "bb": bbox,
            },
        )
        await s.commit()


async def insert_relationship(
    *, domain: str, rel_type: str, src_id: str, dst_id: str, file_id: str | None, page: int | None
) -> None:
    async with session() as s:
        await s.execute(
            text(
                """
                INSERT INTO entity_relationships (domain, rel_type, src_id, dst_id, evidence_file, evidence_page)
                VALUES (:d, :rt, :s, :ds, :f, :p)
                ON CONFLICT (domain, rel_type, src_id, dst_id) DO NOTHING
                """
            ),
            {"d": domain, "rt": rel_type, "s": src_id, "ds": dst_id, "f": file_id, "p": page},
        )
        await s.commit()


# ─── Jobs ─────────────────────────────────────────────────────────────────
async def enqueue_job(
    *, domain: str, file_id: str, schema_id: str | None, stage: str = "parse"
) -> dict[str, Any]:
    async with session() as s:
        row = (
            await s.execute(
                text(
                    """
                    INSERT INTO ingest_jobs (domain, file_id, schema_id, stage, status)
                    VALUES (:d, :f, :s, :stage, 'queued')
                    ON CONFLICT (file_id, schema_id) DO UPDATE SET
                      stage = EXCLUDED.stage, status = 'queued', attempts = 0,
                      last_error = NULL, updated_at = now()
                    RETURNING id::text
                    """
                ),
                {"d": domain, "f": file_id, "s": schema_id, "stage": stage},
            )
        ).mappings().one()
        await s.commit()
        return dict(row)


async def claim_next_job(worker_id: str) -> dict[str, Any] | None:
    async with session() as s:
        row = (
            await s.execute(
                text(
                    """
                    WITH next_job AS (
                      SELECT id FROM ingest_jobs
                      WHERE status = 'queued'
                      ORDER BY updated_at
                      FOR UPDATE SKIP LOCKED
                      LIMIT 1
                    )
                    UPDATE ingest_jobs j
                    SET status = 'running', locked_by = :w, locked_at = now(),
                        attempts = j.attempts + 1, updated_at = now()
                    FROM next_job
                    WHERE j.id = next_job.id
                    RETURNING j.id::text, j.domain, j.file_id::text, j.schema_id::text, j.stage, j.attempts
                    """
                ),
                {"w": worker_id},
            )
        ).mappings().first()
        await s.commit()
        return dict(row) if row else None


async def mark_job(job_id: str, *, status: str, stage: str | None = None, error: str | None = None) -> None:
    async with session() as s:
        await s.execute(
            text(
                """
                UPDATE ingest_jobs
                SET status = :st,
                    stage = COALESCE(:stg, stage),
                    last_error = :err,
                    updated_at = now()
                WHERE id = :id
                """
            ),
            {"st": status, "stg": stage, "err": error, "id": job_id},
        )
        await s.commit()


async def list_jobs(*, domain: str | None, status: str | None) -> list[dict[str, Any]]:
    sql = "SELECT id::text, domain, file_id::text, stage, status, attempts, last_error, updated_at FROM ingest_jobs"
    params: dict[str, Any] = {}
    conds: list[str] = []
    if domain:
        conds.append("domain = :d")
        params["d"] = domain
    if status:
        conds.append("status = :s")
        params["s"] = status
    if conds:
        sql += " WHERE " + " AND ".join(conds)
    sql += " ORDER BY updated_at DESC LIMIT 200"
    async with session() as s:
        rows = (await s.execute(text(sql), params)).mappings().all()
        return [dict(r) for r in rows]


async def get_job(job_id: str) -> dict[str, Any] | None:
    async with session() as s:
        row = (
            await s.execute(
                text(
                    "SELECT id::text, domain, file_id::text, schema_id::text, stage, status, attempts, last_error, "
                    "locked_by, locked_at, created_at, updated_at FROM ingest_jobs WHERE id = :id"
                ),
                {"id": job_id},
            )
        ).mappings().first()
        return dict(row) if row else None


# ─── Sessions + traces ────────────────────────────────────────────────────
async def get_or_create_session(session_id: str | None, domain: str) -> dict[str, Any]:
    async with session() as s:
        if session_id:
            row = (
                await s.execute(
                    text("SELECT id::text, history FROM sessions WHERE id = :id"),
                    {"id": session_id},
                )
            ).mappings().first()
            if row:
                return dict(row)
        row = (
            await s.execute(
                text(
                    "INSERT INTO sessions (domain) VALUES (:d) RETURNING id::text, history"
                ),
                {"d": domain},
            )
        ).mappings().one()
        await s.commit()
        return dict(row)


async def append_session_turn(session_id: str, turn: dict[str, Any]) -> None:
    async with session() as s:
        await s.execute(
            text(
                "UPDATE sessions SET history = history || CAST(:t AS jsonb), updated_at = now() WHERE id = :id"
            ),
            {"id": session_id, "t": json.dumps([turn])},
        )
        await s.commit()


async def get_query_trace(trace_id: str) -> dict[str, Any] | None:
    async with session() as s:
        row = (
            await s.execute(
                text(
                    "SELECT id::text, domain, question, scope, filters, retrieved, answer, citations, confidence, latency_ms, created_at "
                    "FROM query_traces WHERE id = :id"
                ),
                {"id": trace_id},
            )
        ).mappings().first()
        return dict(row) if row else None


async def list_query_traces(*, domain: str | None, limit: int = 50) -> list[dict[str, Any]]:
    sql = "SELECT id::text, domain, question, latency_ms, created_at FROM query_traces"
    params: dict[str, Any] = {"limit": limit}
    if domain:
        sql += " WHERE domain = :d"
        params["d"] = domain
    sql += " ORDER BY created_at DESC LIMIT :limit"
    async with session() as s:
        rows = (await s.execute(text(sql), params)).mappings().all()
        return [dict(r) for r in rows]


async def insert_query_trace(trace: dict[str, Any]) -> str:
    async with session() as s:
        row = (
            await s.execute(
                text(
                    """
                    INSERT INTO query_traces (domain, question, scope, filters, retrieved, answer, citations, confidence, latency_ms)
                    VALUES (:d, :q, CAST(:sc AS jsonb), CAST(:f AS jsonb), CAST(:r AS jsonb), :a, CAST(:c AS jsonb), CAST(:cf AS jsonb), :lat)
                    RETURNING id::text
                    """
                ),
                {
                    "d": trace["domain"],
                    "q": trace["question"],
                    "sc": json.dumps(trace.get("scope") or {}),
                    "f": json.dumps(trace.get("filters") or {}),
                    "r": json.dumps(trace.get("retrieved") or []),
                    "a": trace.get("answer", ""),
                    "c": json.dumps(trace.get("citations") or []),
                    "cf": json.dumps(trace.get("confidence") or {}),
                    "lat": trace.get("latency_ms"),
                },
            )
        ).mappings().one()
        await s.commit()
        return row["id"]
