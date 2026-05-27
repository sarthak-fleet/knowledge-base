"""'edgar' source — SEC filings via edgartools, same pattern as HighSignal's adapter.

SEC serves filings as HTML + XBRL, not PDF. We save the primary document HTML;
the parser's auto-dispatch (unstructured.partition.html) handles it correctly.

Configurable: tickers, forms, lookback days.
Note: requires `SEC_USER_AGENT` env (EDGAR requires identification).
"""

from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from kb.sources.base import IngestedDoc, Source
from kb.sources.registry import register_source

logger = logging.getLogger("kb.sources.edgar")


def _filing_html(filing: object) -> str | None:
    """Pull HTML body from a filing in a way that survives edgartools API drift."""
    for attr in ("html", "html_content", "raw_html"):
        fn = getattr(filing, attr, None)
        if callable(fn):
            try:
                out = fn()
                if isinstance(out, str) and "<" in out:
                    return out
            except Exception:
                continue
        elif isinstance(fn, str) and "<" in fn:
            return fn
    # As a fallback, try filing.text() (plain text)
    txt_fn = getattr(filing, "text", None)
    if callable(txt_fn):
        try:
            txt = txt_fn()
            if isinstance(txt, str) and txt:
                return f"<html><body><pre>{txt}</pre></body></html>"
        except Exception:
            return None
    return None


@dataclass
class EdgarSource(Source):
    tickers: list[str] = field(default_factory=list)
    forms: list[str] = field(default_factory=lambda: ["10-K", "10-Q", "8-K"])
    days: int = 540
    per_ticker_per_form: int = 2
    limit_total: int = 12
    name: str = "edgar"

    async def fetch(self) -> AsyncIterator[IngestedDoc]:
        from edgar import Company, set_identity

        user_agent = os.environ.get("SEC_USER_AGENT", "kb-demo demo@example.com")
        set_identity(user_agent)
        since = datetime.now(UTC) - timedelta(days=self.days)

        yielded = 0
        for ticker in self.tickers:
            try:
                co = await asyncio.to_thread(Company, ticker)
            except Exception as e:
                logger.warning("skip %s: %s", ticker, e)
                continue
            for form in self.forms:
                try:
                    filings = await asyncio.to_thread(lambda c=co, f=form: c.get_filings(form=f))
                except Exception:
                    continue
                taken = 0
                for f in filings:
                    try:
                        filed = datetime.fromisoformat(str(f.filing_date))
                        if filed.tzinfo is None:
                            filed = filed.replace(tzinfo=UTC)
                    except Exception:
                        continue
                    if filed < since:
                        continue
                    html = await asyncio.to_thread(_filing_html, f)
                    if not html:
                        logger.warning("no html for %s %s %s", ticker, form, filed)
                        continue
                    accession = getattr(f, "accession_no", "") or ""
                    filename = f"{ticker}_{form}_{filed.date().isoformat()}_{accession.replace('-', '')}.html"
                    yield IngestedDoc(
                        filename=filename,
                        bytes_=html.encode("utf-8"),
                        mime="text/html",
                        metadata={
                            "source": "edgar",
                            "ticker": ticker,
                            "form": form,
                            "filed_date": filed.date().isoformat(),
                            "accession": accession,
                        },
                    )
                    taken += 1
                    yielded += 1
                    if taken >= self.per_ticker_per_form:
                        break
                    if yielded >= self.limit_total:
                        return


@register_source("edgar")
def _build(
    tickers: list[str] | None = None,
    forms: list[str] | None = None,
    days: int = 540,
    per_ticker_per_form: int = 2,
    limit_total: int = 12,
    **_: object,
) -> EdgarSource:
    return EdgarSource(
        tickers=tickers or ["NVDA", "AAPL", "MSFT"],
        forms=forms or ["10-K", "10-Q", "8-K"],
        days=days,
        per_ticker_per_form=per_ticker_per_form,
        limit_total=limit_total,
    )
