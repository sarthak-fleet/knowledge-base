"""Parse stage cache behavior: cache hit skips parser; cache miss writes artifact + DB row."""

from __future__ import annotations

import asyncio

from kb.parse import parser as parse_mod
from kb.parse.parser import Element


def test_cache_hit_uses_artifact(monkeypatch) -> None:
    calls = {"parsed": 0}

    cached_elements = [
        {
            "id": "el-1",
            "type": "Title",
            "text": "hello",
            "page": 1,
            "bbox": None,
            "parent_id": None,
            "metadata": {},
        },
    ]

    async def fake_get_parse_artifact_db(content_hash):
        return {"content_hash": content_hash, "object_key": "parse/abc/elements.json"}

    async def fake_get_parse_artifact_obj(object_key):
        return cached_elements

    async def fake_parse_pdf_sync(*a, **kw):
        calls["parsed"] += 1
        return []

    async def fake_get_raw_file(object_key):
        calls["read_raw"] = calls.get("read_raw", 0) + 1
        return b""

    monkeypatch.setattr(parse_mod.repo, "get_parse_artifact", fake_get_parse_artifact_db)
    monkeypatch.setattr(parse_mod.objects, "get_parse_artifact", fake_get_parse_artifact_obj)
    monkeypatch.setattr(parse_mod.objects, "get_raw_file", fake_get_raw_file)
    monkeypatch.setattr(parse_mod, "_parse_pdf_sync", fake_parse_pdf_sync)

    elements = asyncio.run(
        parse_mod.parse_file(
            file_id="f1",
            content_hash="abc",
            object_key="raw/x/abc/doc.pdf",
            filename="doc.pdf",
            mime="application/pdf",
        )
    )
    assert calls["parsed"] == 0
    assert calls.get("read_raw", 0) == 0  # cache hit avoids re-fetching raw file too
    assert len(elements) == 1
    assert isinstance(elements[0], Element)
    assert elements[0].text == "hello"
