"""Stage runner: parse → extract → resolve → index. Idempotent at every stage."""

from __future__ import annotations

import logging

from kb.extract import extract_for_file
from kb.resolve import resolve_extraction
from kb.storage import repo
from kb.vector.indexer import index_extraction

logger = logging.getLogger("kb.jobs.runner")


async def run_job(job: dict) -> None:
    """Execute one full ingest job for a single file."""
    file_id: str = job["file_id"]
    domain: str = job["domain"]
    job_id: str = job["id"]

    try:
        await repo.set_file_status(file_id, "parsing")
        await repo.mark_job(job_id, status="running", stage="parse")

        # parse is implicitly invoked inside extract_for_file (cache-aware).
        await repo.mark_job(job_id, status="running", stage="extract")
        await repo.set_file_status(file_id, "extracting")
        extraction = await extract_for_file(file_id=file_id, domain=domain)

        await repo.mark_job(job_id, status="running", stage="resolve")
        await repo.set_file_status(file_id, "resolving")
        resolved = await resolve_extraction(extraction)

        await repo.mark_job(job_id, status="running", stage="index")
        await repo.set_file_status(file_id, "indexing")
        await index_extraction(extraction, resolved.get("parent_index", {}))

        await repo.set_file_status(file_id, "ready")
        await repo.mark_job(job_id, status="done", stage="done")
        logger.info("job %s complete for file %s", job_id, file_id)
    except Exception as e:
        logger.exception("job %s failed for file %s", job_id, file_id)
        await repo.set_file_status(file_id, "failed", error=str(e)[:500])
        await repo.mark_job(job_id, status="failed", error=str(e)[:500])
