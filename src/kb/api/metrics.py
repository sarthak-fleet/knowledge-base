"""Prometheus /metrics endpoint backed by the official prometheus_client library.

Replaces a ~85-line hand-rolled aggregator with a Counter + Summary surface
that other production systems already know how to scrape. The metric NAMES
are unchanged so any existing dashboards keep working:

  - kb_queries_total            (Counter)
  - kb_ingest_files_total       (Counter)
  - kb_query_tokens             (Summary; .5 and .95 quantiles)
  - kb_stage_latency_ms{stage}  (Summary; .5 and .95 per stage)

`record_query` / `record_ingest` keep the same call shape so the wiring in
`kb/query/engine.py` and the worker doesn't change.
"""

from __future__ import annotations

from typing import Any

from prometheus_client import CONTENT_TYPE_LATEST, Counter, Summary, generate_latest

_queries_total = Counter("kb_queries_total", "Total queries served")
_ingest_total = Counter("kb_ingest_files_total", "Total files ingested")
_tokens = Summary("kb_query_tokens", "Token usage per query")
# Pre-declared with the label key; values appear lazily as new stages fire.
_stage_latency = Summary("kb_stage_latency_ms", "Per-stage latency in ms", labelnames=["stage"])


def record_query(latency_ms: int, token_total: int, stages: list[dict[str, Any]]) -> None:
    _queries_total.inc()
    _tokens.observe(float(token_total or 0))
    for s in stages or []:
        _stage_latency.labels(stage=s.get("stage", "unknown")).observe(float(s.get("latency_ms", 0)))


def record_ingest(file_count: int) -> None:
    _ingest_total.inc(int(file_count or 0))


def render_prometheus() -> tuple[bytes, str]:
    """Return (body_bytes, content_type) for the /metrics endpoint."""
    return generate_latest(), CONTENT_TYPE_LATEST
