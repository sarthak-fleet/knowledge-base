# Project Status

Last updated: 2026-06-08

## Current Scope

Private Agent Search is an Exa-style search layer for private, specialized
document collections. It lets users create project-scoped corpora, infer or
confirm schemas, ingest files or records, and expose cited `/search` and
`/query` APIs for agents that need reliable private evidence.

## Done

- FastAPI API, worker, Postgres, Qdrant, MinIO/object-store adapter, and
  optional Streamlit UI are documented as the local stack.
- Project-scoped corpora, schemas, files, entities, sessions, traces, indexed
  chunks, and corpus status endpoints are implemented.
- Bring-your-own-corpus flow exists: upload representative files, infer schema
  drafts, apply confirmed schemas, ingest staged files, and search/query with
  citations.
- Agent-facing search contracts are documented for `/search`, `/agent/search`,
  and `/query`.
- Search evaluation exists through `/search/eval` with precision, recall, MRR,
  and p95 latency.
- SEC and legal demo domains, runbooks, hosting checklist, and High Signal
  integration notes are documented.

## Planned Next

1. Persist `/search/eval` reports and trend them per project/kind.
2. Add framework-specific agent integration examples plus a compatibility test
   for the stable HTTP response contract.
3. Add live progress visibility while sample files are parsed and schema
   inference runs.
4. Add source-set management for uploaded and future company-memory imports:
   grouping, cursors, stale/failed counts, deletion handling, and bulk replace.
5. Add project templates for research papers, company knowledge, notes,
   manuals, contracts, and docs-site snapshots.
6. Add a schema-diff and safe reprocess wizard in the UI.
7. Decide the personal hosting target and complete the hosting checklist with
   durable storage, backups, observability, usage limits, and smoke tests.

## Deferred / Parked

- Public multi-user hosting is deferred until auth, per-project authorization,
  upload limits, endpoint rate limits, job cancellation, backup restore drills,
  and log redaction checks exist.
- Connector-first marketplace scope is deferred; manual/private corpus search
  remains the wedge.
- High Signal integration is phase-2 direction only; this repo should not be
  forked into High Signal until storage and ingest ownership are decided.
