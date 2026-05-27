"""Schema migration: re-run schema-driven extraction against existing files
when a new schema version is applied — WITHOUT re-parsing.

The parse cache (keyed by content_hash) is preserved across schema changes,
which is exactly the seam the PRD calls out. This module:

  1. Iterates ready files in the domain.
  2. Re-enqueues each as a fresh ingest_job tagged with the NEW schema_id.
  3. The worker re-runs extract → resolve → index, hitting the parse cache,
     so OCR / layout detection is NOT repeated.
"""

from __future__ import annotations

import logging

from kb.storage import repo

logger = logging.getLogger("kb.schema.migrate")


async def reindex_domain_with_schema(*, domain: str, schema_id: str) -> int:
    """Enqueue every ready file in `domain` for re-extraction under `schema_id`.

    Returns the number of jobs enqueued.
    """
    files = await repo.list_files(domain=domain)
    enq = 0
    for f in files:
        # Skip files that have never reached `ready` — they'll be re-attempted normally
        if f.get("status") not in ("ready", "failed"):
            continue
        await repo.enqueue_job(
            domain=domain,
            file_id=f["id"],
            schema_id=schema_id,
            stage="extract",  # skip parse: cache will be hit
        )
        enq += 1
    logger.info("schema migrate: enqueued %d files for domain %s under schema %s", enq, domain, schema_id)
    return enq
