"""Query intent + filter extraction.

Two responsibilities:
1. Classify the question shape: `lookup` (RAG over chunks), `aggregate`
   (run SQL against the entities table), or `compare` (multi-entity reasoning).
2. Extract structured filters from the question — tickers, form types, dates,
   entity types — so we can narrow Qdrant payload filters before retrieval.

We use the LLM with tool-calling. The schema we ask it to fill is itself derived
from the domain's `DomainSchema` — so this stays domain-agnostic: the SEC schema
declares `Filing.form_type` as an enum, which becomes the allowed values for
filter extraction. Swap the schema, swap the available filter keys.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import BaseModel, Field

from kb.extract import llm
from kb.schema.model import DomainSchema

logger = logging.getLogger("kb.query.intent")

IntentKind = Literal["lookup", "aggregate", "compare", "negative"]


@dataclass
class QueryIntent:
    """Result of intent + filter extraction."""

    kind: IntentKind = "lookup"
    entity_type: str | None = None      # which entity type the question is mostly about
    filters: dict[str, Any] = field(default_factory=dict)  # facet → value (e.g. {"ticker": "AAPL"})
    sort_by: str | None = None          # field to order by (e.g. "filed_date")
    sort_dir: Literal["asc", "desc"] = "desc"
    limit: int | None = None
    reason: str = ""                    # short rationale (kept on the trace)


def _enum_values(schema: DomainSchema, type_name: str, field_name: str) -> list[str]:
    try:
        et = schema.entity(type_name)
    except KeyError:
        return []
    for f in et.fields:
        if f.name == field_name and f.enum:
            return list(f.enum)
    return []


def _build_user_prompt(question: str, schema: DomainSchema) -> str:
    entity_lines = []
    for e in schema.entities:
        fields = ", ".join(f"{f.name}{'*' if f.identity else ''}" for f in e.fields)
        entity_lines.append(f"- {e.name}: {fields}")
    vocab = "\n".join(f"  - {k}: {v}" for k, v in (schema.vocabulary or {}).items()) or "  (none)"

    return (
        f"Question: {question}\n\n"
        f"Entity types available (identity fields marked with *):\n"
        + "\n".join(entity_lines)
        + f"\n\nDomain vocabulary:\n{vocab}\n\n"
        "Classify the question shape and extract any facet filters that are explicit or "
        "strongly implied (company tickers, form types like 10-K/10-Q/8-K, dates, named "
        "entities). If the question references 'most recent', set sort_by/sort_dir/limit. "
        "If the question asks about something likely missing from the corpus (e.g. a "
        "company that wouldn't appear in the listed entity types), set kind='negative'."
    )


_SYSTEM_PROMPT = (
    "You are a query analyzer. Given a natural-language question about a knowledge base, "
    "output a JSON object that classifies the question's shape and extracts facet filters. "
    "Be precise: only extract filters that are explicit or strongly implied. Do not invent. "
    "Return the JSON object directly."
)


_FEW_SHOT_EXAMPLES = """
Examples of correct classification:

Q: "What does Apple disclose about supply chain risks?"
→ {"kind": "lookup", "entity_type": "RiskFactor", "filters": {"ticker": "AAPL"}, "reason": "Single fact lookup for a named company."}

Q: "Which companies had quarterly revenue exceeding $60 billion?"
→ {"kind": "aggregate", "entity_type": "FinancialMetric", "filters": {"name": "Revenue"}, "reason": "Aggregation over multiple entities with numeric threshold."}

Q: "Compare NVIDIA's Q1 and Q2 2024 EPS-Diluted."
→ {"kind": "compare", "entity_type": "FinancialMetric", "filters": {"ticker": "NVDA"}, "reason": "Side-by-side comparison of named items."}

Q: "What is Microsoft's largest revenue segment?"
→ {"kind": "negative", "entity_type": null, "filters": {"ticker": "MSFT"}, "reason": "Microsoft is unlikely to be in this corpus."}

Q: "What is Apple's highest quarterly revenue in the summary financials?"
→ {"kind": "aggregate", "entity_type": "FinancialMetric", "filters": {"name": "Revenue", "ticker": "AAPL"}, "reason": "Superlative (highest) requires scanning multiple entries — aggregate."}
"""


class _IntentResponse(BaseModel):
    """Pydantic response schema for `extract_intent`. Replaces the hand-rolled
    JSON-schema dict we used with chat_json. Instructor enforces this against
    the LLM and re-prompts on validation failure."""

    kind: IntentKind = "lookup"
    entity_type: str | None = None
    filters: dict[str, Any] = Field(default_factory=dict)
    sort_by: str | None = None
    sort_dir: Literal["asc", "desc"] = "desc"
    limit: int | None = None
    reason: str = ""


async def extract_intent(question: str, schema: DomainSchema, *, model: str | None = None) -> QueryIntent:
    """Best-effort intent extraction. Falls back to lookup-with-no-filters on any error.

    Uses `instructor` to enforce Pydantic-typed output via tool-call. Few-shot
    examples + the schema-derived entity vocabulary still guide the model.
    """
    try:
        resp = await llm.chat_structured(
            system=_SYSTEM_PROMPT + "\n\n" + _FEW_SHOT_EXAMPLES,
            user=_build_user_prompt(question, schema),
            response_model=_IntentResponse,
            model=model,
            temperature=0.0,
            max_tokens=512,
            timeout_s=30,
        )
    except Exception as e:
        logger.info("intent extraction failed (%s); defaulting to lookup", e)
        return QueryIntent(kind="lookup", reason=f"extractor_error: {e!s}"[:200])

    # Drop nulls + empty strings from filters; coerce ticker uppercase.
    clean: dict[str, Any] = {}
    for k, v in resp.filters.items():
        if v in (None, "", []):
            continue
        if k.lower() == "ticker" and isinstance(v, str):
            clean[k] = v.upper()
        else:
            clean[k] = v

    return QueryIntent(
        kind=resp.kind or "lookup",
        entity_type=resp.entity_type or None,
        filters=clean,
        sort_by=resp.sort_by or None,
        sort_dir=resp.sort_dir or "desc",
        limit=resp.limit,
        reason=resp.reason[:300],
    )


def intent_to_payload_filter(intent: QueryIntent, schema: DomainSchema) -> dict[str, Any]:
    """Translate intent into Qdrant payload filter keys.

    Today chunks carry only `domain`, `file_id`, `entity_id`, `parent_id` as
    indexed payload keys. So this returns an empty filter; intent is still used
    downstream for boosting hits whose entity_id matches a lookup.
    """
    return {}


# Single source of truth for the aggregate-keyword fallback.
# Grok Issue 8: previously this regex was inlined in engine.py and duplicated
# (in spirit) elsewhere. Centralising it lets every caller share the same
# heuristic, and `looks_aggregate` now logs when the fallback would override
# a `lookup` classification so operators can see classifier drift in logs.
_AGGREGATE_KEYWORDS = (
    "which compan", "how many", "highest", "lowest", "compare ", "across all",
    "exceed", "above $", "more than $", "greater than", "less than $",
    "average ", "median ", "total ", "sum ",
)


def looks_aggregate(question: str) -> bool:
    """True if the question shape suggests an aggregate/structured query.

    Used as a safety net when the LLM intent classifier mis-labels an
    obvious aggregate as `lookup`.
    """
    q_low = (question or "").lower()
    return any(kw in q_low for kw in _AGGREGATE_KEYWORDS)


async def intent_to_entity_ids(intent: QueryIntent, domain: str) -> list[str]:
    """Resolve intent (entity_type + facet filters) -> matching entity IDs."""
    from kb.query.structured import list_entities_matching

    if not intent.entity_type or not intent.filters:
        return []
    rows = await list_entities_matching(
        domain=domain,
        entity_type=intent.entity_type,
        filters={k: v for k, v in intent.filters.items() if isinstance(v, (str, int))},
        limit=50,
    )
    return [r["id"] for r in rows]
