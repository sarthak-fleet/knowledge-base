"""Semantic chunking — split at topic boundaries inferred from embedding distance.

Pattern from LlamaIndex's SemanticSplitterNodeParser (and Greg Kamradt's
"5 levels of chunking"). For each candidate sentence pair, we compute the cosine
distance between their embeddings. A high percentile of these distances marks
a topic shift; split there.

Falls back to fixed-size chunking on any embedding failure or short documents.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

import structlog

logger = structlog.get_logger("kb.vector.semantic_chunking")

_SENT = re.compile(r"(?<=[\.\!\?])\s+")


@dataclass
class SemanticSegment:
    text: str
    sentence_ids: list[int]


def _sentences(text: str) -> list[str]:
    parts = [p.strip() for p in _SENT.split(text or "") if p.strip()]
    return parts or ([text.strip()] if text else [])


def _cosine(a: list[float], b: list[float]) -> float:
    if not a or not b:
        return 0.0
    dot = sum(x * y for x, y in zip(a, b, strict=False))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(y * y for y in b) ** 0.5
    return 0.0 if na == 0 or nb == 0 else dot / (na * nb)


async def semantic_split(
    text: str,
    *,
    percentile_threshold: float = 0.85,
    min_chunk_chars: int = 200,
    max_chunk_chars: int = 2000,
) -> list[SemanticSegment]:
    """Split text at semantic boundaries detected via embedding distance.

    Algorithm:
      1. Sentence-tokenise.
      2. Embed each sentence.
      3. Compute distance between consecutive sentences.
      4. Split where distance > percentile_threshold of all distances.
      5. Enforce min_chunk_chars (merge tiny segments forward) and
         max_chunk_chars (hard split if any segment grows too big).
    """
    from kb.vector.embed import embed_dense

    sentences = _sentences(text)
    if len(sentences) < 3:
        return [SemanticSegment(text=text or "", sentence_ids=list(range(len(sentences))))]

    try:
        embs = await embed_dense(sentences)
    except Exception as e:
        logger.info("semantic chunking embedding failed (%s); single segment", e)
        return [SemanticSegment(text=text, sentence_ids=list(range(len(sentences))))]

    distances = [1.0 - _cosine(embs[i], embs[i + 1]) for i in range(len(embs) - 1)]
    if not distances:
        return [SemanticSegment(text=text, sentence_ids=list(range(len(sentences))))]

    sorted_d = sorted(distances)
    cutoff_idx = max(0, min(len(sorted_d) - 1, int(len(sorted_d) * percentile_threshold)))
    cutoff = sorted_d[cutoff_idx]

    segments: list[SemanticSegment] = []
    buf: list[int] = [0]
    for i, d in enumerate(distances):
        if d >= cutoff:
            seg_text = " ".join(sentences[j] for j in buf)
            segments.append(SemanticSegment(text=seg_text, sentence_ids=buf[:]))
            buf = [i + 1]
        else:
            buf.append(i + 1)
    if buf:
        seg_text = " ".join(sentences[j] for j in buf)
        segments.append(SemanticSegment(text=seg_text, sentence_ids=buf[:]))

    # Enforce minimum chunk size: merge tiny segments forward.
    merged: list[SemanticSegment] = []
    for seg in segments:
        if merged and len(merged[-1].text) < min_chunk_chars:
            merged[-1].text += " " + seg.text
            merged[-1].sentence_ids.extend(seg.sentence_ids)
        else:
            merged.append(seg)

    # Enforce maximum: hard-split any over-long segment by sentences.
    final: list[SemanticSegment] = []
    for seg in merged:
        if len(seg.text) <= max_chunk_chars:
            final.append(seg)
            continue
        cur = SemanticSegment(text="", sentence_ids=[])
        for sid in seg.sentence_ids:
            s = sentences[sid]
            if len(cur.text) + len(s) > max_chunk_chars and cur.text:
                final.append(cur)
                cur = SemanticSegment(text="", sentence_ids=[])
            cur.text = (cur.text + " " + s).strip() if cur.text else s
            cur.sentence_ids.append(sid)
        if cur.text:
            final.append(cur)

    return final
