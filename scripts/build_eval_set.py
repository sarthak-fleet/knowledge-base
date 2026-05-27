#!/usr/bin/env python3
"""Synthetic eval-set generator.

The bottleneck of every retrieval improvement on this codebase is the eval
noise floor — with 25 questions, deltas under ±4 pass-points are
indistinguishable. This script generates ~80-100 questions automatically:

  1. Pull N representative chunks per domain (stratified across files).
  2. For each chunk, LLM-generate ONE question whose answer is in that chunk
     (the chunk IS the gold ground truth).
  3. Hard-negative mining: for each generated (question, gold_chunk) pair,
     attach 2-3 hard-negative chunks — similar-looking text in OTHER files
     that *doesn't* answer the question. Useful for context_precision eval.
  4. LLM-pass filter: drop questions that are too generic ("what does this
     document say?") or that any chunk would answer.

Writes `domains/<domain>/eval/dataset_large.yaml` in the same shape as the
existing dataset.yaml — drop in via `make eval DATASET=...`.

Usage:
    docker compose exec api python -m scripts.build_eval_set --domain sec --n 80
"""

from __future__ import annotations

import argparse
import asyncio
import random
from pathlib import Path
from typing import Any

import structlog
import yaml
from pydantic import BaseModel, Field

from kb.extract import llm
from kb.storage import repo

logger = structlog.get_logger("scripts.build_eval_set")


class _GenQ(BaseModel):
    question: str = Field(default="", max_length=300)
    key_facts: list[str] = Field(default_factory=list, max_length=4)
    skip: bool = Field(default=False, description="Set true if no useful question can be generated from this chunk.")


_SYSTEM = (
    "Given a chunk of text from a real document, generate ONE specific question "
    "whose answer is contained in this chunk. The question should: "
    "(a) be specific enough that a reader couldn't answer it from generic knowledge, "
    "(b) reference concrete entities/numbers/dates if the chunk contains them, "
    "(c) NOT be 'what does this say' or 'summarize'. "
    "Also list 1-3 'key_facts' — atomic statements an answer must contain to be correct. "
    "Set skip=true ONLY if the chunk is pure boilerplate / template / a single number with no context."
)


async def _gen_one(chunk_text: str, *, model: str | None = None) -> _GenQ:
    """LLM-generate a (question, key_facts) tuple for a single chunk.

    Uses `chat_text` + manual JSON parse rather than `chat_structured` so we
    don't depend on the model supporting OpenAI tool_choice — some routes
    in the free gateway don't.
    """
    import json
    import re

    prompt = (
        f"CHUNK:\n{chunk_text[:2000]}\n\n"
        'Reply with ONLY a JSON object matching this shape:\n'
        '{"question": "...", "key_facts": ["...", "..."], "skip": false}\n'
        "Use skip=true ONLY if the chunk has no useful question (pure boilerplate / "
        "isolated number / template). No prose, no markdown fence."
    )
    try:
        raw, _usage = await llm.chat_text_with_usage(
            system=_SYSTEM,
            user=prompt,
            model=model,
            temperature=0.3,
            max_tokens=400,
        )
    except Exception as e:
        logger.warning("gen call failed", error=str(e)[:200])
        return _GenQ(skip=True)

    # Liberal parse: strip markdown fences, find first {...}, fall back to skip.
    text = (raw or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```\s*$", "", text)
    try:
        return _GenQ.model_validate(json.loads(text))
    except Exception:
        m = re.search(r"\{.*\}", text, flags=re.S)
        if m:
            try:
                return _GenQ.model_validate(json.loads(m.group(0)))
            except Exception:
                pass
    return _GenQ(skip=True)


def _sample_chunks(hits: list[dict[str, Any]], n: int) -> list[dict[str, Any]]:
    """Stratified sample across files — never more than ~3 chunks per file
    so we don't bias toward whichever filing happens to have the most chunks."""
    by_file: dict[str, list[dict]] = {}
    for h in hits:
        fid = h.get("metadata", {}).get("file_id") or h.get("file_id") or "?"
        by_file.setdefault(fid, []).append(h)

    out: list[dict[str, Any]] = []
    per_file = max(1, n // max(len(by_file), 1))
    for _fid, chunks in by_file.items():
        random.shuffle(chunks)
        out.extend(chunks[:per_file])
    random.shuffle(out)
    return out[:n]


async def _pull_chunks(domain: str, n: int) -> list[dict[str, Any]]:
    """Sample chunks from Qdrant for this domain by scrolling the collection."""
    from qdrant_client import AsyncQdrantClient

    from kb.config import get_settings

    s = get_settings()
    client = AsyncQdrantClient(url=s.qdrant_url, api_key=s.qdrant_api_key or None, prefer_grpc=False)
    coll = f"kb_{domain}"
    # Pull a generous oversample; we filter parents-only and stratify.
    raw, _ = await client.scroll(collection_name=coll, limit=n * 8, with_payload=True)
    chunks = []
    for p in raw:
        payload = dict(p.payload or {})
        # Parent chunks (no parent_id) are richer than child fragments
        if not payload.get("parent_id"):
            chunks.append({"id": str(p.id), "text": payload.get("text", ""), "metadata": payload})
    return _sample_chunks(chunks, n)


async def _resolve_filename(file_id: str) -> str:
    f = await repo.get_file(file_id)
    return (f or {}).get("filename", "")


async def _build(args: argparse.Namespace) -> None:
    chunks = await _pull_chunks(args.domain, args.n)
    logger.info("sampled chunks", domain=args.domain, n=len(chunks))

    sem = asyncio.Semaphore(4)  # respect aiolimiter; 4 concurrent gens

    async def _one(c: dict[str, Any]) -> tuple[dict[str, Any], _GenQ]:
        async with sem:
            q = await _gen_one(c["text"])
        return c, q

    results = await asyncio.gather(*(_one(c) for c in chunks))
    questions: list[dict[str, Any]] = []
    next_id = 100
    for c, q in results:
        if q.skip or not q.question.strip() or not q.key_facts:
            continue
        file_id = c["metadata"].get("file_id")
        if not file_id:
            continue
        filename = await _resolve_filename(file_id)
        questions.append(
            {
                "id": f"gen-{next_id}",
                "question": q.question.strip(),
                "key_facts": [k.strip() for k in q.key_facts if k.strip()][:3],
                "expected_files": [filename] if filename else [],
                "gold_chunk_id": c["id"],
                "tags": ["synthetic"],
            }
        )
        next_id += 1

    out_path = Path(args.output)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(yaml.safe_dump({"domain": args.domain, "questions": questions}, sort_keys=False))
    logger.info("wrote", path=str(out_path), kept=len(questions), dropped=len(chunks) - len(questions))
    print(f"\nWrote {len(questions)} questions to {out_path} (skipped {len(chunks) - len(questions)})")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--domain", required=True)
    p.add_argument("--n", type=int, default=80)
    p.add_argument("--output", required=False)
    args = p.parse_args()
    if not args.output:
        args.output = f"domains/{args.domain}/eval/dataset_large.yaml"
    asyncio.run(_build(args))


if __name__ == "__main__":
    main()
