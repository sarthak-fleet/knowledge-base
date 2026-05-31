"""Persist / fetch schemas. New version per apply; latest becomes active."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from kb.schema.model import DomainSchema
from kb.storage import repo


async def apply_schema_file(path: Path, project: str = "default") -> DomainSchema:
    spec = yaml.safe_load(Path(path).read_text())
    return await apply_schema_dict(
        domain=spec["domain"], name=spec.get("name", "default"), spec=spec, project=project
    )


async def apply_schema_dict(
    *, domain: str, name: str, spec: dict[str, Any], project: str = "default"
) -> DomainSchema:
    spec = dict(spec)
    spec.setdefault("domain", domain)
    spec.setdefault("name", name)
    schema = DomainSchema.model_validate(spec)
    schema.validate_self()
    await repo.upsert_domain(schema.domain, project=project)
    saved = await repo.insert_schema_version(
        domain=schema.domain, name=schema.name, spec=schema.model_dump(), project=project
    )
    schema.version = saved["version"]
    return schema


async def list_schemas(project: str = "default") -> list[dict[str, Any]]:
    return await repo.list_schemas(project=project)


async def get_active_schema(domain: str, project: str = "default") -> dict[str, Any] | None:
    return await repo.get_active_schema(domain, project=project)


def schema_from_dict(spec: dict[str, Any]) -> DomainSchema:
    return DomainSchema.model_validate(spec)
