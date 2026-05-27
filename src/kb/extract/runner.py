"""Schema-driven extraction over cached elements. Yields candidate records per type.

For each page-window we render the elements as a numbered text block, ask the LLM
for entities matching the active schema, and validate the response against the
schema's JSON Schema. Each record carries its own provenance.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

import structlog

from kb.config import get_settings, pipeline
from kb.extract import llm
from kb.extract.schema_to_json import extraction_envelope_schema
from kb.extract.windowing import page_windows
from kb.parse import Element, parse_file
from kb.schema.loader import schema_from_dict
from kb.schema.model import DomainSchema
from kb.storage import repo

logger = structlog.get_logger("kb.extract")


@dataclass
class ExtractedRecord:
    """One LLM-extracted record before entity resolution."""

    entity_type: str
    fields: dict[str, Any]            # schema fields minus _provenance
    provenance: dict[str, Any]        # page_start, page_end, excerpt, element_ids, confidence
    window: tuple[int, int]           # source window for traceability


@dataclass
class ExtractionResult:
    file_id: str
    schema_id: str
    domain: str
    records: list[ExtractedRecord]
    elements: list[Element]


def _render_window(elements: list[Element], window: tuple[int, int]) -> str:
    lines: list[str] = []
    p0, p1 = window
    lines.append(f"=== WINDOW pages {p0}-{p1} ===")
    cur_page = -1
    for e in elements:
        if e.page != cur_page:
            cur_page = e.page
            lines.append(f"\n--- page {cur_page} ---")
        prefix = f"[{e.id} {e.type}]"
        text = e.text
        if e.type == "Table" and e.metadata.get("text_as_html") and not text:
            text = e.metadata["text_as_html"]
        lines.append(f"{prefix} {text}")
    return "\n".join(lines)


def _vocabulary_block(schema: DomainSchema) -> str:
    if not schema.vocabulary:
        return ""
    items = "\n".join(f"- {k}: {v}" for k, v in schema.vocabulary.items())
    return f"\nDomain vocabulary:\n{items}\n"


async def _extract_window(
    schema: DomainSchema,
    window: tuple[int, int],
    elements: list[Element],
    *,
    cfg: dict[str, Any],
) -> list[ExtractedRecord]:
    envelope = extraction_envelope_schema(schema)
    sys_prompt = (
        pipeline.get(cfg, "prompts.extract_system", "")
        + _vocabulary_block(schema)
        + "\n\nReturn entities ONLY when the context supports them. "
          "For every record, fill _provenance with page numbers and a verbatim excerpt (<=400 chars) "
          "from the context that supports the record."
    )
    user_prompt = _render_window(elements, window)
    floor: float = float(pipeline.get(cfg, "extract.confidence_floor", 0.4))
    timeout_s: float = float(pipeline.get(cfg, "llm.extract.request_timeout_s", 120))

    try:
        resp = await llm.chat_json(
            system=sys_prompt,
            user=user_prompt,
            schema=envelope,
            model=pipeline.get(cfg, "llm.extract.model"),
            temperature=float(pipeline.get(cfg, "llm.extract.temperature", 0.0)),
            max_tokens=int(pipeline.get(cfg, "llm.extract.max_tokens", 4096)),
            timeout_s=timeout_s,
        )
    except Exception as e:
        logger.warning("window %s extraction failed: %s", window, e)
        return []

    out: list[ExtractedRecord] = []
    for etype, records in (resp.get("entities") or {}).items():
        if not isinstance(records, list):
            continue
        for r in records:
            if not isinstance(r, dict):
                continue
            prov = r.pop("_provenance", {}) or {}
            try:
                conf = float(prov.get("confidence", 0.0))
            except (TypeError, ValueError):
                conf = 0.0
            if conf < floor:
                continue
            out.append(
                ExtractedRecord(
                    entity_type=etype,
                    fields=r,
                    provenance=prov,
                    window=window,
                )
            )
    return out


async def extract_for_file(*, file_id: str, domain: str) -> ExtractionResult:
    file_row = await repo.get_file(file_id)
    if not file_row:
        raise RuntimeError(f"file {file_id} not found")
    schema_row = await repo.get_active_schema(domain)
    if not schema_row:
        raise RuntimeError(f"no active schema for domain {domain}")
    schema = schema_from_dict(schema_row["spec"])

    elements = await parse_file(
        file_id=file_id,
        content_hash=file_row["content_hash"],
        object_key=file_row["object_key"],
        filename=file_row["filename"],
        mime=file_row["mime"],
    )

    cfg = pipeline.pipeline_config(domain)
    window_pages = int(pipeline.get(cfg, "extract.window_pages", 8))
    overlap = int(pipeline.get(cfg, "extract.window_overlap_pages", 1))
    max_calls = int(pipeline.get(cfg, "extract.max_concurrent_calls", 4))

    sem = asyncio.Semaphore(max_calls)

    async def _one(win: tuple[int, int], els: list[Element]) -> list[ExtractedRecord]:
        async with sem:
            return await _extract_window(schema, win, els, cfg=cfg)

    tasks = []
    for p0, p1, bucket in page_windows(elements, window_pages=window_pages, overlap_pages=overlap):
        tasks.append(asyncio.create_task(_one((p0, p1), bucket)))

    records: list[ExtractedRecord] = []
    for chunk in await asyncio.gather(*tasks, return_exceptions=True):
        if isinstance(chunk, Exception):
            logger.warning("window task error: %s", chunk)
            continue
        records.extend(chunk)

    # XLSX bridge: for spreadsheet files, parse per-row entities deterministically.
    # The LLM extractor often misses dense tabular content; this is the safety net.
    if file_row["filename"].lower().endswith((".xlsx", ".xls")):
        from kb.extract.xlsx_bridge import extract_financial_metrics_from_xlsx
        # Reconstruct rows from elements: each ListItem element is one row;
        # the Title element is the header.
        rows: list[list[str]] = []
        header: list[str] | None = None
        for e in elements:
            if e.metadata.get("is_header"):
                # Header text looks like "Sheet 'X' header: A | B | C"
                if ":" in e.text and "|" in e.text:
                    h_part = e.text.split(":", 1)[1]
                    header = [s.strip() for s in h_part.split("|")]
                    rows.append(header)
            elif e.metadata.get("sheet") and not e.metadata.get("is_header"):
                # Row text looks like "[Sheet] Col1: Val1 | Col2: Val2 ..."
                body = e.text.split("] ", 1)[1] if "] " in e.text else e.text
                vals = [
                    pair.split(":", 1)[1].strip() if ":" in pair else pair.strip()
                    for pair in body.split("|")
                ]
                rows.append(vals)
        if rows:
            for rec in extract_financial_metrics_from_xlsx(rows):
                # Grok Issue 4: defensive default — any future or direct caller
                # that omits `_provenance` no longer raises KeyError mid-ingest.
                prov = rec.pop("_provenance", {}) or {}
                records.append(ExtractedRecord(
                    entity_type="FinancialMetric",
                    fields=rec,
                    provenance=prov,
                    window=(0, 0),
                ))
            logger.info("file %s: xlsx_bridge added rows for tabular extraction", file_id)

    settings = get_settings()  # noqa: F841 (kept for symmetry / future tuning)
    logger.info("file %s: extracted %d candidate records across %d windows", file_id, len(records), len(tasks))
    return ExtractionResult(
        file_id=file_id,
        schema_id=schema_row["id"],
        domain=domain,
        records=records,
        elements=elements,
    )
