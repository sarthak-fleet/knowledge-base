"""Local dense + sparse embeddings via fastembed (no API calls).

Both functions degrade gracefully: if a model fails to load (download interrupted,
missing weights), we log once and return empty vectors so the rest of the pipeline
keeps moving. Indexing without sparse becomes dense-only; retrieval falls back to
dense-only fusion (still hybrid-style via RRF among dense ranks, just degraded).
"""

from __future__ import annotations

import asyncio
import logging
from functools import lru_cache

from kb.config import get_settings

logger = logging.getLogger("kb.vector.embed")

_sparse_disabled = False


@lru_cache(maxsize=1)
def _dense():
    from fastembed import TextEmbedding
    s = get_settings()
    return TextEmbedding(model_name=s.embed_model)


@lru_cache(maxsize=1)
def _sparse():
    from fastembed import SparseTextEmbedding
    s = get_settings()
    return SparseTextEmbedding(model_name=s.sparse_model)


async def embed_dense(texts: list[str]) -> list[list[float]]:
    def _do() -> list[list[float]]:
        return [list(map(float, v)) for v in _dense().embed(texts)]
    return await asyncio.to_thread(_do)


# Single-query memoisation: the engine re-embeds the same query text in
# intent, retrieve, rerank, and span_cite stages. This is a request-local cache.
_query_cache: dict[str, list[float]] = {}
_query_cache_lock = asyncio.Lock()


async def embed_query_cached(text: str) -> list[float]:
    """Embed a single query text, with a process-wide cache keyed by text.

    Saves 3-4 redundant embedding calls per /query. Cache is bounded by simple
    FIFO eviction at 256 entries.
    """
    if text in _query_cache:
        return _query_cache[text]
    async with _query_cache_lock:
        if text in _query_cache:
            return _query_cache[text]
        vec = (await embed_dense([text]))[0]
        if len(_query_cache) >= 256:
            # Drop the oldest entry (Python dicts preserve insertion order).
            _query_cache.pop(next(iter(_query_cache)))
        _query_cache[text] = vec
        return vec


async def embed_sparse(texts: list[str]) -> list[dict[str, list]]:
    global _sparse_disabled
    if _sparse_disabled:
        return [{"indices": [], "values": []} for _ in texts]

    def _do() -> list[dict[str, list]]:
        out = []
        for sv in _sparse().embed(texts):
            out.append({"indices": list(map(int, sv.indices)), "values": list(map(float, sv.values))})
        return out

    try:
        return await asyncio.to_thread(_do)
    except Exception as e:
        # Wipe the sparse-model lru cache so a later retry can re-init,
        # but flip the disable flag for this process so we don't keep crashing.
        _sparse.cache_clear()
        _sparse_disabled = True
        logger.error("sparse embedding disabled for this process: %s", e)
        return [{"indices": [], "values": []} for _ in texts]
