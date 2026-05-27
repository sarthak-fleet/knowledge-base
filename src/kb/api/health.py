"""Dependency probes used by /readyz."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from sqlalchemy import text

from kb.config import get_settings
from kb.storage.db import session
from kb.storage.objects import _get_backend
from kb.vector.factory import get_store

logger = logging.getLogger("kb.api.health")


async def _probe_db() -> dict[str, Any]:
    try:
        async with session() as s:
            await s.execute(text("SELECT 1"))
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)[:200]}


async def _probe_vector() -> dict[str, Any]:
    try:
        store = get_store()
        # Touching the store without a collection still exercises the connection
        await store.ensure_collection("_healthz")
        return {"ok": True, "backend": get_settings().vector_store}
    except Exception as e:
        return {"ok": False, "backend": get_settings().vector_store, "error": str(e)[:200]}


async def _probe_object() -> dict[str, Any]:
    """Round-trip a tiny object, then delete it.

    Grok Issue 10: the prior probe wrote `_healthz/probe.txt` on every check
    and never deleted, slowly littering the bucket. We now delete after the
    exists() check; failure to delete is non-fatal (probe still reports ok).
    """
    try:
        backend = _get_backend()
        key = "_healthz/probe.txt"
        await backend.put(key, b"ok", mime="text/plain")
        ok = await backend.exists(key)
        try:
            await backend.delete(key)
        except Exception:
            # Cleanup is best-effort. A stale probe object isn't a probe failure.
            pass
        return {"ok": ok, "backend": get_settings().object_store}
    except Exception as e:
        return {"ok": False, "backend": get_settings().object_store, "error": str(e)[:200]}


async def probe() -> dict[str, Any]:
    db, vec, obj = await asyncio.gather(_probe_db(), _probe_vector(), _probe_object())
    ok = db["ok"] and vec["ok"] and obj["ok"]
    return {"status": "ok" if ok else "degraded", "db": db, "vector": vec, "object": obj}
