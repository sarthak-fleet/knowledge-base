# Runbook

## Worker Checks

```bash
make worker-check
make worker-preflight
make worker-gaps
make worker-sibling-audit
make worker-ocr-dry-run
```

## Deployed Smoke

```bash
export RAG_BASE_URL="${RAG_BASE_URL:-https://knowledgebase.sarthakagrawal927.workers.dev}"
curl -fsS "$RAG_BASE_URL/v1/healthz" | jq
```

Authenticated checks require a service key:

```bash
export RAG_SERVICE_KEY="<service-key>"
cd cloudflare/worker
pnpm run readiness:auth
```

The final full-port gate is intentionally fail-closed:

```bash
cd cloudflare/worker
RAG_SERVICE_KEY="<service-key>" pnpm run readiness:full-port
```

That command combines deployed health/auth checks, the live NVDA scanned-PDF OCR
eval, local Wrangler binding preflight, the sibling `rag-service` retirement
audit, and the full-port blocker inventory.

## Parse Eval

Dry-run the local one-case payload without network or AI usage:

```bash
cd cloudflare/worker
pnpm run eval:parse:nvda-scanned:dry-run
```

Run the authenticated deployed OCR proof only when `RAG_SERVICE_KEY` is
available:

```bash
cd cloudflare/worker
RAG_SERVICE_KEY="<service-key>" pnpm run eval:parse:nvda-scanned:live
```

The packaged scanned-PDF gate tries Llama 3.2 Vision first, then Llama 4 Scout.
Cloudflare requires an account-level Meta license acceptance before the first
Llama 3.2 Vision call. Run the guarded helper with Cloudflare account
credentials in your shell; do not write either value into tracked files:

```bash
cd cloudflare/worker
CLOUDFLARE_ACCOUNT_ID="<account-id>" pnpm run workers-ai:accept-llama32-vision-license -- --dry-run
CLOUDFLARE_ACCOUNT_ID="<account-id>" CLOUDFLARE_AUTH_TOKEN="<api-token>" pnpm run workers-ai:accept-llama32-vision-license
```

## Common Failure Modes

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `readiness:full-port` reports `authenticated-key-present` skipped | `RAG_SERVICE_KEY` is not set | Provide a service key via env or `--key`; do not commit it. |
| `nvda-scanned-ocr-live` is skipped | The live OCR eval also needs `RAG_SERVICE_KEY` | Set the key and rerun the full-port gate. |
| `nvda-scanned-ocr-live` reports a Llama 3.2 license error | The Cloudflare account has not accepted the Meta license for `@cf/meta/llama-3.2-11b-vision-instruct` | Run `pnpm run workers-ai:accept-llama32-vision-license` once with Cloudflare account env vars, then rerun the live OCR gate. |
| `sibling-rag-service-retired` fails | A stale sibling folder or active fleet reference has reappeared after retirement | Run `pnpm run audit:sibling-rag-service -- --json --require-retired`, remove the regression, and keep all fleet RAG runtime in `cloudflare/worker`. |
| `cloudflare-full-port-complete` reports remaining blockers | The goal is not fully complete | Inspect `cloudflare/full-port-gaps.json` and close the listed blockers. |
| `worker-local-preflight` fails | Wrangler bindings drifted from the expected Cloudflare services | Fix `cloudflare/worker/wrangler.jsonc`, then rerun `pnpm run preflight`. |
| Query results are slow on cold semantic misses | Workers AI embedding + Vectorize request paid cold-path latency | Prefer lexical/auto for exact-term UX, cache popular queries, or use precomputed query vectors where possible. |
