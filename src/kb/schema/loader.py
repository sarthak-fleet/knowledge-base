"""Persist / fetch schemas. New version per apply; latest becomes active."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from kb.schema.model import DomainSchema
from kb.storage import repo


async def apply_schema_file(path: Path) -> DomainSchema:
    spec = yaml.safe_load(Path(path).read_text())
    return await apply_schema_dict(domain=spec["domain"], name=spec.get("name", "default"), spec=spec)


async def apply_schema_dict(*, domain: str, name: str, spec: dict[str, Any]) -> DomainSchema:
    spec = dict(spec)
    spec.setdefault("domain", domain)
    spec.setdefault("name", name)
    schema = DomainSchema.model_validate(spec)
    schema.validate_self()
    await repo.upsert_domain(schema.domain)
    saved = await repo.insert_schema_version(domain=schema.domain, name=schema.name, spec=schema.model_dump())
    schema.version = saved["version"]
    return schema


async def list_schemas() -> list[dict[str, Any]]:
    return await repo.list_schemas()


async def get_active_schema(domain: str) -> dict[str, Any] | None:
    return await repo.get_active_schema(domain)


def schema_from_dict(spec: dict[str, Any]) -> DomainSchema:
    return DomainSchema.model_validate(spec)
