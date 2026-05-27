# Runbook

## Local bring-up

```bash
cp .env.example .env             # fill AI_API_KEY (DeepSeek default)
make up                          # docker compose up -d --build
docker compose ps                # all healthy?
curl -s http://localhost:8000/healthz
```

## Seed the SEC demo

```bash
make seed
# Internally:
#   1. waits for the API
#   2. POSTs domains/sec/schema.yaml
#   3. fetches 10–12 recent filings via edgartools (needs SEC_USER_AGENT)
#   4. uploads them all
#   5. enqueues ingest jobs
```

Watch progress:

```bash
docker compose logs -f worker
# or
curl -s http://localhost:8000/ingest/jobs?domain=sec | jq .
```

## Run the eval

```bash
make eval     # writes eval_report.json into the api container
docker compose exec api cat eval_report.json | jq '.mean_citation_f1, .answer_pass_rate'
```

The Streamlit "Eval" page reads the same file.

## Common failure modes

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `make seed` says "no filings fetched" | `SEC_USER_AGENT` empty or unsanctioned | set a real name + email in `.env`. |
| jobs stuck in `failed` with `LLM 401` | `AI_API_KEY` missing | fill it in `.env`, `docker compose restart worker` |
| jobs failing on `hi_res` 10-K | OOM in `unstructured` PDF detector | drop `parse.hi_res_pages_max` in `domains/sec/config.yaml`, or override to `strategy: fast` |
| `/query` returns `"I cannot answer with citations…"` | retrieval returned 0 hits or model produced no `[n]` markers | check `/ingest/jobs` for indexing status; verify `KB_VECTOR_STORE=qdrant` matches what the worker wrote |
| Streamlit shows "API unreachable" | api container down | `docker compose logs api`; common cause is bad `.env` |
| Free-AI gateway returns `invalid_project_id` | `AI_PROJECT_ID` empty when upstream gateway requires it | set `AI_PROJECT_ID=<your-project>` in `.env`, restart api. Empty is fine for vanilla OpenAI/DeepSeek. |
| `make eval` shows `query_error` on aggregate questions | DuckDB route 500'd — usually missing `duckdb` dep or import outside try/except | `docker compose exec api python -c "import duckdb"` to confirm dep |
| DuckDB SQL returns NULL on `WHERE ticker='X'` | Entity extraction didn't fill `ticker` | route auto-falls back to file-level ticker via filename prefix `^TICKER[_-]`; if filenames don't follow that, extend `_TICKER_FROM_FILENAME` in `duckdb_route.py` |
| Aggregate questions return wrong column | metric names inconsistent across companies | prefer `metric_canonical` column in SQL (already in prompt); falls back to ILIKE on `name` when null |
| `kb_queries_total = 0` in `/metrics` despite serving queries | `record_query` not wired into engine | should be fixed in `engine.py`; add `metrics.record_query(...)` before `return QueryOut(...)` |
| LLM auth/quota failures appear as empty answers | `_log_llm_error` re-raises auth/quota but other paths catch | watch `docker compose logs api` for `LLM AUTH FAILED` / `LLM QUOTA FAILED` ERROR-level lines |
| Eval crashes with `'str' object has no attribute 'get'` in `ragas.py` | weaker model returned `chunks: ["str", ...]` instead of `[{relevant:bool}, ...]` | already guarded; ensure rebuilt image post-c171a1e |

## Swap vector store

```bash
# .env
KB_VECTOR_STORE=pgvector
docker compose restart api worker
# Re-index (existing chunks live in Qdrant — they don't auto-migrate)
docker compose exec api python -m kb.cli ingest run --domain sec   # add `--force` once supported on CLI
```

## Onboard a new domain

```bash
mkdir -p domains/<name>
$EDITOR domains/<name>/schema.yaml      # see domains/sec/schema.yaml
docker compose exec api python -m kb.cli schema apply domains/<name>/schema.yaml
# upload files with `domain=<name>` and POST /ingest/run
```

No code changes required.
