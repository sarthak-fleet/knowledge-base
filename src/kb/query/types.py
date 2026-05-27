"""Request / response models for the query API.

Lives outside `kb.api.routes` so the query engine can use them without pulling in
the FastAPI route layer (and creating a circular import).
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class CitationSource(BaseModel):
    file_id: str
    filename: str


class Citation(BaseModel):
    file_id: str
    filename: str
    page_start: int
    page_end: int
    excerpt: str
    bbox: list[float] | None = None
    # When the cited chunk's text appears verbatim across multiple files
    # (dedup at ingest) or near-duplicate chunks were collapsed via MMR,
    # `also_in` lists every additional source whose excerpt is the same.
    also_in: list[CitationSource] = []
    # Provenance of the citation itself. "retrieval" = surfaced by hybrid
    # search; "graph_route" = surfaced by the GraphRAG-shaped theme summary
    # whose narrative themes shaped part of the answer.
    via: str = "retrieval"


class RetrievedNode(BaseModel):
    node_id: str
    score: float
    file_id: str
    entity_id: str | None = None
    excerpt: str


class Confidence(BaseModel):
    value: float = Field(ge=0.0, le=1.0)
    reason: str


class QueryIn(BaseModel):
    domain: str
    question: str
    session_id: str | None = None
    scope: dict | None = None  # e.g. {"entity_id": "..."} or {"parent_id": "..."}
    filters: dict | None = None  # e.g. {"date_gte": "2024-01-01", "filing_type": "10-K"}


class QueryOut(BaseModel):
    answer: str
    citations: list[Citation]
    retrieved: list[RetrievedNode]
    confidence: Confidence
    session_id: str | None = None
    trace_id: str
