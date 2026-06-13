"""Retrieval-only eval wiring."""

from __future__ import annotations

import asyncio
from argparse import Namespace

import yaml

from kb.eval import run_retrieval_only as eval_mod
from kb.vector.base import SearchHit


class FakeStore:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def ensure_collection(self, domain: str) -> None:
        return None

    async def hybrid_search(self, domain: str, query: str, **kwargs):
        self.calls.append({"domain": domain, "query": query, **kwargs})
        return [
            SearchHit(
                id="hit-1",
                text="alpha beta",
                score=1.0,
                metadata={"file_id": "file-1", "page_start": 1, "page_end": 1},
            )
        ]


def test_retrieval_only_uses_configured_rerank_top_k(monkeypatch, tmp_path) -> None:
    ds_path = tmp_path / "ds.yaml"
    ds_path.write_text(
        yaml.safe_dump(
            {
                "questions": [
                    {"id": "q1", "question": "alpha", "expected_files": ["file-1"], "tags": []}
                ]
            }
        )
    )
    out_path = tmp_path / "out.json"

    store = FakeStore()

    monkeypatch.setattr(eval_mod, "get_store", lambda: store)
    monkeypatch.setattr(
        eval_mod.pipeline,
        "pipeline_config",
        lambda domain: {"retrieve": {"top_k_dense": 15, "top_k_sparse": 9, "rerank_top_k": 4}},
    )

    async def fake_get_file(file_id: str):
        return {"id": file_id, "filename": f"{file_id}.pdf"}

    monkeypatch.setattr(eval_mod.repo, "get_file", fake_get_file)

    async def fake_rerank(query: str, hits, top_k: int):
        return hits[:top_k]

    monkeypatch.setattr(eval_mod, "cross_rerank", fake_rerank)

    rc = asyncio.run(
        eval_mod._run(
            Namespace(
                project="default",
                domain="sec",
                dataset=str(ds_path),
                output=str(out_path),
            )
        )
    )

    assert rc == 0
    assert store.calls[0]["rerank_top_k"] == 4
