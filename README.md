# Knowledge Base Service

Domain-agnostic Knowledge Base over unstructured documents. Define your schema, drop in PDFs / HTMLs / spreadsheets, ask questions, get cited answers.

> **Status (2026-05-27, Step 7 — cross-model + bug-sweep round):**
> Verified end-to-end on the free-AI gateway across **5 synth models** × **2 domains**.
> Headline: **SEC × llama-3.1-8b → F1 0.61, pass 0.68. Legal × Flash → F1 0.79, pass 0.67.**
> Bigger model ≠ better for RAG synthesis — Pro hedged its way to a lower pass rate than llama-8b.
> See [`LEARNING.md`](LEARNING.md) for the full session story or [`NOTES.md`](NOTES.md) § 4.7 for the matrix.

## One-command bootstrap

```bash
cp .env.example .env   # fill in AI_API_KEY (DeepSeek default). SEC_USER_AGENT for EDGAR.
make up                # docker compose up -d --build  (postgres, qdrant, minio, api, worker, streamlit)
make seed              # SEC: schema + 10 EDGAR filings + digital PDF + scanned (OCR) PDF + XLSX
make seed-legal        # LEGAL: schema + 6 SPDX license texts (MIT, Apache-2.0, GPL-3.0, BSD-3, MPL-2.0, ISC)
make seed-all          # both
make eval              # 25-question SEC eval (citation P/R + LLM judge + per-category)
make eval-legal        # 12-question legal eval
```

The `api` container runs `python -m kb.cli db init` on startup to apply migrations
idempotently — no manual setup step.

**Two demo domains coexist** in the same stack with completely different schemas,
sources, and eval sets — proves the system itself is domain-agnostic. See
[`DESIGN.md`](DESIGN.md) and [`LIVE_VERIFICATION.md`](LIVE_VERIFICATION.md).

Then open:

- API + Swagger → http://localhost:8000/docs
- Streamlit demo → http://localhost:8501
- MinIO console → http://localhost:9001
- Qdrant dashboard → http://localhost:6333/dashboard

## What's in here

| Path | What |
| --- | --- |
| `src/kb/schema/` | User-defined schema (entities, fields, NL descriptions, relationships, versioning) |
| `src/kb/parse/` | Unstructured-based parsing with content-hash element cache (parse once, re-extract many) |
| `src/kb/extract/` | Schema-driven extraction via OpenAI-compatible LLM; per-field provenance |
| `src/kb/resolve/` | Entity resolution: deterministic identity keys + fuzzy + embedding tiebreak |
| `src/kb/vector/` | Vector store adapter — Qdrant (default, hybrid dense+sparse) or pgvector |
| `src/kb/query/` | Hybrid retrieval + auto-merge + cited synthesis + trace persistence |
| `src/kb/sources/` | Source-adapter Protocol; `edgar`, `upload` built-in; pluggable |
| `src/kb/jobs/` | Asyncio worker pool against a Postgres job table (`SKIP LOCKED`) |
| `src/kb/api/` | FastAPI surface — Swagger at `/docs`, readiness at `/readyz` |
| `src/kb/config/` | Layered config — `defaults.yaml` < `domains/<d>/config.yaml` < env |
| `src/kb/storage/` | Postgres engine + raw-SQL repo + object-store adapter (minio/local) |
| `src/kb/eval/` | Eval runner: deterministic citation P/R + LLM-judge correctness |
| `domains/sec/` | Demo schema + config + 25-question eval set for SEC EDGAR filings |
| `domains/legal/` | Demo schema + config + 12-question eval set for SPDX licenses |
| `migrations/` | Postgres schema (extensions, tables, indexes), idempotent |
| `streamlit_app/` | Single-page demo UI — HighSignal-styled dark theme |
| `DESIGN.md` | Architecture, trade-offs, what's missing |
| `NOTES.md` | Interview brief — decision log, eval timeline, all numbers |
| `LEARNING.md` | The session story end-to-end, every decision, every bug found |
| `LIVE_VERIFICATION.md` | Snapshot of the actual live run — eval numbers, sample answers |
| `GROK_FINDINGS.md` | External code review (Grok 4.3); all 13 findings addressed |
| `docs/runbook.md` | Operator runbook + common failure modes |
| `docs/highsignal-integration.md` | Phase-2 plan to fold into HighSignal |
| `scripts/chain_legal_evals.sh` | Chain multi-model evals back-to-back |

## Configurability (no domain values in source)

Everything pipeline-related is configurable in `domains/<name>/config.yaml`:

```yaml
llm:
  extract: { model: deepseek-chat, temperature: 0.0 }
  synthesize: { model: deepseek-chat, temperature: 0.2 }
embedding:
  dense: BAAI/bge-small-en-v1.5
  sparse: Qdrant/bm42-all-minilm-l6-v2-attentions
parse:
  default_strategy: auto
  hi_res_pages_max: 200
chunk:
  parent_size: 2048
  child_size: 512
  overlap: 64
retrieve:
  top_k_dense: 20
  top_k_sparse: 20
  rerank_top_k: 8
  hybrid_alpha: 0.5
```

## Swapping domains

```bash
make schema-apply   # for any domains/<name>/schema.yaml
# then POST /files with your domain= and the pipeline takes over.
```

No code change required to onboard a new sector — see `DESIGN.md` for the boundary tests.
