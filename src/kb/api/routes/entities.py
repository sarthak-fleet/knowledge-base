"""Entity + lineage browse."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from kb.storage import repo

router = APIRouter(prefix="/entities", tags=["entities"])


@router.get("")
async def list_entities(
    domain: str,
    type: str | None = None,
    q: str | None = None,
    limit: int = 50,
    project: str = "default",
) -> list[dict]:
    return await repo.list_entities(domain=domain, type=type, q=q, limit=limit, project=project)


@router.get("/{entity_id}")
async def get_entity(entity_id: str) -> dict:
    row = await repo.get_entity(entity_id)
    if not row:
        raise HTTPException(404, "entity not found")
    return row


@router.get("/{entity_id}/lineage")
async def get_lineage(entity_id: str) -> dict:
    """Parent containment chain + mentions across files."""
    return await repo.get_entity_lineage(entity_id)


@router.get("/{entity_id}/relationships")
async def get_relationships(entity_id: str) -> list[dict]:
    return await repo.get_entity_relationships(entity_id)
