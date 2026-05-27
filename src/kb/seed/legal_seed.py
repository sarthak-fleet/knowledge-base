"""Seed the 'legal' demo with real open-source software licenses.

These are well-known public legal documents with clear contractual structure
(parties, grant, restrictions, obligations, disclaimers). Perfect for proving
the system runs on a completely different domain without code changes.

Sources: SPDX-listed canonical texts.

Run: docker compose exec api python -m kb.seed.legal_seed
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
from pathlib import Path

import httpx
from rich import print

from kb.sources.base import IngestedDoc
from kb.sources.ingest import ingest_source
from kb.sources.registry import build_source

logger = logging.getLogger("kb.seed.legal")

# SPDX license texts as canonical sources (raw text from the SPDX license list).
LICENSE_URLS = {
    "MIT.txt":          "https://raw.githubusercontent.com/spdx/license-list-data/main/text/MIT.txt",
    "Apache-2.0.txt":   "https://raw.githubusercontent.com/spdx/license-list-data/main/text/Apache-2.0.txt",
    "GPL-3.0-only.txt": "https://raw.githubusercontent.com/spdx/license-list-data/main/text/GPL-3.0-only.txt",
    "BSD-3-Clause.txt": "https://raw.githubusercontent.com/spdx/license-list-data/main/text/BSD-3-Clause.txt",
    "MPL-2.0.txt":      "https://raw.githubusercontent.com/spdx/license-list-data/main/text/MPL-2.0.txt",
    "ISC.txt":          "https://raw.githubusercontent.com/spdx/license-list-data/main/text/ISC.txt",
}


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


async def _ensure_schema(*, api: str) -> None:
    import yaml

    schema_path = Path("/app/domains/legal/schema.yaml")
    if not schema_path.exists():
        schema_path = Path(__file__).resolve().parents[3] / "domains/legal/schema.yaml"
    spec = yaml.safe_load(schema_path.read_text())
    async with httpx.AsyncClient(timeout=60) as client:
        r = await client.post(f"{api}/schemas", json={"domain": "legal", "name": spec["name"], "spec": spec})
        r.raise_for_status()
        print(f"[green]schema applied[/green] {r.json()}")


async def _fetch_licenses() -> list[IngestedDoc]:
    out: list[IngestedDoc] = []
    async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
        for name, url in LICENSE_URLS.items():
            try:
                r = await client.get(url)
                r.raise_for_status()
                out.append(IngestedDoc(
                    filename=name,
                    bytes_=r.content,
                    mime="text/plain",
                    metadata={"source": "spdx", "url": url},
                ))
                print(f"[green]downloaded[/green] {name} ({len(r.content)} bytes)")
            except Exception as e:
                print(f"[yellow]skip {name}: {e}[/yellow]")
    return out


async def _main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    api = os.environ.get("KB_API_URL", "http://api:8000")

    await _wait_for_api(api)
    await _ensure_schema(api=api)

    print("[cyan]fetching SPDX license texts...[/cyan]")
    docs = await _fetch_licenses()
    if not docs:
        print("[red]no licenses fetched[/red]")
        return 2

    src = build_source("upload", docs=docs)
    out = await ingest_source(api_base=api, domain="legal", source=src)
    print(f"[green]ingested {len(out)} licenses for domain 'legal'[/green]")
    print("[cyan]ingest enqueued; tail worker logs: docker compose logs -f worker[/cyan]")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(_main()))
    except Exception as e:
        print(f"[red]seed failed:[/red] {e}")
        sys.exit(2)
