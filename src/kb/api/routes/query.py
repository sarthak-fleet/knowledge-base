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
      event: started   data: {"domain": "...", "question": "..."}      (immediate TTFB)
      event: stage     data: {"stage": "intent", "latency_ms": ...}    (one per stage)
      event: answer    data: {"answer": "...", "citations": [...]}      (final)
      event: error     data: {"detail": "..."}                          (on failure)

    NOTE — the current shape is **not** truly incremental per-stage. The full
    pipeline runs to completion inside `answer_query` and the stages are then
    replayed as SSE events. We emit a `started` event up-front so the client
    gets a real first-byte signal; the per-stage events still arrive only
    after the pipeline finishes.

    Truly incremental streaming requires `answer_query` to be an async
    generator that yields stages as it computes them. Substantial refactor —
    deferred. See DESIGN.md "what's missing".
    """

    async def _gen() -> AsyncIterator[bytes]:
        # Ship a started event immediately so the client sees TTFB even
        # though the rest is batched after the pipeline ends.
        yield (
            f"event: started\ndata: {json.dumps({'domain': body.domain, 'question': body.question})}\n\n"
        ).encode()
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
async def list_traces(
    domain: str | None = None,
    limit: int = 50,
    project: str = "default",
) -> list[dict]:
    return await repo.list_query_traces(domain=domain, limit=limit, project=project)


@router.get("/trace/{trace_id}", summary="Full record of what the system did for one answer")
async def get_trace(trace_id: str) -> dict:
    row = await repo.get_query_trace(trace_id)
    if not row:
        raise HTTPException(404, "trace not found")
    return row
