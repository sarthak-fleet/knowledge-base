"""Re-embed files whose chunks are missing or under-populated in the vector store.

The four post-ABCD zero-chunk 10-Ks (and one mid-ingest abort xlsx) ended
up in this state because Contextual Retrieval LLM calls failed during the
original ingest and the files were force-marked `ready` to drain the
queue. Entities for those files are already in Postgres; only the
chunk-embed-upsert step needs to be re-run.

Re-embed is pure local compute: parse_file is cached by content_hash,
chunking is deterministic, embedding is local fastembed, upsert is a
Qdrant write. Zero LLM calls; gateway-independent.

Usage:
    docker compose exec api python -m scripts.reembed_missing --domain sec
    docker compose exec api python -m scripts.reembed_missing --domain sec --file-id <uuid> [...]
"""

from __future__ import annotations

import argparse
import asyncio
from collections import Counter

import structlog
from qdrant_client import AsyncQdrantClient

from kb.config import get_settings, pipeline
from kb.parse import Element
from kb.parse.parser import parse_file
from kb.storage import repo
from kb.vector.base import Chunk
from kb.vector.chunking import build_chunks, build_chunks_semantic
from kb.vector.dedup import content_hash as _content_hash
from kb.vector.factory import get_store

logger = structlog.get_logger("scripts.reembed_missing")


async def _qdrant_chunk_counts(domain: str) -> Counter[str]:
    s = get_settings()
    c = AsyncQdrantClient(url=s.qdrant_url, api_key=s.qdrant_api_key or None, prefer_grpc=False)
    raw, _ = await c.scroll(collection_name=f"kb_{domain}", limit=20000, with_payload=True)
    counts: Counter[str] = Counter()
    for p in raw:
        fid = (p.payload or {}).get("file_id") or ""
        if fid:
            counts[fid] += 1
    return counts


async def _reembed_one(domain: str, file_id: str) -> int:
    """Re-parse → re-chunk → upsert. Returns number of child chunks written."""
    file_row = await repo.get_file(file_id)
    if not file_row:
        logger.warning("file not found", file_id=file_id)
        return 0

    elements: list[Element] = await parse_file(
        file_id=file_id,
        content_hash=file_row["content_hash"],
        object_key=file_row["object_key"],
        filename=file_row["filename"],
        mime=file_row["mime"],
    )
    if not elements:
        logger.warning("no parsed elements", file_id=file_id, filename=file_row["filename"])
        return 0

    cfg = pipeline.pipeline_config(domain)
    parent_size = int(pipeline.get(cfg, "chunk.parent_size", 2048))
    child_size = int(pipeline.get(cfg, "chunk.child_size", 512))
    overlap = int(pipeline.get(cfg, "chunk.overlap", 64))

    base_meta = {"domain": domain, "file_id": file_id, "entity_id": None}

    if bool(pipeline.get(cfg, "chunk.semantic_chunking", False)):
        parents, children = await build_chunks_semantic(
            elements, parent_size=parent_size, child_size=child_size, overlap=overlap,
            base_metadata=base_meta,
        )
    else:
        parents, children = build_chunks(
            elements, parent_size=parent_size, child_size=child_size, overlap=overlap,
            base_metadata=base_meta,
        )

    parent_chunks = [
        Chunk(
            id=p.id, text=p.text,
            metadata={**p.metadata, "page_start": p.page_start, "page_end": p.page_end,
                      "is_parent": True, "element_ids": p.element_ids},
            parent_id=None,
            content_hash=_content_hash("parent:" + p.text),
        )
        for p in parents
    ]
    child_chunks = [
        Chunk(
            id=c.id, text=c.text,
            metadata={**c.metadata, "page_start": c.page_start, "page_end": c.page_end,
                      "is_parent": False, "element_ids": c.element_ids},
            parent_id=c.parent_id,
            content_hash=_content_hash("child:" + c.text),
        )
        for c in children
    ]

    store = get_store()
    await store.delete_by_file(domain, file_id)
    await store.upsert(domain, parent_chunks)
    await store.upsert(domain, child_chunks)
    logger.info("re-embedded", file_id=file_id, filename=file_row["filename"],
                parents=len(parents), children=len(children))
    return len(children)


async def _run(args: argparse.Namespace) -> None:
    if args.file_id:
        targets = list(args.file_id)
        logger.info("reembed: explicit targets", n=len(targets))
    else:
        # Auto-pick files whose Qdrant chunk count is under the threshold.
        counts = await _qdrant_chunk_counts(args.domain)
        files = await repo.list_files(args.domain)
        targets = [f["id"] for f in files if counts.get(f["id"], 0) < args.min_chunks]
        logger.info("reembed: auto-picked under-populated files",
                    n=len(targets), min_chunks=args.min_chunks)

    if not targets:
        print("No files to re-embed. Nothing to do.")
        return

    total_children = 0
    for fid in targets:
        try:
            total_children += await _reembed_one(args.domain, fid)
        except Exception as e:
            logger.error("reembed failed", file_id=fid, error=str(e)[:200])

    print(f"\nRe-embedded {len(targets)} files; wrote {total_children} child chunks.")

    after = await _qdrant_chunk_counts(args.domain)
    print(f"Domain kb_{args.domain} now has {sum(after.values())} points across {len(after)} files.")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--domain", required=True)
    p.add_argument("--file-id", action="append", default=None,
                   help="Specific file_id(s) to re-embed; repeatable. Default: auto-pick.")
    p.add_argument("--min-chunks", type=int, default=10,
                   help="Auto-pick threshold: re-embed files with fewer than this many chunks.")
    args = p.parse_args()
    asyncio.run(_run(args))


if __name__ == "__main__":
    main()
