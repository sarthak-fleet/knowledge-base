# Knowledge Base Service

[![CI](https://github.com/sarthakagrawal927/knowledge-base/actions/workflows/ci.yml/badge.svg)](https://github.com/sarthakagrawal927/knowledge-base/actions/workflows/ci.yml)
[![tests](https://img.shields.io/badge/tests-77%20passing-brightgreen)](#)
[![ruff](https://img.shields.io/badge/ruff-clean-brightgreen)](#)

A domain-agnostic Knowledge Base over unstructured documents. Define a schema, drop in PDFs / HTMLs / spreadsheets, ask questions, get cited answers.

## What's interesting about this one

**Verified across 5 LLMs × 2 unrelated domains** (SEC EDGAR filings + SPDX legal licenses), with one counter-intuitive empirical result:

> On this RAG pipeline, **`groq-llama-3.1-8b` beats `gemini-2.5-pro` by 24 pass-rate points** on SEC. Bigger models hedge, smaller decisive ones don't — when retrieval is solid, the synthesis model becomes a rephrase-and-commit job that cheap models do *better*.

Three other moments documented honestly in `LEARNING.md`:
1. The DuckDB structured-query route was silently broken for 5 eval rounds (missing dep + import outside try) — every aggregate question 500'd, eval logged as `query_error`, all v0-v5 numbers achieved despite this. Caught by loud-error-logging, fixed.
2. A methodology bug — `docker compose exec -e AI_MODEL=...` doesn't propagate to the API server, so 3 supposedly-different cross-model eval runs were the same model under different labels. Caught when two report files had identical MD5.
3. A citation-hygiene gap I introduced in my own GraphRAG sketch (entity-graph themes shaped the answer but their `entity_mentions` weren't in the citation list) — caught it in self-review, closed it before shipping.

The project mantra **"cited or it didn't happen"** holds through every retrieval path: hybrid + structured DuckDB + GraphRAG-sketch + Self-RAG retry + vision-LLM tables, all wired to terminate at a retrievable `(file_id, page, excerpt)` triple.

## Reading guide

If you only have 15 minutes, read these in order:

1. **`LEARNING.md` Part 4 (decision log)** — every architectural choice, why and what surfaced it. Includes the 4 production bugs above.
2. **`LEARNING.md` Part 8 (five distilled lessons)** — what to take away.
3. **`NOTES.md` § 4.7-final cross-domain × cross-model matrix** — the 8-cell empirical table that drives the headline finding.

For deeper looks:
- **Architecture** — `DESIGN.md` + the ASCII diagram below
- **Live run** — `LIVE_VERIFICATION.md`
- **External code review** — `GROK_FINDINGS.md` (13 findings, all resolved)
- **Demo** — `docs/demo-walkthrough.md`
- **Operator runbook** — `docs/runbook.md`

## High-level shape

```
                   ┌─── HTTP /query ────┐                              ┌── Postgres ──┐
   User ──────────►│   FastAPI (api)    │──┐                       ┌──►│  entities,   │
                   └──────────┬─────────┘  │                       │   │  jobs,       │
                              │            │                       │   │  traces      │
                              ▼            │                       │   └──────────────┘
                ┌─────────────────────────┐│        ┌──────────────┴─┐
                │ Query pipeline (9 stg)  ││ ◄──────│ asyncio worker │ ◄── ingest jobs
                │  intent → decompose →   ││ ingest │  (SKIP LOCKED) │
                │  rewrite (multi + HyDE)→│└────────│                │     ┌── MinIO ──┐
                │  retrieve (hybrid)    → │         └────────────────┘ ───►│  raw +    │
                │  rerank (jina v2)     → │                                │  parse    │
                │  MMR → CRAG → Self-RAG→ │                                │  cache    │
                │  graph_route (themes)→  │  ┌── Qdrant ──┐                └───────────┘
                │  duckdb (structured) →  │─►│ kb_sec     │
                │  synthesize → verify →  │  │ kb_legal   │
                │  span_cite              │  │ (hybrid:   │
                └─────────────────────────┘  │  dense +   │
                                             │  sparse)   │
                                             └────────────┘
```

Two demo domains (SEC + Legal) run on the **same code** with completely different schemas, sources, and eval sets — proves domain-agnosticism empirically, not aspirationally.

## One-command bootstrap

```bash
cp .env.example .env   # fill in AI_API_KEY (DeepSeek default, free-AI gateway also configured)
make up                # docker compose up -d --build  (postgres, qdrant, minio, api, worker, streamlit)
make seed              # SEC: schema + 10 EDGAR filings + digital PDF + scanned (OCR) PDF + XLSX
make seed-legal        # LEGAL: schema + 6 SPDX license texts (MIT, Apache-2.0, GPL-3.0, BSD-3, MPL-2.0, ISC)
make seed-all          # both
make eval              # 25-question SEC eval (citation P/R + LLM judge + RAGAS metrics)
make eval-legal        # 12-question legal eval
```

The `api` container runs `python -m kb.cli db init` on startup to apply migrations idempotently — no manual setup.

Then open:

- API + Swagger → http://localhost:8000/docs
- Streamlit demo → http://localhost:8501
- Prometheus metrics → http://localhost:8000/metrics
- MinIO console → http://localhost:9001
- Qdrant dashboard → http://localhost:6333/dashboard

## How this was built — AI-assistance disclosure

Built with heavy assist from Claude Opus 4.7 (visible as the co-author on commits). Being explicit about the split:

| What I owned | What was collaborated |
| --- | --- |
| Architecture decisions (Postgres + Qdrant + MinIO split, schema-driven extraction, 9-stage pipeline shape) | Implementation mechanics for each stage |
| Scope boundaries (which features to ship, which to cancel — e.g., the explicit cancel + reasoning on task #82 retrieval iteration) | Library swap mechanics (instructor, structlog, prometheus_client migration) |
| When to debug vs when to defer (the cross-model methodology bug → re-run with proper env propagation; the DuckDB ticker→canonical→noise-floor chain) | Code-level refactors |
| Citation hygiene as a non-negotiable across new routes (caught my own GraphRAG-citation gap in self-review) | Test scaffolding, doc rewrites |
| The empirical methodology (5×2 matrix, judge held constant, deterministic LLM cache for reproducibility) | Doc generation from my notes |

The decision log in `LEARNING.md` was written from my own session notes; it's what I'd talk through in an interview.

## Libraries used (intentionally, not "look mum a library")

11 well-known libraries adopted in this codebase, each replacing hand-rolled scaffolding with a known-good standard:

| Library | What it replaced |
| --- | --- |
| `instructor` | hand-rolled `chat_json` + JSON-schema dicts + defensive parsing at 5 LLM call sites |
| `prometheus_client` | ~85-line hand-rolled metrics aggregator |
| `structlog` | stdlib `logging.getLogger` across 32 modules; JSON in prod, console in TTY |
| `asgi-correlation-id` | request_id threaded through every log line via context-var |
| `cachetools` | manual FIFO dict eviction in `vector/embed.py` (Grok #9) |
| `aiolimiter` | gateway 429 retry-cascade prevention |
| `orjson` | stdlib JSON in FastAPI response path |
| `uvloop` | stdlib asyncio loop |
| `pre-commit` | trailing-whitespace, EOF, YAML/TOML/JSON validity, debug-statement detector, private-key detector |
| `pytest-cov` + `mypy` | coverage + type-check signal in CI |
| `ruff format` | format gate in CI |

## What's in the source tree

| Path | What |
| --- | --- |
| `src/kb/schema/` | User-defined schema (entities, fields, NL descriptions, relationships, versioning) |
| `src/kb/parse/` | Unstructured-based parsing + content-hash element cache + opt-in vision-LLM table extraction |
| `src/kb/extract/` | Schema-driven extraction via OpenAI-compatible LLM (instructor); per-field provenance |
| `src/kb/resolve/` | Entity resolution: deterministic identity keys + rapidfuzz + embedding tiebreak |
| `src/kb/vector/` | Qdrant (default, hybrid dense+sparse via RRF) or pgvector |
| `src/kb/query/` | 9-stage pipeline + GraphRAG-sketch route + DuckDB structured route + Self-RAG retry |
| `src/kb/sources/` | Source-adapter Protocol; `edgar`, `upload` built-in; pluggable |
| `src/kb/jobs/` | Asyncio worker pool against Postgres job table (`SKIP LOCKED`) |
| `src/kb/api/` | FastAPI surface — Swagger at `/docs`, readiness at `/readyz`, metrics at `/metrics` |
| `src/kb/config/` | Layered config — `defaults.yaml` < `domains/<d>/config.yaml` < env |
| `src/kb/observability.py` | structlog + uvloop bootstrap, called once at process start |
| `src/kb/eval/` | Eval runner: deterministic citation P/R + LLM-judge + RAGAS-shaped metrics + disk cache |
| `domains/sec/` | Demo schema + config + 25-question eval set for SEC EDGAR filings |
| `domains/legal/` | Demo schema + config + 12-question eval set for SPDX licenses |
| `migrations/` | Postgres schema (extensions, tables, indexes), idempotent SQL |
| `streamlit_app/` | Single-page demo UI |
| `tests/` | 77 unit + integration tests, ruff + ruff-format + mypy in CI |

## Configurability (no domain values in source)

Everything pipeline-related is configurable in `domains/<name>/config.yaml`:

```yaml
llm:
  extract: { model: deepseek-chat, temperature: 0.0 }
  synthesize: { model: deepseek-chat, temperature: 0.2 }
embedding:
  dense: BAAI/bge-small-en-v1.5
  sparse: Qdrant/bm42-all-minilm-l6-v2-attentions
retrieve:
  top_k_dense: 20
  top_k_sparse: 20
  rerank_top_k: 8
  selfrag_threshold: 0.4
  graph_route_enabled: true
```

## Swapping domains

```bash
make schema-apply   # for any domains/<name>/schema.yaml
# then POST /files with your domain= and the pipeline takes over.
```

No code change required to onboard a new domain — see `DESIGN.md` for the boundary tests.
