"""Query rewriting: LLM expands one question into N retrieval-optimised variants.

Why: question vocabulary often doesn't match document vocabulary. "What does
Apple disclose about supply chain concentration?" might be phrased in 10-Ks
as "single source supplier risk" or "manufacturing concentration in Asia".
Multi-query rewriting + RRF over the retrieval results catches both surface
forms.

Also includes HyDE (Hypothetical Document Embeddings, Gao 2022): generate a
fake answer and embed THAT. Helps zero-shot dense retrieval when the question
is short and the answer in the corpus is long.

References:
  - Multi-query retrieval: LangChain MultiQueryRetriever, LlamaIndex MultiStepQueryEngine
  - HyDE: arXiv 2212.10496 (Gao et al. 2022)
"""

from __future__ import annotations

import logging

from pydantic import BaseModel, Field

from kb.extract import llm

logger = logging.getLogger("kb.query.rewriter")

_REWRITE_SYSTEM = (
    "You expand one user question into multiple search-friendly rephrasings. "
    "Each rephrasing should: (a) preserve the user's intent, (b) substitute "
    "domain-typical vocabulary when possible (e.g. 'single source supplier' "
    "instead of 'supply chain concentration'), (c) be a self-contained "
    "question/phrase a retriever could match against documents."
)


class _RewriteResponse(BaseModel):
    variants: list[str] = Field(default_factory=list, max_length=5)


async def rewrite_query(question: str, *, n: int = 3, model: str | None = None) -> list[str]:
    """Return up to `n` retrieval variants of the question, INCLUDING the original.

    On any failure, returns just the original question. Variants are deduped.
    """
    if n <= 1:
        return [question]
    user = (
        f"Question: {question}\n\n"
        f"Produce exactly {n - 1} additional rephrasings (so {n} total including the original). "
        f"Vary vocabulary, especially substituting domain-typical terms when applicable."
    )
    try:
        resp = await llm.chat_structured(
            system=_REWRITE_SYSTEM,
            user=user,
            response_model=_RewriteResponse,
            model=model,
            temperature=0.3,
            max_tokens=400,
            timeout_s=30,
        )
    except Exception as e:
        logger.info("query rewrite failed (%s); using original only", e)
        return [question]

    out = [question]
    for v in resp.variants[: n - 1]:
        v = v.strip()
        if v and v.lower() != question.lower() and v not in out:
            out.append(v)
    return out


_HYDE_SYSTEM = (
    "Write one or two sentences that would PLAUSIBLY appear in the corpus "
    "answering the user's question. Don't worry about being factually correct; "
    "the goal is to produce text whose embedding sits close to a real answer "
    "in the document collection. Output the sentence(s) directly, no preamble."
)


async def hyde_passage(question: str, *, model: str | None = None) -> str:
    """Return a hypothetical answer passage for use as a query embedding.

    Returns the original question on failure (safe fallback).
    """
    try:
        text, _ = await llm.chat_text_with_usage(
            system=_HYDE_SYSTEM,
            user=f"Question: {question}",
            model=model,
            temperature=0.3,
            max_tokens=400,
        )
    except Exception as e:
        logger.info("HyDE generation failed (%s); using original", e)
        return question
    text = (text or "").strip()
    return text or question


_DECOMP_SYSTEM = (
    "Decide whether the question is COMPOUND (requires looking up multiple "
    "separable sub-questions and combining the results). If compound, split "
    "into 2-4 atomic sub-questions. If not compound, return the original as "
    "a single-element list."
)


class _DecompResponse(BaseModel):
    is_compound: bool = False
    sub_questions: list[str] = Field(default_factory=list, max_length=4)


async def decompose_query(question: str, *, model: str | None = None) -> tuple[bool, list[str]]:
    """Decompose a compound question into sub-questions.

    Returns (is_compound, sub_questions). Falls back to (False, [question]).
    """
    try:
        resp = await llm.chat_structured(
            system=_DECOMP_SYSTEM,
            user=f"Question: {question}",
            response_model=_DecompResponse,
            model=model,
            temperature=0.0,
            max_tokens=400,
            timeout_s=30,
        )
    except Exception as e:
        logger.info("decomposition failed (%s); single-shot", e)
        return False, [question]

    subs = [s.strip() for s in resp.sub_questions if s and s.strip()]
    if not resp.is_compound or not subs:
        return False, [question]
    return True, subs[:4]


def fuse_rrf(rankings: list[list[str]], *, k: int = 60) -> list[tuple[str, float]]:
    """Reciprocal Rank Fusion across multiple ranked lists of chunk IDs.

    Returns sorted [(chunk_id, rrf_score)] by score descending.
    """
    scores: dict[str, float] = {}
    for ranks in rankings:
        for i, chunk_id in enumerate(ranks):
            scores[chunk_id] = scores.get(chunk_id, 0.0) + 1.0 / (k + i + 1)
    return sorted(scores.items(), key=lambda x: x[1], reverse=True)
