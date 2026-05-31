"""Cross-encoder reranker.

Hybrid retrieval gives us a candidate set ordered by RRF over dense + sparse. A
cross-encoder reads the (query, candidate) pair as a single sequence and scores
relevance directly — much more precise than separately encoding the two sides.

We default to `jinaai/jina-reranker-v2-base-multilingual` (Jul 2024), which
beats the older `ms-marco-MiniLM-L-6-v2` by ~7 NDCG points on BEIR while
still running on CPU. Overridable via `KB_RERANK_MODEL` for benchmarking
against e.g. `BAAI/bge-reranker-base` or `Xenova/ms-marco-MiniLM-L-12-v2`.

Graceful: if the model fails to load, we log once and pass through the
original ranking — retrieval still works, just less precise.
"""

from __future__ import annotations

import asyncio
import os
from functools import lru_cache

import structlog

from kb.vector.base import SearchHit

logger = structlog.get_logger("kb.query.rerank")

_disabled = False

# Sane default + env override; fastembed-supported list:
#   Xenova/ms-marco-MiniLM-L-6-v2    (old, smallest)
#   Xenova/ms-marco-MiniLM-L-12-v2
#   BAAI/bge-reranker-base
#   jinaai/jina-reranker-v1-{tiny,turbo}-en
#   jinaai/jina-reranker-v2-base-multilingual   <- our default
_DEFAULT_RERANK_MODEL = "jinaai/jina-reranker-v2-base-multilingual"


@lru_cache(maxsize=1)
def _model():
    from fastembed.rerank.cross_encoder import TextCrossEncoder

    name = os.environ.get("KB_RERANK_MODEL", _DEFAULT_RERANK_MODEL)
    logger.info("loading reranker", model=name)
    return TextCrossEncoder(model_name=name)


async def rerank(query: str, hits: list[SearchHit], *, top_k: int) -> list[SearchHit]:
    """Re-score `hits` against `query` using a cross-encoder.

    Returns the top-k hits with `.score` replaced by the cross-encoder score
    (preserving original metadata). Falls back to the original order if the
    reranker fails or is disabled.

    Batches the cross-encoder call to bound peak memory: feeding all ~40
    candidates at once spikes the activation tensor enough to OOM a 16 GB
    host on the SEC corpus. Batch size defaults to 8 and is tunable via
    KB_RERANK_BATCH_SIZE.
    """
    global _disabled
    if not hits or _disabled:
        return hits[:top_k]

    batch_size = max(1, int(os.environ.get("KB_RERANK_BATCH_SIZE", "8")))

    def _do() -> list[tuple[float, SearchHit]]:
        texts = [h.text for h in hits]
        model = _model()
        scores: list[float] = []
        for i in range(0, len(texts), batch_size):
            chunk = texts[i : i + batch_size]
            scores.extend(model.rerank(query, chunk))
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
