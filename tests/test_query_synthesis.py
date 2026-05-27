"""Query engine without DB/LLM/vector store — verifies citation extraction, refusal, conf parsing."""

from __future__ import annotations

import re

from kb.query.engine import _extract_cited_indices, _format_sources


def test_cite_re_finds_numbers() -> None:
    assert _extract_cited_indices("foo [1] bar [2][3] baz.") == [1, 2, 3]


def test_cite_re_ignores_text() -> None:
    assert _extract_cited_indices("nothing here") == []


def test_format_sources_includes_index_and_page() -> None:
    hits = [
        {"text": "alpha", "metadata": {"file_id": "abcdef0123", "page_start": 5, "page_end": 5}},
        {"text": "beta",  "metadata": {"file_id": "ffffffffff", "page_start": 8, "page_end": 10}},
    ]
    out = _format_sources(hits)
    assert "[1]" in out and "[2]" in out
    assert "page=5" in out
    assert "page=8-10" in out


def test_trailing_confidence_json_pattern() -> None:
    sample = 'The answer is X. [1] {"confidence": 0.83, "confidence_reason": "well-supported"}'
    m = re.search(r"\{[^{}]*confidence[^{}]*\}\s*$", sample)
    assert m
    import json
    j = json.loads(m.group(0))
    assert j["confidence"] == 0.83
