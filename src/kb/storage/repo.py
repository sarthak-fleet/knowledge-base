"""Raw SQL repository. Kept SQL-first; no ORM models, just dicts in/out.

This keeps the schema obvious to a reviewer and keeps row shapes flexible for
the schema-driven `fields` JSONB column.

`project` is the new top-level namespace introduced in migration 05. Every
function takes `project: str = "default"` so legacy callers (single-namespace
installs that pre-date the project concept) keep working unchanged. The
existing `domain` parameter now represents "kind within a project".
"""

from __future__ import annotations

import json
from typing import Any

from sqlalchemy import text

from kb.storage.db import session


# ─── Projects ─────────────────────────────────────────────────────────────
async def list_projects() -> list[dict[str, Any]]:
    async with session() as s:
        rows = (
            (
                await s.execute(
                    text(
                        """
                        SELECT p.name, p.description,
                               (SELECT COUNT(DISTINCT domain) FROM schemas WHERE project = p.name) AS kind_count,
                               (SELECT COUNT(*) FROM files WHERE project = p.name) AS file_count
                          FROM projects p
                         ORDER BY p.name
                        """
                    )
                )
            )
            .mappings()
            .all()
        )
        return [dict(r) for r in rows]


async def upsert_project(name: str, description: str | None = None) -> dict[str, Any]:
    async with session() as s:
        row = (
            (
                await s.execute(
                    text(
                        """
                        INSERT INTO projects (name, description)
                        VALUES (:name, COALESCE(:description, ''))
                        ON CONFLICT (name) DO UPDATE SET
                          description = COALESCE(EXCLUDED.description, projects.description),
                          updated_at = now()
                        RETURNING name, description
                        """
                    ),
                    {"name": name, "description": description},
                )
            )
            .mappings()
            .one()
        )
        await s.commit()
        return dict(row)


# ─── Domains (= "kinds" within a project) ─────────────────────────────────
async def list_domains(project: str = "default") -> list[dict[str, Any]]:
    async with session() as s:
        rows = (
            (
                await s.execute(
                    text(
                        """
                        SELECT d.name, d.project, d.description,
                               (SELECT MAX(version) FROM schemas s
                                 WHERE s.domain = d.name AND s.project = d.project AND s.is_active
                               ) AS schema_version
                          FROM domains d
                         WHERE d.project = :project
                         ORDER BY d.name
                        """
                    ),
                    {"project": project},
                )
            )
            .mappings()
            .all()
        )
        return [dict(r) for r in rows]


async def upsert_domain(
    name: str, description: str | None = None, project: str = "default"
) -> dict[str, Any]:
    async with session() as s:
        # Ensure project exists (auto-create non-default ones on first use).
        if project != "default":
            await s.execute(
                text("INSERT INTO projects (name) VALUES (:p) ON CONFLICT (name) DO NOTHING"),
                {"p": project},
            )
        row = (
            (
                await s.execute(
                    text(
                        """
                        INSERT INTO domains (name, description, project)
                        VALUES (:name, :description, :project)
                        ON CONFLICT (name) DO UPDATE SET
                          description = COALESCE(EXCLUDED.description, domains.description),
                          project = EXCLUDED.project,
                          updated_at = now()
                        RETURNING name, project, description,
                                  (SELECT MAX(version) FROM schemas s
                                    WHERE s.domain = domains.name AND s.project = domains.project AND s.is_active
                                  ) AS schema_version
                        """
                    ),
                    {"name": name, "description": description, "project": project},
                )
            )
            .mappings()
            .one()
        )
        await s.commit()
        return dict(row)


# ─── Schemas ──────────────────────────────────────────────────────────────
async def insert_schema_version(
    *, domain: str, name: str, spec: dict[str, Any], project: str = "default"
) -> dict[str, Any]:
    async with session() as s:
        next_version = (
            await s.execute(
                text(
                    "SELECT COALESCE(MAX(version), 0) + 1 AS v FROM schemas "
                    "WHERE project = :p AND domain = :d AND name = :n"
                ),
                {"p": project, "d": domain, "n": name},
            )
        ).scalar_one()
        spec = {**spec, "version": next_version}
        await s.execute(
            text("UPDATE schemas SET is_active = FALSE WHERE project = :p AND domain = :d"),
            {"p": project, "d": domain},
        )
        row = (
            (
                await s.execute(
                    text(
                        """
                        INSERT INTO schemas (project, domain, name, version, spec, is_active)
                        VALUES (:project, :domain, :name, :version, CAST(:spec AS jsonb), TRUE)
                        RETURNING id, project, domain, name, version
                        """
                    ),
                    {
                        "project": project,
                        "domain": domain,
                        "name": name,
                        "version": next_version,
                        "spec": json.dumps(spec),
                    },
                )
            )
            .mappings()
            .one()
        )
        await s.commit()
        return dict(row)


async def list_schemas(project: str = "default") -> list[dict[str, Any]]:
    async with session() as s:
        rows = (
            (
                await s.execute(
                    text(
                        """
                        SELECT project, domain, name, version,
                               jsonb_array_length(spec->'entities') AS entity_count
                          FROM schemas
                         WHERE is_active AND project = :project
                         ORDER BY domain, name
                        """
                    ),
                    {"project": project},
                )
            )
            .mappings()
            .all()
        )
        return [dict(r) for r in rows]


async def get_active_schema(domain: str, project: str = "default") -> dict[str, Any] | None:
    async with session() as s:
        row = (
            (
                await s.execute(
                    text(
                        "SELECT id, project, domain, name, version, spec FROM schemas "
                        "WHERE project = :p AND domain = :d AND is_active LIMIT 1"
                    ),
                    {"p": project, "d": domain},
                )
            )
            .mappings()
            .first()
        )
        return dict(row) if row else None


async def get_active_schema_id(domain: str, project: str = "default") -> str | None:
    async with session() as s:
        row = (
            await s.execute(
                text(
                    "SELECT id::text AS id FROM schemas "
                    "WHERE project = :p AND domain = :d AND is_active LIMIT 1"
                ),
                {"p": project, "d": domain},
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
    project: str = "default",
) -> dict[str, Any]:
    async with session() as s:
        row = (
            (
                await s.execute(
                    text(
                        """
                        INSERT INTO files (project, domain, filename, mime, bytes, content_hash, object_key)
                        VALUES (:project, :domain, :filename, :mime, :bytes, :content_hash, :object_key)
                        ON CONFLICT (domain, content_hash) DO UPDATE SET
                          filename = EXCLUDED.filename,
                          mime = COALESCE(EXCLUDED.mime, files.mime),
                          object_key = EXCLUDED.object_key,
                          project = EXCLUDED.project,
                          updated_at = now()
                        RETURNING id::text, project, domain, filename, content_hash, bytes, mime, status, last_error
                        """
                    ),
                    {
                        "project": project,
                        "domain": domain,
                        "filename": filename,
                        "mime": mime,
                        "bytes": size,
                        "content_hash": content_hash,
                        "object_key": object_key,
                    },
                )
            )
            .mappings()
            .one()
        )
        await s.commit()
        return dict(row)


async def list_files(
    domain: str | None = None,
    project: str = "default",
    kinds: list[str] | None = None,
) -> list[dict[str, Any]]:
    sql = (
        "SELECT id::text, project, domain, filename, content_hash, bytes, mime, status, last_error "
        "FROM files WHERE project = :project"
    )
    params: dict[str, Any] = {"project": project}
    if domain:
        sql += " AND domain = :domain"
        params["domain"] = domain
    elif kinds:
        sql += " AND domain = ANY(:kinds)"
        params["kinds"] = kinds
    sql += " ORDER BY uploaded_at DESC"
    async with session() as s:
        rows = (await s.execute(text(sql), params)).mappings().all()
        return [dict(r) for r in rows]


async def get_file(file_id: str) -> dict[str, Any] | None:
    async with session() as s:
        row = (
            (
                await s.execute(
                    text(
                        "SELECT id::text, project, domain, filename, content_hash, bytes, mime, status, "
                        "last_error, object_key FROM files WHERE id = :id"
                    ),
                    {"id": file_id},
                )
            )
            .mappings()
            .first()
        )
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
            (
                await s.execute(
                    text("SELECT * FROM parse_artifacts WHERE content_hash = :h"),
                    {"h": content_hash},
                )
            )
            .mappings()
            .first()
        )
        return dict(row) if row else None


async def put_parse_artifact(
    *,
    content_hash: str,
    parser: str,
    parser_version: str | None,
    object_key: str,
    page_count: int | None,
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
            {
                "h": content_hash,
                "p": parser,
                "pv": parser_version,
                "ok": object_key,
                "pc": page_count,
            },
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
    project: str = "default",
) -> dict[str, Any]:
    async with session() as s:
        row = (
            (
                await s.execute(
                    text(
                        """
                        INSERT INTO entities (project, domain, type, identity_key, display_name, fields, parent_id)
                        VALUES (:project, :domain, :type, :ik, :dn, CAST(:f AS jsonb), :pid)
                        ON CONFLICT (domain, type, identity_key) DO UPDATE SET
                          display_name = COALESCE(EXCLUDED.display_name, entities.display_name),
                          fields = entities.fields || EXCLUDED.fields,
                          parent_id = COALESCE(EXCLUDED.parent_id, entities.parent_id),
                          project = EXCLUDED.project,
                          updated_at = now()
                        RETURNING id::text, project, type, identity_key, display_name, parent_id::text, fields
                        """
                    ),
                    {
                        "project": project,
                        "domain": domain,
                        "type": type,
                        "ik": identity_key,
                        "dn": display_name,
                        "f": json.dumps(fields),
                        "pid": parent_id,
                    },
                )
            )
            .mappings()
            .one()
        )
        await s.commit()
        return dict(row)


async def find_entity(
    domain: str, type: str, identity_key: str, project: str = "default"
) -> dict[str, Any] | None:
    async with session() as s:
        row = (
            (
                await s.execute(
                    text(
                        "SELECT id::text, project, type, identity_key, display_name, fields, parent_id::text "
                        "FROM entities WHERE project = :p AND domain = :d AND type = :t AND identity_key = :k"
                    ),
                    {"p": project, "d": domain, "t": type, "k": identity_key},
                )
            )
            .mappings()
            .first()
        )
        return dict(row) if row else None


async def list_entities(
    *,
    domain: str | None,
    type: str | None,
    q: str | None,
    limit: int,
    project: str = "default",
    kinds: list[str] | None = None,
) -> list[dict[str, Any]]:
    sql = """
        SELECT id::text, project, domain, type, identity_key, display_name, fields, parent_id::text
        FROM entities
        WHERE project = :project
    """
    params: dict[str, Any] = {"project": project, "limit": limit}
    if domain:
        sql += " AND domain = :domain"
        params["domain"] = domain
    elif kinds:
        sql += " AND domain = ANY(:kinds)"
        params["kinds"] = kinds
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
            (
                await s.execute(
                    text(
                        "SELECT id::text, project, domain, type, identity_key, display_name, fields, parent_id::text "
                        "FROM entities WHERE id = :id"
                    ),
                    {"id": entity_id},
                )
            )
            .mappings()
            .first()
        )
        return dict(row) if row else None


async def get_entity_lineage(entity_id: str) -> dict[str, Any]:
    """Recursive parent walk + child counts + mention list."""
    async with session() as s:
        ancestors = (
            (
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
            )
            .mappings()
            .all()
        )
        children = (
            (
                await s.execute(
                    text(
                        "SELECT id::text, type, display_name FROM entities WHERE parent_id = :id ORDER BY type, display_name"
                    ),
                    {"id": entity_id},
                )
            )
            .mappings()
            .all()
        )
        mentions = (
            (
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
            )
            .mappings()
            .all()
        )
        return {
            "ancestors": [dict(r) for r in ancestors],
            "children": [dict(r) for r in children],
            "mentions": [dict(r) for r in mentions],
        }


async def get_entity_relationships(entity_id: str) -> list[dict[str, Any]]:
    async with session() as s:
        rows = (
            (
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
            )
            .mappings()
            .all()
        )
        return [dict(r) for r in rows]


async def insert_mention(
    *,
    entity_id: str,
    file_id: str,
    schema_id: str,
    field_values: dict[str, Any],
    confidence: float,
    project: str = "default",
    domain: str = "",
) -> None:
    async with session() as s:
        await s.execute(
            text(
                """
                INSERT INTO entity_mentions (project, domain, entity_id, file_id, schema_id, field_values, confidence)
                VALUES (:project, :domain, :e, :f, :s, CAST(:fv AS jsonb), :c)
                ON CONFLICT (entity_id, file_id, schema_id) DO UPDATE SET
                  field_values = EXCLUDED.field_values, confidence = EXCLUDED.confidence
                """
            ),
            {
                "project": project,
                "domain": domain,
                "e": entity_id,
                "f": file_id,
                "s": schema_id,
                "fv": json.dumps(field_values),
                "c": confidence,
            },
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
    project: str = "default",
    domain: str = "",
) -> None:
    async with session() as s:
        await s.execute(
            text(
                """
                INSERT INTO provenance_spans (project, domain, file_id, entity_id, field, page_start, page_end, element_id, excerpt, bbox)
                VALUES (:project, :domain, :fid, :eid, :field, :ps, :pe, :el, :ex, :bb)
                """
            ),
            {
                "project": project,
                "domain": domain,
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
    *,
    domain: str,
    rel_type: str,
    src_id: str,
    dst_id: str,
    file_id: str | None,
    page: int | None,
    project: str = "default",
) -> None:
    async with session() as s:
        await s.execute(
            text(
                """
                INSERT INTO entity_relationships (project, domain, rel_type, src_id, dst_id, evidence_file, evidence_page)
                VALUES (:project, :d, :rt, :s, :ds, :f, :p)
                ON CONFLICT (domain, rel_type, src_id, dst_id) DO NOTHING
                """
            ),
            {
                "project": project,
                "d": domain,
                "rt": rel_type,
                "s": src_id,
                "ds": dst_id,
                "f": file_id,
                "p": page,
            },
        )
        await s.commit()


# ─── Jobs ─────────────────────────────────────────────────────────────────
async def enqueue_job(
    *,
    domain: str,
    file_id: str,
    schema_id: str | None,
    stage: str = "parse",
    project: str = "default",
) -> dict[str, Any]:
    async with session() as s:
        row = (
            (
                await s.execute(
                    text(
                        """
                    INSERT INTO ingest_jobs (project, domain, file_id, schema_id, stage, status)
                    VALUES (:project, :d, :f, :s, :stage, 'queued')
                    ON CONFLICT (file_id, schema_id) DO UPDATE SET
                      stage = EXCLUDED.stage, status = 'queued', attempts = 0,
                      project = EXCLUDED.project,
                      last_error = NULL, updated_at = now()
                    RETURNING id::text
                    """
                    ),
                    {
                        "project": project,
                        "d": domain,
                        "f": file_id,
                        "s": schema_id,
                        "stage": stage,
                    },
                )
            )
            .mappings()
            .one()
        )
        await s.commit()
        return dict(row)


async def claim_next_job(worker_id: str) -> dict[str, Any] | None:
    async with session() as s:
        row = (
            (
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
                    RETURNING j.id::text, j.project, j.domain, j.file_id::text, j.schema_id::text, j.stage, j.attempts
                    """
                    ),
                    {"w": worker_id},
                )
            )
            .mappings()
            .first()
        )
        await s.commit()
        return dict(row) if row else None


async def mark_job(
    job_id: str, *, status: str, stage: str | None = None, error: str | None = None
) -> None:
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


async def list_jobs(
    *,
    domain: str | None,
    status: str | None,
    project: str = "default",
) -> list[dict[str, Any]]:
    sql = (
        "SELECT id::text, project, domain, file_id::text, stage, status, attempts, last_error, updated_at "
        "FROM ingest_jobs WHERE project = :project"
    )
    params: dict[str, Any] = {"project": project}
    if domain:
        sql += " AND domain = :d"
        params["d"] = domain
    if status:
        sql += " AND status = :s"
        params["s"] = status
    sql += " ORDER BY updated_at DESC LIMIT 200"
    async with session() as s:
        rows = (await s.execute(text(sql), params)).mappings().all()
        return [dict(r) for r in rows]


async def get_job(job_id: str) -> dict[str, Any] | None:
    async with session() as s:
        row = (
            (
                await s.execute(
                    text(
                        "SELECT id::text, project, domain, file_id::text, schema_id::text, stage, status, "
                        "attempts, last_error, locked_by, locked_at, created_at, updated_at "
                        "FROM ingest_jobs WHERE id = :id"
                    ),
                    {"id": job_id},
                )
            )
            .mappings()
            .first()
        )
        return dict(row) if row else None


# ─── Sessions + traces ────────────────────────────────────────────────────
async def get_or_create_session(session_id: str | None, domain: str) -> dict[str, Any]:
    async with session() as s:
        if session_id:
            row = (
                (
                    await s.execute(
                        text("SELECT id::text, history FROM sessions WHERE id = :id"),
                        {"id": session_id},
                    )
                )
                .mappings()
                .first()
            )
            if row:
                return dict(row)
        row = (
            (
                await s.execute(
                    text("INSERT INTO sessions (domain) VALUES (:d) RETURNING id::text, history"),
                    {"d": domain},
                )
            )
            .mappings()
            .one()
        )
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
            (
                await s.execute(
                    text(
                        "SELECT id::text, project, domain, question, scope, filters, retrieved, "
                        "answer, citations, confidence, latency_ms, created_at "
                        "FROM query_traces WHERE id = :id"
                    ),
                    {"id": trace_id},
                )
            )
            .mappings()
            .first()
        )
        return dict(row) if row else None


async def list_query_traces(
    *, domain: str | None, limit: int = 50, project: str = "default"
) -> list[dict[str, Any]]:
    sql = (
        "SELECT id::text, project, domain, question, latency_ms, created_at "
        "FROM query_traces WHERE project = :project"
    )
    params: dict[str, Any] = {"project": project, "limit": limit}
    if domain:
        sql += " AND domain = :d"
        params["d"] = domain
    sql += " ORDER BY created_at DESC LIMIT :limit"
    async with session() as s:
        rows = (await s.execute(text(sql), params)).mappings().all()
        return [dict(r) for r in rows]


async def insert_query_trace(trace: dict[str, Any]) -> str:
    async with session() as s:
        row = (
            (
                await s.execute(
                    text(
                        """
                    INSERT INTO query_traces (project, domain, question, scope, filters, retrieved, answer, citations, confidence, latency_ms)
                    VALUES (:project, :d, :q, CAST(:sc AS jsonb), CAST(:f AS jsonb), CAST(:r AS jsonb), :a, CAST(:c AS jsonb), CAST(:cf AS jsonb), :lat)
                    RETURNING id::text
                    """
                    ),
                    {
                        "project": trace.get("project", "default"),
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
            )
            .mappings()
            .one()
        )
        await s.commit()
        return row["id"]
