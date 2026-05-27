"""XLSX → entities bridge.

The schema-driven LLM extraction often misses per-row XLSX data because the
chunk text doesn't read like natural language. For domains with a financial
schema (Company + FinancialMetric), we can recognise XLSX content and emit
entities directly without the LLM.

Heuristic detection:
  - The first row contains column headers
  - At least one header column looks like an entity identifier (e.g. 'Ticker', 'Symbol')
  - At least one header column looks like a value field (e.g. 'Revenue', 'Net Income', 'EPS')

When recognised, we emit one FinancialMetric entity per (row × value-column),
attaching the source file_id as the mention.
"""

from __future__ import annotations

import re
from typing import Any

import structlog

logger = structlog.get_logger("kb.extract.xlsx_bridge")

# Field-name hints. Order matters: the first match wins.
_IDENT_COLS = {"ticker", "symbol", "company", "issuer"}
_PERIOD_COLS = {"period", "quarter", "fiscal year", "year", "date"}
_NAME_COLS = {"name", "metric", "indicator"}
_VALUE_COLS = {
    "revenue",
    "net income",
    "income",
    "eps",
    "eps diluted",
    "eps-diluted",
    "gross profit",
    "operating income",
    "cash",
    "total assets",
}


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9 ]+", " ", (s or "").lower()).strip()


def _classify_header(headers: list[str]) -> dict[str, int]:
    """Return {role: column_index} for ident/period/name/value-style headers."""
    out: dict[str, int] = {}
    for i, h in enumerate(headers):
        n = _norm(h)
        if not n:
            continue
        if n == "ticker" or n in _IDENT_COLS:
            out.setdefault("ticker", i)
        elif n in _NAME_COLS:
            out.setdefault("name", i)
        elif n in _PERIOD_COLS or "quarter" in n or "year" in n or "period" in n:
            # Multiple period-y cols — keep the first and tag the rest as values if numeric.
            if "period" not in out:
                out["period"] = i
            else:
                out.setdefault(f"period_extra_{i}", i)
        elif n in _VALUE_COLS or any(k in n for k in _VALUE_COLS):
            out[f"value:{n}"] = i
    return out


def extract_financial_metrics_from_xlsx(
    rows: list[list[str]],
) -> list[dict[str, Any]]:
    """Given rows of an XLSX (header in row 0), emit FinancialMetric records.

    Returns list of {ticker, name, value, period, unit, _provenance} dicts.
    Empty list if the sheet doesn't look like a financial summary.
    """
    if len(rows) < 2:
        return []
    headers = [str(c) for c in (rows[0] or [])]
    cls = _classify_header(headers)

    ticker_col = cls.get("ticker")
    value_cols = [(k.split(":", 1)[1], v) for k, v in cls.items() if k.startswith("value:")]

    # If we can't even tell ticker + at least one value column, abort.
    if ticker_col is None or not value_cols:
        return []

    # Some sheets have multiple period-ish columns (e.g. Fiscal Year + Quarter).
    # Concatenate them all into a period string.
    period_indices = [i for k, i in cls.items() if k.startswith("period") or k == "period"]
    period_indices = sorted(set(period_indices))

    out: list[dict[str, Any]] = []
    for r_idx, raw in enumerate(rows[1:], start=1):
        row = [str(c) if c is not None else "" for c in raw]
        if not any(c.strip() for c in row):
            continue
        if ticker_col >= len(row):
            continue
        ticker = row[ticker_col].strip().upper()
        if not ticker or len(ticker) > 8:
            continue
        period_parts = [row[i] for i in period_indices if i < len(row) and row[i].strip()]
        period = " ".join(period_parts).strip() if period_parts else ""
        for col_name, col_idx in value_cols:
            if col_idx >= len(row):
                continue
            raw_val = row[col_idx].strip()
            if not raw_val:
                continue
            try:
                num = float(raw_val.replace(",", ""))
            except (TypeError, ValueError):
                continue
            unit_guess = ""
            if any(k in col_name for k in ("revenue", "income", "assets", "cash", "profit")):
                unit_guess = "USD-millions"
            elif "eps" in col_name:
                unit_guess = "USD"
            elif "margin" in col_name:
                unit_guess = "%"
            out.append(
                {
                    "ticker": ticker,
                    "name": col_name.title(),
                    "value": num,
                    "period": period or "",
                    "unit": unit_guess,
                    "_provenance": {
                        "page_start": 0,
                        "page_end": 0,
                        "excerpt": f"Row {r_idx}: {ticker} | {period} | {col_name} = {num}",
                        "confidence": 1.0,
                    },
                }
            )
    if out:
        logger.info("xlsx_bridge: extracted %d FinancialMetric records", len(out))
    return out
