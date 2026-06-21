# Session log — what shipped this round

> Historical session log from the Python reference era. Current runtime and UI
> live in the Cloudflare Worker under `cloudflare/worker`.

A working log of the work done after the original submission landed. Reading order: top to bottom.
For commit-level detail, `git log --oneline dd141e1..HEAD`.

## Headline changes

1. **Project namespace** — promoted `domain` → `(project, kind)`. Existing data auto-lands in `project='default'`; new projects can be created via API or UI.
2. **Cross-kind retrieval** — one `/query` can fan out across multiple kinds within a project and return a single cited answer.
3. **Unified ingestion API** — three input shapes (file, record, text), all carrying `type` (the entity-type label from the schema). Same type ⇒ same structure, enforced.
4. **Project-aware UI** — landing page lists projects; clicking one opens a chat + files + schemas workspace. This now lives in the Worker `/ui`.
5. **Memory-leak fix** — `AsyncOpenAI` was being instantiated per LLM call and never closed; singleton fix dropped per-query growth from ~500 MB to flat.
6. **Schema-driven pipeline shapes** — entity types declare their pipeline role (`graph_route: true`, `tabular: true`, field-level `tabular_identifier`/`tabular_value`). Query/extract stages read these instead of per-domain config sidecars.
7. **SEC parser title-promotion heuristic** — recovers `Title` elements Unstructured drops on HTML; section-boost and boundary-aware chunking now have something to fire on.
8. **Smaller / configurable reranker** — `KB_RERANK_MODEL` env var; swap jina-v2-base (1.1 GB) for MiniLM-L-6-v2 (250 MB) and watch the stack drop from ~7.7 GB to ~4 GB total.
9. **Multi-stage Dockerfile** — image went 11.6 GB → 7.68 GB.

## Data model

### Schema, post-session

```
projects(name PK, description, created_at, updated_at)

domains(name PK, project FK projects(name), description, created_at, updated_at)
                  └── kind name registry (= former "domain")

schemas(id PK, project, domain, name, version, spec JSONB, is_active,
        UNIQUE(domain, name, version))
                  └── one schema per (project, kind), versioned

files / entities / entity_mentions / chunks / ingest_jobs / query_traces / ...
        all gained `project TEXT NOT NULL DEFAULT 'default'`
```

Existing UNIQUE constraints (`files(domain, content_hash)`, `entities(domain, type, identity_key)`)
kept project-implicit for back-compat. Composite-with-project uniqueness is a future migration when
two projects actually need the same kind name with different content.

### What `(project, kind)` looks like in YAML

```yaml
# domains/sec/schema.yaml
domain: sec               # kind name
name: edgar-filings        # schema name within this kind
version: 1
entities:
  - name: RiskFactor
    graph_route: true            # new — pipeline role from §6
    fields: [...]
  - name: FinancialMetric
    tabular: true                # new
    fields:
      - { name: ticker, tabular_identifier: true }   # new
      - { name: revenue, tabular_value: true }       # new
```

Apply with `kb schema apply --project biotech-ipo domains/sec/schema.yaml`. Defaults to
`project='default'` when the flag is omitted.

## API surface (new + changed)

### Projects

```
GET  /projects                            # list with kind_count + file_count
POST /projects   {name, description}      # create or update
```

### Ingestion — three forms, one contract `(project, kind, type)`

```
POST /files                               # multipart file upload (existing)
       fields: project, domain (= kind), file

POST /ingest/record                       # NEW — JSON record(s)
       body:  {project, kind, type, data: [{...}, ...] | {...}}
       does:  validates against schema's entity type
              upserts entities + mentions
              writes a virtual JSON file to MinIO for citation traceability

POST /ingest/text                         # NEW — raw text
       body:  {project, kind, type?, title, text}
       does:  stores as virtual .txt file
              queues normal parse→extract→vector pipeline
```

The "same type ⇒ same structure" rule is enforced at `/ingest/record` ingest time.
Missing `required` or `identity` fields → 422 with specifics.

### Query, with cross-kind support

```
POST /query
{
  "project": "biotech-ipo",
  "domain":  "sec_filings",       # primary kind (used for intent + schema)
  "kinds":   ["sec_filings", "memos"],   # optional — fan out across these
  "question": "..."
}
```

When `kinds` is set, retrieval runs hybrid search per kind, fuses via RRF, runs one
cross-encoder rerank, synthesizes a single answer with citations spanning all kinds.

### Other endpoints that gained `project`

- `GET /files?project=X`
- `GET /schemas?project=X`
- `GET /schemas/{domain}/active?project=X`
- `POST /schemas {..., project: "X"}`
- `POST /ingest/run {project, domain, ...}`
- `GET /ingest/jobs?project=X`
- `GET /query/traces?project=X`

All default to `'default'` for back-compat.

## CLI changes

```
kb schema apply --project biotech-ipo domains/sec/schema.yaml
kb schema list  --project biotech-ipo
kb ingest run   --project biotech-ipo --domain sec_filings
```

## Historical Local UI

The old Python UI has been retired. Use the Worker `/ui` for the active testing
surface.

- **Landing**: cards for every project (showing kind/file counts) + a "Create new project" form below.
- **Workspace** (after clicking a project): three tabs.
  - **Chat** — multiselect over the project's kinds (default: all). Chat-style conversation
    using cross-kind retrieval. Each assistant turn carries cited sources + confidence with reason.
  - **Files** — table of all files in the project (with kind column). Upload form
    targets a specific kind. Ingest jobs table at the bottom.
  - **Schemas** — per-kind schema overview (entity types, fields, descriptions).

## Memory + deployment

### What kb-api uses (peak during a query)

| With | kb-api peak | Whole stack |
|---|---|---|
| jina-reranker-v2-base (default) | ~4 GB | ~6–7 GB |
| MiniLM-L-6-v2 (`KB_RERANK_MODEL` override) | ~0.9 GB | ~3–4 GB |

Set in `docker-compose.override.yml` (gitignored) for local runs:

```yaml
services:
  api:
    environment:
      KB_RERANK_MODEL: Xenova/ms-marco-MiniLM-L-6-v2
      KB_EMBED_MODEL: BAAI/bge-small-en-v1.5
      KB_EMBED_DIM: "384"
  worker:
    environment:
      KB_RERANK_MODEL: Xenova/ms-marco-MiniLM-L-6-v2
      KB_EMBED_MODEL: BAAI/bge-small-en-v1.5
      KB_EMBED_DIM: "384"
```

### The OpenAI-client leak

`make_client()` was returning a fresh `AsyncOpenAI` on every LLM call. Each instance carried its
own httpx connection pool that never got closed; with ~15 LLM calls per `/query`, the API process
grew ~500 MB per query and OOM-killed around query 15 of the SEC eval on a 16 GB OrbStack VM.
Singletoning the client (`@lru_cache(maxsize=1)`) fixed it — memory is now flat at ~4 GB across
the full 25-question SEC eval.

### Multi-stage Docker

Builder stage holds the toolchain (build-essential, git, uv) + runs fastembed pre-warm.
Runtime stage copies only site-packages + `/tmp/fastembed_cache` + app source. Final image
**7.68 GB** (was 11.6 GB). The pre-warm cache lives at `/tmp/fastembed_cache` because fastembed
ignores `FASTEMBED_CACHE_DIR` in the pinned version — verified empirically.

## Eval state at end of session

Both runs use bge-small (384d) + MiniLM-L-6-v2 reranker, full pipeline:

| Domain | n | citation F1 | inside historical range (0.514–0.807)? |
|---|---|---|---|
| Legal | 12 | 0.735 | ✓ |
| SEC | 25 | 0.643 (with jina-v2-base) / 0.577 (with MiniLM-L-6-v2) | ✓ for both |

`pass_rate=0` on both because the LLM judge hits `api.deepseek.com` (not the free-AI gateway) —
an `.env` quoting issue with the multi-word `SEC_USER_AGENT` line and how `set -a; source .env`
handles unquoted values. Fix: quote the value, or run eval from inside the container where the
env is already correct.

## What was deferred (explicitly, not "left over")

1. **Qdrant collection-per-project consolidation** — fan-out at the engine level works; consolidation is an optimization for 30+ kinds per project. Today: per-kind collections, fan-out at query time.
2. **Schema suggestion from sample data** — `POST /schemas/infer` endpoint exists as a stub; making it real (LLM proposes entity types from a few sample chunks/records) is the highest-value next step for zero-friction onboarding into new kinds.
3. **Source connectors** beyond `upload` + `edgar` (Drive, S3, Slack, Notion). You asked to skip.
4. **Per-token SSE streaming** on `/query` — endpoint exists but emits stage-level events.
5. **Memory-aware semaphore per pipeline stage** — current `KB_WORKER_CONCURRENCY=2` default is safe-by-count; proper fix is a RAM-aware semaphore.
6. **SEC EDGAR fixtures** — each 10-K is several MB; Legal fixtures are committed under `domains/legal/fixtures/`.
7. **UI polish** — file deletion, project rename/delete, schema editor in browser.

## Verification checklist for after the laptop restart

When OrbStack is back up:

```bash
make up                                          # bring the stack up
curl -fsS http://localhost:8000/readyz | jq      # db/vector/object all ok

# Smoke the project layer
curl -s http://localhost:8000/projects | jq

# Smoke /ingest/record (today's last commit — not yet live-verified)
curl -s -X POST http://localhost:8000/projects \
  -H 'Content-Type: application/json' \
  -d '{"name":"smoke","description":"smoke test"}'

# (apply a schema for the smoke project first, or use an existing kind)
curl -s -X POST http://localhost:8000/ingest/text \
  -H 'Content-Type: application/json' \
  -d '{"project":"default","kind":"legal","title":"smoke","text":"A smoke test."}'

# Full eval (back-compat sanity check)
make eval-legal
```

If `/readyz` is green and `/projects` returns the seeded `default` project plus any you've added,
the project layer is alive. If `/ingest/text` returns a 201 with a `file_id`, the new ingestion
path works.

## Files of interest (where to look)

```
migrations/05_projects.sql                       # the migration that started it all
src/kb/storage/repo.py                           # all SQL gated by (project, kind)
src/kb/query/types.py                            # QueryIn now has project + kinds
src/kb/query/engine.py                           # cross-kind fan-out in answer_query
src/kb/api/routes/projects.py                    # NEW — GET/POST /projects
src/kb/api/routes/ingest_data.py                 # NEW — /ingest/record + /ingest/text
src/kb/extract/llm.py                            # singleton AsyncOpenAI fix
src/kb/query/rerank.py                           # batched cross-encoder + KB_RERANK_MODEL
src/kb/parse/parser.py                           # title-promotion heuristic
src/kb/schema/model.py                           # graph_route/tabular/tabular_identifier flags
src/kb/extract/xlsx_bridge.py                    # reads schema for entity type + ident field
src/kb/query/graph_route.py                      # reads schema for default entity type
cloudflare/worker/src/index.ts                   # Worker-hosted testing UI
docker/Dockerfile                                # multi-stage build
docker-compose.override.yml                      # local-only model overrides (gitignored)
WRITEUP.md                                       # 4-page submission write-up
NOTES.md / LEARNING.md / DESIGN.md / README.md   # pre-session deep docs
SESSION_LOG.md                                   # this file
```
