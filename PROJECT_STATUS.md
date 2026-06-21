# knowledgebase — PROJECT STATUS

Last updated: 2026-06-21

## Why/What

**Thesis:** Private Agent Search — Exa-style cited search over project-scoped private corpora. Users create domains, infer/confirm schemas, ingest files, and expose `/search` and `/query` APIs for agents. Wedge: specialized private corpus + explicit schemas + cited evidence, not generic chat RAG.

**In scope:** Final Cloudflare product owned by this repo, fleet **RAG_SERVICE** Cloudflare Worker (`cloudflare/worker`), TypeScript/Rust/WASM product runtime, demo domains (SEC + Legal), eval pipeline, consumer bindings (SaaS Maker, Linkchat, Starboard).

**Out / parked:** Public multi-user hosting without auth/limits, connector marketplace, High Signal integration (phase-2), semantic p99 <300 ms on cold Workers AI misses without cache.

**Migration complete (2026-06-21):** Full Cloudflare port is done — `gaps:full-port` reports 0 remaining. The current `cloudflare/worker` is deployed (version `418b60d7-5901-40e1-8948-a92d56cab351`) with the `knowledgebase-cloudflare-full-port-2026-06-21` fingerprint live, deployed legacy-route parity and live NVDA scanned-PDF OCR (pass_rate 1) proven via `readiness:full-port`, and the sibling `rag-service` repo deleted after `readiness:sibling-retirement` passed (source-only archive kept at `../rag-service-retired-2026-06-21.tgz`).

**Deployed corpus is empty by design.** The cutover ships code + infra parity, not ingested data: the deployed D1 has `documents=0` / `chunks=0` and no per-domain entries in the `indexes` table across all tenants, so live RAG queries (`/v1/kb/query`) over demo domains return `domain index not found` until ingestion runs. This matches the documented empty-at-rollout design (knowledge tables empty, no backfill required before rollout; Starboard falls back to lexical-only). The `legal`/`sec` `kb_domains`/`kb_entities`/`kb_files` rows present in deployed D1 are a small partial metadata import, not a queryable corpus. To make demo queries answer, run domain ingestion (e.g. `migrate-raw-files.mjs --queue-ingest` or the `/v1/kb/files/:id/reprocess` route) from the R2 raw files — this spends Workers AI embedding calls and is an opt-in post-cutover step.

## Dependencies

### External

- **Cloudflare bindings (Worker):** Workers AI embeddings, Vectorize (`rag-bge-768`, `rag-bge-small-384`), D1 `rag-db`, R2 `rag-raw-docs`.
- **Secrets:** `RAG_SERVICE_KEYS` JSON map (never commit). Fleet audit: `pnpm fleet:secret-audit -- --project knowledgebase` from saas-maker.
- **AI Gateway cache:** implemented but not enabled (Wrangler OAuth blocked gateway creation).

### Internal fleet

- **SaaS Maker:** no active in-API RAG/knowledge backend; old knowledge routes, tables, and service bindings were removed on 2026-06-20.
- **Linkchat:** wired via service binding; legacy SaaS Maker RAG fallback removed for profile-memory create/ingest/delete/search.
- **Starboard:** wired via service binding; relevance search now uses `knowledgebase` RAG or lexical-only results, while Starboard's Turso vector table remains for non-RAG app features.
- **High Signal:** phase-2 integration deferred (`docs/highsignal-integration.md`).
- **Sibling `rag-service`:** retired. Deleted on 2026-06-21 after
  `readiness:sibling-retirement` passed (deployed parity, fingerprint, auth+OCR,
  zero active external references, gap matrix consistent). `audit:sibling-rag-service
  --require-retired` now reports `retirement_ok: true` / `sibling_exists: false`.
  A source-only safety archive is kept at `../rag-service-retired-2026-06-21.tgz`.
  Do not recreate a separate `rag-service` Worker — all fleet RAG runtime lives in
  `cloudflare/worker`.
- **Deployed Worker cutover:** complete. The current `cloudflare/worker` code is
  deployed (version `418b60d7-5901-40e1-8948-a92d56cab351`); public
  health/ready/metrics aliases return 200, protected retired FastAPI aliases
  reject anonymous callers with 401, and the deployed `/healthz` payload exposes
  `deploy_fingerprint=knowledgebase-cloudflare-full-port-2026-06-21`.
  `readiness:full-port` passed deployed legacy-route parity, the fingerprint
  check, authenticated checks, and the live NVDA scanned-PDF OCR eval
  (`RAG_ALLOW_LIVE_OCR=1`, pass_rate 1) on the same Worker version.
- **Python runtime:** retired. The Worker full-port/preflight gates, UI,
  migration tooling, and local checks are TypeScript/Node-only; the old Python
  FastAPI server, Python UI, Docker Compose runtime, parser/query/eval package,
  package metadata, and root pytest suite have been removed.

### Stack & commands

#### Cloudflare RAG_SERVICE Worker

```bash
cd cloudflare/worker
pnpm install
pnpm dev                    # wrangler dev
pnpm run deploy:dry-run      # bundle + binding validation without publishing
pnpm run predeploy:local     # check + preflight + OCR dry-run + local smoke + dry-run
pnpm deploy
pnpm check                  # typecheck + vitest
pnpm run audit:python-runtime-retirement -- --require-complete
pnpm run smoke:local-cutover # boot wrangler dev and prove aliases + fingerprint locally
pnpm run readiness          # deployed health + anon /v1/* rejection
pnpm run readiness:auth     # full auth smoke with RAG_SERVICE_KEY
pnpm run readiness:sibling-retirement # read-only proof before deleting ../rag-service
pnpm run smoke:legacy-routes -- --base-url "$RAG_BASE_URL" --require-complete
pnpm run backfill:dry-run | benchmark:dry-run | smoke:export:dry-run | migrate:raw:dry-run | migrate:raw:objects:dry-run
```

**Worker `/v1/*` (service-key auth):** public `healthz`/`readyz`/`metrics`, indexes CRUD, ingest, ingest-vectors, documents delete, query, query-vector, `/v1/kb/projects`, `/v1/kb/projects/:project/status`, `/v1/kb/domains`, `/v1/kb/files` list/register/get/reprocess/delete, `/v1/kb/files/upload`, `/v1/kb/sources`, `/v1/kb/sources/import` for URL and EDGAR sources, `/v1/kb/status`, `/v1/kb/jobs`, `/v1/kb/ingest/jobs/:job_id`, `/v1/kb/parse-artifacts/:hash`, `/v1/kb/schemas`, infer/drafts/get/apply/discard/active/domain-reprocess, `/v1/kb/ingest/run`, `/v1/kb/ingest/record`, `/v1/kb/ingest/text`, `/v1/kb/entities`, entity find/detail/lineage/relationships, `/v1/kb/entities/search`, `/v1/kb/relationships`, `/v1/kb/search`, `/v1/kb/query`, `/v1/kb/query/stream`, `/v1/kb/sessions`, `/v1/kb/query/traces`, `/v1/kb/query/trace/:id/drilldown`, `/v1/kb/evals/search`, `/v1/kb/evals/query`, `/v1/kb/evals/reports`. Retired FastAPI aliases forward into the Worker handlers for `/search`, `/agent/search`, `/search/eval`, `/query`, `/query/stream`, `/query/traces`, `/query/trace/:id`, `/projects`, `/domains`, `/schemas`, `/files`, `/sources`, `/entities`, and `/ingest/*`. Hosted UI at `/` and `/ui`.

```
Worker: Fleet consumer → Hono → Workers AI embed → Vectorize query → D1 chunk text
        kb_* metadata on D1 for domains, schemas, files, jobs (migration 0003)
        staged R2 text/JSON/CSV-like files → domain Vectorize index → /v1/kb/search
        uploads create D1 ingest jobs; /v1/kb/ingest/run defaults to Workflow-backed Cloudflare Queue ingestion
        async:false is the explicit inline/debug override; queued/inline runs carry durable D1 workflow_id run identifiers
        ingest writes parse artifacts to R2 + D1
        active inferred schemas extract structured entities/mentions/provenance into D1
        schema-inferred parent/ref fields, *_ids arrays, and prefixed cross-type fields create D1 entity relationships
        relationship resolution matches exact plus canonicalized identity/display-name aliases
        /v1/kb/relationships/backfill rebuilds graph edges for historical D1 entities from active schemas
        /v1/kb/entities/search provides a zero-AI D1 fast path for exact structured lookups
        /v1/kb/query plans explicit D1 field filters such as counterparty: Acme
        /v1/kb/query expands D1 structured matches with D1 relationship graph evidence
        explicit hybrid mode fuses D1 BM25-style fuzzy sparse lexical + Vectorize retrieval with RRF, local MMR, and opt-in Workers AI neural rerank
        query rewrite/decompose fans out lexical variants inside the Worker without extra AI
        semantic mode corrects weak/empty Vectorize evidence with D1 lexical RRF fallback
        /v1/kb/query auto-uses the D1 entity fast path before Vectorize/Workers AI fallback
        /v1/kb/query returns fast extractive cited answers by default and opt-in Workers AI cited synthesis via answer_mode
        /v1/kb/query/stream preserves the retired FastAPI SSE stream contract with started/stage/answer/error events
        /v1/kb/query persists D1 query traces
        /v1/kb/query attaches deterministic answer/evidence verification to confidence
        /v1/kb/sessions stores D1-backed query sessions and bounded message history
        /v1/kb/evals/query scores answer hit rate, citation rate, deterministic faithfulness/support coverage, opt-in Workers AI judge scores, AI use rate, and latency
        eval reports persist to D1 and D1 rollups are exposed through /v1/kb/evals/summary
        query traces and eval reports emit compact RAG_ANALYTICS Analytics Engine data points
        query citations use deterministic question-token span selection before answer assembly
```

**Empirical headline:** On solid retrieval, `groq-llama-3.1-8b` beats `gemini-2.5-pro` by 24 pass-rate points on SEC eval — contingent on retrieval quality (see `NOTES.md` §4.7, `WRITEUP.md`).

## Timeline

- **D1 migrations:** core RAG tables, query cache, **`0003_knowledgebase_metadata.sql`** (`kb_*` projects/domains/schemas/files/jobs/chunks/sessions/traces).
- **Eval maturity:** cross-domain 5×2 LLM eval matrix documented; methodology bugs caught and fixed (DuckDB route, env propagation, citation hygiene).
- **Fleet cutover:** SaaS Maker, Linkchat, Starboard on service binding; production SaaS Maker knowledge tables empty — no backfill required before rollout.
- **CI:** Worker-local `pnpm run predeploy:local` is the active local gate;
  it wraps typecheck/tests, binding preflight, Python retirement audit, local
  no-external-`rag-service` reference guard, the no-network NVDA scanned-PDF OCR
  eval payload dry-run, Wrangler alias/fingerprint smoke, and deploy dry-run.

## Products

| Product | Surface | Role |
| --- | --- | --- |
| Cloudflare RAG_SERVICE | Worker `/v1/*` + hosted `/ui` | Fleet-shared index/query/metadata API with tenant isolation |
| Demo domains | SEC (25-question eval) + Legal/SPDX (12-question eval) | Same code, two reference corpora |
| Agent contracts | `docs/agent-tool-contract.md`, `docs/agent-integration-examples.md` | External agent integration specs |

## Features (shipped)

### Cloudflare RAG_SERVICE (fleet shared worker)

- Index create/list/delete, document ingest/delete, vector query, query-by-vector; tenant isolation hardening.
- Service-key auth (`Authorization: Bearer` or `X-RAG-Key`); `RAG_SERVICE_KEYS` tenant mapping.
- Lexical auto-retrieval path meets p95/p99 targets for exact-term queries.
- Semantic path optimized (p95 <300 ms warmed; p99 cold outliers remain).
- `D1MetadataRepository` + full `/v1/kb/*` route set.
- Multipart upload → R2 + D1 registration; hosted testing UI.
- Hosted testing UI covers custom upload/input, direct structured-record
  ingestion with schema inference for new domains, schema-free inline
  domain-text ingestion, schema inference, ingestion,
  URL/EDGAR source import, parser options, source-set actions, sessions, traces,
  drilldowns, evals, and advanced query controls.
- TypeScript schema inference/draft/apply; retrieval eval route on Worker path.
- Nested JSON and quoted CSV record inference for arbitrary structured upload surfaces.
- Cloudflare-native parser slice for text/JSON/NDJSON/CSV, HTML, digital PDF text with coordinate-derived table rows, XLSX rows, DOCX paragraph text, and PPTX slide text; no Python parser runtime in the Worker.
- Legacy parse eval harness: `cloudflare/worker/scripts/legacy-parse-eval.mjs`
  builds parse-quality eval cases from the migrated D1 JSON export plus mirrored
  raw/parse object roots, batches large payloads, supports dry-run, bounded
  text previews, and filename/content-hash/case-id filters for targeted costly
  OCR reruns, can build a one-file direct case from local MinIO inline `xl.meta`
  raw/parse objects when no D1 export is available, supports `--require-cases`
  and `--min-pass-rate 1` as the final parity gate, and posts to
  `/v1/kb/evals/parse`. `pnpm run eval:parse:nvda-scanned:dry-run` verifies
  the local one-case payload without network or AI usage and prints the selected
  Cloudflare vision OCR model chain plus pass-rate gate; `pnpm run
  eval:parse:nvda-scanned:live` is the authenticated deployed one-case gate.
  `pnpm run readiness:full-port` requires deployed health/auth, deployed
  retired-route alias smokes, the expected deploy fingerprint, the live NVDA
  scanned-PDF OCR eval with `RAG_ALLOW_LIVE_OCR=1` or `--allow-live-ocr`, the
  Worker-local Node preflight, the sibling `rag-service` retirement audit, and
  the Worker-local Node full-port gap gate.
- Deployed parser parity evidence on Worker version
  `3099934b-54b6-44ef-9f57-994dc1550701`: legacy parse eval ran 19 migrated
  cases in 4 batches, passed 18/19 (94.74%), and skipped 3 JSON record files
  that had no legacy parse artifact. Passing coverage includes legal text,
  SEC HTML, digital PDF text/table rows, and XLSX rows/header wording. The one
  remaining failure is `NVDA_riskfactors_sample_scanned.pdf`: Cloudflare
  Markdown Conversion extracts/describes the image and matches the title, but
  does not transcribe the two expected risk-factor paragraphs from the legacy
  OCR artifact.
- Direct Workers AI image OCR is implemented as an opt-in parser fallback via
  `RAG_VISION_OCR_MODEL`, and upload schema inference, ingest runs, and parse
  evals can set `markdown_conversion`/`vision_ocr_model` per request without
  changing Worker secrets; queued and Workflow-backed ingestion preserve those
  parser options. It handles standalone JPEG/PNG/WebP uploads, embedded
  JPEG/JPX images, plus basic Flate RGB/grayscale PDF image streams converted
  to PNG, prioritizes page-like PDF images over tiny embedded assets, and runs
  for PDFs whose local text extraction is weak rather than only for completely
  textless PDFs. When vision and Markdown Conversion both return text the
  Worker stores a merged `workers-ai-vision-markdown-ocr-v1` artifact.
  It is not enabled by default:
  LLaVA took ~71.8 s for the scanned PDF and still missed the target
  paragraphs. The direct parse-eval harness can now build the local
  `NVDA_riskfactors_sample_scanned.pdf` case from MinIO inline metadata without
  a D1 export. The Worker now accepts a comma-separated Cloudflare vision model
  chain: Llama 3.2 Vision tries Workers AI native `prompt` + image bytes first
  and falls back to an `image_url` message, while Llama 4 Scout uses the
  `image_url` message shape. The packaged NVDA live gate tries
  `@cf/meta/llama-3.2-11b-vision-instruct` first, then
  `@cf/meta/llama-4-scout-17b-16e-instruct`; parse evals retry later configured
  models when the first model returns text but still misses expected OCR
  snippets. The deployed live OCR gate has been run: `readiness:full-port` with
  `RAG_ALLOW_LIVE_OCR=1` passed `nvda-scanned-ocr-live` with pass_rate 1 on the
  deployed Worker, closing the scanned-PDF gap on the Cloudflare vision model chain.
- Cloudflare Workflow plus Queue is the primary `/v1/kb/ingest/run` path when
  bound, with direct Queue fallback and `async:false` as an explicit inline/debug
  override.
- Durable ingest run IDs in D1 `workflow_id`, propagated through Workflow
  instances, Queue messages, and job state.
- Run-level queued ingestion progress via `/v1/kb/ingest/runs/:run_id`, exposed in the hosted testing UI.
- Domain-backed source-set summaries and bulk dry-run/requeue/archive/delete actions, exposed in the hosted testing UI.
- Schema-inferred structured entity relationship extraction, prior-ingest target
  resolution, prefixed cross-type entity extraction, and `/v1/kb/relationships`
  inspection.
- Deterministic identity/display-name alias resolution for D1 relationship
  matching.
- Historical D1 entity graph repair through `/v1/kb/relationships/backfill`.
- Zero-AI D1 exact field-filter planning in `/v1/kb/query` for structured entity fields.
- Zero-AI D1 graph evidence expansion in `/v1/kb/query` for structured entity matches.
- Explicit `hybrid` retrieval mode with D1 BM25-style fuzzy sparse lexical + Vectorize RRF fusion plus Worker-native keyword rerank/MMR and opt-in Workers AI neural rerank.
- Deterministic rewrite/decompose lexical fanout for multi-part questions, exposed through Worker API/UI flags for benchmark comparison.
- Corrective semantic fallback: explicit `semantic` queries with weak/empty Vectorize evidence fuse D1 lexical evidence before returning.
- Opt-in Workers AI answer synthesis for `/v1/kb/query` through `answer_mode: "workers_ai"`, with extractive cited answers kept as the default fast path.
- SSE query lifecycle parity through `/v1/kb/query/stream`, exposed in the
  hosted testing UI as Stream Answer and backed by the same answer path as
  `/v1/kb/query`.
- Retired FastAPI route compatibility through authenticated Worker aliases for
  root agent/search/query paths and product prefixes; `pnpm run
  audit:legacy-route-parity` is a Node-only release gate and is included in
  Worker preflight.
- Python runtime retirement through a Node-only audit for the old FastAPI
  package, Python UI, Docker runtime, Python package metadata, root pytest
  suite, and Python helper scripts; `pnpm run preflight` runs this gate.
- D1-backed query sessions tied to `/v1/kb/query` traces and exposed in the hosted testing UI.
- D1-backed trace export and deterministic trace comparison routes exposed in the hosted testing UI.
- Deterministic answer-quality trace drilldowns exposed through `/v1/kb/query/trace/:id/drilldown` and the hosted testing UI.
- Deterministic question-token span selection for `/v1/kb/query` citations without extra AI calls.
- Inline deterministic answer/evidence verification in `/v1/kb/query` confidence, persisted into D1 query traces without extra AI calls.
- D1 eval report history and rollups via `/v1/kb/evals/reports` and `/v1/kb/evals/summary`, including deterministic answer faithfulness/support coverage metrics and opt-in Workers AI model-judged support scores.
- Analytics Engine data points for successful query traces and eval reports via the `RAG_ANALYTICS` dataset binding.
- Public `/readyz` and Prometheus-compatible `/metrics` compatibility endpoints
  for the retired FastAPI meta surface, backed by Cloudflare D1/Vectorize/R2
  binding checks.
- Benchmark harnesses, backfill script (`scripts/backfill-saas-maker.mjs`), checksum-reporting raw R2/D1 migration script (`scripts/migrate-raw-files.mjs`), smoke export script, route tests, readiness checks.
- Raw-file migration guardrails: `scripts/migrate-raw-files.mjs` accepts local,
  manifest, or mirrored MinIO/S3 object exports, rejects direct MinIO
  disk/erasure layouts containing `xl.meta`, and the local legacy MinIO mirror
  accounts for 48 files / 20,395,043 bytes across 5 domains. Those raw files
  were uploaded to R2 under both legacy filename-suffixed keys and current
  hash-only Worker keys. The legacy parse prefix contributed 34 artifacts, also
  uploaded to R2. Remote verification fetched and hash-checked all
  D1-referenced raw files (22) and parse artifacts (28).
- D1 metadata migration guardrails: `scripts/migrate-d1-metadata.mjs` now
  derives missing legacy mention/provenance domains from referenced rows,
  orders self-referenced entities/chunks before children, supports
  `--no-transaction` for remote D1 imports, and turns the real local Postgres
  export into 2,199 D1 rows that apply cleanly to a disposable D1-shaped SQLite
  database. The same import has been applied to remote D1 with matching table
  counts. Authenticated Worker route smokes now read migrated
  domains/status/entities/parse-artifact metadata.
- Auth hardening for verification/cutover: Worker version
  `62d62f04-dc91-4fd7-aadc-ad85be589852` supports
  `RAG_SERVICE_KEYS_APPEND`, an append-only secret map that allows temporary
  verification keys without overwriting the primary fleet `RAG_SERVICE_KEYS`.
- Python runtime retirement: the old Python FastAPI server, Python UI, Docker
  Compose runtime, parser/query/eval package, package metadata, and root pytest
  suite have been removed; the active product/tooling surface is the
  Cloudflare Worker package.

## Todo / Planned / Deferred / Blocked

### Planned

1. Add richer eval trend views per project/kind/filter on top of the persisted
   Worker eval reports.
2. Framework-specific agent integration examples + HTTP contract compatibility test.
3. Live progress UI while schema inference itself is parsing representative
   files in the Worker `/ui`.
4. Deeper source-set management: cursors, stale counts, and bulk replace.
5. Project templates (papers, company knowledge, notes, manuals, contracts, docs snapshots).
6. Schema-diff and safe reprocess wizard in UI.
7. Close the final Cloudflare full-port parity decision: scanned-PDF exact OCR
   through accepted Workers AI vision, accepted Markdown Conversion quality, or
   an explicit non-default fallback, run `pnpm run deploy:dry-run`, deploy the
   current `cloudflare/worker` code, run `pnpm run smoke:legacy-routes --
   --base-url "$RAG_BASE_URL" --require-complete`, then run
   `RAG_ALLOW_LIVE_OCR=1 RAG_SERVICE_KEY=<service-key> pnpm run
   readiness:full-port` from `cloudflare/worker` so deployed health/auth,
   legacy aliases, OCR, preflight, sibling retirement, and gap gates all pass
   together.
8. Retire sibling `rag-service` only after the scanned-PDF OCR parity decision
   is closed, deployed cutover is proven, and all bindings, smoke checks, docs,
   and scripts point here. `cloudflare/full-port-gaps.json` tracks this as
   `sibling_rag_service_retirement` and `deployed_worker_cutover` so the goal
   cannot be marked complete while the folder still exists or the deployed
   Worker is behind local parity; `pnpm run readiness:sibling-retirement` is
   the read-only pre-delete gate that must pass before removing the sibling
   folder, and `pnpm run audit:sibling-rag-service` from
   `cloudflare/worker` is the machine-readable proof for sibling deletion.
9. Finish hosting checklist: durable storage, backups, observability, usage limits, smoke tests.
10. Enable AI Gateway cache when Wrangler OAuth unblocks gateway creation.

### Deferred

- **Public multi-user hosting** — until auth, per-project authorization, upload limits, rate limits, job cancellation, backup drills, log redaction.
- **Connector marketplace** — manual/private corpus search remains the wedge.
- **High Signal integration** — phase-2; storage/ingest ownership must be decided first.
- **Per-project service key rotation UI.**
- **Queue/workflow ingestion at scale** on Worker.
- **Exact Qdrant BM42 model equivalence on Worker** — Cloudflare Vectorize does not provide BM42. Product retrieval parity uses the Cloudflare-native replacement: Vectorize dense search, D1 fuzzy sparse lexical scoring, semantic/hybrid RRF, MMR, opt-in Workers AI neural rerank, rewrite/decompose, and D1 graph expansion.
- **Semantic p99 <300 ms on cold Workers AI + Vectorize misses** — needs cached popular queries or precomputed query vectors; weak semantic evidence now has lexical correction, but unique semantic misses still pay Workers AI + Vectorize latency first.

### Blocked

- Future product additions must land in the Worker/D1 repository and `/v1/kb/*` aliases before being considered product-complete.
- Raw local MinIO objects and parse artifacts have been uploaded to remote R2
  and verified against D1-referenced hashes. Authenticated Worker route-level
  upload/ingest smoke remains part of the broader route verification gap.
- Legacy Postgres metadata has been imported into remote D1 and verified by
  direct D1 counts plus authenticated Worker route-level reads.
- AI Gateway cache implemented but not enabled (Wrangler OAuth blocked gateway creation).
- Cloudflare Vectorize is not Qdrant BM42; the accepted Worker replacement is D1 fuzzy sparse lexical + Vectorize dense RRF with optional Workers AI rerank.
- Workers cannot host the old OCR/parser stack as-is; text/HTML/digital-PDF-table/XLSX/DOCX/PPTX parsing is now TypeScript-native, and opt-in vision OCR can be merged with Markdown Conversion. Exact scanned-PDF OCR parity still needs a Cloudflare vision-model acceptance test or an explicit non-default fallback decision.
- Worker name: `knowledgebase` on Cloudflare; D1 id in `wrangler.jsonc`.
- Consumers must set `RAG_SERVICE_KEY` + service binding or `RAG_SERVICE_URL` fallback.
- `cloudflare/full-port-gaps.json` is the executable full-port gap matrix. Use
  `cd cloudflare/worker && pnpm run gaps:full-port` for the Node-only Worker
  release gate. Current remaining items are `sibling_rag_service_retirement`,
  `deployed_worker_cutover`, and `ocr_and_office_parsing`.
- `cloudflare/worker/scripts/preflight.mjs` is the Node-only Cloudflare binding,
  legacy-route-parity, and Python runtime retirement preflight for release
  readiness.
