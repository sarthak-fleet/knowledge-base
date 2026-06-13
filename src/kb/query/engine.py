"""Query engine: intent → (structured | RAG) → rerank → span-cite → synthesis.

This is intentionally a small orchestrator. Each step is a named stage that goes
on the query trace with its own latency and (where applicable) token cost. The
reviewer / user can inspect `/query/trace/{id}` to see exactly what happened.
"""

from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass
from typing import Any, Literal

import structlog

from kb.config import pipeline
from kb.extract import llm
from kb.query.intent import (
    QueryIntent,
    extract_intent,
    intent_to_entity_ids,
    intent_to_payload_filter,
)
from kb.query.mmr import consolidate_sources, mmr_rerank
from kb.query.rerank import rerank as cross_rerank
from kb.query.spans import pick_best_span
from kb.query.structured import maybe_structured_answer
from kb.query.types import Citation, CitationSource, Confidence, QueryIn, QueryOut, RetrievedNode
from kb.query.verify import (
    adjust_confidence_with_verification,
    verification_summary,
    verify_citations,
)
from kb.schema.loader import schema_from_dict
from kb.storage import repo
from kb.vector.factory import get_store

logger = structlog.get_logger("kb.query")

_CITE_RE = re.compile(r"\[(\d+)\]")


@dataclass(frozen=True)
class _CitationSource:
    via: Literal["graph_route", "retrieval"]
    file_id: str
    filename: str
    page_start: int
    page_end: int
    excerpt: str
    hit: dict[str, Any] | None = None


def _build_graph_sources(
    mentions: list[dict[str, Any]], filenames: dict[str, str], excerpt_chars: int
) -> list[_CitationSource]:
    """Normalize graph-route mentions into citation sources.

    Dedupes by file/page/excerpt so one graph mention does not get duplicated
    into the source list and shift downstream numbering.
    """
    out: list[_CitationSource] = []
    seen: set[tuple[str, int, int, str]] = set()
    for m in mentions:
        fid = str(m.get("file_id") or "")
        if not fid:
            continue
        ps = int(m.get("page_start") or 0)
        pe = int(m.get("page_end") or ps)
        excerpt = (m.get("excerpt") or "")[:excerpt_chars]
        key = (fid, ps, pe, excerpt)
        if key in seen:
            continue
        seen.add(key)
        out.append(
            _CitationSource(
                via="graph_route",
                file_id=fid,
                filename=filenames.get(fid, "unknown"),
                page_start=ps,
                page_end=pe,
                excerpt=excerpt,
            )
        )
    return out


def _build_retrieval_sources(hits: list[dict[str, Any]]) -> list[_CitationSource]:
    return [
        _CitationSource(
            via="retrieval",
            file_id=str(h["metadata"].get("file_id", "")),
            filename="",
            page_start=int(h["metadata"].get("page_start") or 0),
            page_end=int(h["metadata"].get("page_end") or h["metadata"].get("page_start") or 0),
            excerpt="",
            hit=h,
        )
        for h in hits
    ]


def _format_numbered_sources(
    graph_sources: list[_CitationSource], retrieval_sources: list[_CitationSource]
) -> str:
    out: list[str] = []
    if graph_sources:
        out.append("Graph sources:")
        for i, src in enumerate(graph_sources, start=1):
            page = src.page_start
            if src.page_end and src.page_end != page:
                page = f"{src.page_start}-{src.page_end}"
            out.append(f"[{i}] (file={src.file_id[:8]} page={page})\n{src.excerpt}")
    if retrieval_sources:
        if out:
            out.append("")
        out.append("Retrieval sources:")
        offset = len(graph_sources)
        for i, src in enumerate(retrieval_sources, start=1):
            h = src.hit or {}
            md = h.get("metadata", {})
            page = md.get("page_start", "?")
            if md.get("page_end") and md.get("page_end") != page:
                page = f"{md['page_start']}-{md['page_end']}"
            out.append(
                f"[{offset + i}] (file={md.get('file_id', '?')[:8]} page={page})\n{h.get('text', '')}"
            )
    return "\n\n".join(out)


def _extract_cited_indices(answer: str) -> list[int]:
    return sorted({int(m.group(1)) for m in _CITE_RE.finditer(answer)})


def _build_explicit_filters(
    scope: dict[str, Any] | None, filters: dict[str, Any] | None
) -> dict[str, Any]:
    """Filters explicitly supplied by the caller (NOT intent-derived)."""
    f: dict[str, Any] = {}
    if scope:
        for k in ("entity_id", "file_id", "parent_id"):
            if scope.get(k):
                f[k] = scope[k]
    if filters:
        for k, v in filters.items():
            f[k] = v
    return f


def _format_sources(hits: list[dict[str, Any]]) -> str:
    out: list[str] = []
    for i, h in enumerate(hits, start=1):
        md = h["metadata"]
        page = md.get("page_start", "?")
        if md.get("page_end") and md.get("page_end") != page:
            page = f"{md['page_start']}-{md['page_end']}"
        out.append(f"[{i}] (file={md.get('file_id', '?')[:8]} page={page})\n{h['text']}")
    return "\n\n".join(out)


def _bookend_reorder(hits: list[Any]) -> list[Any]:
    """Reorder so highest-relevance chunks sit at the START and END of the prompt.

    Liu et al. 2023 (arXiv 2307.03172) showed LLMs over-attend to chunks at the
    beginning and end of context, miss the middle. With K chunks sorted by
    relevance descending, this returns them in the order [0, 2, 4, ..., 5, 3, 1]
    so the top-1 sits at position 0 and the top-2 sits at position K-1.
    """
    if len(hits) <= 2:
        return hits
    odds = hits[1::2]  # 2nd, 4th, ... ranked
    evens = hits[0::2]  # 1st, 3rd, 5th, ...
    return evens + list(reversed(odds))


async def _resolve_filenames(file_ids: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for fid in set(file_ids):
        f = await repo.get_file(fid)
        if f:
            out[fid] = f["filename"]
    return out


def _stage(name: str, started: float, **extra: Any) -> dict[str, Any]:
    return {"stage": name, "latency_ms": int((time.time() - started) * 1000), **extra}


async def answer_query(body: QueryIn) -> QueryOut:
    started_total = time.time()
    cfg = pipeline.pipeline_config(body.domain)
    store = get_store()
    stages: list[dict[str, Any]] = []
    token_usage: dict[str, int] = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}

    # ── Stage 0: session + intent ────────────────────────────────────────────
    sess = await repo.get_or_create_session(body.session_id, body.domain, project=body.project)
    session_id = sess["id"]
    history = sess.get("history") or []
    history_block = ""
    if history:
        last = history[-3:]
        history_block = "\n\nPrior turns:\n" + "\n".join(
            f"Q: {t.get('q', '')}\nA: {t.get('a', '')[:200]}" for t in last
        )

    schema_row = await repo.get_active_schema(body.domain, project=body.project)
    if not schema_row:
        raise RuntimeError(f"no active schema for domain {body.domain}")
    schema = schema_from_dict(schema_row["spec"])

    started = time.time()
    intent: QueryIntent = await extract_intent(body.question, schema, domain=body.domain)
    stages.append(
        _stage("intent", started, kind=intent.kind, filters=intent.filters, reason=intent.reason)
    )
    logger.info("intent: kind=%s filters=%s", intent.kind, intent.filters)

    # ── Stage 1a: structured-query path (fuzzy SQL over entities table) ─────
    structured: dict[str, Any] | None = None
    if intent.kind in ("aggregate", "compare"):
        started = time.time()
        structured = await maybe_structured_answer(
            intent=intent, domain=body.domain, question=body.question, project=body.project
        )
        stages.append(
            _stage(
                "structured",
                started,
                hit=bool(structured),
                count=len(structured["entities"]) if structured else 0,
            )
        )

    # ── Stage 1b: DuckDB text-to-SQL route — heavier hammer for aggregation ─
    # Used when the structured route returned nothing or for more complex queries.
    # The LLM writes SQL against in-memory DuckDB views of the entities table.
    # Reference: Patronus FinanceBench (arXiv 2311.11944).
    duckdb_result: dict[str, Any] | None = None
    # Keyword fallback: the intent classifier is non-deterministic and sometimes
    # labels "which X had Y > Z?" as `lookup`. Catch the obvious shapes here so
    # the DuckDB route still fires. Centralised in kb.query.intent.looks_aggregate
    # (Grok Issue 8).
    from kb.query.intent import looks_aggregate as _looks_aggregate

    looks_agg = _looks_aggregate(body.question)
    if looks_agg and intent.kind == "lookup":
        # Grok Issue 8: surface classifier drift so operators see when
        # the keyword fallback is overriding the LLM-assigned intent.
        logger.info(
            "intent fallback fired: classifier=lookup but keyword shape suggests aggregate (q=%r)",
            body.question[:80],
        )
    if (intent.kind in ("aggregate", "compare") or looks_agg) and bool(
        pipeline.get(cfg, "retrieve.duckdb_route_enabled", True)
    ):
        started = time.time()
        # The import is inside the try so a missing optional dep (or any
        # transitive ImportError in duckdb_route) downgrades to "no DuckDB
        # route" rather than 500'ing the whole query. We hit this in prod
        # when duckdb wasn't yet in pyproject.toml.
        try:
            from kb.query.duckdb_route import maybe_duckdb_answer

            dr = await maybe_duckdb_answer(
                intent=intent, domain=body.domain, question=body.question, project=body.project
            )
        except Exception as e:
            logger.warning("duckdb route failed: %s", e)
            dr = None
        if dr:
            duckdb_result = {
                "rows": dr.rows,
                "columns": dr.columns,
                "sql": dr.sql,
                "mentions": dr.mentions,
                "summary": dr.summary,
            }
            stages.append(_stage("duckdb", started, rows=len(dr.rows), sql=dr.sql[:120]))
        else:
            stages.append(_stage("duckdb", started, rows=0))

    # ── Stage 1b.5: graph route for cross-document "themes" questions ───────
    # GraphRAG-shaped (Microsoft, arXiv 2404.16130) but scoped to our entity
    # graph: when the question asks for cross-document themes, vector retrieval
    # over chunks is the wrong shape. Group entities, summarise, cite filings.
    # NOT mutually exclusive with DuckDB — both can fire and feed the
    # synthesizer complementary structured + narrative views.
    graph_result: dict[str, Any] | None = None
    if bool(pipeline.get(cfg, "retrieve.graph_route_enabled", True)):
        from kb.query.graph_route import looks_like_themes, maybe_graph_answer

        if looks_like_themes(body.question):
            started = time.time()
            try:
                gr = await maybe_graph_answer(
                    intent=intent, domain=body.domain, question=body.question, project=body.project
                )
            except Exception as e:
                logger.warning("graph route failed: %s", e)
                gr = None
            if gr:
                graph_result = {
                    "summary": gr.summary,
                    "rows": [{"id": r.get("id"), "type": r.get("type")} for r in gr.rows],
                    "mentions": gr.mentions,
                    "grouping_field": gr.grouping_field,
                }
                stages.append(
                    _stage(
                        "graph_route",
                        started,
                        entities=len(gr.rows),
                        grouping=gr.grouping_field,
                    )
                )
            else:
                stages.append(_stage("graph_route", started, entities=0))

    # ── Stage 1c: query rewriting + HyDE + decomposition ────────────────────
    # Produces an expanded list of queries to retrieve against, fused via RRF.
    # All three are configurable on/off via retrieve.* config keys.
    #
    # Dependency graph (matters for perf):
    #   decompose(body.question)  →  changes the seed list of queries
    #   hyde(body.question)       →  independent of decompose
    #   rewrite(q) for q in queries  →  depends on decompose's output, but
    #                                   each rewrite is independent of the others
    #
    # So we run decompose ‖ hyde in parallel, then fan-out rewrite across all
    # the resulting queries in parallel. ~50% latency drop on warm cache vs the
    # prior sequential shape.
    queries = [body.question]
    syn_model_for_queries = pipeline.get(cfg, "llm.synthesize.model")
    decompose_on = bool(pipeline.get(cfg, "retrieve.query_decomposition", True))
    hyde_on = bool(pipeline.get(cfg, "retrieve.hyde", False))

    async def _decompose_call() -> tuple[bool, list[str], float]:
        if not decompose_on:
            return False, [body.question], 0.0
        from kb.query.rewriter import decompose_query

        t0 = time.time()
        is_compound, subs = await decompose_query(body.question, model=syn_model_for_queries)
        return (
            is_compound,
            (subs[:] if is_compound and len(subs) > 1 else [body.question]),
            (time.time() - t0) * 1000,
        )

    async def _hyde_call() -> tuple[str | None, float]:
        if not hyde_on:
            return None, 0.0
        from kb.query.rewriter import hyde_passage

        t0 = time.time()
        h = await hyde_passage(body.question, model=syn_model_for_queries)
        return (h if h and h != body.question else None), (time.time() - t0) * 1000

    started_block = time.time()
    (is_compound, decomposed, decompose_ms), (hyde_text, hyde_ms) = await asyncio.gather(
        _decompose_call(), _hyde_call()
    )
    queries = decomposed
    if decompose_on:
        stages.append(
            {
                "stage": "decompose",
                "latency_ms": int(decompose_ms),
                "kind": "compound" if is_compound else "single",
                "sub_count": len(queries),
            }
        )

    # Fan-out rewrite across all queries in parallel.
    if bool(pipeline.get(cfg, "retrieve.query_rewriting", True)):
        from kb.query.rewriter import rewrite_query

        n = int(pipeline.get(cfg, "retrieve.query_rewriting_variants", 3))
        started = time.time()
        rewrite_results = await asyncio.gather(
            *(rewrite_query(q, n=n, model=syn_model_for_queries) for q in queries),
            return_exceptions=True,
        )
        expanded: list[str] = []
        for r in rewrite_results:
            if isinstance(r, Exception):
                continue
            expanded.extend(r)
        # Dedupe, cap at 6 to keep retrieval cost reasonable
        seen: set[str] = set()
        queries = []
        for q in expanded:
            ql = q.lower().strip()
            if ql and ql not in seen:
                seen.add(ql)
                queries.append(q)
            if len(queries) >= 6:
                break
        stages.append(_stage("rewrite", started, variants=len(queries)))

    if hyde_on:
        if hyde_text:
            queries.append(hyde_text)
        stages.append({"stage": "hyde", "latency_ms": int(hyde_ms), "used": hyde_text is not None})

    _block_ms = int((time.time() - started_block) * 1000)
    logger.info(
        "query_expansion_done",
        block_ms=_block_ms,
        decompose_ms=int(decompose_ms),
        hyde_ms=int(hyde_ms),
        final_queries=len(queries),
    )

    # ── Stage 2: retrieval (multi-query RRF, optionally multi-kind RRF) ──────
    explicit_filters = _build_explicit_filters(body.scope, body.filters)
    payload_filters = {
        **intent_to_payload_filter(intent, schema),
        **explicit_filters,
        "project": body.project,
    }
    top_k_dense = int(pipeline.get(cfg, "retrieve.top_k_dense", 20))
    top_k_sparse = int(pipeline.get(cfg, "retrieve.top_k_sparse", 20))
    candidate_k = int(pipeline.get(cfg, "retrieve.candidate_k", max(top_k_dense, top_k_sparse) * 2))
    rerank_top_k = int(pipeline.get(cfg, "retrieve.rerank_top_k", 8))

    # Project-aware cross-kind retrieval. `body.kinds` (when set) lists every
    # kind within `body.project` to fan retrieval out across. Default behaviour
    # (no kinds set) is a single-kind query against `body.domain`, matching
    # the pre-project shape.
    target_kinds: list[str] = body.kinds or [body.domain]

    async def _search_one_kind(kind: str, q: str) -> list[Any]:
        return await store.hybrid_search(
            domain=kind,
            query=q,
            top_k_dense=top_k_dense,
            top_k_sparse=top_k_sparse,
            rerank_top_k=candidate_k,
            filters=payload_filters or None,
        )

    started = time.time()
    if len(queries) == 1 and len(target_kinds) == 1:
        hits = await _search_one_kind(target_kinds[0], queries[0])
    else:
        # Multi-query and/or multi-kind: run each (kind × query) combo, then
        # fuse all rankings via RRF on chunk IDs in one pass. This is the same
        # RRF kernel that multi-query already uses — it scales to any number
        # of input rankings.
        from kb.query.rewriter import fuse_rrf

        per_run: list[list[Any]] = []
        rankings: list[list[str]] = []
        for kind in target_kinds:
            for q in queries:
                h = await _search_one_kind(kind, q)
                per_run.append(h)
                rankings.append([x.id for x in h])
        # Deduplicate hits and assign RRF score
        by_id: dict[str, Any] = {}
        for hlist in per_run:
            for h in hlist:
                if h.id not in by_id:
                    by_id[h.id] = h
        fused = fuse_rrf(rankings)
        hits = []
        for cid, rrf_score in fused[:candidate_k]:
            h = by_id.get(cid)
            if h is not None:
                # Overwrite the retrieval score with the fused RRF score.
                h.score = float(rrf_score)
                hits.append(h)
    intent_entity_ids = await intent_to_entity_ids(intent, body.domain, project=body.project)
    stages.append(
        _stage(
            "retrieve",
            started,
            candidates=len(hits),
            queries=len(queries),
            filters=payload_filters or {},
            intent_entities=len(intent_entity_ids),
        )
    )

    # Soft boost: if the intent resolved to specific entity ids (by ticker/form_type),
    # promote hits whose entity_id matches. Pure ordering — never drops candidates.
    if intent_entity_ids or (structured and structured.get("entities")):
        wanted = set(intent_entity_ids)
        if structured and structured.get("entities"):
            wanted.update(e["id"] for e in structured["entities"])
        boosted = sorted(
            hits,
            key=lambda h: (1.0 if (h.metadata.get("entity_id") in wanted) else 0.0, h.score),
            reverse=True,
        )
        hits = boosted

    # Section-boost: when the question references section-shape vocabulary
    # (e.g. "risk factors", "results of operations", "management's discussion")
    # promote hits whose chunk metadata's `section_title` matches. Uses the
    # `section_title` field added by build_chunks (chunking.py). Pure ordering
    # boost; the LLM rerank stage below has the final say.
    if bool(pipeline.get(cfg, "retrieve.section_boost_enabled", True)) and hits:
        q_low = body.question.lower()
        # Tokenize the question into 2+ word phrases that often map to SEC
        # section names. A future-proof version would derive these from the
        # schema; this list is the 80% on SEC + Legal.
        _section_phrases = (
            "risk factor",
            "risk factors",
            "results of operations",
            "management discussion",
            "md&a",
            "supply chain",
            "customer concentration",
            "export control",
            "climate",
            "cybersecurity",
            "warranty",
            "indemnif",
            "license grant",
            "patent grant",
            "copyleft",
            "distribut",  # catches both "distribution" and "redistribution" — license sections use either
        )
        matchers = [p for p in _section_phrases if p in q_low]
        if matchers:

            def _section_score(h: Any) -> float:
                title = (h.metadata.get("section_title") or "").lower()
                if not title:
                    return 0.0
                return float(sum(1 for p in matchers if p in title))

            hits = sorted(
                hits,
                key=lambda h: (_section_score(h), h.score),
                reverse=True,
            )
            stages.append(
                {
                    "stage": "section_boost",
                    "latency_ms": 0,
                    "matched_phrases": matchers[:3],
                    "boosted_count": sum(1 for h in hits[:rerank_top_k] if _section_score(h) > 0),
                }
            )

    # ── Stage 3: cross-encoder rerank ────────────────────────────────────────
    mmr_pool = int(pipeline.get(cfg, "retrieve.mmr_pool", rerank_top_k * 2))
    if bool(pipeline.get(cfg, "retrieve.rerank_with_cross_encoder", True)) and hits:
        started = time.time()
        # Keep a larger pool here so MMR has room to choose for diversity.
        hits = await cross_rerank(body.question, hits, top_k=mmr_pool)
        stages.append(_stage("rerank", started, kept=len(hits)))
    else:
        hits = hits[:mmr_pool]

    # ── Stage 3.5: MMR for diversity ─────────────────────────────────────────
    if bool(pipeline.get(cfg, "retrieve.mmr_enabled", True)) and len(hits) > rerank_top_k:
        started = time.time()
        lam = float(pipeline.get(cfg, "retrieve.mmr_lambda", 0.7))
        hits = await mmr_rerank(hits, query=body.question, top_k=rerank_top_k, lambda_=lam)
        stages.append(_stage("mmr", started, kept=len(hits), lambda_=lam))
    else:
        hits = hits[:rerank_top_k]

    # ── Stage 3.7: bookend reorder (lost-in-the-middle, Liu 2023) ────────────
    if bool(pipeline.get(cfg, "retrieve.bookend_reorder", True)) and len(hits) >= 3:
        hits = _bookend_reorder(hits)

    serializable_hits = [
        {"id": h.id, "text": h.text, "score": h.score, "metadata": h.metadata} for h in hits
    ]

    # ── Stage 3.8: CRAG retrieval evaluator ──────────────────────────────────
    # Score retrieval QUALITY before synthesis. If clearly noise, downgrade
    # confidence proactively. Yan et al. 2024 (arXiv 2401.15884).
    from kb.query.crag import evaluate_retrieval

    crag_score: float = 1.0
    crag_reason: str = ""
    if bool(pipeline.get(cfg, "retrieve.crag_evaluator", True)) and serializable_hits:
        started = time.time()
        crag_score, crag_reason = await evaluate_retrieval(
            question=body.question,
            chunks=serializable_hits,
            model=pipeline.get(cfg, "llm.synthesize.model"),
        )
        stages.append(_stage("crag", started, score=crag_score, reason=crag_reason[:80]))

    # ── Stage 3.9: Self-RAG retry on low CRAG score ──────────────────────────
    # Self-RAG (Asai et al. 2024, arXiv 2310.11511): when retrieval looks weak,
    # ask the LLM to reformulate the query based on what the (weak) chunks
    # told us, then re-run retrieval ONCE with the new query. Keep whichever
    # result has the better CRAG score. Bounded: max 1 retry per request.
    selfrag_threshold = float(pipeline.get(cfg, "retrieve.selfrag_threshold", 0.4))
    if (
        bool(pipeline.get(cfg, "retrieve.selfrag_enabled", True))
        and serializable_hits
        and crag_score < selfrag_threshold
    ):
        from kb.query.rewriter import reformulate_for_self_rag

        started = time.time()
        # Build a terse summary of what we got so the reformulator can pivot.
        weak_summary = "\n".join(f"- {(h.get('text') or '')[:200]}" for h in serializable_hits[:4])
        new_query = await reformulate_for_self_rag(
            body.question, weak_summary, model=pipeline.get(cfg, "llm.synthesize.model")
        )
        if new_query != body.question:
            # Single re-issue of the hybrid search (no MMR / rerank chain
            # again — keep the retry cheap).
            retry_hits = await store.hybrid_search(
                domain=body.domain,
                query=new_query,
                top_k_dense=top_k_dense,
                top_k_sparse=top_k_sparse,
                rerank_top_k=rerank_top_k,
                filters=payload_filters or None,
            )
            retry_serial = [
                {"id": h.id, "text": h.text, "score": h.score, "metadata": h.metadata}
                for h in retry_hits
            ]
            new_crag_score, new_crag_reason = await evaluate_retrieval(
                question=body.question,
                chunks=retry_serial,
                model=pipeline.get(cfg, "llm.synthesize.model"),
            )
            if new_crag_score > crag_score:
                hits = retry_hits
                serializable_hits = retry_serial
                crag_score, crag_reason = new_crag_score, new_crag_reason
                stages.append(
                    _stage(
                        "self_rag",
                        started,
                        triggered=True,
                        improved=True,
                        new_query=new_query[:120],
                        new_crag=new_crag_score,
                    )
                )
            else:
                stages.append(
                    _stage(
                        "self_rag",
                        started,
                        triggered=True,
                        improved=False,
                        new_query=new_query[:120],
                    )
                )

    # ── Stage 4: synthesis ───────────────────────────────────────────────────
    sys_prompt = pipeline.get(cfg, "prompts.synthesize_system", "")
    graph_sources: list[_CitationSource] = []
    if graph_result and graph_result.get("mentions"):
        graph_filenames = await _resolve_filenames(
            list({m["file_id"] for m in graph_result["mentions"] if m.get("file_id")})
        )
        graph_sources = _build_graph_sources(
            graph_result["mentions"],
            graph_filenames,
            int(pipeline.get(cfg, "synthesize.excerpt_chars", 400)),
        )
    retrieval_sources = _build_retrieval_sources(serializable_hits)
    # Keep the existing chunk/source mapping for retrieval-only citations.
    sources_by_chunk = consolidate_sources(hits)
    combined_sources = graph_sources + retrieval_sources
    structured_block = ""
    if structured:
        structured_block += (
            "\nStructured pre-answer (already grounded in the entities table):\n"
            f"{structured['summary']}\n"
        )
    if duckdb_result:
        structured_block += (
            "\nDuckDB query result (text-to-SQL over extracted tables; trust this for numeric/aggregation facts):\n"
            f"{duckdb_result['summary']}\n"
        )
    if graph_result:
        structured_block += (
            "\nGraph-route summary (cross-document themes derived from the "
            f"entity layer, grouped by {graph_result['grouping_field']}; "
            "use this as the spine of the answer for theme-shape questions):\n"
            f"{graph_result['summary']}\n"
        )
    user_prompt = (
        f"Question: {body.question}{history_block}{structured_block}\n\n"
        f"Sources:\n{_format_numbered_sources(graph_sources, retrieval_sources)}\n\n"
        "Answer the question using ONLY the sources above. Cite using inline [n] markers "
        "tied to the source numbers. If the sources don't support an answer, say so "
        "explicitly and report low confidence. "
        'End with a JSON object on its own line: {"confidence": 0.0-1.0, "confidence_reason": "..."}.'
    )

    answer_text = ""
    refuse_no_cite = bool(pipeline.get(cfg, "synthesize.refuse_if_no_citations", True))
    started = time.time()
    syn_usage: dict[str, int] = {}
    try:
        answer_text, syn_usage = await llm.chat_text_with_usage(
            system=sys_prompt,
            user=user_prompt,
            model=pipeline.get(cfg, "llm.synthesize.model"),
            temperature=float(pipeline.get(cfg, "llm.synthesize.temperature", 0.2)),
            max_tokens=int(pipeline.get(cfg, "llm.synthesize.max_tokens", 1024)),
        )
    except Exception as e:
        logger.warning("synthesis failed: %s", e)
        answer_text = "I could not synthesize an answer due to a transient error."
    stages.append(
        _stage("synthesize", started, **{k: v for k, v in syn_usage.items() if k != "model"})
    )
    for k in ("prompt_tokens", "completion_tokens", "total_tokens"):
        token_usage[k] += int(syn_usage.get(k, 0))

    confidence_value, confidence_reason = 0.5, "default"
    # Grok Issue 3: route the confidence-JSON parse through the same robust
    # _coerce_json helper used everywhere else. Earlier code matched the LAST
    # {...} on the line with `\s*$`, which could either fail silently (leaving
    # the answer with a stray JSON trailer) or accept a non-confidence JSON
    # block. Now we explicitly look for a confidence-shaped object at EOF and
    # only strip when the parse succeeds AND the object has the expected keys.
    from kb.extract.llm import _coerce_json

    m = re.search(r"(\{[^{}]*?\"confidence\"[^{}]*?\})\s*$", answer_text, flags=re.S)
    if m:
        j = _coerce_json(m.group(1))
        if isinstance(j, dict) and "confidence" in j:
            try:
                confidence_value = float(j.get("confidence", confidence_value))
                confidence_reason = str(j.get("confidence_reason", confidence_reason))
                answer_text = answer_text[: m.start()].rstrip()
            except (TypeError, ValueError):
                pass

    # CRAG: if retrieval was scored low, cap confidence proactively.
    crag_min = float(pipeline.get(cfg, "retrieve.crag_min_score", 0.3))
    if crag_score < crag_min and serializable_hits:
        confidence_value = min(confidence_value, crag_score)
        confidence_reason = f"CRAG retrieval score {crag_score:.2f}: {crag_reason}"

    cited_indices = _extract_cited_indices(answer_text)
    if not cited_indices and refuse_no_cite and combined_sources:
        answer_text = (
            "I cannot answer with citations from the provided sources. "
            "The retrieved excerpts do not directly support a confident answer to this question."
        )
        confidence_value = min(confidence_value, 0.2)
        confidence_reason = "no inline citations produced"

    # ── Stage 4.5: citation verification ─────────────────────────────────────
    # AIS-style entailment per claim — the most expensive stage in the pipeline
    # (~16s p50 with Pro judge). We can skip it on **high-confidence retrieval +
    # high model confidence** without compromising the "cited or it didn't
    # happen" rule: if CRAG already scored retrieval as strong AND the
    # synthesizer reported high confidence, the marginal cost of one more
    # per-claim entailment pass isn't worth ~16s. The synth-level
    # refuse_if_no_citations guard still fires regardless.
    verify_enabled = bool(pipeline.get(cfg, "synthesize.verify_citations", True))
    hard_citation_gate = bool(pipeline.get(cfg, "synthesize.hard_citation_gate", False))
    require_verified_citations = bool(
        pipeline.get(cfg, "synthesize.require_verified_citations", hard_citation_gate)
    )
    min_verified_claim_pass_rate = float(
        pipeline.get(cfg, "synthesize.min_verified_claim_pass_rate", 1.0)
    )
    verify_skip_threshold = float(pipeline.get(cfg, "synthesize.verify_skip_threshold", 0.7))
    should_verify = (
        verify_enabled
        and cited_indices
        and (
            hard_citation_gate
            or not (
                crag_score >= verify_skip_threshold and confidence_value >= verify_skip_threshold
            )
        )
    )
    verify_summary: dict[str, Any] = {}
    if should_verify:
        started = time.time()
        checks = await verify_citations(
            answer=answer_text,
            sources=serializable_hits,
            model=pipeline.get(cfg, "llm.synthesize.model"),
        )
        verify_summary = verification_summary(checks)
        confidence_value, confidence_reason = adjust_confidence_with_verification(
            confidence_value,
            confidence_reason,
            verify_summary,
        )
        stages.append(
            _stage(
                "verify",
                started,
                **{k: v for k, v in verify_summary.items() if k != "failed_claims"},
            )
        )
        pass_rate = verify_summary.get("pass_rate")
        gate_failed = False
        if pass_rate is None:
            gate_failed = require_verified_citations
        else:
            gate_failed = float(pass_rate) < min_verified_claim_pass_rate
        if hard_citation_gate and gate_failed:
            answer_text = (
                "I cannot answer with verified citations from the provided sources. "
                "The retrieved excerpts did not pass the citation support check."
            )
            confidence_value = min(confidence_value, 0.2)
            confidence_reason = "citation verification gate failed"
            cited_indices = []
    elif verify_enabled and cited_indices:
        # Recorded for trace-transparency — verify is configured on but we
        # skipped it because retrieval + synth were both highly confident.
        stages.append(
            {
                "stage": "verify",
                "latency_ms": 0,
                "skipped": True,
                "reason": f"crag={crag_score:.2f}, conf={confidence_value:.2f}",
            }
        )

    # ── Stage 5: span-level citations (global numbering across graph + retrieval) ───
    started = time.time()
    retrieval_file_ids_to_resolve: set[str] = set()
    for i in cited_indices:
        if len(graph_sources) < i <= len(combined_sources):
            src = combined_sources[i - 1]
            if src.via == "retrieval":
                h = src.hit or {}
                md = h.get("metadata", {})
                primary = md.get("file_id", "")
                if primary:
                    retrieval_file_ids_to_resolve.add(primary)
                for fid in sources_by_chunk.get(h.get("id", ""), []):
                    if fid:
                        retrieval_file_ids_to_resolve.add(fid)
    retrieval_filenames = await _resolve_filenames(list(retrieval_file_ids_to_resolve))
    excerpt_chars = int(pipeline.get(cfg, "synthesize.excerpt_chars", 400))

    citations: list[Citation] = []
    for i in cited_indices:
        if not (1 <= i <= len(combined_sources)):
            continue
        src = combined_sources[i - 1]
        if src.via == "graph_route":
            citations.append(
                Citation(
                    file_id=src.file_id,
                    filename=src.filename,
                    page_start=src.page_start,
                    page_end=src.page_end,
                    excerpt=src.excerpt,
                    also_in=[],
                    bbox=None,
                    via="graph_route",
                )
            )
            continue
        h = src.hit or {}
        md = h.get("metadata", {})
        excerpt = await pick_best_span(
            query=body.question, chunk_text=h.get("text", ""), max_chars=excerpt_chars
        )
        primary = md.get("file_id", "")
        also_files = [
            CitationSource(file_id=f, filename=retrieval_filenames.get(f, "unknown"))
            for f in sources_by_chunk.get(h.get("id", ""), [])
            if f and f != primary
        ]
        citations.append(
            Citation(
                file_id=primary,
                filename=retrieval_filenames.get(primary, "unknown"),
                page_start=int(md.get("page_start") or 0),
                page_end=int(md.get("page_end") or md.get("page_start") or 0),
                excerpt=excerpt,
                also_in=also_files,
                bbox=None,
                via="retrieval",
            )
        )

    stages.append(_stage("span_cite", started, citations=len(citations)))

    retrieved_nodes = [
        RetrievedNode(
            node_id=h["id"],
            score=float(h["score"]),
            file_id=h["metadata"].get("file_id", ""),
            entity_id=h["metadata"].get("entity_id"),
            excerpt=h["text"][:240],
        )
        for h in serializable_hits
    ]

    latency_ms = int((time.time() - started_total) * 1000)
    trace_id = await repo.insert_query_trace(
        {
            "project": body.project,
            "domain": body.domain,
            "question": body.question,
            "scope": body.scope,
            "filters": {
                **(body.filters or {}),
                "_intent": {
                    "kind": intent.kind,
                    "entity_type": intent.entity_type,
                    "filters": intent.filters,
                    "reason": intent.reason,
                },
                "_stages": stages,
                "_token_usage": token_usage,
                "_verification": verify_summary,
            },
            "retrieved": serializable_hits,
            "answer": answer_text,
            "citations": [c.model_dump() for c in citations],
            "confidence": {"value": confidence_value, "reason": confidence_reason},
            "latency_ms": latency_ms,
        }
    )
    await repo.append_session_turn(session_id, {"q": body.question, "a": answer_text})

    # Wire the request into the Prometheus aggregator. Previously this was a
    # ghost feature — `kb.api.metrics.record_query` was defined and the
    # `/metrics` endpoint served it, but nothing in the engine ever called it,
    # so every counter stayed at 0 in production. Caught by post-eval defensive
    # sweep alongside the duckdb-route bug.
    try:
        from kb.api import metrics

        metrics.record_query(latency_ms, token_usage.get("total_tokens", 0), stages)
    except Exception as e:
        logger.info("metrics.record_query failed (non-fatal): %s", e)

    return QueryOut(
        answer=answer_text,
        citations=citations,
        retrieved=retrieved_nodes,
        confidence=Confidence(value=confidence_value, reason=confidence_reason),
        session_id=session_id,
        trace_id=trace_id,
    )
