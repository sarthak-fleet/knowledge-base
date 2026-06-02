"""Parse stage: file bytes -> list[Element] with page numbers + bboxes.

Boundary contract:
- Input: raw file bytes + filename
- Output: list of Element dicts persisted as JSON, keyed by sha256(bytes)
- Idempotent: if the cache hit is present, parsing is skipped entirely.

This is the "parse once, re-extract many" boundary called out in DESIGN.md.
"""

from __future__ import annotations

import asyncio
import re
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import structlog

from kb.config import get_settings, pipeline
from kb.storage import objects, repo

logger = structlog.get_logger("kb.parse")


@dataclass
class Element:
    """Stable in-house element shape — independent of Unstructured's version."""

    id: str  # parser-assigned element id
    type: str  # Title | NarrativeText | Table | ListItem | ...
    text: str
    page: int  # 1-based page index, 0 when N/A (e.g. xlsx)
    bbox: list[float] | None  # [x0, y0, x1, y1] when known
    parent_id: str | None  # heuristic hierarchy from Unstructured
    metadata: dict[str, Any]  # passthrough (filetype, languages, table HTML, etc.)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _parse_options(
    filename: str,
    mime: str | None,
    default: str,
    parse_config: dict[str, Any] | None,
) -> tuple[str, str, list[str], str]:
    cfg = parse_config or {}
    name = filename.lower()
    ext = Path(name).suffix
    raw_by_ext = cfg.get("strategy_by_extension")
    by_ext = raw_by_ext if isinstance(raw_by_ext, dict) else {}
    strategy = str(by_ext.get(ext) or cfg.get("default_strategy") or default)
    pdf_strategy = str(cfg.get("pdf_strategy") or strategy)
    engine = str(cfg.get("parser_engine") or cfg.get("engine") or "unstructured")
    raw_languages = cfg.get("ocr_languages")
    languages = raw_languages if isinstance(raw_languages, list) else ["eng"]
    languages = [str(x) for x in languages if x]

    # Only .xlsx hits the per-row branch — _parse_xlsx_sync uses openpyxl, which
    # doesn't read .xls. Legacy .xls falls through to unstructured.partition.auto
    # (which converts via LibreOffice). We lose per-row chunking on .xls, but
    # routing it to openpyxl would just fail.
    if name.endswith(".xlsx"):
        parser_id = "unstructured:xlsx"
        return "xlsx", "unstructured", languages, parser_id
    if name.endswith(".pdf"):
        parser_id = f"{engine}:pdf:{pdf_strategy}"
        return pdf_strategy, engine, languages, parser_id
    parser_id = f"{engine}:auto"
    return "auto", engine, languages, parser_id


def _strategy_for(filename: str, mime: str | None, default: str) -> str:
    # Kept for tests and older callers; parse_file now uses _parse_options so
    # domain config can drive parser engine + per-extension strategy.
    name = filename.lower()
    if name.endswith(".xlsx"):
        return "xlsx"
    if name.endswith(".pdf"):
        return default
    return "auto"  # unstructured.partition.auto handles everything else (txt, md, docx, html, ...)


def _parse_pdf_sync(
    blob: bytes, filename: str, strategy: str, languages: list[str]
) -> list[Element]:
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


def _parse_docling_sync(blob: bytes, filename: str) -> list[Element]:
    try:
        from docling.document_converter import DocumentConverter  # type: ignore[import-not-found]
    except ImportError as e:
        raise RuntimeError(
            "parser_engine=docling was configured, but docling is not installed"
        ) from e

    with tempfile.NamedTemporaryFile(suffix=Path(filename).suffix or ".pdf", delete=False) as tf:
        tf.write(blob)
        tmp = Path(tf.name)
    try:
        result = DocumentConverter().convert(str(tmp))
        text = result.document.export_to_markdown()
    finally:
        tmp.unlink(missing_ok=True)

    blocks = [b.strip() for b in re.split(r"\n{2,}", text) if b.strip()]
    return [
        Element(
            id=f"docling-{i:06d}",
            type="Title" if _is_title_like(block) else "NarrativeText",
            text=block,
            page=1,
            bbox=None,
            parent_id=None,
            metadata={"parser": "docling"},
        )
        for i, block in enumerate(blocks)
    ]


# Title-promotion heuristics. Unstructured's HTML parser categorises every
# block on a 10-K as NarrativeText (verified across the 540 elements of an
# AAPL 10-K — zero Title or Header elements). Boundary-aware chunking and
# section-boost both depend on Title markers to fire, so we recover them
# from body elements with a small set of pure-Python checks.

# Section-numbered headers: "Item 1A.", "PART II", "Section 4.2", "Article 7".
_TITLE_SECTION_HEAD = re.compile(
    r"^(item|part|section|article)\s+[ivx0-9]+[a-z]?(\.\d+)?\.?\s*",
    re.IGNORECASE,
)
_SENTENCE_END = re.compile(r"[.!?:;]\s*$")


def _is_title_like(text: str) -> bool:
    """True when a body element's text reads like a section header.

    Pure helper, unit-tested. Catches all-caps headings, Title-Cased headings,
    and section-numbered headings ("Item 1A", "PART II"). Errs on the side of
    not promoting — false negatives just leave the element as body, false
    positives create spurious chunk boundaries that downstream stages tolerate.
    """
    t = (text or "").strip()
    if not t or len(t) > 200 or "\n" in t:
        return False
    if _SENTENCE_END.search(t):
        return False
    words = t.split()
    if not (1 <= len(words) <= 25):
        return False
    if _TITLE_SECTION_HEAD.match(t):
        return True
    if t.isupper() and any(c.isalpha() for c in t):
        return True
    content_words = [w for w in words if any(c.isalpha() for c in w)]
    if not content_words:
        return False
    cap = sum(1 for w in content_words if w[0:1].isupper())
    return cap / len(content_words) >= 0.6


def _promote_title_like(elements: list[Element]) -> list[Element]:
    """Rewrite body elements that look like headings as Title elements.

    Necessary because Unstructured's HTML parser categorises every block as
    NarrativeText / UncategorizedText / Text on the 10-K-shaped corpora that
    this project ingests, leaving boundary-aware chunking and section-boost
    with no Title markers to operate on. Generic enough to apply to any
    auto-partition output (PDF parse path bypasses this — its hi_res/fast
    strategies already produce Title elements correctly).
    """
    body_types = {"NarrativeText", "Text", "UncategorizedText"}
    out: list[Element] = []
    promoted = 0
    for e in elements:
        if e.type in body_types and _is_title_like(e.text):
            out.append(
                Element(
                    id=e.id,
                    type="Title",
                    text=e.text,
                    page=e.page,
                    bbox=e.bbox,
                    parent_id=e.parent_id,
                    metadata={**(e.metadata or {}), "title_promoted": True},
                )
            )
            promoted += 1
        else:
            out.append(e)
    if promoted:
        logger.info("title-promotion: rewrote %d body elements as Title", promoted)
    return out


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
    out = [_element_from_unstructured(e, i, default_page=1) for i, e in enumerate(elements)]
    return _promote_title_like(out)


def _parse_xlsx_sync(blob: bytes, filename: str) -> list[Element]:
    """Parse XLSX into one Element per row.

    `unstructured.partition.xlsx` returns one Table element per sheet, which produces
    a single monolithic chunk that doesn't retrieve well for row-specific questions
    ("what was X for Y in Q3?"). We use openpyxl directly to emit per-row text so
    each row is independently searchable.
    """
    import openpyxl  # type: ignore[import-untyped]

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
                    out.append(
                        Element(
                            id=f"xlsx-{sheet.title}-header",
                            type="Title",
                            text=f"Sheet '{sheet.title}' header: " + " | ".join(header),
                            page=0,
                            bbox=None,
                            parent_id=None,
                            metadata={"sheet": sheet.title, "row": row_i, "is_header": True},
                        )
                    )
                    idx += 1
                    continue
                # Render row as "Col1=Val1 | Col2=Val2 ..." for retrieval-friendly text.
                pairs = [f"{h}: {v}" for h, v in zip(header, values, strict=False) if h]
                text = f"[{sheet.title}] " + " | ".join(pairs)
                out.append(
                    Element(
                        id=f"xlsx-{sheet.title}-r{row_i}",
                        type="ListItem",
                        text=text,
                        page=0,
                        bbox=None,
                        parent_id=f"xlsx-{sheet.title}-header",
                        metadata={"sheet": sheet.title, "row": row_i, "is_header": False},
                    )
                )
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


async def parse_file(
    *,
    file_id: str,
    content_hash: str,
    object_key: str,
    filename: str,
    mime: str | None,
    parse_config: dict[str, Any] | None = None,
) -> list[Element]:
    """Return cached elements if present; otherwise parse, cache, return.

    Grok Issue 5: a corrupted parse artifact (network mid-write, manual MinIO
    tampering, format change) is now treated as a cache miss rather than
    crashing the extract stage.
    """
    settings = get_settings()
    strategy, engine, languages, parser_id = _parse_options(
        filename,
        mime,
        settings.parse_strategy_default,
        parse_config,
    )
    cached = await repo.get_parse_artifact(content_hash)
    reuse_across_strategies = bool(
        pipeline.get(parse_config or {}, "reuse_cache_across_strategies", False)
    )
    if cached and (reuse_across_strategies or cached.get("parser") == parser_id):
        try:
            raw = await objects.get_parse_artifact(cached["object_key"])
            logger.info("parse cache hit for %s parser=%s", content_hash[:12], cached.get("parser"))
            return [Element(**r) for r in raw]
        except objects.ParseArtifactCorruptError:
            logger.warning("parse cache for %s is corrupt; re-parsing", content_hash[:12])
            # Fall through to fresh parse below.
    elif cached:
        logger.info(
            "parse cache miss for %s: parser changed %s -> %s",
            content_hash[:12],
            cached.get("parser"),
            parser_id,
        )

    blob = await objects.get_raw_file(object_key)
    logger.info(
        "parsing file_id=%s engine=%s strategy=%s bytes=%d",
        file_id,
        engine,
        strategy,
        len(blob),
    )

    if strategy == "xlsx":
        elements = await asyncio.to_thread(_parse_xlsx_sync, blob, filename)
        parser = parser_id
    elif filename.lower().endswith(".pdf"):
        if engine == "docling":
            elements = await asyncio.to_thread(_parse_docling_sync, blob, filename)
        else:
            elements = await asyncio.to_thread(_parse_pdf_sync, blob, filename, strategy, languages)
        parser = parser_id
        # Optional supplementary vision-LLM pass to pick up tables that
        # Unstructured + tesseract miss. Opt-in via KB_PARSE_USE_VISION.
        if engine != "docling" and settings.parse_use_vision:
            from kb.parse.vision import augment_elements_with_vision_tables

            elements = await augment_elements_with_vision_tables(elements, blob, filename=filename)
            parser += "+vision"
    else:
        if engine == "docling":
            elements = await asyncio.to_thread(_parse_docling_sync, blob, filename)
            parser = parser_id
        else:
            elements = await asyncio.to_thread(_parse_auto_sync, blob, filename)
            parser = parser_id

    artifact_key = await objects.put_parse_artifact(content_hash, [e.to_dict() for e in elements])
    page_count = max((e.page for e in elements), default=0)
    await repo.put_parse_artifact(
        content_hash=content_hash,
        parser=parser,
        parser_version=None,
        object_key=artifact_key,
        page_count=page_count,
    )
    logger.info(
        "parsed %s: %d elements across %d pages", content_hash[:12], len(elements), page_count
    )
    return elements
