"""Structured query path — runs against the entities table directly.

For aggregation / comparison questions ("which companies have revenue > $60B?")
the chunk-based RAG approach is wrong: the same fact is already extracted into
typed entities and we should answer from there. This path:

1. Translates intent.filters into a parameterised SQL filter over `entities.fields`.
2. Returns the matching entities + their mentions (with provenance) so the synthesis
   step can still cite source files page-by-page.

If the structured query returns nothing, the caller falls back to RAG.
"""

from __future__ import annotations

import json
import operator
import re
from typing import Any

import structlog
from sqlalchemy import text

from kb.query.intent import QueryIntent
from kb.storage.db import session

logger = structlog.get_logger("kb.query.structured")


# Map of simple comparison operators we accept in NL-parsed numeric filters.
_OPS = {">": operator.gt, ">=": operator.ge, "<": operator.lt, "<=": operator.le, "=": operator.eq}
_FIELD_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _safe_field_key(key: str) -> str | None:
    """Return a SQL-safe JSON field key or None if the key is not valid."""
    if isinstance(key, str) and _FIELD_KEY_RE.fullmatch(key):
        return key
    return None


async def list_entities_matching(
    *,
    domain: str,
    entity_type: str | None,
    filters: dict[str, Any],
    limit: int = 50,
    project: str = "default",
) -> list[dict[str, Any]]:
    """Lightweight structured query over the entities table.

    Supports two filter shapes per key:
      - Plain value:    `{"ticker": "AAPL"}`              → `fields->>'ticker' = 'AAPL'`
      - Compare tuple:  `{"value": (">", 60000)}`         → `(fields->>'value')::numeric > 60000`
    """
    conds: list[str] = ["project = :project", "domain = :d"]
    params: dict[str, Any] = {"project": project, "d": domain, "_limit": limit}
    if entity_type:
        conds.append("type = :t")
        params["t"] = entity_type

    for i, (k, v) in enumerate(filters.items()):
        safe_key = _safe_field_key(k)
        if not safe_key:
            logger.warning("dropping unsafe structured filter key: %r", k)
            continue
        key = f"f{i}"
        if isinstance(v, tuple) and len(v) == 2 and v[0] in _OPS:
            op, val = v
            conds.append(f"(fields->>'{safe_key}')::numeric {op} :{key}")
            params[key] = val
        else:
            # Fuzzy-string match by default: "Q2 2024" matches "Q2 FY2024", etc.
            # Intent extraction often produces normalized strings that don't
            # exactly equal the stored field; ILIKE with %v% catches both.
            conds.append(f"(fields->>'{safe_key}') ILIKE :{key}")
            params[key] = f"%{v}%"

    sql = (
        "SELECT id::text, type, identity_key, display_name, fields, parent_id::text "
        "FROM entities WHERE " + " AND ".join(conds) + " ORDER BY updated_at DESC LIMIT :_limit"
    )
    async with session() as s:
        rows = (await s.execute(text(sql), params)).mappings().all()
        return [dict(r) for r in rows]


async def mentions_for(entity_ids: list[str], project: str = "default") -> list[dict[str, Any]]:
    """Pull mentions + provenance for a set of canonical entities."""
    if not entity_ids:
        return []
    async with session() as s:
        rows = (
            (
                await s.execute(
                    text(
                        """
                    SELECT m.entity_id::text, m.file_id::text, f.filename,
                           p.page_start, p.page_end, p.excerpt
                    FROM entity_mentions m
                    JOIN files f ON f.id = m.file_id
                    LEFT JOIN provenance_spans p ON p.entity_id = m.entity_id AND p.file_id = m.file_id
                    WHERE m.project = :project AND m.entity_id = ANY(:ids)
                    ORDER BY m.created_at DESC
                    LIMIT 200
                    """
                    ),
                    {"project": project, "ids": entity_ids},
                )
            )
            .mappings()
            .all()
        )
        return [dict(r) for r in rows]


def parse_numeric_threshold(question: str) -> tuple[str, float] | None:
    """Crude numeric-threshold parser: 'revenue > $60 billion' → ('>', 60_000)."""
    import re

    m = re.search(
        r"(>|>=|<|<=)\s*\$?\s*(\d[\d,\.]*)\s*(b|bn|billion|m|mm|million|k|thousand)?",
        question.lower(),
    )
    if not m:
        return None
    op = m.group(1)
    num = float(m.group(2).replace(",", ""))
    unit = (m.group(3) or "").lower()
    if unit.startswith("b"):
        num *= 1000  # entities store in $M
    elif unit.startswith("k") or unit.startswith("thousand"):
        num /= 1000
    return op, num


async def maybe_structured_answer(
    *,
    intent: QueryIntent,
    domain: str,
    question: str,
    project: str = "default",
) -> dict[str, Any] | None:
    """Try to answer aggregation-shape questions from the entities table.

    Returns None if structured path doesn't apply or finds nothing.
    Otherwise returns a dict with `entities`, `mentions`, and a natural-language
    summary the synthesis step can cite from.
    """
    if intent.kind not in ("aggregate", "compare"):
        return None
    threshold = parse_numeric_threshold(question)
    filters: dict[str, Any] = {}
    # Pull any non-numeric filters from intent
    for k, v in intent.filters.items():
        if isinstance(v, (str, int)):
            filters[k] = v
    # Heuristic: aggregate questions often target FinancialMetric or RiskFactor
    et = intent.entity_type
    if not et and any(w in question.lower() for w in ("revenue", "income", "eps", "margin")):
        et = "FinancialMetric"
    if threshold and et == "FinancialMetric":
        filters["value"] = (threshold[0], threshold[1])
    elif threshold:
        # Generic numeric filter on 'value' field
        filters["value"] = (threshold[0], threshold[1])

    entities = await list_entities_matching(
        domain=domain,
        entity_type=et,
        filters=filters,
        limit=50,
        project=project,
    )
    if not entities:
        return None
    mentions = await mentions_for([e["id"] for e in entities], project=project)
    summary_lines = [
        f"Found {len(entities)} {et or 'entities'} matching filters {json.dumps(filters)}:"
    ]
    for e in entities[:10]:
        summary_lines.append(
            f"  - {e['display_name'] or e['identity_key']}: {json.dumps(e['fields'])}"
        )
    return {
        "entities": entities,
        "mentions": mentions,
        "summary": "\n".join(summary_lines),
    }
