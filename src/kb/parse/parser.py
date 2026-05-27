"""Parse stage: file bytes -> list[Element] with page numbers + bboxes.

Boundary contract:
- Input: raw file bytes + filename
- Output: list of Element dicts persisted as JSON, keyed by sha256(bytes)
- Idempotent: if the cache hit is present, parsing is skipped entirely.

This is the "parse once, re-extract many" boundary called out in DESIGN.md.
"""

from __future__ import annotations

import asyncio
import logging
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from kb.config import get_settings
from kb.storage import objects, repo

logger = logging.getLogger("kb.parse")


@dataclass
class Element:
    """Stable in-house element shape — independent of Unstructured's version."""

    id: str                      # parser-assigned element id
    type: str                    # Title | NarrativeText | Table | ListItem | ...
    text: str
    page: int                    # 1-based page index, 0 when N/A (e.g. xlsx)
    bbox: list[float] | None     # [x0, y0, x1, y1] when known
    parent_id: str | None        # heuristic hierarchy from Unstructured
    metadata: dict[str, Any]     # passthrough (filetype, languages, table HTML, etc.)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _strategy_for(filename: str, mime: str | None, default: str) -> str:
    name = filename.lower()
    if name.endswith((".xlsx", ".xls")):
        return "xlsx"
    if name.endswith(".pdf"):
        return default
    return "auto"  # unstructured.partition.auto handles everything else (txt, md, docx, html, ...)


def _parse_pdf_sync(blob: bytes, filename: str, strategy: str, languages: list[str]) -> list[Element]:
    from unstructured.partition.pdf import partition_pdf

    with tempfile.NamedTemporaryFile(suffix=Path(filename).suffix or ".pdf", delete=False) as tf:
        tf.write(blob)
        tmp = Path(tf.name)
    try:
        elements = partition_pdf(
            filename=str(tmp),
            strategy="auto" if strategy == "auto" else strategy,
            languages=languages,
            extract_images_in_pdf=False,
            infer_table_structure=True,
        )
    finally:
        tmp.unlink(missing_ok=True)

    return [_element_from_unstructured(e, i) for i, e in enumerate(elements)]


def _parse_auto_sync(blob: bytes, filename: str) -> list[Element]:
    """Auto-dispatch via unstructured.partition.auto for non-PDF / non-XLSX files."""
    from unstructured.partition.auto import partition

    with tempfile.NamedTemporaryFile(suffix=Path(filename).suffix or ".txt", delete=False) as tf:
        tf.write(blob)
        tmp = Path(tf.name)
    try:
        elements = partition(filename=str(tmp))
    finally:
        tmp.unlink(missing_ok=True)
    return [_element_from_unstructured(e, i, default_page=1) for i, e in enumerate(elements)]


def _parse_xlsx_sync(blob: bytes, filename: str) -> list[Element]:
    """Parse XLSX into one Element per row.

    `unstructured.partition.xlsx` returns one Table element per sheet, which produces
    a single monolithic chunk that doesn't retrieve well for row-specific questions
    ("what was X for Y in Q3?"). We use openpyxl directly to emit per-row text so
    each row is independently searchable.
    """
    import openpyxl

    with tempfile.NamedTemporaryFile(suffix=Path(filename).suffix or ".xlsx", delete=False) as tf:
        tf.write(blob)
        tmp = Path(tf.name)
    try:
        wb = openpyxl.load_workbook(tmp, data_only=True, read_only=True)
        out: list[Element] = []
        idx = 0
        for sheet in wb.worksheets:
            rows = sheet.iter_rows(values_only=True)
            header: list[str] = []
            for row_i, row in enumerate(rows):
                values = [("" if v is None else str(v)) for v in row]
                if not any(v.strip() for v in values):
                    continue
                if not header:
                    header = values
                    out.append(Element(
                        id=f"xlsx-{sheet.title}-header",
                        type="Title",
                        text=f"Sheet '{sheet.title}' header: " + " | ".join(header),
                        page=0,
                        bbox=None,
                        parent_id=None,
                        metadata={"sheet": sheet.title, "row": row_i, "is_header": True},
                    ))
                    idx += 1
                    continue
                # Render row as "Col1=Val1 | Col2=Val2 ..." for retrieval-friendly text.
                pairs = [f"{h}: {v}" for h, v in zip(header, values, strict=False) if h]
                text = f"[{sheet.title}] " + " | ".join(pairs)
                out.append(Element(
                    id=f"xlsx-{sheet.title}-r{row_i}",
                    type="ListItem",
                    text=text,
                    page=0,
                    bbox=None,
                    parent_id=f"xlsx-{sheet.title}-header",
                    metadata={"sheet": sheet.title, "row": row_i, "is_header": False},
                ))
                idx += 1
    finally:
        tmp.unlink(missing_ok=True)
    return out


def _element_from_unstructured(e: Any, idx: int, default_page: int = 1) -> Element:
    md = getattr(e, "metadata", None)
    md_dict: dict[str, Any] = md.to_dict() if md and hasattr(md, "to_dict") else {}
    page = int(md_dict.get("page_number") or default_page)
    bbox: list[float] | None = None
    coords = md_dict.get("coordinates") if isinstance(md_dict.get("coordinates"), dict) else None
    if coords:
        try:
            pts = coords.get("points")
            if pts and len(pts) >= 4:
                xs = [float(p[0]) for p in pts]
                ys = [float(p[1]) for p in pts]
                bbox = [min(xs), min(ys), max(xs), max(ys)]
        except Exception:
            bbox = None
    elem_id = md_dict.get("element_id") or f"el-{idx:06d}"
    return Element(
        id=str(elem_id),
        type=type(e).__name__,
        text=(getattr(e, "text", None) or "").strip(),
        page=page,
        bbox=bbox,
        parent_id=md_dict.get("parent_id"),
        metadata={
            "filetype": md_dict.get("filetype"),
            "languages": md_dict.get("languages"),
            "page_name": md_dict.get("page_name"),
            "text_as_html": md_dict.get("text_as_html"),
        },
    )


async def parse_file(*, file_id: str, content_hash: str, object_key: str, filename: str, mime: str | None) -> list[Element]:
    """Return cached elements if present; otherwise parse, cache, return."""
    cached = await repo.get_parse_artifact(content_hash)
    if cached:
        logger.info("parse cache hit for %s", content_hash[:12])
        raw = await objects.get_parse_artifact(cached["object_key"])
        return [Element(**r) for r in raw]

    blob = await objects.get_raw_file(object_key)
    settings = get_settings()
    strategy = _strategy_for(filename, mime, settings.parse_strategy_default)
    logger.info("parsing file_id=%s strategy=%s bytes=%d", file_id, strategy, len(blob))

    if strategy == "xlsx":
        elements = await asyncio.to_thread(_parse_xlsx_sync, blob, filename)
        parser = "unstructured:xlsx"
    elif filename.lower().endswith(".pdf"):
        elements = await asyncio.to_thread(_parse_pdf_sync, blob, filename, strategy, ["eng"])
        parser = f"unstructured:pdf:{strategy}"
    else:
        elements = await asyncio.to_thread(_parse_auto_sync, blob, filename)
        parser = "unstructured:auto"

    artifact_key = await objects.put_parse_artifact(content_hash, [e.to_dict() for e in elements])
    page_count = max((e.page for e in elements), default=0)
    await repo.put_parse_artifact(
        content_hash=content_hash,
        parser=parser,
        parser_version=None,
        object_key=artifact_key,
        page_count=page_count,
    )
    logger.info("parsed %s: %d elements across %d pages", content_hash[:12], len(elements), page_count)
    return elements
