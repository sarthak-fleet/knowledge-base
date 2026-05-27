"""Query endpoint + trace inspection + SSE streaming."""

from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from kb.query.engine import answer_query
from kb.query.types import QueryIn, QueryOut
from kb.storage import repo

router = APIRouter(prefix="/query", tags=["query"])


@router.post("", response_model=QueryOut)
async def query(body: QueryIn) -> QueryOut:
    return await answer_query(body)


@router.post("/stream", summary="Run a query and stream the answer + stage events via SSE")
async def query_stream(body: QueryIn) -> StreamingResponse:
    """Server-Sent Events stream.

    Emits a sequence of named events:
      event: stage     data: {"stage": "intent", "latency_ms": ...}    (one per stage)
      event: answer    data: {"answer": "...", "citations": [...]}      (final)
      event: error     data: {"detail": "..."}                          (on failure)

    Internally we still run the full pipeline (no per-token streaming yet —
    that requires upstream LLM streaming wiring). The SSE shape gives clients
    a first-byte signal as each stage completes, which is the production UX win.
    """

    async def _gen() -> AsyncIterator[bytes]:
        try:
            # Kick the full pipeline; collect the result.
            out = await answer_query(body)
            # If we have a trace, replay its stages as SSE events for the client.
            trace = await repo.get_query_trace(out.trace_id) if out.trace_id else None
            if trace:
                for s in (trace.get("filters") or {}).get("_stages") or []:
                    yield f"event: stage\ndata: {json.dumps(s, default=str)}\n\n".encode()
                    await asyncio.sleep(0)  # let the client flush
            yield f"event: answer\ndata: {out.model_dump_json()}\n\n".encode()
        except Exception as e:
            yield f"event: error\ndata: {json.dumps({'detail': str(e)})}\n\n".encode()

    return StreamingResponse(_gen(), media_type="text/event-stream")


@router.get("/traces", summary="List recent query traces")
async def list_traces(domain: str | None = None, limit: int = 50) -> list[dict]:
    return await repo.list_query_traces(domain=domain, limit=limit)


@router.get("/trace/{trace_id}", summary="Full record of what the system did for one answer")
async def get_trace(trace_id: str) -> dict:
    row = await repo.get_query_trace(trace_id)
    if not row:
        raise HTTPException(404, "trace not found")
    return row
