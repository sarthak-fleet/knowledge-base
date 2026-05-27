"""Schema inference endpoint — propose a schema from uploaded files."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from kb.schema.infer import collect_samples_from_domain, infer_schema

router = APIRouter(prefix="/schemas", tags=["schemas"])


class InferIn(BaseModel):
    domain: str
    sample_texts: list[str] | None = None  # if None, sample from chunks table
    sample_count: int = 12


@router.post("/infer", summary="Propose a domain schema from sample text chunks")
async def infer(body: InferIn) -> dict:
    samples = body.sample_texts
    if not samples:
        samples = await collect_samples_from_domain(body.domain, n=body.sample_count)
    if not samples:
        raise HTTPException(400, "no samples available — upload files first or pass sample_texts")
    schema = await infer_schema(domain_hint=body.domain, samples=samples)
    return {
        "domain": schema.domain,
        "name": schema.name,
        "spec": schema.model_dump(),
        "sample_count": len(samples),
        "note": "Review + edit, then POST to /schemas to commit.",
    }
