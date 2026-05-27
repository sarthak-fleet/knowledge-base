"""Query engine: intent → (structured | RAG) → rerank → span-cite → synthesis.

This is intentionally a small orchestrator. Each step is a named stage that goes
on the query trace with its own latency and (where applicable) token cost. The
reviewer / user can inspect `/query/trace/{id}` to see exactly what happened.
"""

from __future__ import annotations

import re
import time
from typing import Any

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
    sess = await repo.get_or_create_session(body.session_id, body.domain)
    session_id = sess["id"]
    history = sess.get("history") or []
    history_block = ""
    if history:
        last = history[-3:]
        history_block = "\n\nPrior turns:\n" + "\n".join(
            f"Q: {t.get('q', '')}\nA: {t.get('a', '')[:200]}" for t in last
        )

    schema_row = await repo.get_active_schema(body.domain)
    if not schema_row:
        raise RuntimeError(f"no active schema for domain {body.domain}")
    schema = schema_from_dict(schema_row["spec"])

    started = time.time()
    intent: QueryIntent = await extract_intent(body.question, schema)
    stages.append(
        _stage("intent", started, kind=intent.kind, filters=intent.filters, reason=intent.reason)
    )
    logger.info("intent: kind=%s filters=%s", intent.kind, intent.filters)

    # ── Stage 1a: structured-query path (fuzzy SQL over entities table) ─────
    structured: dict[str, Any] | None = None
    if intent.kind in ("aggregate", "compare"):
        started = time.time()
        structured = await maybe_structured_answer(
            intent=intent, domain=body.domain, question=body.question
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
                intent=intent, domain=body.domain, question=body.question
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
                    intent=intent, domain=body.domain, question=body.question
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
    queries = [body.question]
    if bool(pipeline.get(cfg, "retrieve.query_decomposition", True)):
        from kb.query.rewriter import decompose_query

        started = time.time()
        is_compound, subs = await decompose_query(
            body.question, model=pipeline.get(cfg, "llm.synthesize.model")
        )
        if is_compound and len(subs) > 1:
            queries = subs[:]
            stages.append(_stage("decompose", started, kind="compound", sub_count=len(subs)))
        else:
            stages.append(_stage("decompose", started, kind="single"))
    if bool(pipeline.get(cfg, "retrieve.query_rewriting", True)):
        from kb.query.rewriter import rewrite_query

        started = time.time()
        n = int(pipeline.get(cfg, "retrieve.query_rewriting_variants", 3))
        expanded: list[str] = []
        for q in queries:
            expanded.extend(
                await rewrite_query(q, n=n, model=pipeline.get(cfg, "llm.synthesize.model"))
            )
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
    if bool(pipeline.get(cfg, "retrieve.hyde", False)):
        from kb.query.rewriter import hyde_passage

        started = time.time()
        hyde = await hyde_passage(body.question, model=pipeline.get(cfg, "llm.synthesize.model"))
        if hyde and hyde != body.question:
            queries.append(hyde)
        stages.append(_stage("hyde", started, used=hyde != body.question))

    # ── Stage 2: retrieval (multi-query RRF) ─────────────────────────────────
    explicit_filters = _build_explicit_filters(body.scope, body.filters)
    payload_filters = {**intent_to_payload_filter(intent, schema), **explicit_filters}
    top_k_dense = int(pipeline.get(cfg, "retrieve.top_k_dense", 20))
    top_k_sparse = int(pipeline.get(cfg, "retrieve.top_k_sparse", 20))
    candidate_k = int(pipeline.get(cfg, "retrieve.candidate_k", max(top_k_dense, top_k_sparse) * 2))
    rerank_top_k = int(pipeline.get(cfg, "retrieve.rerank_top_k", 8))

    started = time.time()
    if len(queries) == 1:
        hits = await store.hybrid_search(
            domain=body.domain,
            query=queries[0],
            top_k_dense=top_k_dense,
            top_k_sparse=top_k_sparse,
            rerank_top_k=candidate_k,
            filters=payload_filters or None,
        )
    else:
        # Multi-query: run each, fuse via RRF on the chunk IDs.
        from kb.query.rewriter import fuse_rrf

        per_query: list[list[Any]] = []
        rankings: list[list[str]] = []
        for q in queries:
            h = await store.hybrid_search(
                domain=body.domain,
                query=q,
                top_k_dense=top_k_dense,
                top_k_sparse=top_k_sparse,
                rerank_top_k=candidate_k,
                filters=payload_filters or None,
            )
            per_query.append(h)
            rankings.append([x.id for x in h])
        # Deduplicate hits and assign RRF score
        by_id: dict[str, Any] = {}
        for hlist in per_query:
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
    intent_entity_ids = await intent_to_entity_ids(intent, body.domain)
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
        weak_summary = "\n".join(
            f"- {(h.get('text') or '')[:200]}" for h in serializable_hits[:4]
        )
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

    # Map chunk_id -> [primary file_id, ...also_in_files] for multi-source citations.
    sources_by_chunk = consolidate_sources(hits)

    # ── Stage 4: synthesis ───────────────────────────────────────────────────
    sys_prompt = pipeline.get(cfg, "prompts.synthesize_system", "")
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
        f"Sources:\n{_format_sources(serializable_hits)}\n\n"
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
    if not cited_indices and refuse_no_cite and serializable_hits:
        answer_text = (
            "I cannot answer with citations from the provided sources. "
            "The retrieved excerpts do not directly support a confident answer to this question."
        )
        confidence_value = min(confidence_value, 0.2)
        confidence_reason = "no inline citations produced"

    # ── Stage 4.5: citation verification ─────────────────────────────────────
    verify_enabled = bool(pipeline.get(cfg, "synthesize.verify_citations", True))
    verify_summary: dict[str, Any] = {}
    if verify_enabled and cited_indices:
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

    # ── Stage 5: span-level citations (multi-source aware) ───────────────────
    # Resolve filenames for the cited chunks + every file in their also_in_files.
    file_ids_to_resolve: set[str] = set()
    for i in cited_indices:
        if not (1 <= i <= len(serializable_hits)):
            continue
        h = serializable_hits[i - 1]
        for fid in sources_by_chunk.get(h["id"], []):
            if fid:
                file_ids_to_resolve.add(fid)
    filenames = await _resolve_filenames(list(file_ids_to_resolve))
    excerpt_chars = int(pipeline.get(cfg, "synthesize.excerpt_chars", 400))

    started = time.time()
    citations: list[Citation] = []
    for i in cited_indices:
        if not (1 <= i <= len(serializable_hits)):
            continue
        h = serializable_hits[i - 1]
        md = h["metadata"]
        excerpt = await pick_best_span(
            query=body.question, chunk_text=h["text"], max_chars=excerpt_chars
        )
        primary = md.get("file_id", "")
        also_files = [
            CitationSource(file_id=f, filename=filenames.get(f, "unknown"))
            for f in sources_by_chunk.get(h["id"], [])
            if f and f != primary
        ]
        citations.append(
            Citation(
                file_id=primary,
                filename=filenames.get(primary, "unknown"),
                page_start=int(md.get("page_start") or 0),
                page_end=int(md.get("page_end") or md.get("page_start") or 0),
                excerpt=excerpt,
                also_in=also_files,
                bbox=None,
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
