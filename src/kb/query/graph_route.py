"""Graph-shaped query route for cross-document "themes" questions.

Inspired by Microsoft GraphRAG (arXiv 2404.16130), but scoped much smaller:
we already extract typed entities with provenance into Postgres — the entity
graph is *already there*. For "themes across N filings" / "consistent
patterns" / "how does X talk about Y?" questions, vector retrieval over
chunks is the wrong shape: you want to operate on the entity layer
directly.

This route:
  1. Detects "themes" intent via keyword shape (separate from looks_aggregate
     so we don't double-route).
  2. Pulls all entities of the most plausible type for the filter (today:
     `RiskFactor` is the strong fit on the SEC schema).
  3. Groups by an entity-defined grouping field if available (`category`
     for RiskFactor) or by parent_id (Section / Filing).
  4. Asks the LLM to summarise the consistent themes across the group, with
     citations back to the source filings via the entity_mentions table.

This is a sketch — not full GraphRAG. The full version would build
communities via Leiden / Louvain over a co-occurrence graph, generate LLM
summaries per community, and support local vs global search. The cheap
version below is the 80%-value path on our two demo domains.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import structlog

from kb.config.pipeline import get as cfg_get
from kb.config.pipeline import pipeline_config
from kb.extract import llm
from kb.query.intent import QueryIntent
from kb.query.structured import mentions_for
from kb.storage import repo

logger = structlog.get_logger("kb.query.graph_route")


_THEME_KEYWORDS = (
    "themes",
    "consistent",
    "across all",
    "across the",
    "patterns",
    "in general",
    "overall",
    "summarize all",
    "summarise all",
    "every filing",
    "all filings",
)


def looks_like_themes(question: str) -> bool:
    """True if the question shape suggests cross-document theme synthesis."""
    q = (question or "").lower()
    return any(kw in q for kw in _THEME_KEYWORDS)


@dataclass
class GraphResult:
    summary: str  # LLM-generated multi-doc summary
    rows: list[dict[str, Any]]  # the entities that fed the summary
    mentions: list[dict[str, Any]]  # provenance for citations
    grouping_field: str  # which field we grouped by (for trace transparency)


_THEME_SYSTEM = (
    "You are summarising consistent themes across multiple documents. Given a list "
    "of extracted entities (each tagged with its source filing) and the user's "
    "question, produce a short summary that:\n"
    "  - Identifies the 3-5 most prominent recurring themes\n"
    "  - For each, lists the sources it appears in (by filename or ticker)\n"
    "  - Does NOT invent themes that aren't supported by the listed entities\n"
    "Keep the response under 250 words. Cite using [n] markers — the caller will "
    "rewrite them into proper Citation objects."
)


def _format_entities_for_prompt(entities: list[dict[str, Any]], grouping_field: str) -> str:
    """Render the entity list as a numbered, grouped block the LLM can read."""
    by_group: dict[str, list[dict[str, Any]]] = {}
    for e in entities:
        g = (e.get("fields") or {}).get(grouping_field) or "ungrouped"
        by_group.setdefault(str(g), []).append(e)

    lines = []
    n = 0
    for g, items in by_group.items():
        lines.append(f"\n## Group: {g}")
        for it in items:
            n += 1
            fields = it.get("fields") or {}
            label = it.get("display_name") or fields.get("name") or it.get("identity_key") or "?"
            extras = " ".join(f"{k}={v}" for k, v in fields.items() if k != "name" and v)
            lines.append(f"[{n}] {label} ({extras})")
    return "\n".join(lines)


async def maybe_graph_answer(
    *, intent: QueryIntent, domain: str, question: str
) -> GraphResult | None:
    """Try the graph route. Returns None if the route doesn't fire or finds nothing.

    The caller (engine.py) decides when to invoke this based on
    `looks_like_themes(question)`. The route itself just looks at intent +
    domain entities and either produces a summary or backs off.
    """
    # We need an entity type to operate on. Source order, most-specific first:
    #   1. intent.entity_type (the question itself named one)
    #   2. schema-declared entity types with `graph_route: true`
    #   3. legacy `graph_route.default_entity_type` in domain config (kept for back-compat)
    # If none of those resolve, back off cleanly.
    entity_type: str | None = intent.entity_type
    if not entity_type:
        try:
            schema_row = await repo.get_active_schema(domain)
            if schema_row:
                from kb.schema.loader import schema_from_dict

                schema = schema_from_dict(schema_row["spec"])
                graph_types = schema.graph_route_entity_types()
                if graph_types:
                    entity_type = graph_types[0].name
        except Exception as e:
            logger.info("graph_route: schema-based entity-type lookup failed (%s)", e)
    if not entity_type:
        entity_type = cfg_get(pipeline_config(domain), "graph_route.default_entity_type")
    if not entity_type:
        return None

    # Pull entities — bounded; if we have hundreds, sample.
    rows = await repo.list_entities(domain=domain, type=entity_type, q=None, limit=200)
    if not rows:
        return None

    # Apply ticker filter if intent supplied one (e.g., "themes in NVIDIA filings").
    ticker = (intent.filters or {}).get("ticker")
    if ticker:
        rows = [r for r in rows if (r.get("fields") or {}).get("ticker") == ticker] or rows

    # Pick a grouping field: prefer `category` (RiskFactor has it on SEC),
    # fall back to `subject` / `type` / parent_id, otherwise no grouping.
    sample_fields = (rows[0].get("fields") or {}).keys() if rows else []
    grouping_field = next(
        (f for f in ("category", "subject", "topic", "kind") if f in sample_fields),
        "type",
    )

    # Resolve mentions for provenance.
    entity_ids = [str(r.get("id")) for r in rows if r.get("id")]
    mentions = await mentions_for(entity_ids) if entity_ids else []

    prompt = _format_entities_for_prompt(rows, grouping_field)
    try:
        summary, _usage = await llm.chat_text_with_usage(
            system=_THEME_SYSTEM,
            user=f"QUESTION:\n{question}\n\nENTITIES:\n{prompt}",
            temperature=0.1,
            max_tokens=600,
        )
    except Exception as e:
        logger.info("graph route summary failed", error=str(e)[:200])
        return None

    if not summary or not summary.strip():
        return None

    return GraphResult(
        summary=summary.strip(),
        rows=rows,
        mentions=mentions,
        grouping_field=grouping_field,
    )
