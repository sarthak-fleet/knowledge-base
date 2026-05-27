"""RAGAS-style metrics — implemented inline so we don't depend on the heavy `ragas` lib.

Why inline? `ragas` pulls in datasets + langchain + multiple transformers; we
already have OpenAI-compatible LLM access via `kb.extract.llm`. The prompts
below are the same shape RAGAS uses in their reference implementation
(https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/), simplified
for OpenAI-compatible JSON output.

Four metrics, all scored ∈ [0, 1] and produced by LLM-as-judge over the trace:

  faithfulness         every claim in the answer is supported by the retrieved chunks
  context_precision    fraction of retrieved chunks that were actually useful
  context_recall       fraction of ground-truth key_facts found across the retrieved chunks
  answer_relevance     how well the answer addresses the question (vs. tangential / refusal)

Reference papers:
  - RAGAS: arXiv 2309.15217 (Es et al. 2023)
  - FActScore (faithfulness lineage): arXiv 2305.14251 (Min et al. 2023)
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

import httpx
import structlog

logger = structlog.get_logger("kb.eval.ragas")


@dataclass
class RagasScores:
    faithfulness: float
    context_precision: float
    context_recall: float
    answer_relevance: float

    def overall(self) -> float:
        return (self.faithfulness + self.context_precision + self.context_recall + self.answer_relevance) / 4


_FAITHFULNESS_SYSTEM = (
    "You decide if every claim in an answer is grounded in the provided sources. "
    "Decompose the answer into atomic claims. For each claim, decide if the sources "
    "support it (supported=true) or not (supported=false). "
    "Be conservative: a claim is supported only if a source textually contains or "
    "directly implies it. "
    'Return JSON: {"claims": [{"claim":"...","supported":bool}, ...]}.'
)

_CONTEXT_PRECISION_SYSTEM = (
    "You decide which retrieved chunks were actually relevant to the question. "
    "For each numbered chunk, mark `relevant: true` if it contains information "
    "useful for answering the question, otherwise false. "
    'Return JSON: {"chunks": [{"id": 1, "relevant": bool}, ...]}.'
)

_CONTEXT_RECALL_SYSTEM = (
    "You decide which of the gold key_facts are recoverable from the retrieved chunks. "
    "For each fact, mark `recoverable: true` if at least one chunk contains or directly implies it. "
    'Return JSON: {"facts": [{"fact":"...","recoverable": bool}, ...]}.'
)

_ANSWER_RELEVANCE_SYSTEM = (
    "You decide how well an answer addresses a question, IGNORING whether it's factually correct. "
    "Score 0.0 (irrelevant / off-topic / refusal-when-answer-exists) to 1.0 "
    "(directly addresses the question, even if briefly). "
    'Return JSON: {"score": 0.0-1.0, "reason": "..."}.'
)


def _coerce_json(text: str) -> dict:
    """Be liberal: strip fences, find first {...}, default to {}."""
    import re
    t = (text or "").strip()
    if t.startswith("```"):
        t = re.sub(r"^```(?:json)?\s*", "", t)
        t = re.sub(r"\s*```\s*$", "", t)
    try:
        return json.loads(t)
    except Exception:
        m = re.search(r"\{.*\}", t, flags=re.S)
        if m:
            try:
                return json.loads(m.group(0))
            except Exception:
                pass
    return {}


async def _call(client: httpx.AsyncClient, *, base: str, key: str | None, model: str, system: str, user: str) -> dict:
    import os as _os
    payload = {
        "model": model,
        "temperature": 0.0,
        "max_tokens": 800,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }
    project_id = _os.environ.get("AI_PROJECT_ID")
    if project_id:
        payload["project_id"] = project_id
    headers = {"Authorization": f"Bearer {key}"} if key else {}

    from kb.extract.llm import cache_get, cache_key, cache_put
    ck = cache_key(model=model, system=system, user=user, params={"kind": "ragas", "t": 0.0, "max": 800})
    hit = cache_get(ck)
    if hit is not None:
        return hit.get("data", {})

    try:
        r = await client.post(f"{base}/chat/completions", json=payload, headers=headers, timeout=120)
        r.raise_for_status()
        body = r.json()
        out = _coerce_json(body["choices"][0]["message"]["content"] or "")
        cache_put(ck, {"data": out})
        return out
    except Exception as e:
        logger.info("ragas LLM call failed: %s", e)
        return {}


def _format_chunks(chunks: list[dict[str, Any]]) -> str:
    return "\n\n".join(
        f"[{i+1}] {c.get('text','') or c.get('excerpt','')}"[:1200]
        for i, c in enumerate(chunks)
    )


async def score_ragas(
    *,
    client: httpx.AsyncClient,
    base: str,
    key: str | None,
    model: str,
    question: str,
    answer: str,
    chunks: list[dict[str, Any]],
    key_facts: list[str],
) -> RagasScores:
    """Compute RAGAS-style faithfulness + context_precision + context_recall + answer_relevance.

    On any per-metric failure, that metric defaults to 0.0 — never raises.
    """
    if not answer.strip():
        return RagasScores(0.0, 0.0, 0.0, 0.0)

    chunks_block = _format_chunks(chunks)

    # 1) Faithfulness
    fa = await _call(
        client, base=base, key=key, model=model,
        system=_FAITHFULNESS_SYSTEM,
        user=f"ANSWER:\n{answer}\n\nSOURCES:\n{chunks_block}",
    )
    # Defensive guard: some weaker models (e.g. gemini-2.5-flash-lite) return
    # `chunks: ["..", ".."]` (list of strings) instead of `[{"relevant": ...}]`.
    # Skip non-dict items rather than crashing the whole eval.
    claims = [c for c in (fa.get("claims") or []) if isinstance(c, dict)]
    faithfulness = (
        sum(1 for c in claims if c.get("supported")) / len(claims)
        if claims else 0.0
    )

    # 2) Context precision
    cp = await _call(
        client, base=base, key=key, model=model,
        system=_CONTEXT_PRECISION_SYSTEM,
        user=f"QUESTION:\n{question}\n\nCHUNKS:\n{chunks_block}",
    )
    items = [c for c in (cp.get("chunks") or []) if isinstance(c, dict)]
    context_precision = (
        sum(1 for c in items if c.get("relevant")) / len(items)
        if items else 0.0
    )

    # 3) Context recall — only meaningful when key_facts are provided
    if key_facts and chunks:
        cr = await _call(
            client, base=base, key=key, model=model,
            system=_CONTEXT_RECALL_SYSTEM,
            user=f"KEY_FACTS:\n{json.dumps(key_facts)}\n\nCHUNKS:\n{chunks_block}",
        )
        facts = [f for f in (cr.get("facts") or []) if isinstance(f, dict)]
        context_recall = (
            sum(1 for f in facts if f.get("recoverable")) / len(facts)
            if facts else 0.0
        )
    else:
        context_recall = 1.0 if not key_facts else 0.0

    # 4) Answer relevance
    ar = await _call(
        client, base=base, key=key, model=model,
        system=_ANSWER_RELEVANCE_SYSTEM,
        user=f"QUESTION:\n{question}\n\nANSWER:\n{answer}",
    )
    try:
        answer_relevance = float(ar.get("score", 0.0))
    except (TypeError, ValueError):
        answer_relevance = 0.0
    answer_relevance = max(0.0, min(1.0, answer_relevance))

    return RagasScores(faithfulness, context_precision, context_recall, answer_relevance)
