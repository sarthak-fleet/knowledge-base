# Cloudflare Migration Agent Handoff

Last updated: 2026-06-22

## Cloudflare Migration Complete Live

`knowledgebase` is now the only fleet RAG service codebase. The canonical runtime
is `cloudflare/worker`, targeting Cloudflare Workers with free-ai/Workers AI,
Vectorize, D1, R2, Queues, Workflows, and the Worker-hosted testing UI. The
current embedding-model/catalog release is deployed and live-smoked on
Cloudflare.

The old Python runtime has been removed from this branch. The old sibling
`../rag-service` directory is gone; a source-only safety archive exists at
`../rag-service-retired-2026-06-21.tgz`.

## Current Evidence

- Current branch: `cloudflare-full-port`; the working tree intentionally
  contains the local Cloudflare port changes and generated verification assets.
- `cd cloudflare/worker && pnpm run predeploy:local -- --json` was re-run on
  2026-06-22 and reports `ok: true`, including local tests, preflight,
  Python/runtime retirement audit,
  external RAG reference audit, consumer RAG integration audit, free-ai embedding
  catalog plus deploy-script audit, Linkchat/Starboard Cloudflare bundle builds,
  upstream free-ai cost/type/test check,
  Vectorize embedding binding selectability audit, the
  full-port gap matrix, scanned-OCR dry-run, the read-only embedding-model
  release plan, local cutover smoke, and `wrangler deploy --dry-run`.
- `cd cloudflare/worker && pnpm run gaps:full-port -- --json` reports `ok:
  true`, `remaining: 0`.
- `cd cloudflare/worker && pnpm run audit:sibling-rag-service -- --json`
  reports `retirement_ok: true`, `sibling_exists: false`, and no active
  external references.
- Live `knowledgebase` Worker version
  `a5ae4310-9091-42c8-8d22-5c26d7d09312` is deployed at
  `https://knowledgebase.sarthakagrawal927.workers.dev` with fingerprint
  `knowledgebase-cloudflare-embedding-models-2026-06-21`.
- Live `free-ai` gateway version `14f263b7-67cf-4f8c-a213-7d83197a7fdc`
  returns 6 enabled embedding models; `gemini-embedding-001` resolves with
  provider `gemini`, 1536 dimensions, and aliases including
  `text-embedding-3-small`, `text-embedding-3-large`, and `text-embedding-004`.
- D1 migrations `0005_index_embedding_model.sql` and
  `0006_kb_domain_embedding_model.sql` are applied remotely.
- Vectorize indexes `rag-gemini-1536`, `rag-embedding-1024`,
  `rag-embedding-768`, and `rag-embedding-384` are bound in the Worker and have
  the required `tenant` and `index_id` metadata indexes.
- `release-status:embedding-model -- --check-vectorize-metadata-indexes
  --check-knowledgebase-embedding-models` reports `ok: true`.
- `readiness:embedding-model` reports `ok: true`.
- `smoke:rag-crud:embedding-model` reports `ok: true` for live create, ingest,
  query, delete, `/v1/kb/ingest/text` custom input, and `/v1/kb/search`.
- `readiness:full-port` with `RAG_ALLOW_LIVE_OCR=1` reports `ok: true`, hosted
  `/` and `/ui` checks green, and NVDA scanned-PDF OCR `pass_rate: 1` with
  report id `15dba9a8-488a-4410-b75b-ce74fba34044`.
- `pnpm run check` passes locally: 29 test files, 280 tests.
- `pnpm run audit:d1-migrations -- --require-complete` proves the local D1
  migration set contains `0005_index_embedding_model.sql` with the required
  `indexes.embedding_model` / `indexes.embedding_provider` columns and
  `0006_kb_domain_embedding_model.sql` with the matching selected-model columns
  for `kb_domains`.
- `pnpm run audit:free-ai-embedding-contract -- --require-complete` proves the
  local `../free-ai` gateway source exposes the embedding catalog contract and a
  cost-audited Cloudflare deploy script that knowledgebase selected-model
  readiness depends on.
- `cd /Users/sarthak/Desktop/fleet/free-ai && pnpm run check` was re-run on
  2026-06-22 and passes locally: cost audit, typecheck, and 18 Vitest files /
  108 tests. Targeted embedding catalog tests also pass.
- `cd /Users/sarthak/Desktop/fleet/free-ai && pnpm run
  smoke:embedding-models -- --json --model gemini-embedding-001` passes against
  the deployed gateway with `embedding_model_count: 6`.
- `pnpm run audit:vectorize-embedding-bindings -- --json --require-all` reports
  all live deployed free-ai dimensions configured and all 6 models selectable.
- `pnpm run audit:vectorize-metadata-indexes -- --json --require-complete`
  reports every configured Vectorize index has the required `tenant` and
  `index_id` string metadata indexes.
- `RAG_SERVICE_KEY=<service-key> pnpm run release-status:embedding-model --
  --json --check-vectorize-metadata-indexes
  --check-knowledgebase-embedding-models` includes the read-only metadata audit
  and deployed knowledgebase embedding catalog proof in the main live
  embedding-model release status when Wrangler read access and a service key are
  available. The latest authenticated live run on 2026-06-22 reports `ok:
  true`; a no-key invocation still skips the protected knowledgebase catalog
  check by design.
- `GET /v1/embedding-models` exposes the configured Vectorize dimension profiles and
  free-ai embedding catalog; `POST /v1/indexes` accepts either a profile or an
  explicit `embedding_model`, persists the selected provider/model on the index,
  and routes ingest/query/delete by the index dimensions. With
  `RAG_EMBED_PROVIDER=free_ai`, profile-default index creation also validates
  the configured default model against the live free-ai catalog before creating
  the index. `/v1/kb/domains` and first-touch custom input routes accept an
  explicit free-ai `embedding_model`, persist the canonical model/provider on the
  domain, and the hosted testing UI sends that selected model with domain save,
  upload, infer-upload, schema inference, source import, direct record/text
  ingest, and queued/inline domain ingest actions. Auto-created `/v1/kb/*`
  domain indexes use the stored domain model when present, otherwise the default
  base model, with the same validation and canonical model/provider persistence.
  KB file registration/upload,
  infer-upload, source import with auto-ingest, schema/file reprocess,
  source-set requeue, async text, inline record/text, and queued KB ingest check
  this before staging raw input, mutating ingest jobs, or enqueueing
  Queue/Workflow runs; existing stored KB index models are revalidated against
  the live free-ai catalog before scheduling new work. The code supports optional
  `VECTORIZE_1024`, `VECTORIZE_768`, `VECTORIZE_384`, and `VECTORIZE_SMALL` bindings. The current deployed config binds
  `VECTORIZE`, `VECTORIZE_1024`, `VECTORIZE_768`, and `VECTORIZE_384`; all
  dimensions advertised by deployed `free-ai` are selectable. The testing UI only offers
  enabled free-ai models that have a compatible configured Vectorize binding
  when `/v1/embedding-models` is backed by live `catalog_source: "free_ai"` rows
  and the row has `selectable: true`; static fallback rows are diagnostic only
  and are not presented as explicit choices. The read-only release status and
  mutating RAG CRUD smoke also require `selectable: true` before treating an explicit
  embedding model as deployable. It omits
  `embedding_profile` when an explicit model is selected, so the model's
  dimensions determine the binding.
- `pnpm run preflight` now fails if `RAG_EMBED_PROVIDER=free_ai` is configured
  without the `FREE_AI` Cloudflare service binding or without a positive
  default embedding dimension, default embedding model, and provider. This keeps
  the fastest Cloudflare-to-Cloudflare embedding path and catches bad default
  embedding config before live CRUD smoke. It also checks the default
  `FREE_AI_EMBED_DIMENSIONS` value against the trailing dimension in the bound
  `VECTORIZE` index name (`rag-gemini-1536`) so changing the default embedding
  model cannot silently reuse a fixed-dimension Vectorize index.
- Deployed `/v1/healthz` readiness now requires `d1_schema: true`, Vectorize,
  and R2. It will fail if the Worker can connect to D1 but the
  `0005_index_embedding_model.sql` and `0006_kb_domain_embedding_model.sql`
  migrations have not been applied, or if the R2 binding is absent.
  `smoke:local-cutover` uses
  `RAG_ALLOW_UNMIGRATED_LOCAL_D1=true` only for `wrangler dev --local`; deployed
  readiness still rejects `d1_schema: false`.
- The selected-model live smoke requires `catalog_source: "free_ai"`. A static
  fallback catalog is intentionally not enough proof, and the selected row must
  also include a compatible Vectorize binding. The deployed release now satisfies
  this path; keep the same requirement for future catalog/model changes.

## Completed Blockers

1. Deployed Worker cutover is complete for the current embedding-model Worker.
   Public `/healthz`, `/readyz`, and `/metrics` return 200; protected retired
   FastAPI aliases return 401 without a service key; the live deploy fingerprint
   matches `knowledgebase-cloudflare-embedding-models-2026-06-21`.
2. Live scanned-PDF OCR parity is proven by the completed `readiness:full-port`
   run with `RAG_ALLOW_LIVE_OCR=1`; the NVDA scanned-PDF fixture passed with
   `pass_rate: 1`.
3. Sibling `rag-service` retirement is complete. The folder was deleted after
   readiness passed, and the audit now proves no sibling deployable surfaces or
   active external references remain.

## Guardrails

- Do not recreate a sibling RAG service. All fleet RAG runtime belongs in
  `knowledgebase/cloudflare/worker`.
- Do not touch secrets, `.env` files, cloud credentials, SSH keys, kube configs,
  or production config unless explicitly asked.
- Real deploys, migrations, releases, secret changes, and destructive operations
  still require explicit user approval.
- Live OCR and Workers AI cost-bearing checks should remain opt-in with
  `RAG_ALLOW_LIVE_OCR=1` or the matching script flag.

## Fleet Consumers

The user wants karte.cc/linkchat and Starboard to use this Worker.

Current consumer state:

- `/Users/sarthak/Desktop/fleet/karte` is the current local Linkchat/Karte repo.
  It is on `main`, even with `origin/main`, with local RAG integration edits.
  The old `src/lib/saasmaker.ts` RAG helper has been removed locally;
  `src/lib/knowledgebase.ts` now routes profile memory create/ingest/delete/search
  through the `knowledgebase` Worker via `RAG_SERVICE` and `RAG_SERVICE_KEY`.
  A static contract test covers the route imports and absence of the legacy
  SaasMaker RAG helper. Local `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm
  cf:build`, and `git diff --check` pass; lint has warnings only.
- `/Users/sarthak/Desktop/fleet/starboard` is on `main`, even with
  `origin/main`, with local RAG integration edits. `/api/stars` relevance search
  uses the shared `knowledgebase` Worker and falls back to lexical-only results
  when unavailable; `/api/stars/sync` ingests new repo documents through the same
  `knowledgebase` client. Local Turso vectors remain for discover/similar/
  recommendation features. `src/lib/knowledgebase.ts` reads `RAG_SERVICE_KEY` and
  `STARBOARD_RAG_INDEX_ID` from OpenNext's Cloudflare env as well as
  `process.env`, so Worker vars/secrets work after deploy. Local `pnpm
  typecheck`, `pnpm test`, `pnpm lint`, `pnpm cf:build`, and `git diff --check`
  pass; lint has warnings only. `pnpm check` is blocked by broad pre-existing
  Biome diagnostics outside this RAG integration.
- Do not overwrite these dirty consumer edits without first reading and
  preserving them.

Recommended next steps:

1. Print the ordered release checklist with `pnpm run release-plan:embedding-model
   -- --json` from `cloudflare/worker` before future embedding/free-ai changes.
   It is read-only and marks which steps are mutating and require explicit
   approval. Use `RAG_SERVICE_KEY=<service-key> pnpm run release-status:embedding-model
   -- --json --check-vectorize-metadata-indexes
   --check-knowledgebase-embedding-models` as the read-only live status gate; it
   now reports deployed knowledgebase `/v1/embedding-models` readiness, the
   selected model's concrete Vectorize binding/index readiness, and deployed
   free-ai dimension readiness. The selected knowledgebase row must be selectable
   with a compatible Vectorize binding, valid provider, and positive numeric
   dimensions. The Vectorize dimension check blocks on every enabled embedding
   dimension advertised by the deployed `free-ai` catalog, and the free-ai catalog
   check fails malformed enabled embedding rows that lack a provider or positive
   numeric dimensions. The checked-in optional candidate
   dimensions remain planning context unless they are live in `free-ai`. It
   currently reports green for the deployed 2026-06-22 release. Its JSON output includes
   `release_plan_steps` on failed checks, a top-level `blocker_steps` summary,
   and `blocker_commands` with command, mutating, approval, optional, and
   required-env metadata that maps each live blocker back to this ordered
   checklist. If the knowledgebase catalog check is skipped only because
   `RAG_SERVICE_KEY` is missing, it maps to the read-only `live-release-status`
   invocation step rather than broad deploy/provision steps. If configured
   Vectorize metadata indexes are missing, `blocker_commands` expands to the
   exact `create-metadata-index` commands reported by the metadata audit plus
   the follow-up readiness audit.
2. Keep `predeploy:local`, `release-status:embedding-model`,
   `readiness:embedding-model`, `smoke:rag-crud:embedding-model`, and
   `readiness:full-port` as the regression gates after future Worker/free-ai
   changes.
3. `predeploy:local` already runs `pnpm run audit:consumer-rag-integrations --
   --json --require-complete` and `pnpm run build:consumer-cloudflare -- --json`.
   Rerun them directly after consumer-only changes. The source audit proves
   checked-out source wiring only; it is not deployed consumer smoke. It also
   proves karte's profile-memory create/ingest/delete/search payload contract and
   Starboard's user-scoped semantic knowledgebase search plus repo text content
   and `user_id`/`repo_id`/`full_name`/`language` ingest metadata contract, and
   verifies both checked-out consumer repos expose Cloudflare-backed `deploy:cf`
   scripts that run the repo's Cloudflare build pipeline before deploy. The
   build verifier bundles both consumer apps (`../../../karte` `cf:build`,
   `../../../starboard` `build:cf`) but does not deploy them.
4. Karte/Linkchat is deployed as Worker version
   `5a1eaee5-5f7a-4b5b-b64c-3943792f3cb2` with `RAG_SERVICE` bound to
   `knowledgebase` and `RAG_SERVICE_KEY` configured. Public page and auth-boundary
   smokes passed; full profile-memory create/ingest/search/delete through the
   app still needs a real user session.
5. Starboard is deployed as Worker version
   `029e9980-9931-4443-97ba-2cd6c081b17b` with `RAG_SERVICE` bound to
   `knowledgebase`, `RAG_SERVICE_KEY` configured, and
   `STARBOARD_RAG_INDEX_ID=16522a1b-afe6-4167-99d7-d00695ee271a`. Public page
   and auth-boundary smokes passed; direct Starboard-shaped ingest/query/delete
   through deployed knowledgebase passed. Full `/api/stars/sync` plus relevance
   search through the app still needs a real user session.

## Useful Commands

```bash
cd cloudflare/worker
pnpm run check
pnpm run predeploy:local -- --json
pnpm run audit:consumer-rag-integrations -- --json --require-complete
pnpm run build:consumer-cloudflare -- --json
pnpm run audit:free-ai-embedding-contract -- --json --require-complete
pnpm run audit:vectorize-embedding-bindings -- --json
pnpm run audit:vectorize-metadata-indexes -- --json --require-complete
pnpm run release-plan:embedding-model -- --json
cd ../../../free-ai && pnpm run check
RAG_SERVICE_KEY=<service-key> pnpm run release-status:embedding-model -- --json --check-vectorize-metadata-indexes --check-knowledgebase-embedding-models
RAG_SERVICE_KEY=<service-key> pnpm run readiness:embedding-model
RAG_SERVICE_KEY=<service-key> pnpm run smoke:rag-crud:embedding-model
pnpm run gaps:full-port -- --json
pnpm run audit:sibling-rag-service -- --json
pnpm run smoke:legacy-routes -- --base-url https://knowledgebase.sarthakagrawal927.workers.dev --require-complete --json
```
