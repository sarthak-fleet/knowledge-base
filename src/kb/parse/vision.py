"""Vision-LLM augmentation: a multimodal pass over PDF page images to extract
tables that Unstructured's text-layer + tesseract pipeline misses.

Why a separate pass:
- Unstructured does an excellent job on text and structurally-tagged HTML,
  but its PDF table extraction degrades on scanned documents and on complex
  multi-column financial layouts (the FinanceBench-class failure mode).
- A vision LLM looking at the rendered page image preserves 2D layout, so
  cells in a financial statement keep their column alignment.

How it integrates:
- This is a SUPPLEMENTARY pass. We don't replace Unstructured's output —
  we add `Element(type="Table", ...)` rows with the LLM-extracted markdown
  table text. Downstream chunking + retrieval pick them up like any other
  element.
- Opt-in via `settings.parse_use_vision` (`KB_PARSE_USE_VISION=1`). Off by
  default because vision LLM calls cost tokens; you want this enabled for
  scanned documents and complex financial PDFs, not for every text PDF.
- Uses the same `chat_text_with_usage` boundary as everywhere else, so
  gateway/auth/rate-limit/cache plumbing all work unchanged.

The prompt asks the LLM for tables only — bullet points and narrative text
stay with Unstructured (which is better at them and cheaper). This keeps
the vision pass focused on its actual comparative advantage.
"""

from __future__ import annotations

import asyncio
import base64
import io
from typing import Any

import structlog

from kb.config import get_settings

logger = structlog.get_logger("kb.parse.vision")


_VISION_SYSTEM = (
    "You extract STRUCTURED TABLES from a single page of a financial document. "
    "Return only the tables you find, as markdown tables, one per table found. "
    "Preserve column headers exactly. Preserve numbers exactly (commas/parentheses/units). "
    "If the page has no tables, return the literal string 'NO_TABLES'. "
    "Ignore narrative paragraphs and bullet points — they're being handled separately."
)


def _pdf_to_page_images(pdf_bytes: bytes, *, dpi: int = 144, max_pages: int = 8) -> list[bytes]:
    """Render the first `max_pages` of a PDF to PNG bytes. Bounded to avoid
    runaway cost on long filings — the vision pass is meant for tables that
    matter, not exhaustive coverage."""
    import pdf2image

    pages = pdf2image.convert_from_bytes(
        pdf_bytes, dpi=dpi, first_page=1, last_page=max_pages
    )
    out: list[bytes] = []
    for img in pages:
        buf = io.BytesIO()
        img.save(buf, format="PNG", optimize=True)
        out.append(buf.getvalue())
    return out


async def _ask_one_page(png: bytes, *, model: str | None) -> str:
    """Send one page image to the vision LLM and return its raw response.

    Uses the OpenAI Chat Completions multimodal message format which the
    free-AI gateway proxies to Gemini/GPT/Pixtral correctly:

        {"role": "user", "content": [
            {"type": "text", "text": "..."},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}},
        ]}
    """
    s = get_settings()
    mdl = model or s.ai_model
    b64 = base64.b64encode(png).decode("ascii")
    data_url = f"data:image/png;base64,{b64}"

    from kb.extract.llm import _gateway_extras, make_client

    client = make_client()
    try:
        resp = await client.chat.completions.create(
            model=mdl,
            messages=[
                {"role": "system", "content": _VISION_SYSTEM},
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "Extract tables from this page."},
                        {"type": "image_url", "image_url": {"url": data_url}},
                    ],
                },
            ],
            temperature=0.0,
            max_tokens=2048,
            **_gateway_extras(),
        )
    except Exception as e:
        logger.warning("vision pass failed for page", error=str(e)[:200])
        return ""
    return (resp.choices[0].message.content or "").strip()


async def extract_tables_from_pdf(
    pdf_bytes: bytes, *, model: str | None = None, max_pages: int = 8
) -> list[dict[str, Any]]:
    """Run a vision-LLM pass over a PDF's first `max_pages` pages.

    Returns a list of dicts shaped like:
        {"page": 1, "markdown": "| Col | Col |\\n|---|---|\\n..."}
    one entry per page that yielded a table. Pages with no tables are skipped.
    """
    pages = await asyncio.to_thread(_pdf_to_page_images, pdf_bytes, max_pages=max_pages)
    logger.info("vision: extracting tables", pages=len(pages))

    results: list[dict[str, Any]] = []
    # Sequential to respect the gateway rate limiter — concurrent vision calls
    # are the easiest way to trip "All providers failed: 429".
    for i, png in enumerate(pages, start=1):
        text = await _ask_one_page(png, model=model)
        if text and "NO_TABLES" not in text.upper():
            results.append({"page": i, "markdown": text})
    logger.info("vision: tables extracted", pages_with_tables=len(results))
    return results


async def augment_elements_with_vision_tables(
    elements: list, pdf_bytes: bytes, *, filename: str, model: str | None = None
) -> list:
    """Add LLM-extracted tables to an existing list of Unstructured `Element`s.

    Returns a new list (does not mutate input). The new Table elements get
    a stable id + a `via_vision: True` metadata flag so they're
    distinguishable downstream.
    """
    from kb.parse.parser import Element

    if not get_settings().parse_use_vision:
        return elements

    try:
        tables = await extract_tables_from_pdf(pdf_bytes, model=model)
    except Exception as e:
        logger.warning("vision augment skipped", filename=filename, error=str(e)[:200])
        return elements

    if not tables:
        return elements

    extra: list = []
    for t in tables:
        extra.append(
            Element(
                id=f"vision-table-{filename}-p{t['page']}",
                type="Table",
                text=t["markdown"],
                page=t["page"],
                bbox=None,
                parent_id=None,
                metadata={"via_vision": True, "source_filename": filename},
            )
        )
    logger.info(
        "vision: augmented elements",
        filename=filename,
        added=len(extra),
        total=len(elements) + len(extra),
    )
    return [*elements, *extra]
