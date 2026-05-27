"""Corrective RAG (CRAG) retrieval evaluator.

Inspired by Yan et al. 2024 (arXiv 2401.15884): score retrieval QUALITY before
synthesis. If the top chunks don't actually answer the question, refuse early
rather than letting the synthesizer fabricate from noise.

We implement the lightweight evaluator only — no web/fallback retrieval. The
signal is used to:
  - downgrade confidence proactively
  - skip synthesis on clearly-noise retrievals (refuse upfront)
"""

from __future__ import annotations

import logging
from typing import Any

from kb.extract import llm

logger = logging.getLogger("kb.query.crag")


_EVAL_SYSTEM = (
    "You score whether a set of retrieved chunks contains enough information "
    "to answer a user's question. Output ONE float between 0 and 1: "
    "  1.0  = the chunks directly answer the question, "
    "  0.5  = partial / requires inference, "
    "  0.0  = chunks are unrelated to the question. "
    "Return JSON only: {\"score\": 0.0-1.0, \"reason\": \"...\"}."
)

_EVAL_SCHEMA = {
    "type": "object",
    "properties": {
        "score": {"type": "number"},
        "reason": {"type": "string"},
    },
    "required": ["score", "reason"],
    "additionalProperties": False,
}


def _format_chunks(chunks: list[dict[str, Any]], max_n: int = 6, max_chars: int = 800) -> str:
    out = []
    for i, h in enumerate(chunks[:max_n], 1):
        text = (h.get("text") or "")[:max_chars]
        out.append(f"[{i}] {text}")
    return "\n\n".join(out)


async def evaluate_retrieval(
    *, question: str, chunks: list[dict[str, Any]], model: str | None = None,
) -> tuple[float, str]:
    """Score retrieval quality. Returns (score, reason). On failure: (1.0, "skipped")."""
    if not chunks:
        return 0.0, "no chunks retrieved"
    try:
        resp = await llm.chat_json(
            system=_EVAL_SYSTEM,
            user=f"QUESTION:\n{question}\n\nCHUNKS:\n{_format_chunks(chunks)}",
            schema=_EVAL_SCHEMA,
            model=model,
            temperature=0.0,
            max_tokens=400,
            timeout_s=30,
        )
        score = float(resp.get("score", 1.0))
        reason = str(resp.get("reason", ""))[:200]
        return max(0.0, min(1.0, score)), reason
    except Exception as e:
        logger.info("CRAG evaluator skipped (%s)", e)
        return 1.0, "evaluator unavailable; assume OK"
