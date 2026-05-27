#!/usr/bin/env python3
"""Latency benchmark: fire N queries at the live API, report per-stage p50/p95.

Reads from the existing eval datasets so the queries are realistic. Uses the
in-process trace records that the engine already produces (`_stages`), so
zero new instrumentation is needed.

Usage:
    python scripts/bench.py --domain sec --n 25
    python scripts/bench.py --domain legal --n 12

Output is a markdown table; pipe to a file to drop into the README's
Performance section, or to clipboard for a screenshot.
"""

from __future__ import annotations

import argparse
import asyncio
import statistics
from pathlib import Path
from typing import Any

import httpx
import yaml


async def _run_one(client: httpx.AsyncClient, api: str, domain: str, question: str) -> dict[str, Any]:
    r = await client.post(
        f"{api}/query",
        json={"domain": domain, "question": question},
        timeout=300,
    )
    r.raise_for_status()
    body = r.json()
    trace_id = body.get("trace_id")
    trace = {}
    if trace_id:
        tr = await client.get(f"{api}/query/trace/{trace_id}", timeout=30)
        if tr.status_code == 200:
            trace = tr.json()
    return {"latency_ms": (trace.get("latency_ms") or 0), "trace": trace}


async def _bench(api: str, domain: str, dataset_path: Path, n: int) -> None:
    ds = yaml.safe_load(dataset_path.read_text())
    questions = [q["question"] for q in ds["questions"][:n]]

    stage_lats: dict[str, list[float]] = {}
    total_lats: list[float] = []

    async with httpx.AsyncClient() as client:
        for i, q in enumerate(questions, 1):
            print(f"[{i}/{len(questions)}] {q[:60]}", flush=True)
            try:
                result = await _run_one(client, api, domain, q)
            except Exception as e:
                print(f"  failed: {e}")
                continue
            total_lats.append(result["latency_ms"])
            stages = ((result["trace"].get("filters") or {}).get("_stages") or [])
            for s in stages:
                name = s.get("stage", "?")
                stage_lats.setdefault(name, []).append(float(s.get("latency_ms", 0)))

    def _p(xs: list[float], q: float) -> float:
        if not xs:
            return 0.0
        s = sorted(xs)
        idx = max(0, min(len(s) - 1, int(len(s) * q)))
        return s[idx]

    print()
    print(f"## Bench results — {domain}, n={len(total_lats)}")
    print()
    print("| Stage          |  p50 (ms) |  p95 (ms) |  mean (ms) |  count |")
    print("| -------------- | --------: | --------: | ---------: | -----: |")
    for stage, lats in sorted(stage_lats.items(), key=lambda kv: -sum(kv[1])):
        if not lats:
            continue
        print(
            f"| {stage:<14} | "
            f"{_p(lats, 0.5):>9.0f} | "
            f"{_p(lats, 0.95):>9.0f} | "
            f"{statistics.mean(lats):>10.0f} | "
            f"{len(lats):>6} |"
        )
    print(
        f"| **total**      | "
        f"{_p(total_lats, 0.5):>9.0f} | "
        f"{_p(total_lats, 0.95):>9.0f} | "
        f"{statistics.mean(total_lats):>10.0f} | "
        f"{len(total_lats):>6} |"
    )


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--api", default="http://localhost:8000")
    p.add_argument("--domain", required=True)
    p.add_argument("--dataset")
    p.add_argument("--n", type=int, default=25)
    args = p.parse_args()

    ds_path = Path(args.dataset) if args.dataset else Path(f"domains/{args.domain}/eval/dataset.yaml")
    asyncio.run(_bench(args.api, args.domain, ds_path, args.n))


if __name__ == "__main__":
    main()
