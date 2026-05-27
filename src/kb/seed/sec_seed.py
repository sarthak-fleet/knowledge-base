"""Seed the SEC demo using the source-adapter pattern.

Run inside the api container: `docker compose exec api python -m kb.seed.sec_seed`.
"""

from __future__ import annotations

import asyncio
import io
import logging
import os
import sys
from pathlib import Path

import httpx
from rich import print

from kb.sources.base import IngestedDoc
from kb.sources.ingest import ingest_source
from kb.sources.registry import build_source

logger = logging.getLogger("kb.seed.sec")


def _build_summary_xlsx() -> bytes:
    """Synthetic per-ticker quarterly numbers; lets the XLSX path get exercised."""
    import openpyxl

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Summary"
    ws.append(["Ticker", "Fiscal Year", "Quarter", "Revenue", "Net Income", "EPS Diluted"])
    rows = [
        ("NVDA", 2024, "Q1", 26044, 14881, 5.98),
        ("NVDA", 2024, "Q2", 30040, 16599, 6.66),
        ("AAPL", 2024, "Q3", 85777, 21448, 1.40),
        ("AAPL", 2024, "Q4", 94930, 14736, 0.97),
        ("MSFT", 2024, "Q1", 61858, 21939, 2.94),
        ("MSFT", 2024, "Q2", 64727, 21870, 2.93),
    ]
    for r in rows:
        ws.append(r)
    bio = io.BytesIO()
    wb.save(bio)
    return bio.getvalue()


def _scan_a_pdf(pdf_bytes: bytes) -> bytes:
    """Rasterize a PDF into an image-only PDF (forces OCR path on re-parse)."""
    import pdf2image

    pages = pdf2image.convert_from_bytes(pdf_bytes, dpi=140, first_page=1, last_page=4)
    bio = io.BytesIO()
    if pages:
        pages[0].save(bio, save_all=True, append_images=pages[1:], format="PDF")
    return bio.getvalue()


def _text_to_digital_pdf(text: str, title: str = "Sample") -> bytes:
    """Generate a real digital PDF from text. Demonstrates the digital-PDF path."""
    from reportlab.lib.pagesizes import LETTER
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer

    bio = io.BytesIO()
    doc = SimpleDocTemplate(bio, pagesize=LETTER, title=title)
    styles = getSampleStyleSheet()
    story: list = [Paragraph(title, styles["Title"]), Spacer(1, 12)]
    for para in text.split("\n\n"):
        para = para.strip()
        if not para:
            continue
        # ReportLab interprets some chars; keep it simple.
        para = para.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        story.append(Paragraph(para, styles["BodyText"]))
        story.append(Spacer(1, 6))
    doc.build(story)
    return bio.getvalue()


async def _ensure_schema(*, api: str) -> None:
    import yaml

    schema_path = Path("/app/domains/sec/schema.yaml")
    if not schema_path.exists():  # local-dev fallback
        schema_path = Path(__file__).resolve().parents[3] / "domains/sec/schema.yaml"
    spec = yaml.safe_load(schema_path.read_text())
    async with httpx.AsyncClient(timeout=60) as client:
        r = await client.post(f"{api}/schemas", json={"domain": "sec", "name": spec["name"], "spec": spec})
        r.raise_for_status()
        print(f"[green]schema applied[/green] {r.json()}")


async def _wait_for_api(api: str) -> None:
    async with httpx.AsyncClient(timeout=2) as client:
        for _ in range(60):
            try:
                if (await client.get(f"{api}/healthz")).status_code == 200:
                    return
            except Exception:
                pass
            await asyncio.sleep(1)
    raise RuntimeError(f"KB API at {api} never became healthy")


async def _main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    api = os.environ.get("KB_API_URL", "http://api:8000")

    await _wait_for_api(api)
    await _ensure_schema(api=api)

    # 1) Pull SEC filings via the source adapter
    print("[cyan]fetching SEC filings via 'edgar' source...[/cyan]")
    edgar = build_source("edgar", tickers=["NVDA", "AAPL", "MSFT"], limit_total=10)
    pulled = await ingest_source(api_base=api, domain="sec", source=edgar)
    print(f"[green]ingested {len(pulled)} edgar docs[/green]")

    if not pulled:
        print("[yellow]No EDGAR docs ingested (SEC_USER_AGENT may be missing). Continuing with XLSX-only.[/yellow]")

    # 2) Add a digital PDF + scanned (image-only) PDF + summary XLSX.
    # Digital PDF: real EDGAR content rendered to a PDF with a text layer.
    # Scanned PDF: same content rasterized — forces the OCR path on parse.
    extras: list[IngestedDoc] = []
    sample_text = (
        "NVIDIA CORPORATION\n\n"
        "FORM 10-K (excerpt)\n\n"
        "ITEM 1A. RISK FACTORS\n\n"
        "Export controls have restricted, and may continue to restrict, our ability to sell "
        "certain advanced semiconductor products into specific markets, including China. "
        "These restrictions have materially affected our results of operations.\n\n"
        "Customer concentration: a small number of customers historically accounted for a "
        "large portion of revenue. In fiscal 2024 our largest customer accounted for "
        "approximately 13% of total revenue.\n\n"
        "Supply chain concentration: a substantial portion of our manufacturing is performed "
        "by Taiwan Semiconductor Manufacturing Company (TSMC). Any disruption to TSMC's "
        "operations would have a material adverse effect on our business."
    )
    digital_pdf = _text_to_digital_pdf(sample_text, title="NVDA-RiskFactors-Sample")
    extras.append(IngestedDoc(
        filename="NVDA_riskfactors_sample_digital.pdf",
        bytes_=digital_pdf,
        mime="application/pdf",
        metadata={"source": "sample", "format": "digital_pdf"},
    ))
    try:
        scanned = _scan_a_pdf(digital_pdf)
        extras.append(IngestedDoc(
            filename="NVDA_riskfactors_sample_scanned.pdf",
            bytes_=scanned,
            mime="application/pdf",
            metadata={"source": "sample", "format": "scanned_pdf"},
        ))
    except Exception as e:
        print(f"[yellow]scanned variant skipped: {e}[/yellow]")

    extras.append(IngestedDoc(
        filename="summary_financials.xlsx",
        bytes_=_build_summary_xlsx(),
        mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ))
    if extras:
        upload = build_source("upload", docs=extras)
        await ingest_source(api_base=api, domain="sec", source=upload)
        print(f"[green]uploaded {len(extras)} extras[/green]")

    print("[cyan]ingest enqueued; tail worker logs: docker compose logs -f worker[/cyan]")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(_main()))
    except Exception as e:
        print(f"[red]seed failed:[/red] {e}")
        sys.exit(2)
