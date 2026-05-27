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
from dataclasses import dataclass
from typing import Any

import duckdb

from kb.extract import llm
from kb.query.intent import QueryIntent
from kb.query.structured import mentions_for
from kb.schema.loader import schema_from_dict
from kb.storage import repo

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
