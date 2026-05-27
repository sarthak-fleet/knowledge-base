"""Vector store: pluggable adapter. Default Qdrant, optional pgvector."""

from kb.vector.base import Chunk, SearchHit, VectorStore
from kb.vector.factory import get_store

__all__ = ["Chunk", "SearchHit", "VectorStore", "get_store"]
