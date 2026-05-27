"""Run an eval dataset through the live API and score answers.

Scoring rubric:
  - **Citation precision/recall**: cited file(s) (filenames or substrings) vs `expected_files`,
    plus optional `expected_pages` overlap if both sides supply them.
  - **Answer correctness**: LLM judge with strict prompt — does the answer assert the
    `key_facts` and not contradict them? Returns pass/fail + a short rationale.

Outputs:
  - JSON report at eval_report.json
  - Markdown summary on stdout

Usage:
  docker compose exec api python -m kb.eval.run --domain sec --dataset domains/sec/eval/dataset.yaml
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

import httpx
import yaml
from rich import print
from rich.table import Table


@dataclass
class Score:
    qid: str
    question: str
    tags: list[str]
    citation_precision: float
    citation_recall: float
    citation_f1: float
    answer_pass: bool
    confidence: float
    judge_reason: str
    answer: str
    citations: list[dict[str, Any]]
    # RAGAS-style metrics. Default 0.0 if not computed.
    ragas_faithfulness: float = 0.0
    ragas_context_precision: float = 0.0
    ragas_context_recall: float = 0.0
    ragas_answer_relevance: float = 0.0


def _file_match(citation_file: str, expected: list[str]) -> bool:
    cf = citation_file.lower()
    return any(e.lower() in cf or cf in e.lower() for e in expected)


def _citation_pr(predicted: list[dict], expected_files: list[str]) -> tuple[float, float, float]:
    # Negative-case semantics: expected_files=[] means "no specific source is expected".
    # The system either refuses (no citations) or correctly cites the documents it looked at.
    # Either way, citation precision/recall is not the load-bearing metric for the negative
    # case — the LLM judge over `key_facts` is. Mark P/R/F1 as 1.0 so the averages aren't
    # polluted by negative cases.
    if not expected_files:
        return 1.0, 1.0, 1.0
    if not predicted:
        return 0.0, 0.0, 0.0
    matched_predicted = sum(1 for c in predicted if _file_match(c.get("filename", ""), expected_files))
    precision = matched_predicted / len(predicted)
    matched_expected = sum(1 for e in expected_files if any(_file_match(c.get("filename", ""), [e]) for c in predicted))
    recall = matched_expected / max(len(expected_files), 1)
    f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) else 0.0
    return precision, recall, f1


JUDGE_SYSTEM = (
    "You are a strict grader. Given a question, the model's answer, and the gold key facts, "
    "decide whether the answer is faithful to the key facts. Respond with JSON: "
    '{"pass": true|false, "reason": "..."} — pass=true ONLY if every key fact is supported by '
    "the answer (paraphrase OK) and the answer does not contradict any key fact."
)


def _coerce_judge_json(text: str) -> dict:
    """Be liberal in what we accept: strip fences, find the first JSON object, fall back to regex."""
    import re

    t = text.strip()
    # Strip ```json … ``` fences
    if t.startswith("```"):
        t = re.sub(r"^```(?:json)?\s*", "", t)
        t = re.sub(r"\s*```$", "", t)
    # Try direct parse
    try:
        return json.loads(t)
    except Exception:
        pass
    # Find the first balanced {...} block
    m = re.search(r"\{.*\}", t, flags=re.S)
    if m:
        try:
            return json.loads(m.group(0))
        except Exception:
            pass
    # Last resort: regex for pass + reason
    lower = t.lower()
    passed = "true" in lower[lower.find("pass"):lower.find("pass") + 32] if "pass" in lower else False
    rm = re.search(r'reason["\s:]+([^"]{1,200})', t, flags=re.I)
    return {"pass": passed, "reason": rm.group(1) if rm else "could not parse judge output"}


async def _judge(client: httpx.AsyncClient, *, base: str, key: str | None, model: str, question: str, answer: str, key_facts: list[str]) -> tuple[bool, str]:
    payload = {
        "model": model,
        "temperature": 0.0,
        "max_tokens": 512,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": JUDGE_SYSTEM},
            {
                "role": "user",
                "content": json.dumps(
                    {"question": question, "answer": answer, "key_facts": key_facts}
                ),
            },
        ],
    }
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    try:
        r = await client.post(f"{base}/chat/completions", json=payload, headers=headers, timeout=120)
        r.raise_for_status()
        body = r.json()
        content = body["choices"][0]["message"]["content"] or ""
        j = _coerce_judge_json(content)
        return bool(j.get("pass")), str(j.get("reason", ""))[:300]
    except Exception as e:
        return False, f"judge_error: {e}"


async def _run(args: argparse.Namespace) -> int:
    ds_path = Path(args.dataset)
    ds = yaml.safe_load(ds_path.read_text())
    api = os.environ.get("KB_API_URL", "http://api:8000")
    ai_base = os.environ.get("AI_BASE_URL", "https://api.deepseek.com/v1")
    ai_key = os.environ.get("AI_API_KEY")
    # Use a cheaper judge model if KB_JUDGE_MODEL is set, otherwise fall back.
    ai_model = os.environ.get("KB_JUDGE_MODEL") or os.environ.get("AI_MODEL", "deepseek-chat")

    scores: list[Score] = []
    async with httpx.AsyncClient() as client:
        for item in ds["questions"]:
            qid = item["id"]
            question = item["question"]
            tags: list[str] = item.get("tags", [])
            expected_files: list[str] = item.get("expected_files", [])
            key_facts: list[str] = item.get("key_facts", [])
            scope = item.get("scope") or None
            filters = item.get("filters") or None
            try:
                r = await client.post(
                    f"{api}/query",
                    json={"domain": args.domain, "question": question, "scope": scope, "filters": filters},
                    timeout=180,
                )
                r.raise_for_status()
                out = r.json()
            except Exception as e:
                print(f"[red]{qid} request error: {e}[/red]")
                scores.append(Score(qid, question, tags, 0, 0, 0, False, 0.0, f"query_error: {e}", "", []))
                continue

            citations = out.get("citations", [])
            retrieved = out.get("retrieved", [])
            p, rec, f1 = _citation_pr(citations, expected_files)
            ok, reason = (False, "no key_facts provided")
            if key_facts:
                ok, reason = await _judge(client, base=ai_base, key=ai_key, model=ai_model, question=question, answer=out.get("answer", ""), key_facts=key_facts)

            ragas_scores = None
            if args.ragas:
                from kb.eval.ragas import score_ragas
                ragas_scores = await score_ragas(
                    client=client, base=ai_base, key=ai_key, model=ai_model,
                    question=question, answer=out.get("answer", ""),
                    chunks=retrieved, key_facts=key_facts,
                )

            scores.append(
                Score(
                    qid=qid,
                    question=question,
                    tags=tags,
                    citation_precision=p,
                    citation_recall=rec,
                    citation_f1=f1,
                    answer_pass=ok,
                    confidence=float((out.get("confidence") or {}).get("value", 0.0)),
                    judge_reason=reason,
                    answer=out.get("answer", ""),
                    citations=citations,
                    ragas_faithfulness=ragas_scores.faithfulness if ragas_scores else 0.0,
                    ragas_context_precision=ragas_scores.context_precision if ragas_scores else 0.0,
                    ragas_context_recall=ragas_scores.context_recall if ragas_scores else 0.0,
                    ragas_answer_relevance=ragas_scores.answer_relevance if ragas_scores else 0.0,
                )
            )

    # Report
    table = Table(title=f"Eval — {args.domain} ({len(scores)} questions)")
    table.add_column("qid", style="cyan")
    table.add_column("cit P", justify="right")
    table.add_column("cit R", justify="right")
    table.add_column("cit F1", justify="right")
    table.add_column("ans", justify="center")
    table.add_column("conf", justify="right")
    for s in scores:
        table.add_row(s.qid, f"{s.citation_precision:.2f}", f"{s.citation_recall:.2f}", f"{s.citation_f1:.2f}", "✓" if s.answer_pass else "✗", f"{s.confidence:.2f}")
    print(table)

    # Per-tag breakdown — surfaces strengths/weaknesses per question category.
    by_tag: dict[str, dict[str, float]] = {}
    for s in scores:
        for t in (s.tags or ["untagged"]):
            slot = by_tag.setdefault(t, {"n": 0, "pass": 0, "cit_f1_sum": 0.0})
            slot["n"] += 1
            slot["pass"] += 1 if s.answer_pass else 0
            slot["cit_f1_sum"] += s.citation_f1
    per_tag = {
        t: {
            "n": int(v["n"]),
            "pass_rate": v["pass"] / v["n"] if v["n"] else 0.0,
            "mean_citation_f1": v["cit_f1_sum"] / v["n"] if v["n"] else 0.0,
        }
        for t, v in by_tag.items()
    }
    print()
    tag_tbl = Table(title="Per-category breakdown")
    tag_tbl.add_column("tag", style="cyan")
    tag_tbl.add_column("n", justify="right")
    tag_tbl.add_column("pass %", justify="right")
    tag_tbl.add_column("cit F1", justify="right")
    for t, v in sorted(per_tag.items(), key=lambda x: -x[1]["n"]):
        tag_tbl.add_row(t, str(v["n"]), f"{v['pass_rate']*100:.1f}", f"{v['mean_citation_f1']:.2f}")
    print(tag_tbl)

    summary = {
        "domain": args.domain,
        "n": len(scores),
        "mean_citation_precision": statistics.mean(s.citation_precision for s in scores) if scores else 0,
        "mean_citation_recall": statistics.mean(s.citation_recall for s in scores) if scores else 0,
        "mean_citation_f1": statistics.mean(s.citation_f1 for s in scores) if scores else 0,
        "answer_pass_rate": sum(1 for s in scores if s.answer_pass) / max(len(scores), 1),
        "mean_confidence": statistics.mean(s.confidence for s in scores) if scores else 0,
        "per_tag": per_tag,
        "scores": [asdict(s) for s in scores],
    }
    if args.ragas and scores:
        summary["ragas"] = {
            "faithfulness":      statistics.mean(s.ragas_faithfulness for s in scores),
            "context_precision": statistics.mean(s.ragas_context_precision for s in scores),
            "context_recall":    statistics.mean(s.ragas_context_recall for s in scores),
            "answer_relevance":  statistics.mean(s.ragas_answer_relevance for s in scores),
        }
        ragas_tbl = Table(title="RAGAS-style metrics")
        ragas_tbl.add_column("metric", style="cyan")
        ragas_tbl.add_column("score", justify="right")
        for k, v in summary["ragas"].items():
            ragas_tbl.add_row(k, f"{v:.3f}")
        print(ragas_tbl)
    out_path = Path(args.output)
    out_path.write_text(json.dumps(summary, indent=2))
    print(f"[green]report written[/green] {out_path}")
    print(f"citation F1: {summary['mean_citation_f1']:.3f}")
    print(f"answer pass rate: {summary['answer_pass_rate']:.3f}")
    return 0


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--domain", required=True)
    p.add_argument("--dataset", required=True)
    p.add_argument("--output", default="eval_report.json")
    p.add_argument("--ragas", action="store_true", help="Compute RAGAS-style metrics (faithfulness, context_precision, context_recall, answer_relevance)")
    args = p.parse_args()
    raise SystemExit(asyncio.run(_run(args)))


if __name__ == "__main__":
    main()
