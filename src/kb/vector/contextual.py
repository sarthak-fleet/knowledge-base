"""Contextual Retrieval — Anthropic, Sep 2024.

https://www.anthropic.com/news/contextual-retrieval

For each chunk we want to index, ask an LLM for a 1-2 sentence "situational
prefix" describing where this chunk sits in the parent document (which company /
filing / section / period it pertains to). Prepend that prefix to the chunk
text BEFORE embedding + lexical indexing.

Anthropic reports:
  -49% retrieval failure rate vs. plain dense+BM25
  -67% with cross-encoder rerank added on top

Implementation notes (deviating from Anthropic's blog for reasons):
  - We batch by parent document — one system message per document is shared
    across all its chunks. With prompt caching this is effectively free per chunk.
  - We use the cheaper LLM (extract model = synthesize fallback), not the
    expensive one. Anthropic suggests Haiku; DeepSeek-v4-flash is our equivalent.
  - We do NOT modify the original chunk text stored as `payload.text` (the
    excerpt the user sees). The contextual prefix is used ONLY for
    embedding + sparse search; the verbatim text stays clean for citations.
  - Best-effort: failures degrade gracefully to the bare chunk text.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass

import structlog

from kb.extract import llm

logger = structlog.get_logger("kb.vector.contextual")

# How much of the parent document to show the contextualiser. Anthropic relies on
# prompt caching to make the parent doc essentially free; we cap it for cost +
# context-window safety.
_PARENT_DOC_MAX_CHARS = 12_000

_CONTEXT_SYSTEM = (
    "You are a document indexing assistant. Given a parent document and one "
    "of its chunks, write a single short sentence (max 30 words) that situates "
    "the chunk inside the document. Mention the most-specific scope you can "
    "infer from the chunk + parent doc (which company, filing type, section, "
    "fiscal period, license name, contract party, etc.). "
    "Do NOT restate the chunk's content. Do NOT add new facts. "
    "Output the sentence directly, no preamble, no quotes."
)


@dataclass
class _CtxRequest:
    parent_text: str
    chunk_text: str


async def _one_context(req: _CtxRequest, *, model: str | None = None) -> str:
    """Single LLM call producing one contextual prefix. Returns '' on failure.

    Prompt structure deliberately puts the LARGE, REUSED `<parent_document>` block
    at the START of the user message and the small, per-chunk `<chunk>` block at
    the END. Most LLM-API prompt caches key on a prefix-hash; this layout
    maximises cache hits across all chunks of the same document.
    """
    user = (
        f"<parent_document>\n{req.parent_text[:_PARENT_DOC_MAX_CHARS]}\n</parent_document>\n\n"
        f"<chunk>\n{req.chunk_text}\n</chunk>\n\n"
        "Situate this chunk in one short sentence."
    )
    try:
        out, _usage = await llm.chat_text_with_usage(
            system=_CONTEXT_SYSTEM,
            user=user,
            model=model,
            temperature=0.0,
            # DeepSeek-v4-flash burns ~50-150 tokens on internal reasoning
            # before emitting any visible content. Give the budget room.
            max_tokens=400,
        )
        return (out or "").strip().split("\n")[0]
    except Exception as e:
        logger.info("contextual prefix failed: %s", e)
        return ""


async def contextualize_chunks(
    *,
    parent_text: str,
    chunk_texts: list[str],
    model: str | None = None,
    max_concurrent: int = 8,
) -> list[str]:
    """Return one contextual prefix per chunk, in the same order.

    Prompt-caching: Anthropic's blog assumes the parent_document is in a cache
    block that's paid once per document, not per chunk. DeepSeek's API supports
    per-request prompt caching automatically when the same prefix is reused
    across requests within ~5 minutes. We rely on that: every call here sends
    the SAME `parent_text` system message (the same `_CONTEXT_SYSTEM` + the
    same `<parent_document>` wrapper), so DeepSeek's cache treats it as a
    cache hit after the first call. Effective cost per chunk after the first
    is ~just the chunk-specific user message + completion.

    Empty string for any chunk that failed — callers should fall back to the
    bare chunk text.
    """
    if not chunk_texts:
        return []
    sem = asyncio.Semaphore(max_concurrent)

    async def _go(text: str) -> str:
        async with sem:
            return await _one_context(_CtxRequest(parent_text, text), model=model)

    return await asyncio.gather(*(_go(t) for t in chunk_texts))


def prefix_chunk(context: str, chunk_text: str) -> str:
    """Combine context + chunk in the order Anthropic recommends.

    The prefix becomes part of the EMBEDDED text only. We keep `payload.text`
    as the verbatim chunk for citations.
    """
    if not context:
        return chunk_text
    return f"[Context: {context.strip()}]\n\n{chunk_text}"
