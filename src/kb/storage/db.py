"""Async SQLAlchemy engine. Single engine per process; created on startup."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

_engine: AsyncEngine | None = None
_Session: async_sessionmaker[AsyncSession] | None = None


async def init_engine(dsn: str) -> None:
    global _engine, _Session
    if _engine is not None:
        return
    _engine = create_async_engine(dsn, pool_pre_ping=True, pool_size=10, max_overflow=20)
    _Session = async_sessionmaker(_engine, expire_on_commit=False, class_=AsyncSession)


async def close_engine() -> None:
    global _engine, _Session
    if _engine is not None:
        await _engine.dispose()
    _engine = None
    _Session = None


def engine() -> AsyncEngine:
    if _engine is None:
        raise RuntimeError("DB engine not initialised — call init_engine() first")
    return _engine


@asynccontextmanager
async def session() -> AsyncIterator[AsyncSession]:
    if _Session is None:
        from kb.config import get_settings

        await init_engine(get_settings().postgres_dsn)
    assert _Session is not None
    async with _Session() as s:
        yield s
