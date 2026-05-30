"""Tests for the parser's title-promotion heuristic.

Unstructured's HTML parser leaves all 10-K elements as NarrativeText; this
heuristic recovers Title markers from body elements so boundary-aware
chunking and section-boost have something to fire on.
"""

from __future__ import annotations

from kb.parse.parser import Element, _is_title_like, _promote_title_like

# ─── _is_title_like ────────────────────────────────────────────────────────


def test_section_numbered_item() -> None:
    assert _is_title_like("Item 1A. Risk Factors") is True
    assert _is_title_like("Item 7. Management's Discussion") is True
    assert _is_title_like("ITEM 1A") is True


def test_section_numbered_part() -> None:
    assert _is_title_like("PART II") is True
    assert _is_title_like("Part I") is True


def test_section_numbered_section() -> None:
    assert _is_title_like("Section 4.2") is True


def test_all_caps_heading() -> None:
    assert _is_title_like("RISK FACTORS") is True
    assert _is_title_like("EXECUTIVE COMPENSATION") is True


def test_title_case_heading() -> None:
    assert _is_title_like("Management's Discussion and Analysis") is True
    assert _is_title_like("Risk Factors") is True


def test_rejects_sentence_with_period() -> None:
    assert _is_title_like("Apple's revenue grew significantly this quarter.") is False


def test_rejects_sentence_with_question_mark() -> None:
    assert _is_title_like("What are the risk factors?") is False


def test_rejects_multiline() -> None:
    assert _is_title_like("Item 1A\nRisk Factors") is False


def test_rejects_long_text() -> None:
    long_paragraph = (
        "The company faces a number of significant risks including but not limited to "
        "supply chain disruption customer concentration foreign exchange rate fluctuations "
        "regulatory changes and macroeconomic conditions that could materially impact"
    )
    assert _is_title_like(long_paragraph) is False


def test_rejects_lowercase_prose() -> None:
    assert _is_title_like("the quick brown fox") is False


def test_rejects_empty() -> None:
    assert _is_title_like("") is False
    assert _is_title_like("   ") is False
    assert _is_title_like(None) is False  # type: ignore[arg-type]


def test_rejects_too_many_words() -> None:
    very_long_title = " ".join(["Word"] * 26)
    assert _is_title_like(very_long_title) is False


# ─── _promote_title_like ────────────────────────────────────────────────────


def _body(text: str, idx: int = 0) -> Element:
    return Element(
        id=f"el-{idx}",
        type="NarrativeText",
        text=text,
        page=1,
        bbox=None,
        parent_id=None,
        metadata={},
    )


def test_promotes_section_headers_inline() -> None:
    els = [
        _body("Item 1A. Risk Factors", 0),
        _body("The company faces a number of risks including supply chain.", 1),
        _body("RISK FACTORS", 2),
        _body("Apple's results were strong this quarter.", 3),
    ]
    out = _promote_title_like(els)
    assert out[0].type == "Title"
    assert out[1].type == "NarrativeText"
    assert out[2].type == "Title"
    assert out[3].type == "NarrativeText"


def test_marks_promoted_in_metadata() -> None:
    els = [_body("PART II", 0)]
    out = _promote_title_like(els)
    assert out[0].type == "Title"
    assert out[0].metadata.get("title_promoted") is True


def test_preserves_existing_titles() -> None:
    el = Element(
        id="el-0",
        type="Title",
        text="Something Already Titled",
        page=1,
        bbox=None,
        parent_id=None,
        metadata={"original": True},
    )
    out = _promote_title_like([el])
    assert out[0].type == "Title"
    # Existing Title elements pass through untouched — no title_promoted flag added.
    assert out[0].metadata == {"original": True}


def test_leaves_non_body_types_untouched() -> None:
    el = Element(
        id="el-0",
        type="Table",
        text="Item 1A. Some Heading",
        page=1,
        bbox=None,
        parent_id=None,
        metadata={},
    )
    out = _promote_title_like([el])
    assert out[0].type == "Table"
