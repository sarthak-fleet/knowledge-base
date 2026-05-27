"""Enqueue ingest jobs for files in a domain."""

from __future__ import annotations

from kb.storage import repo


async def enqueue_files(*, domain: str, file_ids: list[str] | None, force: bool) -> int:
    schema_id = await repo.get_active_schema_id(domain)
    files = await repo.list_files(domain=domain)
    if file_ids is not None:
        wanted = set(file_ids)
        files = [f for f in files if f["id"] in wanted]
    n = 0
    for f in files:
        if not force and f["status"] in ("ready",):
            continue
        await repo.enqueue_job(domain=domain, file_id=f["id"], schema_id=schema_id, stage="parse")
        n += 1
    return n


async def enqueue_all(*, domain: str) -> int:
    return await enqueue_files(domain=domain, file_ids=None, force=False)
