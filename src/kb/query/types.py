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
    project: str = "default"  # top-level namespace; legacy callers default to 'default'
    kinds: list[str] | None = None  # if set, fan out retrieval across these kinds within `project`
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


class AgentSearchIn(BaseModel):
    query: str
    domain: str
    project: str = "default"
    kinds: list[str] | None = None
    top_k: int = Field(default=8, ge=1, le=50)
    scope: dict | None = None
    filters: dict | None = None
    rerank: bool = True
    mmr: bool | None = None


class AgentSearchResult(BaseModel):
    rank: int
    score: float
    kind: str
    node_id: str
    file_id: str
    filename: str
    page_start: int
    page_end: int
    excerpt: str
    context_before: str = ""
    context_after: str = ""
    highlights: list[str] = Field(default_factory=list)
    entity_id: str | None = None
    metadata: dict = Field(default_factory=dict)


class AgentSearchOut(BaseModel):
    project: str
    query: str
    domain: str
    kinds: list[str]
    results: list[AgentSearchResult]


class AgentSearchEvalItem(BaseModel):
    id: str
    query: str
    expected_files: list[str] = Field(default_factory=list)
    key_facts: list[str] = Field(default_factory=list)
    filters: dict | None = None
    scope: dict | None = None


class AgentSearchEvalIn(BaseModel):
    project: str = "default"
    domain: str
    kinds: list[str] | None = None
    top_k: int = Field(default=8, ge=1, le=50)
    questions: list[AgentSearchEvalItem]


class AgentSearchEvalRow(BaseModel):
    id: str
    query: str
    expected_files: list[str]
    top_files: list[str]
    precision: float
    recall: float
    mrr: float
    latency_ms: float


class AgentSearchEvalOut(BaseModel):
    project: str
    domain: str
    kinds: list[str]
    question_count: int
    mean_precision: float
    mean_recall: float
    mean_mrr: float
    p95_latency_ms: float
    rows: list[AgentSearchEvalRow]
