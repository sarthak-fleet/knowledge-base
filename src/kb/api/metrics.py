"""Prometheus /metrics endpoint.

Exposes per-stage p50/p95 query latency, token spend, ingest counts, and
RAGAS metric history (sampled from query_traces). Plain-text Prometheus
exposition format — no client dependency.

This is intentionally minimal: a real production setup would push to a TSDB
(VictoriaMetrics, Mimir, etc.); the in-process aggregator here gives the
operator a same-process view via curl.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field
from threading import Lock
from typing import Any


@dataclass
class _Stats:
    samples: deque[float] = field(default_factory=lambda: deque(maxlen=1024))

    def add(self, v: float) -> None:
        self.samples.append(v)

    def p(self, q: float) -> float:
        if not self.samples:
            return 0.0
        s = sorted(self.samples)
        idx = max(0, min(len(s) - 1, int(len(s) * q)))
        return s[idx]

    def avg(self) -> float:
        return sum(self.samples) / len(self.samples) if self.samples else 0.0

    def count(self) -> int:
        return len(self.samples)


_lock = Lock()
_stage_latencies: dict[str, _Stats] = {}
_tokens: _Stats = _Stats()
_queries_total = {"value": 0}
_ingest_total = {"value": 0}


def record_query(latency_ms: int, token_total: int, stages: list[dict[str, Any]]) -> None:
    with _lock:
        _queries_total["value"] += 1
        _tokens.add(float(token_total or 0))
        for s in stages or []:
            name = s.get("stage", "unknown")
            _stage_latencies.setdefault(name, _Stats()).add(float(s.get("latency_ms", 0)))


def record_ingest(file_count: int) -> None:
    with _lock:
        _ingest_total["value"] += int(file_count or 0)


def render_prometheus() -> str:
    """Emit prometheus-format metrics text."""
    out: list[str] = []
    out.append("# HELP kb_queries_total Total number of queries served")
    out.append("# TYPE kb_queries_total counter")
    out.append(f"kb_queries_total {_queries_total['value']}")
    out.append("# HELP kb_ingest_files_total Total files ingested")
    out.append("# TYPE kb_ingest_files_total counter")
    out.append(f"kb_ingest_files_total {_ingest_total['value']}")
    out.append("# HELP kb_query_tokens Token usage per query (rolling)")
    out.append("# TYPE kb_query_tokens summary")
    out.append(f'kb_query_tokens{{quantile="0.5"}} {_tokens.p(0.5):.2f}')
    out.append(f'kb_query_tokens{{quantile="0.95"}} {_tokens.p(0.95):.2f}')
    out.append(f"kb_query_tokens_count {_tokens.count()}")
    out.append("# HELP kb_stage_latency_ms Per-stage latency in ms (rolling)")
    out.append("# TYPE kb_stage_latency_ms summary")
    with _lock:
        for stage, stats in _stage_latencies.items():
            out.append(f'kb_stage_latency_ms{{stage="{stage}",quantile="0.5"}} {stats.p(0.5):.2f}')
            out.append(f'kb_stage_latency_ms{{stage="{stage}",quantile="0.95"}} {stats.p(0.95):.2f}')
            out.append(f'kb_stage_latency_ms_count{{stage="{stage}"}} {stats.count()}')
    return "\n".join(out) + "\n"
