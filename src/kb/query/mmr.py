"""Maximal Marginal Relevance reranking.

After the cross-encoder gives us a candidate set ordered by relevance, MMR
re-picks K with a diversity penalty: each successive pick is the one that
maximises `lambda * relevance - (1 - lambda) * max_similarity_to_already_picked`.

This is what collapses near-duplicate chunks (boilerplate, repeated paragraphs)
in the answer's source list — exactly the gap that chunk-level dedup at ingest
*cannot* close, because near-duplicates with slight wording variations still
end up as distinct chunks.
"""

from __future__ import annotations

import logging
from typing import Any

from kb.vector.base import SearchHit
from kb.vector.embed import embed_dense

logger = logging.getLogger("kb.query.mmr")


def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b:
        return 0.0
    dot = sum(x * y for x, y in zip(a, b, strict=False))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(y * y for y in b) ** 0.5
    return 0.0 if na == 0 or nb == 0 else dot / (na * nb)


async def mmr_rerank(
    candidates: list[SearchHit],
    *,
    query: str,
    top_k: int,
    lambda_: float = 0.7,
) -> list[SearchHit]:
    """Pure-Python MMR over already-relevance-scored candidates.

    `candidates` should be ordered by relevance (cross-encoder score).
    Returns up to `top_k` picks with maximum diversity vs. the running set.
    Graceful: if embedding fails, returns the head of the input untouched.
    """
    if not candidates or top_k <= 0:
        return []
    if len(candidates) <= top_k:
        return candidates

    texts = [c.text for c in candidates]
    try:
        # Embed candidates only (query similarity is the existing relevance score)
        embs = await embed_dense(texts)
    except Exception as e:
        logger.warning("MMR embedding failed (%s); passing through head", e)
        return candidates[:top_k]

    # Relevance: normalize cross-encoder scores to [0, 1] for stable lambda mixing.
    raw_scores = [c.score for c in candidates]
    lo, hi = min(raw_scores), max(raw_scores)
    span = max(hi - lo, 1e-9)
    rel = [(s - lo) / span for s in raw_scores]

    picked: list[int] = []
    remaining: set[int] = set(range(len(candidates)))

    # Always seed with the most relevant chunk.
    seed = max(remaining, key=lambda i: rel[i])
    picked.append(seed)
    remaining.remove(seed)

    while len(picked) < top_k and remaining:
        best_i = -1
        best_score = float("-inf")
        for i in remaining:
            max_sim = max(_cosine(embs[i], embs[j]) for j in picked)
            mmr = lambda_ * rel[i] - (1.0 - lambda_) * max_sim
            if mmr > best_score:
                best_score = mmr
                best_i = i
        if best_i < 0:
            break
        picked.append(best_i)
        remaining.remove(best_i)

    return [candidates[i] for i in picked]


def consolidate_sources(hits: list[SearchHit]) -> dict[str, Any]:
    """Collect every (file_id, also_in_files) pair across all retrieved hits.

    Returns a mapping `chunk_id → list[file_id]` that synthesis can use to
    expand citations beyond the primary source.
    """
    out: dict[str, list[str]] = {}
    for h in hits:
        files: list[str] = []
        primary = h.metadata.get("file_id")
        if primary:
            files.append(primary)
        for extra in h.metadata.get("also_in_files") or []:
            if extra and extra not in files:
                files.append(extra)
        out[h.id] = files
    return out
