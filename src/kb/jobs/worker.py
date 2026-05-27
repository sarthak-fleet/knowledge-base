"""Asyncio worker — N concurrent tasks claiming jobs via SKIP LOCKED.

Run with `python -m kb.jobs.worker`. Concurrency from KB_WORKER_CONCURRENCY.
"""

from __future__ import annotations

import asyncio
import os
import signal
import socket
import uuid

import structlog

from kb.config import get_settings
from kb.storage import repo
from kb.storage.db import init_engine

logger = structlog.get_logger("kb.jobs.worker")
_running = True


async def _worker_loop(worker_id: str, idle_sleep: float) -> None:
    from kb.jobs.runner import run_job

    while _running:
        job = await repo.claim_next_job(worker_id)
        if job is None:
            await asyncio.sleep(idle_sleep)
            continue
        logger.info("worker %s claimed job %s file=%s stage=%s", worker_id, job["id"], job["file_id"], job["stage"])
        try:
            await run_job(job)
        except Exception:
            logger.exception("worker %s unexpected error on job %s", worker_id, job["id"])


async def _main() -> None:
    from kb.observability import configure_logging
    configure_logging()
    settings = get_settings()
    await init_engine(settings.postgres_dsn)
    hostname = socket.gethostname()
    n = settings.worker_concurrency
    logger.info("starting %d worker tasks on %s (vector_store=%s)", n, hostname, settings.vector_store)

    loop = asyncio.get_event_loop()

    def _stop() -> None:
        global _running
        _running = False
        logger.info("shutdown signal received")

    # Graceful shutdown:
    # - Unix: asyncio's `add_signal_handler` integrates SIGINT/SIGTERM into
    #   the event loop.
    # - Windows: `add_signal_handler` raises NotImplementedError. We fall back
    #   to plain `signal.signal`, which fires from the main thread and flips
    #   `_running`; the worker loop polls it. Docker on Linux is the prod
    #   target, so this Windows path is for local dev only.
    # (Grok Issue 11: previously the Windows fallback was silently a no-op.)
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _stop)
        except NotImplementedError:
            signal.signal(sig, lambda *_: _stop())

    tasks = [
        asyncio.create_task(_worker_loop(worker_id=f"{hostname}-{os.getpid()}-{i}-{uuid.uuid4().hex[:4]}", idle_sleep=2.0))
        for i in range(n)
    ]
    await asyncio.gather(*tasks)


if __name__ == "__main__":
    from kb.observability import install_uvloop
    install_uvloop()  # must run before asyncio.run
    asyncio.run(_main())
