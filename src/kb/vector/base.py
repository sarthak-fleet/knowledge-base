"""Vector store interface — same contract across Qdrant and pgvector backends."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass
class Chunk:
    id: str
    text: str
    metadata: dict[str, Any] = field(default_factory=dict)
    # parent_id is used for AutoMergingRetriever-style hierarchy
    parent_id: str | None = None
    # content_hash = sha256(normalize(text)). When set, store-level dedup
    # short-circuits duplicate-text inserts by appending file_id to the
    # existing chunk's `also_in_files` payload instead of writing a new point.
    content_hash: str | None = None
    # Optional override for the text used to compute dense + sparse embeddings.
    # If not set, embeddings are computed over `text`. When Contextual Retrieval
    # is enabled, this carries the chunk PREPENDED with a 1-sentence situational
    # context from the LLM; `text` stays the verbatim excerpt for citations.
    embed_text: str | None = None

    def text_to_embed(self) -> str:
        return self.embed_text or self.text


@dataclass
class SearchHit:
    id: str
    text: str
    score: float
    metadata: dict[str, Any]
    parent_id: str | None = None


class VectorStore(Protocol):
    async def ensure_collection(self, domain: str) -> None: ...
    async def upsert(self, domain: str, chunks: list[Chunk]) -> None: ...
    async def delete_by_file(self, domain: str, file_id: str) -> None: ...
    async def hybrid_search(
        self,
        domain: str,
        query: str,
        *,
        top_k_dense: int = 20,
        top_k_sparse: int = 20,
        rerank_top_k: int = 8,
        filters: dict[str, Any] | None = None,
    ) -> list[SearchHit]: ...
