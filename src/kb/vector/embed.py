"""Local dense + sparse embeddings via fastembed (no API calls).

Both functions degrade gracefully: if a model fails to load (download interrupted,
missing weights), we log once and return empty vectors so the rest of the pipeline
keeps moving. Indexing without sparse becomes dense-only; retrieval falls back to
dense-only fusion (still hybrid-style via RRF among dense ranks, just degraded).
"""

from __future__ import annotations

import asyncio
from functools import lru_cache

import structlog
from cachetools import LRUCache

from kb.config import get_settings

logger = structlog.get_logger("kb.vector.embed")

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


# Single-query memoisation: the engine re-embeds the same query text across
# the intent, retrieve, rerank, and span_cite stages. This is a process-wide
# request-local cache. `cachetools.LRUCache` replaces a hand-rolled FIFO
# (Grok Issue 9): proper LRU semantics rather than insertion-order eviction.
_query_cache: LRUCache[str, list[float]] = LRUCache(maxsize=256)
_query_cache_lock = asyncio.Lock()


async def embed_query_cached(text: str) -> list[float]:
    """Embed a single query text, with a process-wide LRU cache keyed by text."""
    if text in _query_cache:
        return _query_cache[text]
    async with _query_cache_lock:
        if text in _query_cache:
            return _query_cache[text]
        vec = (await embed_dense([text]))[0]
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
