"""Retrieval-only eval — bypasses every LLM call in the pipeline.

When the upstream LLM gateway is unavailable, the standard /query path
(intent → decompose → HyDE → rewrite → CRAG → synth → verify_citations →
optional RAGAS judge) won't complete, so eval/run.py produces zero rows.

This script measures citation F1 (the load-bearing retrieval metric for
the A+C+D interventions) using only local primitives:

  hybrid_search (Qdrant + bm42)  →  cross_rerank (jina, local model)  →
  section-boost  (D — pure ordering, no LLM)  →  top-K filenames

It does NOT measure: answer pass rate, faithfulness, ctx precision/recall.
Those need synth, which needs the gateway. Citation F1 is the metric the
ABCD interventions were designed to move; this is enough for a clean
apples-to-apples row against the § 4.7 / 4.7-final baselines (whose
citation F1 numbers were also produced by this same retrieval pipeline —
the synth model just attached cited indices to the top-K, so cit-F1 is
fundamentally a retrieval metric, not a synthesis one).

Usage:
    docker compose exec api python -m kb.eval.run_retrieval_only \
        --project default --domain sec --dataset domains/sec/eval/dataset.yaml \
        --output /data/eval_results/sec_post-abcd_retrieval_only.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import statistics
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import yaml
from rich import print
from rich.table import Table

from kb.config import pipeline
from kb.query.rerank import rerank as cross_rerank
from kb.storage import repo
from kb.vector.factory import get_store


@dataclass
class Score:
    qid: str
    question: str
    tags: list[str]
    citation_precision: float
    citation_recall: float
    citation_f1: float
    top_k_files: list[str]
    section_boost_hits: int


_SECTION_PHRASES = (
    "risk factor",
    "risk factors",
    "results of operations",
    "management discussion",
    "md&a",
    "supply chain",
    "customer concentration",
    "export control",
    "climate",
    "cybersecurity",
    "warranty",
    "indemnif",
    "license grant",
    "patent grant",
    "copyleft",
    "distribut",
)


def _section_boost(hits: list[Any], question: str) -> tuple[list[Any], int]:
    """Mirror engine.py's section-boost logic exactly (D)."""
    q_low = question.lower()
    matchers = [p for p in _SECTION_PHRASES if p in q_low]
    if not matchers or not hits:
        return hits, 0

    def _score(h: Any) -> float:
        title = (h.metadata.get("section_title") or "").lower()
        if not title:
            return 0.0
        return float(sum(1 for p in matchers if p in title))

    sorted_hits = sorted(hits, key=lambda h: (_score(h), h.score), reverse=True)
    boosted = sum(1 for h in sorted_hits[: min(8, len(sorted_hits))] if _score(h) > 0)
    return sorted_hits, boosted


def _file_match(citation_file: str, expected: list[str]) -> bool:
    cf = (citation_file or "").lower()
    return any(e.lower() in cf or cf in e.lower() for e in expected)


def _citation_pr(
    predicted_files: list[str], expected_files: list[str]
) -> tuple[float, float, float]:
    if not expected_files:
        return 1.0, 1.0, 1.0
    if not predicted_files:
        return 0.0, 0.0, 0.0
    matched_predicted = sum(1 for f in predicted_files if _file_match(f, expected_files))
    precision = matched_predicted / len(predicted_files)
    matched_expected = sum(
        1 for e in expected_files if any(_file_match(f, [e]) for f in predicted_files)
    )
    recall = matched_expected / max(len(expected_files), 1)
    f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0
    return precision, recall, f1


async def _resolve_filenames(file_ids: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for fid in set(file_ids):
        if not fid:
            continue
        f = await repo.get_file(fid)
        if f:
            out[fid] = f.get("filename", "") or ""
    return out


async def _run(args: argparse.Namespace) -> int:
    ds = yaml.safe_load(Path(args.dataset).read_text())
    questions = ds["questions"]

    cfg = pipeline.pipeline_config(args.domain)
    top_k_dense = int(pipeline.get(cfg, "retrieve.top_k_dense", 25))
    top_k_sparse = int(pipeline.get(cfg, "retrieve.top_k_sparse", 25))
    rerank_top_k = int(pipeline.get(cfg, "retrieve.rerank_top_k", 10))

    store = get_store()
    await store.ensure_collection(args.domain)

    scores: list[Score] = []
    for item in questions:
        qid = item["id"]
        question = item["question"]
        tags = item.get("tags", [])
        expected_files = item.get("expected_files", [])

        try:
            hits = await store.hybrid_search(
                args.domain,
                question,
                top_k_dense=top_k_dense,
                top_k_sparse=top_k_sparse,
                rerank_top_k=rerank_top_k,
                filters={"project": args.project},
            )
            if hits:
                hits = await cross_rerank(question, hits, top_k=max(rerank_top_k, 8))
            if os.environ.get("KB_DISABLE_SECTION_BOOST"):
                boosted = 0
            else:
                hits, boosted = _section_boost(hits, question)
            hits = hits[:rerank_top_k]
        except Exception as e:
            print(f"[red]{qid} retrieve error: {e}[/red]")
            scores.append(Score(qid, question, tags, 0.0, 0.0, 0.0, [], 0))
            continue

        file_ids = [h.metadata.get("file_id") for h in hits if h.metadata.get("file_id")]
        fid_to_name = await _resolve_filenames(file_ids)
        top_files = [fid_to_name.get(fid, "") for fid in file_ids if fid_to_name.get(fid)]
        # Dedup preserving order
        seen: set[str] = set()
        unique_top_files = []
        for f in top_files:
            if f in seen:
                continue
            seen.add(f)
            unique_top_files.append(f)

        p, rec, f1 = _citation_pr(unique_top_files, expected_files)
        scores.append(Score(qid, question, tags, p, rec, f1, unique_top_files, boosted))

    table = Table(title=f"Retrieval-only eval — {args.domain} ({len(scores)} questions)")
    table.add_column("qid", style="cyan")
    table.add_column("cit P", justify="right")
    table.add_column("cit R", justify="right")
    table.add_column("cit F1", justify="right")
    table.add_column("§boost", justify="right")
    for s in scores:
        table.add_row(
            s.qid,
            f"{s.citation_precision:.2f}",
            f"{s.citation_recall:.2f}",
            f"{s.citation_f1:.2f}",
            str(s.section_boost_hits),
        )
    print(table)

    summary = {
        "project": args.project,
        "domain": args.domain,
        "n": len(scores),
        "mode": "retrieval_only",
        "mean_citation_precision": statistics.mean(s.citation_precision for s in scores)
        if scores
        else 0,
        "mean_citation_recall": statistics.mean(s.citation_recall for s in scores) if scores else 0,
        "mean_citation_f1": statistics.mean(s.citation_f1 for s in scores) if scores else 0,
        "section_boost_total_hits": sum(s.section_boost_hits for s in scores),
        "scores": [asdict(s) for s in scores],
    }

    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(summary, indent=2))
    print(f"[green]report written[/green] {args.output}")
    print(f"mean citation F1: {summary['mean_citation_f1']:.3f}")
    print(f"mean citation P:  {summary['mean_citation_precision']:.3f}")
    print(f"mean citation R:  {summary['mean_citation_recall']:.3f}")
    return 0


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--project", default="default")
    p.add_argument("--domain", required=True)
    p.add_argument("--dataset", required=True)
    p.add_argument("--output", default="retrieval_only_eval.json")
    args = p.parse_args()
    raise SystemExit(asyncio.run(_run(args)))


if __name__ == "__main__":
    main()
