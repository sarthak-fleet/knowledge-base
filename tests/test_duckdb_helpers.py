"""Unit tests for the pure helpers in kb.query.duckdb_route.

Covers:
- _ticker_from_filename: filename → ticker prefix
- _metric_canonical: raw metric name → canonical bucket

These are the two fixes added in Step 7 (commits 3955e5e and 9ff959d)
that lifted the structured-query route from "always returns NULL" to
"actually finds the rows." No live API needed to test them.
"""

from __future__ import annotations

from kb.query.duckdb_route import _metric_canonical, _ticker_from_filename

# ─── _ticker_from_filename ────────────────────────────────────────────────


def test_ticker_basic_underscore() -> None:
    assert _ticker_from_filename("AAPL_10-K_2025-10-31.html") == "AAPL"


def test_ticker_basic_dash() -> None:
    assert _ticker_from_filename("NVDA-10-Q-2025.html") == "NVDA"


def test_ticker_msft_short() -> None:
    assert _ticker_from_filename("MSFT_8-K_xyz.html") == "MSFT"


def test_ticker_none_for_empty() -> None:
    assert _ticker_from_filename("") is None
    assert _ticker_from_filename(None) is None


def test_ticker_none_for_unprefixed() -> None:
    # No uppercase ticker-shape prefix → None
    assert _ticker_from_filename("summary_financials.xlsx") is None
    assert _ticker_from_filename("license.txt") is None


def test_ticker_only_first_token() -> None:
    # Ensure we don't accidentally grab text after the first separator
    assert _ticker_from_filename("TSLA_10-K_2024-09-30_000162828024041240.html") == "TSLA"


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
