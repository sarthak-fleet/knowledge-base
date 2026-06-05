from __future__ import annotations

import asyncio

from kb.query import search as search_mod
from kb.query.types import AgentSearchEvalIn, AgentSearchEvalItem, AgentSearchIn
from kb.vector.base import SearchHit


class FakeStore:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def hybrid_search(self, domain: str, query: str, **kwargs):
        self.calls.append({"domain": domain, "query": query, **kwargs})
        return [
            SearchHit(
                id=f"{domain}-chunk",
                text=f"{domain} says Postgres is the operational store.",
                score=0.9,
                metadata={
                    "project": "p1",
                    "domain": domain,
                    "file_id": f"{domain}-file",
                    "page_start": 2,
                    "page_end": 3,
                    "entity_id": f"{domain}-entity",
                },
            )
        ]


def test_agent_search_returns_cited_results(monkeypatch) -> None:
    store = FakeStore()

    async def fake_get_file(file_id: str):
        return {"id": file_id, "filename": f"{file_id}.txt"}

    async def fake_span(*, query: str, chunk_text: str, max_chars: int):
        return chunk_text[:max_chars]

    monkeypatch.setattr(search_mod, "get_store", lambda: store)
    monkeypatch.setattr(search_mod.repo, "get_file", fake_get_file)
    monkeypatch.setattr(search_mod, "pick_best_span", fake_span)

    out = asyncio.run(
        search_mod.search_corpus(
            AgentSearchIn(
                project="p1",
                domain="notes",
                kinds=["notes", "manuals"],
                query="operational store",
                top_k=2,
                rerank=False,
            )
        )
    )

    assert out.project == "p1"
    assert out.kinds == ["notes", "manuals"]
    assert [c["domain"] for c in store.calls] == ["notes", "manuals"]
    assert all(c["filters"]["project"] == "p1" for c in store.calls)
    assert len(out.results) == 2
    assert out.results[0].filename.endswith(".txt")
    assert out.results[0].page_start == 2
    assert "Postgres" in out.results[0].excerpt
    assert "store" in out.results[0].highlights


def test_agent_search_eval_scores_expected_files(monkeypatch) -> None:
    store = FakeStore()

    async def fake_get_file(file_id: str):
        return {"id": file_id, "filename": f"{file_id}.txt"}

    async def fake_span(*, query: str, chunk_text: str, max_chars: int):
        return chunk_text[:max_chars]

    async def fake_rerank(query: str, hits, top_k: int):
        return hits[:top_k]

    monkeypatch.setattr(search_mod, "get_store", lambda: store)
    monkeypatch.setattr(search_mod.repo, "get_file", fake_get_file)
    monkeypatch.setattr(search_mod, "pick_best_span", fake_span)
    monkeypatch.setattr(search_mod, "cross_rerank", fake_rerank)

    out = asyncio.run(
        search_mod.evaluate_search(
            AgentSearchEvalIn(
                project="p1",
                domain="notes",
                kinds=["notes"],
                top_k=2,
                questions=[
                    AgentSearchEvalItem(
                        id="q1",
                        query="operational store",
                        expected_files=["notes-file"],
                    )
                ],
            )
        )
    )

    assert out.question_count == 1
    assert out.mean_recall == 1.0
    assert out.mean_mrr == 1.0
    assert out.rows[0].top_files == ["notes-file.txt"]
