"""Agent-native cited search over a project's specialized document corpus."""

from __future__ import annotations

import re
import time
from typing import Any

from kb.config import pipeline
from kb.query.mmr import mmr_rerank
from kb.query.rerank import rerank as cross_rerank
from kb.query.spans import pick_best_span
from kb.query.types import (
    AgentSearchEvalIn,
    AgentSearchEvalOut,
    AgentSearchEvalRow,
    AgentSearchIn,
    AgentSearchOut,
    AgentSearchResult,
)
from kb.storage import repo
from kb.vector.factory import get_store

_TOKEN_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{2,}")


def _explicit_filters(scope: dict[str, Any] | None, filters: dict[str, Any] | None) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if scope:
        for key in ("entity_id", "file_id", "parent_id"):
            if scope.get(key):
                out[key] = scope[key]
    if filters:
        out.update(filters)
    return out


def _highlights(query: str, excerpt: str, *, limit: int = 8) -> list[str]:
    terms = []
    seen = set()
    excerpt_lower = excerpt.lower()
    for term in _TOKEN_RE.findall(query.lower()):
        if term in seen or term not in excerpt_lower:
            continue
        seen.add(term)
        terms.append(term)
        if len(terms) >= limit:
            break
    return terms


def _neighbor_context(chunk_text: str, excerpt: str, *, chars: int = 220) -> tuple[str, str]:
    if not chunk_text or not excerpt:
        return "", ""
    pos = chunk_text.find(excerpt)
    if pos < 0:
        pos = chunk_text.lower().find(excerpt.lower())
    if pos < 0:
        return "", ""
    before = " ".join(chunk_text[max(0, pos - chars) : pos].split())
    after = " ".join(chunk_text[pos + len(excerpt) : pos + len(excerpt) + chars].split())
    return before, after


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
        excerpt = await pick_best_span(
            query=body.query,
            chunk_text=h.text,
            max_chars=excerpt_chars,
        )
        context_before, context_after = _neighbor_context(h.text, excerpt)
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
                excerpt=excerpt,
                context_before=context_before,
                context_after=context_after,
                highlights=_highlights(body.query, excerpt),
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


def _file_match(filename: str, expected_files: list[str]) -> bool:
    hay = (filename or "").lower()
    return any((needle or "").lower() in hay for needle in expected_files)


async def evaluate_search(body: AgentSearchEvalIn) -> AgentSearchEvalOut:
    rows: list[AgentSearchEvalRow] = []
    for item in body.questions:
        started = time.perf_counter()
        out = await search_corpus(
            AgentSearchIn(
                project=body.project,
                domain=body.domain,
                kinds=body.kinds,
                query=item.query,
                top_k=body.top_k,
                filters=item.filters,
                scope=item.scope,
                rerank=True,
            )
        )
        latency_ms = (time.perf_counter() - started) * 1000
        top_files = [r.filename for r in out.results]
        expected = [x for x in item.expected_files if x]
        if expected:
            matched_results = sum(1 for f in top_files if _file_match(f, expected))
            matched_expected = sum(1 for e in expected if _file_match(" ".join(top_files), [e]))
            precision = matched_results / max(len(top_files), 1)
            recall = matched_expected / max(len(expected), 1)
            reciprocal = 0.0
            for rank, filename in enumerate(top_files, start=1):
                if _file_match(filename, expected):
                    reciprocal = 1.0 / rank
                    break
        else:
            precision = 1.0 if not top_files else 0.0
            recall = 1.0
            reciprocal = 1.0
        rows.append(
            AgentSearchEvalRow(
                id=item.id,
                query=item.query,
                expected_files=expected,
                top_files=top_files,
                precision=precision,
                recall=recall,
                mrr=reciprocal,
                latency_ms=latency_ms,
            )
        )

    latencies = sorted((r.latency_ms for r in rows), reverse=False)
    p95_idx = max(0, min(len(latencies) - 1, int(len(latencies) * 0.95) - 1)) if latencies else 0
    return AgentSearchEvalOut(
        project=body.project,
        domain=body.domain,
        kinds=body.kinds or [body.domain],
        question_count=len(rows),
        mean_precision=sum(r.precision for r in rows) / max(len(rows), 1),
        mean_recall=sum(r.recall for r in rows) / max(len(rows), 1),
        mean_mrr=sum(r.mrr for r in rows) / max(len(rows), 1),
        p95_latency_ms=latencies[p95_idx] if latencies else 0.0,
        rows=rows,
    )
