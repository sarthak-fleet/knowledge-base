"""Apply migrations programmatically — idempotent. Splits on `;` carefully (no fancy parser
needed because our migrations are plain DDL, no PL/pgSQL).
"""

from __future__ import annotations

from pathlib import Path

import structlog
from sqlalchemy import text

from kb.storage.db import init_engine, session

logger = structlog.get_logger("kb.storage.init_db")

MIGRATIONS_DIR_CANDIDATES = [
    Path("/app/migrations"),
    Path(__file__).resolve().parents[3] / "migrations",
]


def _migrations_dir() -> Path:
    for p in MIGRATIONS_DIR_CANDIDATES:
        if p.exists():
            return p
    raise RuntimeError("migrations directory not found")


def _split_statements(sql: str) -> list[str]:
    out: list[str] = []
    buf: list[str] = []
    for line in sql.splitlines():
        if line.strip().startswith("--"):
            continue
        buf.append(line)
        if line.rstrip().endswith(";"):
            stmt = "\n".join(buf).strip()
            if stmt:
                out.append(stmt)
            buf = []
    rest = "\n".join(buf).strip()
    if rest:
        out.append(rest)
    return out


async def init_db(dsn: str | None = None) -> dict[str, int]:
    if dsn:
        await init_engine(dsn)
    else:
        from kb.config import get_settings
        await init_engine(get_settings().postgres_dsn)
    mdir = _migrations_dir()
    files = sorted(mdir.glob("*.sql"))
    applied = 0
    statements = 0
    async with session() as s:
        for f in files:
            for stmt in _split_statements(f.read_text()):
                await s.execute(text(stmt))
                statements += 1
            applied += 1
        await s.commit()
    logger.info("applied %d migration files / %d statements from %s", applied, statements, mdir)
    return {"files": applied, "statements": statements}
