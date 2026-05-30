"""Unit tests for the pure helpers in kb.query.duckdb_route.

Covers:
- _capture_filename_field: generic regex-capture from filename (the SEC-specific
  pattern lives in domains/sec/config.yaml as duckdb_route.filename_to_field;
  these tests pin the pattern explicitly so they exercise the helper itself).
- _metric_canonical: raw metric name → canonical bucket
"""

from __future__ import annotations

from kb.query.duckdb_route import _capture_filename_field, _metric_canonical

# SEC ticker-from-filename pattern — kept here so the tests stay deterministic
# and don't depend on the config loader.
SEC_TICKER_PATTERN = r"^([A-Z]{1,5})[_-]"


# ─── _capture_filename_field (SEC ticker pattern) ─────────────────────────


def test_ticker_basic_underscore() -> None:
    assert _capture_filename_field(SEC_TICKER_PATTERN, "AAPL_10-K_2025-10-31.html") == "AAPL"


def test_ticker_basic_dash() -> None:
    assert _capture_filename_field(SEC_TICKER_PATTERN, "NVDA-10-Q-2025.html") == "NVDA"


def test_ticker_msft_short() -> None:
    assert _capture_filename_field(SEC_TICKER_PATTERN, "MSFT_8-K_xyz.html") == "MSFT"


def test_ticker_none_for_empty() -> None:
    assert _capture_filename_field(SEC_TICKER_PATTERN, "") is None
    assert _capture_filename_field(SEC_TICKER_PATTERN, None) is None


def test_ticker_none_for_unprefixed() -> None:
    # No uppercase ticker-shape prefix → None
    assert _capture_filename_field(SEC_TICKER_PATTERN, "summary_financials.xlsx") is None
    assert _capture_filename_field(SEC_TICKER_PATTERN, "license.txt") is None


def test_ticker_only_first_token() -> None:
    # Ensure we don't accidentally grab text after the first separator
    assert (
        _capture_filename_field(SEC_TICKER_PATTERN, "TSLA_10-K_2024-09-30_000162828024041240.html")
        == "TSLA"
    )


def test_capture_returns_none_for_bad_pattern() -> None:
    # Malformed regex should not raise — helper returns None.
    assert _capture_filename_field("(", "anything.html") is None


def test_capture_returns_none_when_pattern_empty() -> None:
    assert _capture_filename_field(None, "AAPL_10-K.html") is None
    assert _capture_filename_field("", "AAPL_10-K.html") is None


# ─── _metric_canonical ────────────────────────────────────────────────────


def test_canonical_revenue_family() -> None:
    assert _metric_canonical("Revenue") == "revenue"
    assert _metric_canonical("Total Net Sales") == "revenue"
    assert _metric_canonical("Net Sales") == "revenue"


def test_canonical_revenue_segment() -> None:
    # Apple's segment lines should bucket separately so an aggregate query
    # for "revenue" doesn't sum iPhone + Services on top of Total Net Sales.
    assert _metric_canonical("Net Sales - iPhone") == "revenue_segment"
    assert _metric_canonical("Net Sales - Services") == "revenue_segment"


def test_canonical_eps_variants() -> None:
    # All four variants we found in the live DB
    assert _metric_canonical("EPS-Diluted") == "eps_diluted"
    assert _metric_canonical("Diluted EPS") == "eps_diluted"
    assert _metric_canonical("Earnings Per Share - Diluted") == "eps_diluted"
    assert _metric_canonical("Eps Diluted") == "eps_diluted"
    assert _metric_canonical("Earnings Per Share - Basic") == "eps_basic"


def test_canonical_net_income_family() -> None:
    assert _metric_canonical("Net Income") == "net_income"
    assert _metric_canonical("Net Earnings") == "net_income"


def test_canonical_other_metrics() -> None:
    assert _metric_canonical("Operating Income") == "operating_income"
    assert _metric_canonical("Gross Margin") == "gross_margin"
    assert _metric_canonical("Total Assets") == "total_assets"
    assert _metric_canonical("Cash and Cash Equivalents") == "cash"


def test_canonical_case_insensitive() -> None:
    assert _metric_canonical("REVENUE") == "revenue"
    assert _metric_canonical("net income") == "net_income"
    assert _metric_canonical("TOTAL net SALES") == "revenue"


def test_canonical_none_for_unknown() -> None:
    # Unrecognised names fall through to NULL; SQL can ILIKE on the raw `name`.
    assert _metric_canonical("Free Cash Flow") is None
    assert _metric_canonical("Days Sales Outstanding") is None


def test_canonical_none_for_empty() -> None:
    assert _metric_canonical("") is None
    assert _metric_canonical(None) is None
