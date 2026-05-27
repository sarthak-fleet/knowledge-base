"""'upload' source — wraps a pre-supplied list of (filename, bytes)."""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass

from kb.sources.base import IngestedDoc, Source
from kb.sources.registry import register_source


@dataclass
class UploadSource(Source):
    docs: list[IngestedDoc]
    name: str = "upload"

    async def fetch(self) -> AsyncIterator[IngestedDoc]:
        for d in self.docs:
            yield d


@register_source("upload")
def _build(docs: list[IngestedDoc] | None = None, **_: object) -> UploadSource:
    return UploadSource(docs=docs or [])
