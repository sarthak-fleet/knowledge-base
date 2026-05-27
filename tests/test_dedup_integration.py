"""Integration test for chunk-level dedup: two chunks with identical normalized text
should produce one persisted point with the second file_id in `also_in_files`.

Uses an in-memory fake vector store implementing the same Protocol to avoid
needing live Qdrant in the unit test process.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any

from kb.vector.base import Chunk, SearchHit
from kb.vector.dedup import content_hash


@dataclass
class _FakeStore:
    """A faithful implementation of the same dedup semantics as QdrantStore.upsert."""

    _points: dict[str, dict[str, Any]] = field(default_factory=dict)
    _hash_index: dict[str, str] = field(default_factory=dict)  # content_hash -> point_id

    async def ensure_collection(self, domain: str) -> None: ...
    async def delete_by_file(self, domain: str, file_id: str) -> None: ...

    async def upsert(self, domain: str, chunks: list[Chunk]) -> None:
        for c in chunks:
            ch = c.content_hash
            existing_id = self._hash_index.get(ch) if ch else None
            if existing_id and existing_id != c.id:
                ex = self._points[existing_id]
                new_file = c.metadata.get("file_id")
                primary = ex["payload"].get("file_id")
                if new_file and new_file != primary:
                    also = list(ex["payload"].get("also_in_files") or [])
                    if new_file not in also:
                        also.append(new_file)
                    ex["payload"]["also_in_files"] = also
            else:
                self._points[c.id] = {
                    "id": c.id,
                    "payload": {
                        **c.metadata,
                        "text": c.text,
                        "content_hash": ch,
                        "also_in_files": [],
                    },
                }
                if ch:
                    self._hash_index[ch] = c.id

    async def hybrid_search(self, *a, **kw) -> list[SearchHit]:
        return []


def _chunk(id_: str, text: str, file_id: str) -> Chunk:
    return Chunk(
        id=id_,
        text=text,
        metadata={"file_id": file_id, "page_start": 1, "page_end": 1},
        parent_id=None,
        content_hash=content_hash(text),
    )


def test_two_files_with_identical_chunk_dedup_to_one_point() -> None:
    store = _FakeStore()
    boilerplate = "Forward-looking statements: this report contains forward-looking statements."
    a = _chunk("aaa", boilerplate, "file-1")
    b = _chunk("bbb", boilerplate, "file-2")

    asyncio.run(store.upsert("sec", [a]))
    asyncio.run(store.upsert("sec", [b]))

    assert len(store._points) == 1, "duplicate chunks must collapse into one point"
    only = next(iter(store._points.values()))
    assert only["payload"]["file_id"] == "file-1"
    assert only["payload"]["also_in_files"] == ["file-2"]


def test_three_files_same_chunk_collect_all_extras() -> None:
    store = _FakeStore()
    text = "The Company's manufacturing operations are concentrated in a small number of suppliers."
    asyncio.run(store.upsert("sec", [_chunk("c1", text, "f1")]))
    asyncio.run(store.upsert("sec", [_chunk("c2", text, "f2")]))
    asyncio.run(store.upsert("sec", [_chunk("c3", text, "f3")]))

    assert len(store._points) == 1
    pt = next(iter(store._points.values()))
    assert pt["payload"]["file_id"] == "f1"
    assert pt["payload"]["also_in_files"] == ["f2", "f3"]


def test_different_text_does_not_collapse() -> None:
    store = _FakeStore()
    asyncio.run(store.upsert("sec", [_chunk("a", "alpha sentence", "f1")]))
    asyncio.run(store.upsert("sec", [_chunk("b", "beta sentence", "f2")]))
    assert len(store._points) == 2


def test_same_file_resubmission_does_not_duplicate_also_in() -> None:
    """If the SAME file is re-ingested, we should not accumulate its file_id in
    also_in_files (the primary owner is unchanged)."""
    store = _FakeStore()
    text = "Repeated text"
    asyncio.run(store.upsert("sec", [_chunk("c1", text, "f1")]))
    # New chunk_id but same content + same primary file
    asyncio.run(store.upsert("sec", [_chunk("c2", text, "f1")]))

    pt = next(iter(store._points.values()))
    assert pt["payload"]["file_id"] == "f1"
    assert pt["payload"]["also_in_files"] == []


def test_formatting_differences_collapse_via_normalize() -> None:
    """Two chunks differing only in whitespace/casing should hash to the same
    content_hash and dedup."""
    store = _FakeStore()
    a = _chunk("a", "The   QUICK brown fox JUMPS over the lazy dog!", "f1")
    b = _chunk("b", "the quick brown fox jumps over the lazy dog", "f2")
    asyncio.run(store.upsert("sec", [a]))
    asyncio.run(store.upsert("sec", [b]))
    assert len(store._points) == 1
    pt = next(iter(store._points.values()))
    assert pt["payload"]["also_in_files"] == ["f2"]
