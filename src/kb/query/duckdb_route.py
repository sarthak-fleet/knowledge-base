"""DuckDB text-to-SQL route for numeric / aggregation questions.

Inspired by Patronus FinanceBench (arXiv 2311.11944): vanilla RAG gets 19% on
SEC numeric QA; full-context GPT-4 gets 78%. The class of failures is questions
like "what was X's revenue in Q2 2024?" or "which companies had revenue > $60B?"
that need structured access to extracted tables, not dense+sparse retrieval over
narrative chunks.

This route:
  1. Builds a DuckDB in-memory database from the entities table — every
     extracted entity becomes a row in a typed view per entity_type.
  2. Asks the LLM to write SQL for the question, constrained to the available
     views and columns.
  3. Executes the SQL safely (read-only DuckDB, no UDFs).
  4. Returns rows + provenance (mentions → file_id, filename, excerpt) so the
     synthesis step can still produce a properly cited answer.

The route only fires for intent.kind == 'aggregate' OR when the intent
classifier mentions numeric/comparison shapes. Lookup questions stay on RAG.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Any

import duckdb

from kb.extract import llm
from kb.query.intent import QueryIntent
from kb.query.structured import mentions_for
from kb.schema.loader import schema_from_dict
from kb.storage import repo

# Filename → ticker fallback. Most SEC filings name themselves
# `TICKER_FORM_DATE_*.html` (the EDGAR adapter follows this convention) so
# parsing the prefix is reliable. We use this when the extraction itself
# fails to populate the `ticker` field on a `FinancialMetric` — which is
# the dominant cause of "DuckDB query returns NULL" on aggregate questions
# (found by per-question failure analysis on the Step 7 evals).
_TICKER_FROM_FILENAME = re.compile(r"^([A-Z]{1,5})[_-]")


def _ticker_from_filename(filename: str | None) -> str | None:
    if not filename:
        return None
    m = _TICKER_FROM_FILENAME.match(filename)
    return m.group(1) if m else None


# Metric-name normalization. The extraction LLM produces wildly inconsistent
# `name` values across filings — "Revenue" vs "Total Net Sales" vs
# "Net Sales - iPhone" all mean the same business concept, and the SQL
# generator can't reliably guess which raw name maps to which question.
#
# This canonical-bucket map is overlaid as a new view column,
# `metric_canonical`, so the LLM can write `WHERE metric_canonical='revenue'`
# and pick up every shape. Buckets are conservative — if we don't know a
# mapping, the column is NULL and the raw `name` is still available.
#
# Patterns are checked in order (most specific first). They match
# case-insensitively as substrings of the raw name unless anchored.
_METRIC_CANONICAL_PATTERNS: list[tuple[str, str]] = [
    # eps_diluted before eps_basic so "eps - diluted" hits the right bucket
    (r"\beps\b.*\bdilut", "eps_diluted"),
    (r"\bdilut.*\beps\b", "eps_diluted"),
    (r"earnings per share.*dilut", "eps_diluted"),
    (r"\beps\b.*\bbasic", "eps_basic"),
    (r"earnings per share.*basic", "eps_basic"),
    # revenue family — Net Sales (Apple-flavor), Net Sales - X (Apple
    # sub-segments), and the literal "Revenue" used by MSFT/NVDA.
    (r"total net sales", "revenue"),
    (r"net sales - ", "revenue_segment"),  # iPhone / Services etc. — sub-bucket
    (r"\bnet sales\b", "revenue"),
    (r"\brevenue\b", "revenue"),
    (r"net income", "net_income"),
    (r"net earnings", "net_income"),
    (r"operating income", "operating_income"),
    (r"gross margin", "gross_margin"),
    (r"total assets", "total_assets"),
    (r"cash and cash equiv", "cash"),
]


def _metric_canonical(raw_name: str | None) -> str | None:
    if not raw_name:
        return None
    n = raw_name.lower().strip()
    for pat, canon in _METRIC_CANONICAL_PATTERNS:
        if re.search(pat, n):
            return canon
    return None

logger = logging.getLogger("kb.query.duckdb")


@dataclass
class DuckResult:
    rows: list[dict[str, Any]]      # query result rows
    columns: list[str]
    sql: str                        # the LLM-generated SQL we ran
    mentions: list[dict[str, Any]]  # provenance for the cited entities
    summary: str                    # natural-language summary the synthesizer can cite


def _build_duckdb_from_entities(entities_by_type: dict[str, list[dict]]) -> duckdb.DuckDBPyConnection:
    """Materialise the entities table into DuckDB views, one per entity type.

    For each entity type, we expose:
      - canonical columns: id, type, display_name, identity_key, parent_id
      - all keys present in any entity's `fields` JSON, flattened to columns
    """
    import pandas as pd

    conn = duckdb.connect(":memory:")
    for etype, rows in entities_by_type.items():
        if not rows:
            continue
        all_field_keys: set[str] = set()
        for r in rows:
            all_field_keys.update((r.get("fields") or {}).keys())
        keys = sorted(all_field_keys)
        norm = []
        for r in rows:
            fields = r.get("fields") or {}
            row = {
                "id": str(r.get("id", "")),
                "type": etype,
                "display_name": r.get("display_name"),
                "identity_key": r.get("identity_key"),
                "parent_id": str(r.get("parent_id") or ""),
            }
            for k in keys:
                row[k] = fields.get(k)
            # Inject metric_canonical for FinancialMetric so SQL can write
            # `WHERE metric_canonical='revenue'` and hit every flavor of the
            # underlying raw name ('Revenue', 'Total Net Sales', 'Net Sales',
            # etc.). See _METRIC_CANONICAL_PATTERNS above for the mapping.
            if etype == "FinancialMetric":
                row["metric_canonical"] = _metric_canonical(
                    fields.get("name") or row.get("display_name")
                )
            norm.append(row)
        if norm:
            df = pd.DataFrame(norm)
            conn.register(f"_data_{etype}", df)
            conn.execute(f'CREATE VIEW "{etype}" AS SELECT * FROM _data_{etype}')
    return conn


def _list_views(conn: duckdb.DuckDBPyConnection) -> dict[str, list[str]]:
    """Return {view_name: [column_names]} so we can describe the schema to the LLM."""
    out: dict[str, list[str]] = {}
    for row in conn.execute("SELECT table_name FROM information_schema.tables WHERE table_schema='main'").fetchall():
        name = row[0]
        cols = conn.execute(f'DESCRIBE "{name}"').fetchall()
        out[name] = [c[0] for c in cols]
    return out


_SQL_SYSTEM = (
    "You are a SQL generator. Given a question and a list of available DuckDB views, "
    "write ONE SELECT statement that answers the question. "
    "Rules: "
    "(1) Use ONLY the listed views/columns. "
    "(2) No CTEs unless strictly necessary. "
    "(3) Use ILIKE for fuzzy string matches (period values store 'FY2024', not '2024'). "
    "(4) For numeric comparisons cast: CAST(value AS DOUBLE) > 60000. "
    "(5) Return at most 25 rows. "
    "(6) For FinancialMetric, PREFER the `metric_canonical` column over the raw "
    "`name` — it normalises across companies. Values: 'revenue' (covers 'Revenue', "
    "'Net Sales', 'Total Net Sales'), 'revenue_segment' (Apple's 'Net Sales - iPhone' "
    "etc.), 'net_income', 'operating_income', 'gross_margin', 'eps_diluted', "
    "'eps_basic', 'total_assets', 'cash'. NULL when no mapping applies — in that case "
    "fall back to ILIKE on the raw `name`. "
    "(7) `ticker` is reliable: company stocks ('AAPL', 'NVDA', 'MSFT', 'TSLA', etc.). "
    "Reply with the SQL only, no markdown fences, no commentary."
)


def _sql_user_prompt(question: str, views: dict[str, list[str]]) -> str:
    lines = ["Available DuckDB views:"]
    for name, cols in views.items():
        lines.append(f"  {name}({', '.join(cols)})")
    lines.append(f"\nQuestion: {question}\n\nSQL:")
    return "\n".join(lines)


async def maybe_duckdb_answer(*, intent: QueryIntent, domain: str, question: str) -> DuckResult | None:
    """Try the DuckDB route. Returns None if it finds nothing or SQL fails.

    The caller decides when to fire (intent.kind in {aggregate,compare} OR a
    keyword fallback). This function just runs the SQL pipeline.
    """
    schema_row = await repo.get_active_schema(domain)
    if not schema_row:
        return None
    schema = schema_from_dict(schema_row["spec"])

    entities_by_type: dict[str, list[dict]] = {}
    for et in schema.entities:
        rows = await repo.list_entities(domain=domain, type=et.name, q=None, limit=500)
        if rows:
            entities_by_type[et.name] = rows

    if not entities_by_type:
        return None

    # File-level ticker fallback. Many extracted entities (esp. FinancialMetric
    # in the SEC schema) come back with `ticker=NULL` because the extractor
    # didn't fill the field even though the source file is clearly tagged
    # (e.g. AAPL_10-K_2025.html). Without this, every `WHERE ticker='AAPL'`
    # SQL returns 0 rows and the route emits NULL.
    #
    # We resolve the first mention's filename for every entity once, derive
    # the ticker prefix, and overlay it onto the entity row when the entity
    # itself doesn't have a ticker. Done in batch (single SQL call).
    all_ids = [str(r.get("id")) for rows in entities_by_type.values() for r in rows if r.get("id")]
    file_ticker_by_entity: dict[str, str] = {}
    if all_ids:
        try:
            ments = await mentions_for(all_ids)
            # Keep the first mention per entity (mentions_for is ORDER BY created_at DESC,
            # but a single ticker is what we want regardless of recency).
            for m in ments:
                eid = m.get("entity_id")
                if eid and eid not in file_ticker_by_entity:
                    tk = _ticker_from_filename(m.get("filename"))
                    if tk:
                        file_ticker_by_entity[eid] = tk
        except Exception as e:
            logger.info("duckdb: ticker-fallback resolution failed (%s); proceeding without it", e)

    # Overlay the file-ticker onto every entity row's `fields` dict if the
    # row doesn't already have a ticker. This keeps the DuckDB schema stable
    # (same column names) and lets existing SQL using `ticker` just work.
    if file_ticker_by_entity:
        backfilled = 0
        for _etype, rows in entities_by_type.items():
            for r in rows:
                fields = r.get("fields") or {}
                if not fields.get("ticker"):
                    tk = file_ticker_by_entity.get(str(r.get("id", "")))
                    if tk:
                        fields["ticker"] = tk
                        r["fields"] = fields
                        backfilled += 1
        if backfilled:
            logger.info("duckdb: backfilled ticker on %d entities via filename fallback", backfilled)

    conn = _build_duckdb_from_entities(entities_by_type)
    try:
        views = _list_views(conn)
        # Ask the LLM for SQL
        try:
            sql, _ = await llm.chat_text_with_usage(
                system=_SQL_SYSTEM,
                user=_sql_user_prompt(question, views),
                model=None,
                temperature=0.0,
                max_tokens=400,
            )
        except Exception as e:
            logger.warning("duckdb: SQL generation failed: %s", e)
            return None

        sql = (sql or "").strip()
        # Strip markdown fences if the model added them
        if sql.startswith("```"):
            sql = sql.split("```", 2)[1] if "```" in sql[3:] else sql.strip("`")
            if sql.lower().startswith("sql"):
                sql = sql[3:].strip()
        if not sql.lower().lstrip().startswith("select"):
            logger.info("duckdb: generated SQL is not a SELECT, skipping. got: %s", sql[:80])
            return None
        # Safety: refuse anything that mentions destructive keywords
        bad = ("drop ", "delete ", "update ", "insert ", "alter ", "create table", "attach ")
        if any(b in sql.lower() for b in bad):
            logger.warning("duckdb: rejected destructive SQL: %s", sql[:80])
            return None

        try:
            cursor = conn.execute(sql)
            cols = [d[0] for d in cursor.description] if cursor.description else []
            rows = [dict(zip(cols, row, strict=False)) for row in cursor.fetchall()]
        except Exception as e:
            logger.info("duckdb: SQL execution failed (%s); SQL was: %s", e, sql[:200])
            return None

        if not rows:
            return None

        # Resolve provenance: mentions for every entity_id we returned
        entity_ids = [str(r.get("id")) for r in rows if r.get("id")]
        mentions = await mentions_for(entity_ids) if entity_ids else []

        # Natural-language summary the synthesizer can cite
        col_strs = ", ".join(cols)
        summary_lines = [
            "Executed the following DuckDB SQL against the structured entities table:",
            f"  {sql}",
            f"Returned {len(rows)} row(s), columns: ({col_strs})",
            "Top rows:",
        ]
        for r in rows[:10]:
            summary_lines.append("  " + " | ".join(f"{k}={v}" for k, v in r.items()))
        return DuckResult(
            rows=rows,
            columns=cols,
            sql=sql,
            mentions=mentions,
            summary="\n".join(summary_lines),
        )
    finally:
        conn.close()
