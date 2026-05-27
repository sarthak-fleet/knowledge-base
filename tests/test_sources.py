"""Source-adapter pattern: registry, upload source roundtrip."""

from __future__ import annotations

import asyncio

from kb.sources import IngestedDoc, build_source, sources


def test_builtins_registered() -> None:
    s = sources()
    assert "upload" in s
    assert "edgar" in s


def test_upload_source_yields_docs() -> None:
    docs = [
        IngestedDoc(filename="a.pdf", bytes_=b"raw-a"),
        IngestedDoc(filename="b.xlsx", bytes_=b"raw-b"),
    ]
    src = build_source("upload", docs=docs)

    async def _collect() -> list[str]:
        out: list[str] = []
        async for d in src.fetch():
            out.append(d.filename)
        return out

    assert asyncio.run(_collect()) == ["a.pdf", "b.xlsx"]
