"""Layered config: defaults < domain overrides."""

from kb.config import pipeline


def test_defaults_load() -> None:
    cfg = pipeline.pipeline_config(None)
    # Defaults bumped during Tier-1 retrieval improvements.
    assert pipeline.get(cfg, "retrieve.top_k_dense") == 60
    assert pipeline.get(cfg, "chunk.parent_size") == 2048


def test_sec_override_applies() -> None:
    cfg = pipeline.pipeline_config("sec")
    assert pipeline.get(cfg, "extract.window_pages") == 12   # override
    assert pipeline.get(cfg, "chunk.parent_size") == 2048     # inherited
