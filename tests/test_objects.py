"""Raw object store keying and idempotency."""

from __future__ import annotations

import asyncio
import hashlib

from kb.storage import objects


class FakeBackend:
    def __init__(self) -> None:
        self.keys: list[str] = []
        self._exists: set[str] = set()

    async def exists(self, key: str) -> bool:
        return key in self._exists

    async def put(self, key: str, blob: bytes, mime: str | None = None) -> None:
        self.keys.append(key)
        self._exists.add(key)


def test_put_raw_file_is_idempotent_by_content_hash(monkeypatch) -> None:
    backend = FakeBackend()
    monkeypatch.setattr(objects, "_backend", backend)

    first = asyncio.run(objects.put_raw_file(domain="sec", filename="a.pdf", blob=b"same"))
    second = asyncio.run(objects.put_raw_file(domain="sec", filename="b.pdf", blob=b"same"))

    expected_key = f"raw/sec/{hashlib.sha256(b'same').hexdigest()}"
    assert first == second
    assert backend.keys == [expected_key]
