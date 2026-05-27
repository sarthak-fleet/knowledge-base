"""Pick the vector store backend from settings."""

from __future__ import annotations

from kb.config import get_settings
from kb.vector.base import VectorStore

_store: VectorStore | None = None


def get_store() -> VectorStore:
    global _store
    if _store is not None:
        return _store
    s = get_settings()
    if s.vector_store == "qdrant":
        from kb.vector.qdrant_store import QdrantStore
        _store = QdrantStore()
    elif s.vector_store == "pgvector":
        from kb.vector.pgvector_store import PgvectorStore
        _store = PgvectorStore()
    else:
        raise RuntimeError(f"unknown vector store: {s.vector_store}")
    return _store
