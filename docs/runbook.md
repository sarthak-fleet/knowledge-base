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
