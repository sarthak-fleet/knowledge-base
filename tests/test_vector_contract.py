"""Both vector stores must conform to the same `VectorStore` Protocol surface."""

from __future__ import annotations

import importlib

import pytest

from kb.vector.base import VectorStore


@pytest.mark.skipif(
    importlib.util.find_spec("qdrant_client") is None,
    reason="qdrant-client not installed in this venv",
)
def test_qdrant_implements_protocol() -> None:
    from kb.vector.qdrant_store import QdrantStore

    for method in ("ensure_collection", "upsert", "delete_by_file", "hybrid_search"):
        assert hasattr(QdrantStore, method), f"QdrantStore missing {method}"


def test_pgvector_implements_protocol() -> None:
    from kb.vector.pgvector_store import PgvectorStore

    for method in ("ensure_collection", "upsert", "delete_by_file", "hybrid_search"):
        assert hasattr(PgvectorStore, method), f"PgvectorStore missing {method}"


def test_protocol_has_expected_surface() -> None:
    for method in ("ensure_collection", "upsert", "delete_by_file", "hybrid_search"):
        assert hasattr(VectorStore, method)


def test_filter_whitelist_blocks_unknown_keys() -> None:
    """Defence-in-depth: filter cols not in allowlist must be silently dropped."""
    from kb.vector import pgvector_store as pvs

    assert "file_id" in pvs._ALLOWED_FILTER_COLS
    assert "evil; DROP TABLE chunks;--" not in pvs._ALLOWED_FILTER_COLS
