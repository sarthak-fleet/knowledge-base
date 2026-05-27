"""Typer CLI: `kb schema apply ...`, `kb ingest run ...`, etc."""

from __future__ import annotations

import asyncio
from pathlib import Path

import typer
from rich import print

app = typer.Typer(help="Knowledge Base CLI", no_args_is_help=True)
schema_app = typer.Typer(help="Manage domain schemas")
ingest_app = typer.Typer(help="Run ingestion jobs")
db_app = typer.Typer(help="Database lifecycle")
app.add_typer(schema_app, name="schema")
app.add_typer(ingest_app, name="ingest")
app.add_typer(db_app, name="db")


@db_app.command("init")
def db_init() -> None:
    """Apply migrations idempotently."""
    from kb.storage.init_db import init_db

    out = asyncio.run(init_db())
    print(f"[green]migrations applied[/green] files={out['files']} statements={out['statements']}")


@schema_app.command("apply")
def schema_apply(path: Path) -> None:
    """Load a YAML schema and upsert it into the domain registry."""
    from kb.schema.loader import apply_schema_file

    result = asyncio.run(apply_schema_file(path))
    print(f"[green]Applied[/green] schema [bold]{result.name}[/bold] v{result.version} for domain [bold]{result.domain}[/bold]")


@schema_app.command("list")
def schema_list() -> None:
    from kb.schema.loader import list_schemas

    rows = asyncio.run(list_schemas())
    for r in rows:
        print(f"- {r['domain']}/{r['name']} v{r['version']}  ({r['entity_count']} types)")


@ingest_app.command("run")
def ingest_run(
    domain: str = typer.Option(..., help="Domain name (e.g. 'sec')"),
    force: bool = typer.Option(False, help="Re-enqueue files even if already 'ready'."),
) -> None:
    """Enqueue all unprocessed files in the given domain."""
    from kb.jobs.enqueue import enqueue_files

    n = asyncio.run(enqueue_files(domain=domain, file_ids=None, force=force))
    print(f"[green]Enqueued[/green] {n} files for domain [bold]{domain}[/bold]")


if __name__ == "__main__":
    app()
