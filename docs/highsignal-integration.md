# Phase 2 — HighSignal integration plan

Phase 1 (this repo) is a standalone, docker-compose-deployable KB service. Phase 2 folds
it into HighSignal (`fleet/high-signal`) without forking the code.

## What moves where

| KB component | HighSignal home | Notes |
| --- | --- | --- |
| `src/kb/api/` | new `workers/kb-api/` (Cloudflare Worker) | Re-implement thin handlers; reuse Pydantic→OpenAPI for the schema |
| `src/kb/jobs/` + extract/resolve/index | new `python/kb-ingest/` (sibling of `python/ingest`) | Reuses `AI_BASE_URL`/`AI_API_KEY`/`AI_MODEL`, runs on Modal |
| `src/kb/seed/sec_seed.py` | merge with `python/ingest/src/high_signal_ingest/sources/edgar.py` | Already pulls the same data; just expose a "→ KB" emitter |
| `migrations/` | new schemas in `packages/db` (D1) or stay in Postgres | D1 fits domains/files/jobs; vector + provenance stay in Qdrant/Postgres |
| `streamlit_app/` | retire — use `apps/web` (Next.js) | Reuse HighSignal's globals.css; KB pages under `/kb/*` |

## Storage choices

- **Domains, schemas, files, jobs** — D1 (Cloudflare) once on workers; Postgres for now.
- **Vectors** — Qdrant Cloud (one external dep) or migrate to Cloudflare Vectorize (dense-only;
  we'd implement BM25 in D1 FTS5 to keep hybrid).
- **Raw files + element cache** — R2 (S3-compatible; our MinIO adapter is a near drop-in).
- **Element cache key** stays `parse/<sha256>/elements.json` — same idempotency property.

## Glue to HighSignal's data flow

HighSignal already pulls EDGAR / IR / news. Today those produce signal candidates. With KB
slotted in:

1. After download, push the raw artifact to KB (`POST /files` with `domain=highsignal`).
2. KB runs schema-driven extraction (a HighSignal schema would have `Company`, `Catalyst`,
   `Risk`, `Filing`, `Source`).
3. Signal generation (`python/ingest/generator.py`) calls `POST /query` to ground claims
   with cited excerpts instead of feeding raw text into the LLM.

This gives every published signal a provenance trail that today's pipeline doesn't have.

## What this repo does *now* to keep that path open

- Same LLM env convention (`AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL`, DeepSeek default).
- Same `uv` + `pyproject.toml` + ruff conventions as `python/ingest` and `python/lab`.
- Vector store abstraction → swappable for Vectorize without touching extract/resolve.
- Object store abstraction → swappable for R2 with the same interface.
- No dependency on Postgres-only features in extract/resolve — the boundary is clean.

## Open questions for Phase 2

- Do we run KB ingest on Modal (matches HighSignal) or stay on a long-lived container?
- Single shared schema for HighSignal, or per-source schemas?
- Where does the eval run — CI on `pull_request`, or a HighSignal Modal app?
