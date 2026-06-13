"""Query engine without DB/LLM/vector store — verifies citation extraction, refusal, conf parsing."""

from __future__ import annotations

import asyncio
import re

from kb.query.engine import (
    _build_graph_sources,
    _build_retrieval_sources,
    _extract_cited_indices,
    _format_numbered_sources,
    _format_sources,
)
from kb.query.intent import QueryIntent
from kb.query.structured import _safe_field_key, maybe_structured_answer


def test_cite_re_finds_numbers() -> None:
    assert _extract_cited_indices("foo [1] bar [2][3] baz.") == [1, 2, 3]


def test_cite_re_ignores_text() -> None:
    assert _extract_cited_indices("nothing here") == []


def test_format_sources_includes_index_and_page() -> None:
    hits = [
        {"text": "alpha", "metadata": {"file_id": "abcdef0123", "page_start": 5, "page_end": 5}},
        {"text": "beta", "metadata": {"file_id": "ffffffffff", "page_start": 8, "page_end": 10}},
    ]
    out = _format_sources(hits)
    assert "[1]" in out and "[2]" in out
    assert "page=5" in out
    assert "page=8-10" in out


def test_numbered_sources_put_graph_before_retrieval() -> None:
    graph_sources = _build_graph_sources(
        [
            {
                "file_id": "graphfile-1",
                "page_start": 1,
                "page_end": 1,
                "excerpt": "graph evidence",
            }
        ],
        {"graphfile-1": "graph.txt"},
        200,
    )
    retrieval_sources = _build_retrieval_sources(
        [
            {
                "text": "retrieval evidence",
                "metadata": {"file_id": "retrfile-1", "page_start": 2, "page_end": 2},
            }
        ]
    )

    out = _format_numbered_sources(graph_sources, retrieval_sources)
    assert out.index("[1]") < out.index("[2]")
    assert "graph evidence" in out
    assert "retrieval evidence" in out


def test_safe_field_key_rejects_injection_shape() -> None:
    assert _safe_field_key("ticker") == "ticker"
    assert _safe_field_key("x') IS NULL OR 1=1 --") is None


def test_compare_questions_can_use_structured_path(monkeypatch) -> None:
    async def fake_list_entities_matching(
        *, domain: str, entity_type: str | None, filters: dict, limit: int, project: str
    ):
        assert domain == "sec"
        assert entity_type == "FinancialMetric"
        return [
            {"id": "e1", "display_name": "Revenue", "identity_key": "rev", "fields": {"value": 1}}
        ]

    async def fake_mentions_for(entity_ids: list[str], project: str = "default"):
        assert entity_ids == ["e1"]
        return [
            {
                "entity_id": "e1",
                "file_id": "f1",
                "filename": "file.txt",
                "page_start": 1,
                "page_end": 1,
                "excerpt": "x",
            }
        ]

    import kb.query.structured as structured_mod

    monkeypatch.setattr(structured_mod, "list_entities_matching", fake_list_entities_matching)
    monkeypatch.setattr(structured_mod, "mentions_for", fake_mentions_for)
    out = asyncio.run(
        maybe_structured_answer(
            intent=QueryIntent(
                kind="compare", entity_type="FinancialMetric", filters={"ticker": "AAPL"}
            ),
            domain="sec",
            question="Compare NVIDIA and Apple revenue",
            project="default",
        )
    )

    assert out is not None
    assert out["entities"][0]["id"] == "e1"


def test_trailing_confidence_json_pattern() -> None:
    sample = 'The answer is X. [1] {"confidence": 0.83, "confidence_reason": "well-supported"}'
    m = re.search(r"\{[^{}]*confidence[^{}]*\}\s*$", sample)
    assert m
    import json

    j = json.loads(m.group(0))
    assert j["confidence"] == 0.83
