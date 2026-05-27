"""Span-level citations: narrow a chunk's text to the most relevant sentence(s).

The PRD asks citations to be "file → page → exact excerpt". Our retrieved chunks
are ~500–2000 chars; the *exact* span supporting a claim is usually a sentence
or two within. We pick the best span via dense cosine to the query.
"""

from __future__ import annotations

import re

import structlog

from kb.vector.embed import embed_dense

logger = structlog.get_logger("kb.query.spans")

# Sentence splitter: prefer NLTK-style boundaries but keep it dependency-free.
_SENT = re.compile(r"(?<=[\.\!\?])\s+(?=[A-Z\(])")


def _sentences(text: str) -> list[str]:
    parts = [p.strip() for p in _SENT.split(text or "") if p.strip()]
    if not parts and text:
        return [text.strip()]
    return parts


def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b:
        return 0.0
    dot = sum(x * y for x, y in zip(a, b, strict=False))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(y * y for y in b) ** 0.5
    return 0.0 if na == 0 or nb == 0 else dot / (na * nb)


async def pick_best_span(
    *,
    query: str,
    chunk_text: str,
    max_chars: int = 400,
    window: int = 2,
) -> str:
    """Return the best-matching `window`-sentence slice of `chunk_text` for `query`.

    Falls back to a head-of-chunk excerpt if embedding fails.
    """
    sents = _sentences(chunk_text)
    if not sents:
        return ""
    if len(sents) <= window:
        return " ".join(sents)[:max_chars]

    try:
        # Embed query + each candidate window (sentence + neighbors).
        candidates: list[str] = []
        for i in range(len(sents) - window + 1):
            candidates.append(" ".join(sents[i : i + window]))
        embs = await embed_dense([query, *candidates])
        q = embs[0]
        scored = [(_cosine(q, c), candidates[i]) for i, c in enumerate(embs[1:])]
        scored.sort(key=lambda x: x[0], reverse=True)
        return scored[0][1][:max_chars] if scored else chunk_text[:max_chars]
    except Exception as e:
        logger.debug("span pick fell back: %s", e)
        return chunk_text[:max_chars]
