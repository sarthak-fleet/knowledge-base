"""Agent-native cited search over a project's specialized document corpus."""

from __future__ import annotations

from typing import Any

from kb.config import pipeline
from kb.query.mmr import mmr_rerank
from kb.query.rerank import rerank as cross_rerank
from kb.query.spans import pick_best_span
from kb.query.types import AgentSearchIn, AgentSearchOut, AgentSearchResult
from kb.storage import repo
from kb.vector.factory import get_store


def _explicit_filters(scope: dict[str, Any] | None, filters: dict[str, Any] | None) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if scope:
        for key in ("entity_id", "file_id", "parent_id"):
            if scope.get(key):
                out[key] = scope[key]
    if filters:
        out.update(filters)
    return out


async def _resolve_filenames(file_ids: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for fid in set(file_ids):
        row = await repo.get_file(fid)
        if row:
            out[fid] = row["filename"]
    return out


async def search_corpus(body: AgentSearchIn) -> AgentSearchOut:
    """Return cited evidence results without synthesis.

    This is the agent-facing counterpart to `/query`: same project/kind
    namespace and hybrid retrieval stack, but no LLM answer generation.
    """
    cfg = pipeline.pipeline_config(body.domain)
    store = get_store()

    top_k_dense = int(pipeline.get(cfg, "retrieve.top_k_dense", 20))
    top_k_sparse = int(pipeline.get(cfg, "retrieve.top_k_sparse", 20))
    candidate_k = int(pipeline.get(cfg, "retrieve.candidate_k", max(top_k_dense, top_k_sparse) * 2))
    rerank_top_k = max(body.top_k, int(pipeline.get(cfg, "retrieve.rerank_top_k", body.top_k)))
    target_kinds = body.kinds or [body.domain]
    payload_filters = {**_explicit_filters(body.scope, body.filters), "project": body.project}

    async def _search_one(kind: str) -> list[Any]:
        return await store.hybrid_search(
            domain=kind,
            query=body.query,
            top_k_dense=top_k_dense,
            top_k_sparse=top_k_sparse,
            rerank_top_k=candidate_k,
            filters=payload_filters,
        )

    per_kind = {kind: await _search_one(kind) for kind in target_kinds}
    if len(target_kinds) == 1:
        hits = per_kind[target_kinds[0]]
    else:
        from kb.query.rewriter import fuse_rrf

        by_id: dict[str, Any] = {}
        rankings: list[list[str]] = []
        for hlist in per_kind.values():
            rankings.append([h.id for h in hlist])
            for h in hlist:
                by_id.setdefault(h.id, h)
        hits = []
        for chunk_id, rrf_score in fuse_rrf(rankings)[:candidate_k]:
            h = by_id.get(chunk_id)
            if h is not None:
                h.score = float(rrf_score)
                hits.append(h)

    if body.rerank and hits and bool(pipeline.get(cfg, "retrieve.rerank_with_cross_encoder", True)):
        hits = await cross_rerank(body.query, hits, top_k=rerank_top_k)
    else:
        hits = hits[:rerank_top_k]

    mmr_enabled = body.mmr
    if mmr_enabled is None:
        mmr_enabled = bool(pipeline.get(cfg, "retrieve.mmr_enabled", False))
    if mmr_enabled and len(hits) > body.top_k:
        hits = await mmr_rerank(
            hits,
            query=body.query,
            top_k=body.top_k,
            lambda_=float(pipeline.get(cfg, "retrieve.mmr_lambda", 0.7)),
        )
    else:
        hits = hits[: body.top_k]

    filenames = await _resolve_filenames(
        [h.metadata.get("file_id", "") for h in hits if h.metadata.get("file_id")]
    )
    excerpt_chars = int(pipeline.get(cfg, "synthesize.excerpt_chars", 400))
    results: list[AgentSearchResult] = []
    for rank, h in enumerate(hits, start=1):
        md = h.metadata or {}
        file_id = str(md.get("file_id") or "")
        page_start = int(md.get("page_start") or 0)
        page_end = int(md.get("page_end") or page_start)
        results.append(
            AgentSearchResult(
                rank=rank,
                score=float(h.score),
                kind=str(md.get("domain") or body.domain),
                node_id=h.id,
                file_id=file_id,
                filename=filenames.get(file_id, "unknown"),
                page_start=page_start,
                page_end=page_end,
                excerpt=await pick_best_span(
                    query=body.query,
                    chunk_text=h.text,
                    max_chars=excerpt_chars,
                ),
                entity_id=md.get("entity_id"),
                metadata={
                    k: v
                    for k, v in md.items()
                    if k not in {"project", "file_id", "page_start", "page_end"}
                },
            )
        )

    return AgentSearchOut(
        project=body.project,
        query=body.query,
        domain=body.domain,
        kinds=target_kinds,
        results=results,
    )
