"""Object store abstraction: MinIO (S3-compatible) or local filesystem.

Both raw files and cached parse artifacts (Unstructured element JSON) live here.
Keying convention:
    raw/<domain>/<content_hash>
    parse/<content_hash>/elements.json
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
from pathlib import Path
from typing import Any

import structlog

from kb.config import get_settings


def _content_hash(blob: bytes) -> str:
    return hashlib.sha256(blob).hexdigest()


# ─── Backend interface ────────────────────────────────────────────────────
class _Backend:
    async def put(self, key: str, blob: bytes, mime: str | None = None) -> None: ...
    async def get(self, key: str) -> bytes: ...
    async def exists(self, key: str) -> bool: ...
    async def delete(self, key: str) -> None: ...


class _MinioBackend(_Backend):
    def __init__(self) -> None:
        from minio import Minio  # imported lazily to avoid hard dep at import time

        s = get_settings()
        self._client = Minio(
            s.minio_endpoint,
            access_key=s.minio_access_key,
            secret_key=s.minio_secret_key,
            secure=s.minio_secure,
        )
        self._bucket = s.minio_bucket
        if not self._client.bucket_exists(self._bucket):
            self._client.make_bucket(self._bucket)

    async def put(self, key: str, blob: bytes, mime: str | None = None) -> None:
        def _do() -> None:
            self._client.put_object(
                self._bucket,
                key,
                io.BytesIO(blob),
                length=len(blob),
                content_type=mime or "application/octet-stream",
            )

        await asyncio.to_thread(_do)

    async def get(self, key: str) -> bytes:
        def _do() -> bytes:
            resp = self._client.get_object(self._bucket, key)
            try:
                return resp.read()
            finally:
                resp.close()
                resp.release_conn()

        return await asyncio.to_thread(_do)

    async def exists(self, key: str) -> bool:
        from minio.error import S3Error

        def _do() -> bool:
            try:
                self._client.stat_object(self._bucket, key)
                return True
            except S3Error:
                return False

        return await asyncio.to_thread(_do)

    async def delete(self, key: str) -> None:
        await asyncio.to_thread(self._client.remove_object, self._bucket, key)


class _LocalBackend(_Backend):
    def __init__(self) -> None:
        self._root = Path(get_settings().local_data_dir) / "objects"
        self._root.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        return self._root / key

    async def put(self, key: str, blob: bytes, mime: str | None = None) -> None:
        p = self._path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        await asyncio.to_thread(p.write_bytes, blob)

    async def get(self, key: str) -> bytes:
        return await asyncio.to_thread(self._path(key).read_bytes)

    async def exists(self, key: str) -> bool:
        return await asyncio.to_thread(self._path(key).exists)

    async def delete(self, key: str) -> None:
        p = self._path(key)
        await asyncio.to_thread(p.unlink, True)  # missing_ok=True


_backend: _Backend | None = None


def _get_backend() -> _Backend:
    global _backend
    if _backend is None:
        s = get_settings()
        _backend = _MinioBackend() if s.object_store == "minio" else _LocalBackend()
    return _backend


# ─── Public helpers ───────────────────────────────────────────────────────
async def put_raw_file(*, domain: str, filename: str, blob: bytes) -> tuple[str, str]:
    """Store a raw upload; returns (object_key, content_hash). Idempotent by content_hash."""
    h = _content_hash(blob)
    key = f"raw/{domain}/{h}"
    backend = _get_backend()
    if not await backend.exists(key):
        await backend.put(key, blob)
    return key, h


async def get_raw_file(object_key: str) -> bytes:
    return await _get_backend().get(object_key)


async def put_parse_artifact(content_hash: str, elements: list[dict[str, Any]]) -> str:
    key = f"parse/{content_hash}/elements.json"
    await _get_backend().put(key, json.dumps(elements).encode("utf-8"), mime="application/json")
    return key


class ParseArtifactCorruptError(RuntimeError):
    """Raised when a cached parse artifact in the object store can't be parsed.

    The job runner treats this as a cache miss and re-parses from raw bytes.
    """


async def get_parse_artifact(object_key: str) -> list[dict[str, Any]]:
    """Load a cached parse artifact. Grok Issue 5: a corrupted blob in the
    object store used to crash the whole extract stage with no recovery; now
    we raise a typed error the job runner can treat as a cache miss.
    """
    raw = await _get_backend().get(object_key)
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, ValueError) as e:
        structlog.get_logger("kb.storage.objects").warning(
            "parse artifact corrupt at %s (%s) — caller should treat as cache miss",
            object_key,
            e,
        )
        raise ParseArtifactCorruptError(f"corrupt parse artifact at {object_key}: {e}") from e
    if not isinstance(data, list):
        raise ParseArtifactCorruptError(f"parse artifact at {object_key} is not a list")
    return data


async def parse_artifact_exists(content_hash: str) -> bool:
    return await _get_backend().exists(f"parse/{content_hash}/elements.json")
