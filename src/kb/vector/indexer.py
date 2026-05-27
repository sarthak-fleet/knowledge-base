"""Glue: build chunks from extracted result, attach metadata, upsert to vector store."""

from __future__ import annotations

from typing import Any

import structlog

from kb.config import pipeline
from kb.extract.runner import ExtractionResult
from kb.parse import Element
from kb.vector.base import Chunk
from kb.vector.chunking import build_chunks, build_chunks_semantic
from kb.vector.contextual import contextualize_chunks, prefix_chunk
from kb.vector.dedup import content_hash
from kb.vector.factory import get_store

logger = structlog.get_logger("kb.vector.indexer")


def _entity_id_for_element(
    elements: list[Element],
    parent_index: dict[str, str],
) -> str | None:
    """Best-effort: pin chunks to the most-recently-parented entity in the file.

    Better future approach: tie each element to the most-specific entity whose
    provenance span covers its page. For now we attach to the deepest leaf parent.
    """
    if not parent_index:
        return None
    # Pick the deepest type (heuristic: last inserted in topological order)
    return list(parent_index.values())[-1]


async def index_extraction(result: ExtractionResult, parent_index: dict[str, str]) -> int:
    """Build hierarchical chunks for the file and upsert them. Returns # of child chunks."""
    cfg = pipeline.pipeline_config(result.domain)
    parent_size = int(pipeline.get(cfg, "chunk.parent_size", 2048))
    child_size = int(pipeline.get(cfg, "chunk.child_size", 512))
    overlap = int(pipeline.get(cfg, "chunk.overlap", 64))

    entity_id = _entity_id_for_element(result.elements, parent_index)
    base_meta: dict[str, Any] = {
        "domain": result.domain,
        "file_id": result.file_id,
        "entity_id": entity_id,
    }

    use_semantic = bool(pipeline.get(cfg, "chunk.semantic_chunking", False))
    if use_semantic:
        parents, children = await build_chunks_semantic(
            result.elements,
            parent_size=parent_size,
            child_size=child_size,
            overlap=overlap,
            base_metadata=base_meta,
        )
    else:
        parents, children = build_chunks(
            result.elements,
            parent_size=parent_size,
            child_size=child_size,
            overlap=overlap,
            base_metadata=base_meta,
        )

    store = get_store()

    # Hash prefix distinguishes parent vs child layers so a child whose text
    # happens to equal its parent (small documents) isn't deduped against it.
    parent_chunks = [
        Chunk(
            id=p.id,
            text=p.text,
            metadata={
                **p.metadata,
                "page_start": p.page_start,
                "page_end": p.page_end,
                "is_parent": True,
                "element_ids": p.element_ids,
            },
            parent_id=None,
            content_hash=content_hash("parent:" + p.text),
        )
        for p in parents
    ]
    child_chunks = [
        Chunk(
            id=c.id,
            text=c.text,
            metadata={
                **c.metadata,
                "page_start": c.page_start,
                "page_end": c.page_end,
                "is_parent": False,
                "element_ids": c.element_ids,
            },
            parent_id=c.parent_id,
            content_hash=content_hash("child:" + c.text),
        )
        for c in children
    ]

    # Contextual Retrieval (Anthropic, Sep 2024): for each chunk we ask the LLM
    # for a 1-sentence "where this chunk sits in the doc" prefix. The prefix
    # rides on `embed_text` so it influences the dense + sparse indexes but the
    # citation excerpt stays the verbatim text. Toggle: synthesize.contextual_retrieval.
    use_ctx = bool(pipeline.get(cfg, "synthesize.contextual_retrieval", False))
    if use_ctx and children:
        # Grok Issue 13: log when the 12k-char CR ceiling actually fires so we
        # know which long filings are being trimmed before going to the LLM.
        ctx_limit = 12000
        full_parent = " ".join(e.text for e in result.elements if e.text)
        if len(full_parent) > ctx_limit:
            logger.warning(
                "contextual retrieval: parent for file %s is %d chars; truncating to %d (%.0f%% dropped)",
                result.file_id, len(full_parent), ctx_limit,
                100.0 * (len(full_parent) - ctx_limit) / len(full_parent),
            )
        parent_text = full_parent[:ctx_limit]
        try:
            prefixes = await contextualize_chunks(
                parent_text=parent_text,
                chunk_texts=[c.text for c in children],
                model=pipeline.get(cfg, "llm.extract.model"),
                max_concurrent=int(pipeline.get(cfg, "synthesize.contextual_max_concurrent", 8)),
            )
            for c, p in zip(child_chunks, prefixes, strict=False):
                if p:
                    c.embed_text = prefix_chunk(p, c.text)
            logger.info(
                "contextual retrieval: prefixed %d/%d child chunks for file %s",
                sum(1 for p in prefixes if p), len(prefixes), result.file_id,
            )
        except Exception as e:
            logger.warning("contextual retrieval failed (%s); falling back to bare chunk text", e)

    # Replace any previously indexed chunks for this file before re-upserting.
    await store.delete_by_file(result.domain, result.file_id)
    await store.upsert(result.domain, parent_chunks)
    await store.upsert(result.domain, child_chunks)
    logger.info("indexed file %s: %d parents, %d children (contextual=%s)",
                result.file_id, len(parents), len(children), use_ctx)
    return len(children)
