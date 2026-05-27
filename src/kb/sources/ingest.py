"""Pump a Source into the KB: register file → enqueue ingest."""

from __future__ import annotations

import logging

import httpx

from kb.sources.base import Source

logger = logging.getLogger("kb.sources.ingest")


async def ingest_source(*, api_base: str, domain: str, source: Source) -> list[dict]:
    """For every doc yielded by `source`, POST it to the KB API and return the file rows."""
    out: list[dict] = []
    async with httpx.AsyncClient(timeout=180) as client:
        async for d in source.fetch():
            try:
                r = await client.post(
                    f"{api_base}/files",
                    data={"domain": domain},
                    files={"file": (d.filename, d.bytes_, d.mime or "application/octet-stream")},
                )
                r.raise_for_status()
                out.append(r.json())
                logger.info("ingested %s (%d bytes)", d.filename, len(d.bytes_))
            except Exception as e:
                logger.exception("failed to ingest %s: %s", d.filename, e)
        # Kick the worker
        try:
            await client.post(f"{api_base}/ingest/run", json={"domain": domain})
        except Exception:
            logger.exception("ingest/run failed")
    return out
