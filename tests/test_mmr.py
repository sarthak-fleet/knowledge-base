"""MMR diversity reranker."""

from __future__ import annotations

import asyncio

from kb.query import mmr as mmr_mod
from kb.query.mmr import _cosine, consolidate_sources, mmr_rerank
from kb.vector.base import SearchHit


def _hit(id_: str, text: str, score: float, file_id: str = "", also: list[str] | None = None) -> SearchHit:
    meta = {"file_id": file_id}
    if also is not None:
        meta["also_in_files"] = also
    return SearchHit(id=id_, text=text, score=score, metadata=meta, parent_id=None)


def test_cosine_basics() -> None:
    assert _cosine([1.0, 0.0], [1.0, 0.0]) == 1.0
    assert _cosine([1.0, 0.0], [0.0, 1.0]) == 0.0
    assert _cosine([], [1.0]) == 0.0  # graceful


def test_mmr_returns_input_when_fewer_than_k() -> None:
    hits = [_hit("a", "alpha", 0.9), _hit("b", "beta", 0.7)]
    out = asyncio.run(mmr_rerank(hits, query="q", top_k=5))
    assert out == hits


def test_mmr_seeds_with_most_relevant(monkeypatch) -> None:
    async def fake_embed(texts):
        return [[1.0, 0.0, 0.0]] * len(texts)  # all identical → diversity penalty maxes
    monkeypatch.setattr(mmr_mod, "embed_dense", fake_embed)

    hits = [
        _hit("a", "x", 0.2),
        _hit("b", "x", 0.9),  # highest relevance
        _hit("c", "x", 0.5),
    ]
    out = asyncio.run(mmr_rerank(hits, query="q", top_k=1, lambda_=0.7))
    assert out[0].id == "b"


def test_mmr_prefers_diversity_when_similar(monkeypatch) -> None:
    """Given 3 candidates where #1 and #2 are near-duplicates and #3 is different,
    MMR with lambda=0.5 should pick #1, then #3 (skipping the near-duplicate)."""
    async def fake_embed(texts):
        return [
            [1.0, 0.0, 0.0],    # very similar to next
            [0.99, 0.01, 0.0],  # near-duplicate of first
            [0.0, 1.0, 0.0],    # orthogonal — diverse
        ]
    monkeypatch.setattr(mmr_mod, "embed_dense", fake_embed)

    hits = [
        _hit("a", "boilerplate paragraph", 0.95),
        _hit("b", "boilerplate paragraph copy", 0.90),
        _hit("c", "unique content", 0.50),
    ]
    out = asyncio.run(mmr_rerank(hits, query="q", top_k=2, lambda_=0.5))
    ids = [h.id for h in out]
    assert ids[0] == "a"           # most relevant first
    assert "c" in ids and "b" not in ids  # diversity beats marginal relevance


def test_mmr_falls_back_on_embedding_error(monkeypatch) -> None:
    async def fake_embed(texts):
        raise RuntimeError("simulated outage")
    monkeypatch.setattr(mmr_mod, "embed_dense", fake_embed)

    hits = [_hit(c, "x", 1.0 - i * 0.1) for i, c in enumerate("abcdef")]
    out = asyncio.run(mmr_rerank(hits, query="q", top_k=3))
    assert [h.id for h in out] == ["a", "b", "c"]


def test_consolidate_sources_collects_primary_and_also() -> None:
    hits = [
        _hit("c1", "x", 1.0, file_id="f1", also=["f2", "f3"]),
        _hit("c2", "y", 0.8, file_id="f4"),
        _hit("c3", "z", 0.7, file_id=""),  # missing primary — handled
    ]
    out = consolidate_sources(hits)
    assert out["c1"] == ["f1", "f2", "f3"]
    assert out["c2"] == ["f4"]
    assert out["c3"] == []  # no primary, no extras → empty
