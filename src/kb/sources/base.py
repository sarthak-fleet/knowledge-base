"""Source protocol — yields documents as (filename, bytes, metadata)."""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass
class IngestedDoc:
    filename: str
    bytes_: bytes
    mime: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


class Source(Protocol):
    """A source produces a stream of documents."""

    name: str

    async def fetch(self) -> AsyncIterator[IngestedDoc]: ...
