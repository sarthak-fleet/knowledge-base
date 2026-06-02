"""URL source — fetch arbitrary web documents into the KB."""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from pathlib import PurePosixPath
from urllib.parse import urlparse

import httpx

from kb.sources.base import IngestedDoc, Source
from kb.sources.registry import register_source


def _filename_for_url(url: str, content_type: str | None) -> str:
    parsed = urlparse(url)
    name = PurePosixPath(parsed.path).name or parsed.netloc or "document"
    if "." not in name:
        if content_type and "html" in content_type:
            name += ".html"
        elif content_type and "pdf" in content_type:
            name += ".pdf"
        else:
            name += ".txt"
    return name


@dataclass
class UrlSource(Source):
    urls: list[str] = field(default_factory=list)
    timeout_s: int = 60
    name: str = "url"

    async def fetch(self) -> AsyncIterator[IngestedDoc]:
        async with httpx.AsyncClient(timeout=self.timeout_s, follow_redirects=True) as client:
            for url in self.urls:
                r = await client.get(url)
                r.raise_for_status()
                content_type = r.headers.get("content-type", "").split(";", 1)[0] or None
                yield IngestedDoc(
                    filename=_filename_for_url(url, content_type),
                    bytes_=r.content,
                    mime=content_type,
                    metadata={"source": "url", "url": str(r.url)},
                )


@register_source("url")
def _build(urls: list[str] | None = None, timeout_s: int = 60, **_: object) -> UrlSource:
    return UrlSource(urls=urls or [], timeout_s=timeout_s)
