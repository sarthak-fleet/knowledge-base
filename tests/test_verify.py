"""Citation verification module — confidence adjustment + summary shape."""

from __future__ import annotations

from kb.query.verify import ClaimCheck, adjust_confidence_with_verification, verification_summary


def test_summary_all_supported() -> None:
    checks = [
        ClaimCheck("Apple grants permission.", [1], True, "stated verbatim"),
        ClaimCheck("MIT requires copyright notice.", [1, 2], True, "stated verbatim"),
    ]
    s = verification_summary(checks)
    assert s["checked"] == 2
    assert s["supported"] == 2
    assert s["pass_rate"] == 1.0
    assert s["failed_claims"] == []


def test_summary_partial_support() -> None:
    checks = [
        ClaimCheck("supported claim", [1], True, "ok"),
        ClaimCheck("unsupported claim", [2], False, "not in cited source"),
    ]
    s = verification_summary(checks)
    assert s["supported"] == 1
    assert s["pass_rate"] == 0.5
    assert len(s["failed_claims"]) == 1
    assert s["failed_claims"][0]["claim"] == "unsupported claim"


def test_summary_empty() -> None:
    s = verification_summary([])
    assert s == {"checked": 0, "supported": 0, "pass_rate": None}


def test_confidence_downgraded_when_unsupported() -> None:
    val, reason = adjust_confidence_with_verification(
        0.95,
        "synthesizer confident",
        {"checked": 4, "supported": 2, "pass_rate": 0.5},
    )
    assert val == 0.5  # pulled to the pass_rate floor
    assert "verification" in reason


def test_confidence_preserved_when_all_supported() -> None:
    val, reason = adjust_confidence_with_verification(
        0.9,
        "ok",
        {"checked": 2, "supported": 2, "pass_rate": 1.0},
    )
    assert val == 0.9
    assert "all claims supported" in reason


def test_confidence_unchanged_when_no_checks() -> None:
    val, reason = adjust_confidence_with_verification(
        0.7,
        "ok",
        {"checked": 0, "supported": 0, "pass_rate": None},
    )
    assert val == 0.7
    assert reason == "ok"
