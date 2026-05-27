"""Hierarchical chunking: parent (coarse) + child (fine), child→parent link.

We don't use LlamaIndex's HierarchicalNodeParser directly because we want to
preserve our own provenance (`file_id`, `entity_id`, page span) and our own
chunk IDs. This implementation is small and deterministic.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field
from typing import Any

from kb.parse import Element


@dataclass
class HChunk:
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    text: str = ""
    page_start: int = 0
    page_end: int = 0
    parent_id: str | None = None
    element_ids: list[str] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)


_SENT = re.compile(r"(?<=[.!?])\s+")


def _split(text: str, max_chars: int) -> list[str]:
    if len(text) <= max_chars:
        return [text]
    parts: list[str] = []
    buf: list[str] = []
    cur = 0
    for s in _SENT.split(text):
        if cur + len(s) + 1 > max_chars and buf:
            parts.append(" ".join(buf))
            buf = []
            cur = 0
        buf.append(s)
        cur += len(s) + 1
    if buf:
        parts.append(" ".join(buf))
    return parts


def build_chunks(
    elements: list[Element],
    *,
    parent_size: int = 2048,
    child_size: int = 512,
    overlap: int = 64,
    base_metadata: dict[str, Any] | None = None,
) -> tuple[list[HChunk], list[HChunk]]:
    """Return (parent_chunks, child_chunks).  Parents have no parent_id; children point to a parent."""
    base = base_metadata or {}

    # Build parent buckets by sliding through elements until parent_size is reached.
    parents: list[HChunk] = []
    cur: HChunk | None = None
    cur_text_len = 0

    for e in elements:
        if not e.text:
            continue
        if cur is None or cur_text_len + len(e.text) > parent_size:
            cur = HChunk(
                page_start=e.page,
                page_end=e.page,
                metadata={**base},
            )
            parents.append(cur)
            cur_text_len = 0
        cur.text = (cur.text + "\n\n" + e.text).strip() if cur.text else e.text
        cur.page_end = max(cur.page_end, e.page)
        cur.element_ids.append(e.id)
        cur_text_len += len(e.text)

    # Child chunks: re-split each parent's text into ~child_size pieces.
    children: list[HChunk] = []
    for p in parents:
        for piece in _split(p.text, child_size):
            children.append(
                HChunk(
                    text=piece,
                    page_start=p.page_start,
                    page_end=p.page_end,
                    parent_id=p.id,
                    element_ids=p.element_ids,
                    metadata={**p.metadata, "parent_chunk_id": p.id},
                )
            )

    # Overlap (cheap version): the last `overlap` chars of one child are prepended to the next.
    if overlap > 0 and len(children) > 1:
        for i in range(1, len(children)):
            tail = children[i - 1].text[-overlap:]
            if tail and not children[i].text.startswith(tail):
                children[i].text = tail + " " + children[i].text

    return parents, children


async def _semantic_split(text: str, max_chars: int) -> list[str]:
    """Topic-boundary split via embedding distance. Falls back to _split on failure."""
    try:
        from kb.vector.semantic_chunking import semantic_split

        segs = await semantic_split(text, max_chunk_chars=max_chars)
        return [s.text for s in segs] or [text]
    except Exception:
        return _split(text, max_chars)


async def build_chunks_semantic(
    elements: list[Element],
    *,
    parent_size: int = 2048,
    child_size: int = 512,
    overlap: int = 64,
    base_metadata: dict[str, Any] | None = None,
) -> tuple[list[HChunk], list[HChunk]]:
    """Like build_chunks, but children are split at semantic topic boundaries
    (LlamaIndex SemanticSplitterNodeParser pattern). Falls back to fixed-size
    on any embedding failure.
    """
    base = base_metadata or {}
    parents: list[HChunk] = []
    cur: HChunk | None = None
    cur_text_len = 0
    for e in elements:
        if not e.text:
            continue
        if cur is None or cur_text_len + len(e.text) > parent_size:
            cur = HChunk(page_start=e.page, page_end=e.page, metadata={**base})
            parents.append(cur)
            cur_text_len = 0
        cur.text = (cur.text + "\n\n" + e.text).strip() if cur.text else e.text
        cur.page_end = max(cur.page_end, e.page)
        cur.element_ids.append(e.id)
        cur_text_len += len(e.text)

    children: list[HChunk] = []
    for p in parents:
        pieces = await _semantic_split(p.text, child_size)
        for piece in pieces:
            children.append(
                HChunk(
                    text=piece,
                    page_start=p.page_start,
                    page_end=p.page_end,
                    parent_id=p.id,
                    element_ids=p.element_ids,
                    metadata={**p.metadata, "parent_chunk_id": p.id, "semantic": True},
                )
            )

    if overlap > 0 and len(children) > 1:
        for i in range(1, len(children)):
            tail = children[i - 1].text[-overlap:]
            if tail and not children[i].text.startswith(tail):
                children[i].text = tail + " " + children[i].text

    return parents, children
