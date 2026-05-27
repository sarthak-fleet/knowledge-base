"""Cross-encoder reranker.

Hybrid retrieval gives us a candidate set ordered by RRF over dense + sparse. A
cross-encoder reads the (query, candidate) pair as a single sequence and scores
relevance directly — much more precise than separately encoding the two sides.

We use `BAAI/bge-reranker-base` (a small, CPU-friendly cross-encoder via
fastembed's `TextCrossEncoder`). Graceful: if the model fails to load, we log
once and pass through the original ranking.
"""

from __future__ import annotations

import asyncio
import logging
from functools import lru_cache

from kb.vector.base import SearchHit

logger = logging.getLogger("kb.query.rerank")

_disabled = False


@lru_cache(maxsize=1)
def _model():
    from fastembed.rerank.cross_encoder import TextCrossEncoder
    return TextCrossEncoder(model_name="Xenova/ms-marco-MiniLM-L-6-v2")


async def rerank(query: str, hits: list[SearchHit], *, top_k: int) -> list[SearchHit]:
    """Re-score `hits` against `query` using a cross-encoder.

    Returns the top-k hits with `.score` replaced by the cross-encoder score
    (preserving original metadata). Falls back to the original order if the
    reranker fails or is disabled.
    """
    global _disabled
    if not hits or _disabled:
        return hits[:top_k]

    def _do() -> list[tuple[float, SearchHit]]:
        texts = [h.text for h in hits]
        scores = list(_model().rerank(query, texts))
        return list(zip(scores, hits, strict=True))

    try:
        scored = await asyncio.to_thread(_do)
    except Exception as e:
        _model.cache_clear()
        _disabled = True
        logger.error("cross-encoder reranker disabled: %s", e)
        return hits[:top_k]

    scored.sort(key=lambda x: x[0], reverse=True)
    out: list[SearchHit] = []
    for score, h in scored[:top_k]:
        out.append(
            SearchHit(
                id=h.id,
                text=h.text,
                score=float(score),
                metadata={**h.metadata, "rerank_score": float(score)},
                parent_id=h.parent_id,
            )
        )
    return out
