"""Agent-facing cited search endpoints."""

from __future__ import annotations

from fastapi import APIRouter

from kb.query.search import evaluate_search, search_corpus
from kb.query.types import AgentSearchEvalIn, AgentSearchEvalOut, AgentSearchIn, AgentSearchOut

router = APIRouter(tags=["agent-search"])


@router.post("/search", response_model=AgentSearchOut)
async def search(body: AgentSearchIn) -> AgentSearchOut:
    return await search_corpus(body)


@router.post("/agent/search", response_model=AgentSearchOut)
async def agent_search(body: AgentSearchIn) -> AgentSearchOut:
    return await search_corpus(body)


@router.post("/search/eval", response_model=AgentSearchEvalOut)
async def search_eval(body: AgentSearchEvalIn) -> AgentSearchEvalOut:
    return await evaluate_search(body)
