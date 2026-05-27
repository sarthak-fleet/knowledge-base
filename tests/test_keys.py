"""Identity-key normalization is deterministic and case/whitespace insensitive."""

from kb.resolve.keys import identity_key, normalize


def test_normalize_strips_punct_and_case() -> None:
    assert normalize("NVIDIA Corp.") == "nvidia corp"
    assert normalize("  Apple Inc.  ") == "apple inc"
    assert normalize("Berkshire Hathaway, Inc.") == "berkshire hathaway inc"


def test_identity_key_uses_only_identity_fields() -> None:
    values = {"ticker": "NVDA", "cik": "0001045810", "name": "NVIDIA Corp.", "noise": "ignored"}
    k = identity_key(values, ["ticker", "cik"])
    assert "nvda" in k and "1045810" in k
    assert "ignored" not in k


def test_identity_key_handles_missing_field() -> None:
    values = {"ticker": "AAPL"}
    k = identity_key(values, ["ticker", "cik"])
    assert k.startswith("aapl")  # normalized
