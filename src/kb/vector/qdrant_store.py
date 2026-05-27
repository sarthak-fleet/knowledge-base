"""Qdrant backend with hybrid (dense + sparse) search and metadata filters."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from qdrant_client import AsyncQdrantClient
from qdrant_client.http import models as qm

from kb.config import get_settings
from kb.vector.base import Chunk, SearchHit, VectorStore
from kb.vector.embed import embed_dense, embed_sparse

logger = logging.getLogger("kb.vector.qdrant")


def _collection(domain: str) -> str:
    return f"kb_{domain}"


class QdrantStore(VectorStore):
    def __init__(self) -> None:
        s = get_settings()
        self._client = AsyncQdrantClient(url=s.qdrant_url, api_key=s.qdrant_api_key or None, prefer_grpc=False)
        # Honour KB_EMBED_DIM so swapping embed model (bge-base = 768, etc.) just works.
        self._dim = int(getattr(s, "embed_dim", 384))
        self._ensured: set[str] = set()
        self._lock = asyncio.Lock()

    async def ensure_collection(self, domain: str) -> None:
        """Idempotent collection creation. Multiple worker processes racing here
        no longer fail: we treat "already exists" as success and retry the
        existence check after a brief backoff.
        """
        async with self._lock:
            if domain in self._ensured:
                return
            name = _collection(domain)
            for attempt in range(3):
                existing = {c.name for c in (await self._client.get_collections()).collections}
                if name in existing:
                    self._ensured.add(domain)
                    return
                try:
                    await self._client.create_collection(
                        collection_name=name,
                        vectors_config={"dense": qm.VectorParams(size=self._dim, distance=qm.Distance.COSINE)},
                        sparse_vectors_config={"sparse": qm.SparseVectorParams(index=qm.SparseIndexParams(on_disk=False))},
                    )
                    for fld in ("file_id", "entity_id", "parent_id", "entity_type", "content_hash"):
                        await self._client.create_payload_index(
                            name, field_name=fld, field_schema=qm.PayloadSchemaType.KEYWORD,
                        )
                    logger.info("created qdrant collection %s", name)
                    self._ensured.add(domain)
                    return
                except Exception as e:
                    # Another worker won the race — back off and re-check.
                    logger.info("qdrant create_collection race (attempt %d): %s", attempt + 1, e)
                    await asyncio.sleep(0.3 * (attempt + 1))
            # If we get here, the collection still isn't visible — final attempt
            # without raising, so the caller can retry upsert.
            self._ensured.add(domain)

    async def upsert(self, domain: str, chunks: list[Chunk]) -> None:
        """Insert chunks; dedup by content_hash.

        When a chunk's `content_hash` matches an existing point in the same
        collection, we DO NOT insert a new point — instead we append the new
        chunk's `file_id` to the existing point's `also_in_files` payload.
        This collapses identical text (e.g. boilerplate paragraphs) into a
        single addressable point while preserving every source file.
        """
        if not chunks:
            return
        await self.ensure_collection(domain)

        # Look up existing points by content_hash (cheap — indexed payload field).
        hashes = [c.content_hash for c in chunks if c.content_hash]
        existing_by_hash: dict[str, dict[str, Any]] = {}
        if hashes:
            scroll, _ = await self._client.scroll(
                collection_name=_collection(domain),
                scroll_filter=qm.Filter(
                    must=[qm.FieldCondition(key="content_hash", match=qm.MatchAny(any=list(set(hashes))))]
                ),
                limit=len(hashes) * 2,
                with_payload=True,
            )
            for p in scroll:
                ch = (p.payload or {}).get("content_hash")
                if ch:
                    existing_by_hash[ch] = {"id": p.id, "payload": p.payload or {}}

        # Split into: dedup-update (existing) vs. new-insert
        to_update: list[dict[str, Any]] = []
        new_chunks: list[Chunk] = []
        for c in chunks:
            if c.content_hash and c.content_hash in existing_by_hash:
                existing = existing_by_hash[c.content_hash]
                existing_file_id = existing["payload"].get("file_id")
                new_file_id = c.metadata.get("file_id")
                if new_file_id and new_file_id != existing_file_id:
                    also = list(existing["payload"].get("also_in_files") or [])
                    if new_file_id not in also:
                        also.append(new_file_id)
                    to_update.append({"id": existing["id"], "also_in_files": also})
            else:
                new_chunks.append(c)

        # Apply also_in_files updates in a single payload set
        for u in to_update:
            await self._client.set_payload(
                collection_name=_collection(domain),
                payload={"also_in_files": u["also_in_files"]},
                points=[u["id"]],
            )

        if not new_chunks:
            logger.info("dedup: %d chunks merged into existing points (no new vectors)", len(to_update))
            return

        # Use text_to_embed() so Contextual Retrieval prefixes ride only on the
        # embedded text; payload.text stays the verbatim chunk for citations.
        texts = [c.text_to_embed() for c in new_chunks]
        dense, sparse = await asyncio.gather(embed_dense(texts), embed_sparse(texts))
        points = []
        for c, dv, sv in zip(new_chunks, dense, sparse, strict=False):
            payload = {
                **c.metadata,
                "text": c.text,
                "parent_id": c.parent_id,
                "content_hash": c.content_hash,
                "also_in_files": [],
            }
            vec: dict = {"dense": dv}
            if sv["indices"]:
                vec["sparse"] = qm.SparseVector(indices=sv["indices"], values=sv["values"])
            points.append(qm.PointStruct(id=c.id, vector=vec, payload=payload))
        await self._client.upsert(collection_name=_collection(domain), points=points)
        if to_update:
            logger.info("upsert: %d new, %d merged into existing", len(new_chunks), len(to_update))

    async def delete_by_file(self, domain: str, file_id: str) -> None:
        await self.ensure_collection(domain)
        await self._client.delete(
            collection_name=_collection(domain),
            points_selector=qm.FilterSelector(
                filter=qm.Filter(must=[qm.FieldCondition(key="file_id", match=qm.MatchValue(value=file_id))])
            ),
        )

    @staticmethod
    def _build_filter(filters: dict[str, Any] | None) -> qm.Filter | None:
        if not filters:
            return None
        must: list[qm.FieldCondition] = []
        for k, v in filters.items():
            if v is None:
                continue
            if isinstance(v, list):
                must.append(qm.FieldCondition(key=k, match=qm.MatchAny(any=v)))
            else:
                must.append(qm.FieldCondition(key=k, match=qm.MatchValue(value=v)))
        return qm.Filter(must=must) if must else None

    async def hybrid_search(
        self,
        domain: str,
        query: str,
        *,
        top_k_dense: int = 20,
        top_k_sparse: int = 20,
        rerank_top_k: int = 8,
        filters: dict[str, Any] | None = None,
    ) -> list[SearchHit]:
        await self.ensure_collection(domain)
        dv = (await embed_dense([query]))[0]
        sv = (await embed_sparse([query]))[0]
        flt = self._build_filter(filters)
        prefetch = [qm.Prefetch(using="dense", query=dv, limit=top_k_dense, filter=flt)]
        if sv["indices"]:
            prefetch.append(
                qm.Prefetch(
                    using="sparse",
                    query=qm.SparseVector(indices=sv["indices"], values=sv["values"]),
                    limit=top_k_sparse,
                    filter=flt,
                )
            )
        res = await self._client.query_points(
            collection_name=_collection(domain),
            prefetch=prefetch,
            query=qm.FusionQuery(fusion=qm.Fusion.RRF),
            limit=rerank_top_k,
            with_payload=True,
        )
        return [
            SearchHit(
                id=str(p.id),
                text=(p.payload or {}).get("text", ""),
                score=p.score,
                metadata=p.payload or {},
                parent_id=(p.payload or {}).get("parent_id"),
            )
            for p in res.points
        ]
