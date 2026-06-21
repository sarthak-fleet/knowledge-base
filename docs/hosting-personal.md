# Personal Hosting Runbook

The personal hosting target is the Cloudflare Worker in `cloudflare/worker`.
The retired local Python/Docker stack is no longer a deployable surface.

## Cloudflare Services

- Worker: `knowledgebase`
- D1: product metadata, sessions, traces, eval reports
- R2: raw files and parse artifacts
- Vectorize: dense vector indexes
- Queues and Workflows: async ingestion
- Workers AI: embeddings, optional rerank/synthesis/OCR
- Analytics Engine: query/eval telemetry

## Pre-Deploy Checklist

- Confirm `cloudflare/worker/wrangler.jsonc` has all required bindings.
- Confirm secrets are configured outside the repo.
- Run `pnpm run preflight` from `cloudflare/worker`.
- Run `pnpm run gaps:full-port` and inspect remaining blockers.
- Run `pnpm run readiness:auth` with `RAG_SERVICE_KEY`.
- Run `pnpm run readiness:full-port` only when the live OCR proof and all
  full-port blockers are expected to pass.

## Smoke Test

```bash
export RAG_BASE_URL="${RAG_BASE_URL:-https://knowledgebase.sarthakagrawal927.workers.dev}"
export RAG_SERVICE_KEY="<service-key>"

curl -fsS "$RAG_BASE_URL/v1/healthz" | jq
curl -fsS "$RAG_BASE_URL/v1/indexes" \
  -H "Authorization: Bearer $RAG_SERVICE_KEY" | jq
```

Use the Worker `/ui` for upload, schema, query, trace, and eval workflows.
