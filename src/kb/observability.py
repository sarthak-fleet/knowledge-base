"""Centralised observability setup: structlog config + (later) tracing hooks.

The goal of using `structlog` instead of stdlib `logging` directly:

1. **Structured fields**: `logger.info("query_done", domain="sec", latency_ms=234)`
   ships as JSON in prod, gets rendered as a readable line in a TTY.
2. **Contextvar binding**: `structlog.contextvars.bind_contextvars(request_id=...)`
   threads request-level metadata through every downstream log without
   plumbing it through function signatures.
3. **stdlib compatibility**: existing `logger.info("msg %s", arg)` call sites
   keep working — we use `structlog.stdlib.BoundLogger` and the wrap-for-formatter
   processor chain.

Call `configure_logging()` once at process startup (FastAPI lifespan + worker
`_main()`).
"""

from __future__ import annotations

import logging
import os
import sys

import structlog


def install_uvloop() -> None:
    """Use uvloop as the asyncio event loop on Unix. ~10-20% faster than
    stdlib `asyncio` for IO-heavy workloads (which is exactly us — Postgres,
    Qdrant, LLM gateway, all I/O bound). No-op on Windows.

    Call once at process startup, BEFORE any `asyncio.run(...)` call.
    """
    try:
        import uvloop
        uvloop.install()
    except (ImportError, RuntimeError):
        # ImportError on Windows; RuntimeError if the loop is already running.
        pass


def configure_logging(level: str | None = None) -> None:
    """Configure stdlib logging + structlog with a sensible processor chain.

    JSON rendering when stdout is not a TTY (containers, CI, prod), pretty
    console rendering otherwise.
    """
    log_level_str = (level or os.environ.get("KB_LOG_LEVEL") or "info").upper()
    log_level = getattr(logging, log_level_str, logging.INFO)

    # Shared processors run on both stdlib logs and structlog-native logs.
    shared_processors: list = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        structlog.stdlib.add_logger_name,
        structlog.processors.TimeStamper(fmt="iso", utc=True),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
    ]

    if sys.stdout.isatty():
        # Local dev: human-friendly console output.
        renderer: structlog.types.Processor = structlog.dev.ConsoleRenderer()
    else:
        # Prod / container / CI: JSON-line output for log shippers.
        renderer = structlog.processors.JSONRenderer()

    # Configure structlog itself.
    structlog.configure(
        processors=[
            *shared_processors,
            structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
        ],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )

    # Route stdlib logs (uvicorn, sqlalchemy, etc.) through the same renderer.
    formatter = structlog.stdlib.ProcessorFormatter(
        foreign_pre_chain=shared_processors,
        processors=[
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            renderer,
        ],
    )
    handler = logging.StreamHandler()
    handler.setFormatter(formatter)

    root = logging.getLogger()
    # Replace any pre-existing handlers so we don't double-log.
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(log_level)

    # Quiet down a couple of noisy libraries that don't add signal.
    for noisy in ("uvicorn.access", "httpx", "httpcore"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def get_logger(name: str | None = None) -> structlog.stdlib.BoundLogger:
    """Module-level logger factory. Drop-in replacement for `logging.getLogger`."""
    return structlog.get_logger(name)
