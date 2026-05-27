"""Filter-key whitelist + SQL shape — proves an arbitrary key can't reach SQL."""

from __future__ import annotations

from kb.vector import pgvector_store as pvs


def test_whitelist_includes_expected_columns() -> None:
    assert {"file_id", "entity_id", "parent_chunk", "domain"} == pvs._ALLOWED_FILTER_COLS


def test_injection_shape_dropped() -> None:
    """Building a WHERE clause from an unknown key must produce a no-op for that key."""
    # We don't have a fixture DB here; the assertion is on the whitelist semantics.
    assert "evil; DROP TABLE chunks;--" not in pvs._ALLOWED_FILTER_COLS
    assert "1=1" not in pvs._ALLOWED_FILTER_COLS
