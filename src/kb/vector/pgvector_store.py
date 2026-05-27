"""pgvector backend: dense via vector(384) HNSW, lexical via Postgres FTS, RRF fusion in app code."""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import text

from kb.storage.db import session
from kb.vector.base import Chunk, SearchHit, VectorStore
from kb.vector.embed import embed_dense

# Whitelist filter columns — anything not in here is silently dropped to keep SQL safe.
_ALLOWED_FILTER_COLS = {"file_id", "entity_id", "parent_chunk", "domain"}


def _vec_literal(v: list[float]) -> str:
    return "[" + ",".join(f"{x:.7f}" for x in v) + "]"


class PgvectorStore(VectorStore):
    async def ensure_collection(self, domain: str) -> None:
        # `chunks` table is shared; HNSW index is created lazily once embeddings exist.
        async with session() as s:
            await s.execute(
                text(
                    "CREATE INDEX IF NOT EXISTS chunks_embedding_idx ON chunks USING hnsw (embedding vector_cosine_ops)"
                )
            )
            await s.commit()

    async def upsert(self, domain: str, chunks: list[Chunk]) -> None:
        """Insert chunks; dedup by content_hash. Same semantics as QdrantStore."""
        if not chunks:
            return
        await self.ensure_collection(domain)

        # Look up existing rows by content_hash to short-circuit duplicate inserts.
        hashes = [c.content_hash for c in chunks if c.content_hash]
        existing: dict[str, dict[str, Any]] = {}
        if hashes:
            async with session() as s:
                rows = (
                    (
                        await s.execute(
                            text(
                                "SELECT id, content_hash, file_id, COALESCE(also_in_files, '{}') AS also "
                                "FROM chunks WHERE domain = :d AND content_hash = ANY(:hashes)"
                            ),
                            {"d": domain, "hashes": list(set(hashes))},
                        )
                    )
                    .mappings()
                    .all()
                )
                for r in rows:
                    existing[r["content_hash"]] = dict(r)

        to_update: list[dict[str, Any]] = []
        new_chunks: list[Chunk] = []
        for c in chunks:
            ex = existing.get(c.content_hash) if c.content_hash else None
            if ex:
                new_file_id = c.metadata.get("file_id")
                if new_file_id and new_file_id != str(ex["file_id"]):
                    also = [str(f) for f in (ex["also"] or [])]
                    if new_file_id not in also:
                        also.append(new_file_id)
                        to_update.append({"id": ex["id"], "also_in_files": also})
            else:
                new_chunks.append(c)

        async with session() as s:
            for u in to_update:
                await s.execute(
                    text("UPDATE chunks SET also_in_files = :a::uuid[] WHERE id = :id"),
                    {"id": u["id"], "a": u["also_in_files"]},
                )
            if new_chunks:
                # text_to_embed() carries the Contextual Retrieval prefix when enabled.
                texts = [c.text_to_embed() for c in new_chunks]
                embs = await embed_dense(texts)
                for c, e in zip(new_chunks, embs, strict=False):
                    md = c.metadata
                    await s.execute(
                        text(
                            """
                            INSERT INTO chunks (id, domain, file_id, entity_id, parent_chunk, page_start, page_end,
                                                text, embedding, bbox, content_hash)
                            VALUES (:id, :d, :fid, :eid, :pc, :ps, :pe, :tx, CAST(:emb AS vector), :bb, :ch)
                            ON CONFLICT (id) DO UPDATE SET
                              text = EXCLUDED.text, embedding = EXCLUDED.embedding,
                              content_hash = EXCLUDED.content_hash
                            """
                        ),
                        {
                            "id": uuid.UUID(c.id) if not isinstance(c.id, uuid.UUID) else c.id,
                            "d": domain,
                            "fid": md.get("file_id"),
                            "eid": md.get("entity_id"),
                            "pc": c.parent_id,
                            "ps": md.get("page_start") or 0,
                            "pe": md.get("page_end") or 0,
                            "tx": c.text,
                            "emb": _vec_literal(e),
                            "bb": md.get("bbox"),
                            "ch": c.content_hash,
                        },
                    )
            await s.commit()

    async def delete_by_file(self, domain: str, file_id: str) -> None:
        async with session() as s:
            await s.execute(
                text("DELETE FROM chunks WHERE domain = :d AND file_id = :f"),
                {"d": domain, "f": file_id},
            )
            await s.commit()

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
        qv = (await embed_dense([query]))[0]
        # Filters → SQL where clauses. Column names whitelisted to keep injection-shape closed.
        where: list[str] = ["domain = :d"]
        params: dict[str, Any] = {"d": domain}
        if filters:
            for k, v in filters.items():
                if v is None or k not in _ALLOWED_FILTER_COLS:
                    continue
                where.append(f"{k} = :flt_{k}")
                params[f"flt_{k}"] = v
        wsql = " AND ".join(where)

        async with session() as s:
            dense_rows = (
                (
                    await s.execute(
                        text(
                            f"""
                        SELECT id::text, text, file_id::text, entity_id::text, parent_chunk::text,
                               1 - (embedding <=> CAST(:qv AS vector)) AS score
                        FROM chunks
                        WHERE {wsql} AND embedding IS NOT NULL
                        ORDER BY embedding <=> CAST(:qv AS vector)
                        LIMIT :k
                        """
                        ),
                        {**params, "qv": _vec_literal(qv), "k": top_k_dense},
                    )
                )
                .mappings()
                .all()
            )
            lex_rows = (
                (
                    await s.execute(
                        text(
                            f"""
                        SELECT id::text, text, file_id::text, entity_id::text, parent_chunk::text,
                               ts_rank(tsv, plainto_tsquery('english', :q)) AS score
                        FROM chunks
                        WHERE {wsql} AND tsv @@ plainto_tsquery('english', :q)
                        ORDER BY score DESC
                        LIMIT :k
                        """
                        ),
                        {**params, "q": query, "k": top_k_sparse},
                    )
                )
                .mappings()
                .all()
            )

        # Reciprocal Rank Fusion
        ranks: dict[str, float] = {}
        rows_by_id: dict[str, dict[str, Any]] = {}
        for arr in (dense_rows, lex_rows):
            for i, r in enumerate(arr):
                rid = r["id"]
                ranks[rid] = ranks.get(rid, 0.0) + 1.0 / (60 + i + 1)
                rows_by_id[rid] = dict(r)
        fused = sorted(ranks.items(), key=lambda x: x[1], reverse=True)[:rerank_top_k]
        hits: list[SearchHit] = []
        for rid, score in fused:
            r = rows_by_id[rid]
            hits.append(
                SearchHit(
                    id=rid,
                    text=r["text"],
                    score=float(score),
                    metadata={
                        "file_id": r["file_id"],
                        "entity_id": r["entity_id"],
                        "parent_chunk": r["parent_chunk"],
                    },
                    parent_id=r["parent_chunk"],
                )
            )
        return hits
