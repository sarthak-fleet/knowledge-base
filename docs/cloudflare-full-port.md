# Cloudflare Full Port

Last updated: 2026-06-22

`knowledgebase` is the only RAG service. Cloudflare resources are implementation
details inside this repo: Workers, Workers AI, Vectorize, D1, R2, Queues,
Workflows, and Rust/WASM modules where Worker JavaScript is not enough.

## What Cloudflare Can Fill

| Current capability | Cloudflare target | Status |
| --- | --- | --- |
| Fleet RAG API | Worker in `cloudflare/worker` with Workers AI, Vectorize, D1, R2 | Done for the lightweight shared API, including retired FastAPI compatibility aliases for root `/search`, `/agent/search`, `/search/eval`, `/query`, `/query/stream`, and the old product route prefixes |
| Deployed Worker cutover | Same `cloudflare/worker` code on the live Cloudflare Worker | Done for the current embedding-model release (version `a5ae4310-9091-42c8-8d22-5c26d7d09312`); public health/ready/metrics aliases return 200, protected retired FastAPI aliases reject anonymous callers with 401, deploy fingerprint `knowledgebase-cloudflare-embedding-models-2026-06-21` is live, D1 schema readiness is true, the matching `free-ai` gateway version `14f263b7-67cf-4f8c-a213-7d83197a7fdc` returns 6 enabled embedding models, all advertised dimensions (384/768/1024/1536) have Vectorize bindings plus `tenant`/`index_id` metadata indexes, and `release-status:embedding-model`, `readiness:embedding-model`, `smoke:rag-crud:embedding-model`, and `readiness:full-port` passed on 2026-06-22. |
| Raw files and parse artifacts | R2 | Done; Worker upload and ingest write raw files plus parse artifacts to R2, `scripts/migrate-raw-files.mjs` can migrate local/manifest/mirrored MinIO exports into R2/D1 with SHA-256 dry-run plans, upload hash verification, and direct MinIO disk-layout rejection, and the legacy MinIO raw/parse prefixes have been uploaded to R2 and verified against D1-referenced keys |
| Dense vector search | Vectorize | Done; implemented in Worker with corrective lexical fallback, candidate-prefiltered BM25-style fuzzy D1 sparse lexical scoring, and optional Workers AI neural rerank |
| File uploads and custom testing UI | Workers/Pages UI | Done; Worker UI covers R2 upload, direct structured-record ingestion, schema-free inline domain-text ingestion, schema inference, source-set management, queued-run progress, trace export/comparison, answer-quality drilldown, evals, answer synthesis controls, and advanced query controls |
| Parser/OCR/runtime | TypeScript/Rust/WASM plus Workers AI conversion/vision where useful | Done; Worker parses text/JSON/NDJSON/CSV, HTML, compressed/digital PDF text with coordinate-derived table rows, XLSX rows, DOCX paragraph text, and PPTX slide text; Workers AI Markdown Conversion covers scanned/unsupported rich files in auto/forced modes; opt-in Workers AI vision OCR covers standalone JPEG/PNG/WebP uploads plus embedded JPEG/JPX and basic Flate RGB/grayscale PDF image streams, prioritizes page-like PDF images over tiny embedded assets, can be configured by env or parse-eval payload, and merges with Markdown Conversion as `workers-ai-vision-markdown-ocr-v1`; `/v1/kb/evals/parse` plus `scripts/legacy-parse-eval.mjs` measure parser quality against migrated legacy artifacts; the deployed live scanned-PDF OCR gate (`readiness:full-port` `nvda-scanned-ocr-live`, `RAG_ALLOW_LIVE_OCR=1`) passed with pass_rate 1 on the Cloudflare vision model chain, closing the last parser gap |
| Async ingestion jobs | Queues and Workflows with D1 status records | Done; `/v1/kb/ingest/run` defaults to Workflow-backed Queue dispatch when bound, falls back to direct Queue dispatch, has producer/consumer, D1 job state, durable run ids in `workflow_id`, inline override via `async:false`, Workflow status on run reads, and attempt increments on per-file failures |
| Project/schema/entity metadata | D1 | Done; D1 schema, schema inference/drafts/get/apply/discard/active/reprocess, project/status aliases, domains, file list/register/get/reprocess/delete, ingest job detail, entity find/detail/lineage/relationships with ancestors/children/mentions and relationship display names, sessions, relationships, and status exist; inferred same-type parent/ref relationships and prefixed cross-type relationships persist from singular and array reference fields, resolve exact plus canonicalized identity/display-name aliases, can target entities from earlier ingests, and can be backfilled through `/v1/kb/relationships/backfill`; the real local Postgres export now generates 2,199 D1 rows, applies locally, has been imported into remote D1 with matching counts, and authenticated Worker route smokes read migrated domains/status/entities/parse-artifact metadata |
| Structured/text file ingest and search | R2 + D1 + Vectorize | Done; Worker can infer schemas, manage drafts/apply/discard/active/reprocess, ingest staged JSON/NDJSON/nested JSON/quoted CSV/text, HTML, digital PDF text/table rows, XLSX, DOCX, and PPTX files, supports direct `/v1/kb/ingest/record` virtual JSON input with schema inference for new domains and `/v1/kb/ingest/text` virtual text input, extracts entities/relationships, and searches by domain |
| Source connectors | Workers fetch + R2 + D1 | Done; upload is covered by `/v1/kb/files/upload`, direct records/text are Cloudflare-native, and `/v1/kb/sources/import` supports URL imports plus EDGAR ticker/CIK imports through SEC JSON APIs and primary-document archive fetches without Python `edgartools` |
| Full hybrid retrieval and query answers | Vectorize plus D1 sparse lexical index, app-side fusion, and Workers AI synthesis | Done; explicit `hybrid` mode fuses candidate-prefiltered BM25-style fuzzy sparse lexical and Vectorize results with RRF, lexical paths apply deterministic rewrite/decompose fanout, explicit `semantic` mode corrects weak/empty Vectorize evidence with lexical RRF fallback, applies Worker-native keyword rerank/MMR plus opt-in Workers AI neural rerank, structured queries support exact field filters plus D1 relationship graph evidence, `/v1/kb/query` has extractive answers by default plus opt-in Workers AI cited synthesis, and `/v1/kb/query/stream` preserves the old SSE lifecycle stream contract |
| Eval reports, traces, and metrics | D1, Analytics Engine, Worker/Container observability | Done; D1 traces, eval reports, inline deterministic answer/evidence verification, deterministic faithfulness/support scoring, opt-in Workers AI model-judged AIS-style scoring, D1 rollups, Analytics Engine data points for traces/reports, and a Prometheus-compatible `/metrics` compatibility endpoint exist |
| Python runtime retirement | TypeScript/Rust/WASM Cloudflare Worker plus Node/TypeScript migration tooling | Done; the deployed Worker path, Worker full-port/preflight gates, testing UI, migration tooling, and local checks are TypeScript/Node-only, and the old Python FastAPI server, Python UI, Docker Compose runtime, parser/query/eval package, package metadata, and root pytest suite have been removed |
| Sibling `rag-service` retirement | Delete stale sibling Worker codebase after parity | Done; `../rag-service` was deleted on 2026-06-21 after `readiness:sibling-retirement` passed, `audit:sibling-rag-service --require-retired` reports `retirement_ok: true` / `sibling_exists: false`, and a source-only safety archive is kept at `../rag-service-retired-2026-06-21.tgz` |

## What Cloudflare Cannot Fill As-Is

Cloudflare does not provide native managed Postgres. Hyperdrive can connect
Workers to an existing Postgres/MySQL database, but that would not be
Cloudflare-only. End-to-end Cloudflare means porting the repository schema and
repository layer to D1.

Cloudflare Vectorize is not Qdrant BM42. It can handle dense vector search,
namespaces, and metadata filtering. The Worker replaces Qdrant BM42 with a
Cloudflare-native retrieval stack: Vectorize dense search, bounded D1 LIKE
candidate prefiltering, BM25-style fuzzy sparse lexical scoring over D1 chunks,
app-side RRF fusion, local rerank/MMR, D1 graph expansion, and optional Workers
AI rerank. This is functional retrieval parity, not the exact BM42 model.

Workers cannot directly host the old OCR/parser stack as written. The current
Worker replaces the first parser slice with TypeScript modules for text-like
files, HTML, compressed/digital PDF text plus coordinate-derived table rows,
XLSX ZIP/XML rows, DOCX paragraph text, and PPTX slide text, and uses Workers AI
Markdown Conversion in `auto` mode for scanned or unsupported rich files when
local text is weak. Live deployed evidence on version
`3099934b-54b6-44ef-9f57-994dc1550701` was 18/19 migrated legacy parser cases
passing, with exact OCR parity for an image-only scanned PDF as the one miss.
That gap is now closed: the deployed live scanned-PDF OCR gate
(`readiness:full-port` `nvda-scanned-ocr-live`, `RAG_ALLOW_LIVE_OCR=1`) passed
with pass_rate 1 on the Cloudflare vision model chain. Direct Workers AI
vision OCR is implemented behind opt-in `RAG_VISION_OCR_MODEL`; it can send
standalone JPEG/PNG/WebP uploads and embedded PDF JPEG/JPX images directly,
converts basic Flate RGB/grayscale PDF image streams to PNG before calling
Workers AI, and runs for PDFs whose local text extraction is weak rather than
only for completely textless PDFs. For PDFs, the Worker selects page-like image
candidates before calling Workers AI so tiny logos/decorative assets do not
take the first OCR attempts. The Worker accepts a comma-separated Cloudflare
vision model chain; Llama 3.2 Vision tries
Workers AI native `prompt` + image bytes first and falls back to an `image_url`
message, while Llama 4 Scout uses the `image_url` message shape. Parse evals
can set `vision_ocr_model` globally or per case to test a
model chain without changing Worker secrets; if expected OCR text is still
missing after the first model returns text, the eval route retries the remaining
configured models before failing. When both explicit vision OCR and Markdown
Conversion return text, the Worker stores a merged
`workers-ai-vision-markdown-ocr-v1` artifact.
Vision is not a default because LLaVA took about 71.8 s on the sample and still
missed the paragraphs. The packaged NVDA eval now tries Llama 3.2 Vision first,
then Llama 4 Scout. Durable state belongs in R2, D1, and Vectorize.

The old Python EDGAR source connector depended on `edgartools`, which is not a
Cloudflare-native runtime dependency. The Worker now replaces it with SEC HTTP
API fetches: ticker/CIK lookup through SEC JSON, submissions metadata through
`data.sec.gov`, and primary filing document fetches from the EDGAR archive.
Set `config.user_agent` per import or `RAG_SEC_USER_AGENT` on the Worker for SEC
fair-access identification.

## Required Migration Order

1. Keep `cloudflare/worker` as the canonical fleet `RAG_SERVICE`; delete stale
   sibling-service references and bindings. SaaS Maker has no active in-API
   RAG/knowledge backend; Linkchat and Starboard now point at the
   `knowledgebase` Worker for shared RAG. Linkchat no longer falls back to
   legacy SaaS Maker RAG for profile-memory create/ingest/delete/search.
   Starboard relevance search now uses `knowledgebase` RAG or lexical-only
   results; its local Turso vector table is retained only for non-RAG app
   features such as similar repos, discover, and recommendations.
2. Keep R2 as the production object-store target for raw files and parse
   artifacts; the legacy raw/parse objects are now present in R2.
3. Done: repository-method parity is covered by current `/v1/kb/*` routes and
   compatibility aliases; keep `gaps:full-port` as the regression gate.
4. Done: Postgres job locking was replaced with Queues/Workflows and D1 job
   records.
5. Scanned-PDF OCR path: resolved on the Cloudflare vision model chain. The
   deployed live gate (`readiness:full-port` `nvda-scanned-ocr-live`,
   `RAG_ALLOW_LIVE_OCR=1`) passed with pass_rate 1, so no extra non-default OCR
   dependency was needed.
6. Done for the current embedding-model release: `pnpm deploy` shipped Worker
   version `a5ae4310-9091-42c8-8d22-5c26d7d09312`, the release-status and
   readiness gates confirmed fingerprint
   `knowledgebase-cloudflare-embedding-models-2026-06-21`, D1 schema readiness,
   live free-ai catalog routing, Vectorize dimension/metadata readiness, and
   `RAG_ALLOW_LIVE_OCR=1 RAG_SERVICE_KEY=<service-key> pnpm run
   readiness:full-port` proved deployed aliases, hosted testing UI, auth, and
   live OCR on the same release.
7. Done: the sibling `rag-service` folder was retired on 2026-06-21.
   `RAG_ALLOW_LIVE_OCR=1 RAG_SERVICE_KEY=<service-key> pnpm run
   readiness:sibling-retirement` passed (read-only), `../rag-service` was deleted
   (source-only archive at `../rag-service-retired-2026-06-21.tgz`), and
   `audit:sibling-rag-service --require-retired` now reports `retirement_ok: true`.
   The `sibling_rag_service_retirement` gap and the full-port gap matrix are now
   closed: `gaps:full-port` reports 0 remaining.

Run the repo-native inventory at any time:

```bash
cd cloudflare/worker && pnpm run preflight
cd cloudflare/worker && pnpm run audit:legacy-route-parity
cd cloudflare/worker && pnpm run audit:python-runtime-retirement -- --require-complete
cd cloudflare/worker && pnpm run smoke:local-cutover
cd cloudflare/worker && pnpm run predeploy:local
cd cloudflare/worker && pnpm run audit:sibling-rag-service -- --json --require-retired
cd cloudflare/worker && RAG_SERVICE_KEY=<service-key> pnpm run release-status:embedding-model -- --json --check-vectorize-metadata-indexes --check-knowledgebase-embedding-models
cd cloudflare/worker && RAG_SERVICE_KEY=<service-key> pnpm run readiness:embedding-model
cd cloudflare/worker && RAG_SERVICE_KEY=<service-key> pnpm run smoke:rag-crud:embedding-model
cd cloudflare/worker && pnpm run build:consumer-cloudflare -- --json
cd cloudflare/worker && pnpm run gaps:full-port
```

The `release-status:embedding-model` JSON includes `release_plan_steps` on each
failed check, a de-duplicated `blocker_steps` list, and `blocker_commands` with
the exact command plus mutating/approval/env metadata. Use those fields to map
live Cloudflare blockers back to the ordered `release-plan:embedding-model`
steps without re-deriving the rollout commands.

The executable gap matrix lives in `cloudflare/full-port-gaps.json` and is read
by the Worker-local Node gate. `audit:sibling-rag-service` reports the current
sibling-retirement state, which discovered fleet sibling repos were scanned, and
whether any of them still contain active references to the old `rag-service`
Worker. It should now report `retirement_ok: true` and `sibling_exists: false`.
`audit:python-runtime-retirement` fails if the old
FastAPI package, Python UI, Docker runtime, package metadata, root pytest suite,
or Python helper scripts reappear. Use the Worker-local Node `preflight` command
for release readiness; it verifies Cloudflare bindings, local Worker config,
retired FastAPI route-alias parity, and Python runtime retirement without
requiring Python tooling.
`smoke:local-cutover` boots `wrangler dev --local` on an ephemeral localhost
port and runs the same legacy alias plus deploy-fingerprint smoke used after
deployment, so route compatibility is proven through the local Worker runtime
before publishing. The smoke only exercises health/readiness/metrics and
anonymous auth-boundary aliases; it does not run embedding, OCR, or answer
generation.
`predeploy:local` wraps the local release gate for the Worker code: typecheck
and tests, binding preflight, Python runtime retirement, the no-external-
`rag-service` reference guard, consumer RAG integration audit, Linkchat/Starboard
Cloudflare bundle builds, local `../free-ai` embedding catalog contract audit,
upstream free-ai cost/type/test check, Vectorize embedding binding selectability
audit, the full-port gap matrix, the no-network NVDA scanned-PDF OCR eval
payload dry-run, the read-only embedding-model release plan, local cutover
smoke, and Wrangler deploy dry-run.
`readiness:sibling-retirement` was the final read-only pre-delete gate for the
old sibling Worker codebase. It proved deployed auth/OCR/aliases/fingerprint,
local preflight, external-reference cleanup, and the full-port gap matrix before
the `../rag-service` removal. After retirement, use
`audit:sibling-rag-service -- --json` plus `gaps:full-port -- --json` to prove
the sibling remains gone and the gap matrix stays complete.

Current Cloudflare implementation:

- `cloudflare/worker/migrations/0003_knowledgebase_metadata.sql` creates the
  full-product `kb_*` tables alongside the lightweight RAG API tables.
- `cloudflare/worker/src/kb-metadata-repository.ts` provides Worker repository
  methods over project/domain/schema/file/entity/relationship/session/trace/eval
  tables.
- `/v1/kb/projects`, `/v1/kb/projects/:project/status`, `/v1/kb/domains`,
  `/v1/kb/files` list/register/get/reprocess/delete, `/v1/kb/ingest/jobs/:job_id`,
  and `/v1/kb/status` are authenticated, tenant-scoped routes for product-state parity.
- Retired FastAPI route prefixes are preserved as authenticated compatibility
  aliases that forward into the same Worker handlers: `/projects`, `/domains`,
  `/schemas`, `/files`, `/sources`, `/entities`, `/ingest/*`, `/search`,
  `/agent/search`, `/search/eval`, `/query`, `/query/stream`,
  `/query/traces`, and `/query/trace/:id`. `readiness:full-port` smoke-checks
  those deployed aliases by verifying public meta aliases and anonymous
  rejection on protected legacy aliases, then verifies the deployed `/` and
  `/ui` hosted testing surface contains the embedding-model selector and
  custom-input `/v1/kb/*` controls.
- `/` and `/ui` serve the Cloudflare-hosted testing surface, and
  `/v1/kb/files/upload` accepts multipart files, writes raw bytes to R2, and
  registers the file in D1.
- `/v1/embedding-models` exposes configured Vectorize dimensions plus the live
  `free-ai` embedding catalog. The hosted UI only offers explicit embedding
  choices when that endpoint reports `catalog_source: "free_ai"` and the model
  row has `selectable: true`, meaning it is enabled with a compatible Vectorize
  binding.
- `/v1/kb/schemas/infer`, `/v1/kb/schemas/infer-upload`,
  `/v1/kb/schemas/drafts`, `/v1/kb/schemas/drafts/:draft_id`, and
  `/v1/kb/schemas/:domain/active` provide TypeScript schema inference, R2
  upload-to-infer, draft persistence/get/apply/discard, active schema lookup,
  and domain reprocess.
- `/v1/kb/entities/find`, `/v1/kb/entities/:entity_id`,
  `/v1/kb/entities/:entity_id/lineage`, and
  `/v1/kb/entities/:entity_id/relationships` expose D1 entity identity lookup,
  lineage ancestors/children/mentions, and graph browsing aliases.
- `/v1/kb/ingest/record` and `/v1/kb/ingest/text` port the custom direct-input
  routes: records become R2 JSON artifacts plus immediate Vectorize/D1 structured
  state, with schema inference/activation when the structured domain has no
  active schema; text becomes an R2 text artifact and indexes inline by default,
  without requiring an active schema, with `async: true` available for queued
  parser staging.
- `/v1/kb/sources` and `/v1/kb/sources/import` expose Cloudflare-native source
  imports for URLs and EDGAR SEC filings, with hosted UI controls for both
  source types. EDGAR supports `tickers`, `ciks`, `forms`, `days`,
  `per_ticker_per_form`, `limit_total`, and `user_agent` config fields and
  writes fetched primary documents to R2/D1 queued ingest.
- `/v1/kb/evals/search` ports the retrieval eval loop for hit rate, MRR, and
  latency scoring on the live Worker query path.
- `/v1/kb/schemas/infer-upload`, `/v1/kb/ingest/run`, and
  `/v1/kb/evals/parse` accept parser options at request time. The hosted
  testing UI exposes Markdown Conversion, vision-model, and text-preview
  controls so Cloudflare conversion/OCR behavior can be tested against uploaded
  files or scanned fixtures without changing Worker environment variables.
- `/v1/kb/evals/query` runs answer/citation evals over the same `/v1/kb/query`
  implementation and reports hit rate, citation rate, deterministic
  faithfulness/support coverage, unsupported answer tokens, AI use rate, and
  latency. Send `ai_judge: true` to add opt-in Workers AI model-judged
  AIS-style support scores; this is off by default to avoid surprise AI usage.
- `/v1/kb/evals/search` and `/v1/kb/evals/query` persist reports to D1;
  `/v1/kb/evals/reports`, `/v1/kb/evals/reports/:id`, and
  `/v1/kb/evals/summary` expose report history and D1-backed rollups. The
  Worker also writes compact `RAG_ANALYTICS` Analytics Engine data points for
  successful query traces and eval reports.
- `/v1/kb/ingest/run` and `/v1/kb/search` complete the first Cloudflare-native
  loop from arbitrary structured/text/HTML/digital-PDF-table/XLSX upload to
  domain-level search. Upload schema inference and queued ingest now keep the
  fast local parser path, then fall back to Workers AI Markdown Conversion for
  scanned PDFs, images, legacy Excel/ODF/Numbers, and weak local text.
  `RAG_VISION_OCR_MODEL` can add explicit OCR for standalone JPEG/PNG/WebP
  uploads and weak/image-only PDFs. Set `RAG_MARKDOWN_CONVERSION=always` to
  force conversion for complex PDFs or `off` to disable Markdown Conversion;
  `markdown_conversion` and `vision_ocr_model` can also be supplied per ingest
  run and are preserved through Queue/Workflow dispatch.
- `/v1/kb/evals/parse` runs parser-quality eval cases against inline text or
  base64 fixture bytes, checks expected text/parser/min-length assertions,
  records parser counts and latency, persists a D1 eval report with
  `kind="parse"`, and is exposed from the hosted testing UI's eval panel.
- `scripts/legacy-parse-eval.mjs` converts the migrated D1 JSON export plus
  mirrored raw/parse object roots into deployed parse eval requests. Current
  deployed run: 19 cases, 18 passed, 3 skipped because no legacy parse artifact
  existed for those JSON record files. The only failed case is the image-only
  scanned PDF OCR exact-text gap described above. Rerun the scanned OCR path
  with a Cloudflare vision model chain:

  ```bash
  node cloudflare/worker/scripts/legacy-parse-eval.mjs \
    --export <legacy-d1-export.json> \
    --raw-root <raw-export-root> \
    --parse-root <parse-export-root> \
    --base-url <worker-url> \
    --key <service-key> \
    --domain sec \
    --filename-contains NVDA_riskfactors_sample_scanned.pdf \
    --vision-ocr-model @cf/meta/llama-3.2-11b-vision-instruct,@cf/meta/llama-4-scout-17b-16e-instruct \
    --require-cases \
    --min-pass-rate 1 \
    --include-text-preview
  ```

  If only the local MinIO mirror is available, the harness can build the same
  one-file case directly from inline `xl.meta` objects without a D1 export:

  ```bash
  node cloudflare/worker/scripts/legacy-parse-eval.mjs \
    --raw-root data/minio/kb-bucket \
    --parse-root data/minio/kb-bucket \
    --direct-domain sec \
    --direct-content-hash a56062aa2ee3c2eb6e1128e440e4ab683641e2ef4ccfa7e955538676a02c4c39 \
    --direct-filename NVDA_riskfactors_sample_scanned.pdf \
    --direct-mime application/pdf \
    --base-url <worker-url> \
    --key <service-key> \
    --vision-ocr-model @cf/meta/llama-3.2-11b-vision-instruct,@cf/meta/llama-4-scout-17b-16e-instruct \
    --require-cases \
    --min-pass-rate 1 \
    --include-text-preview
  ```

  The Worker package also exposes the one-case proof as scripts:

  ```bash
  cd cloudflare/worker
  pnpm run eval:parse:nvda-scanned:dry-run
  RAG_SERVICE_KEY=<service-key> pnpm run eval:parse:nvda-scanned:live
  RAG_ALLOW_LIVE_OCR=1 RAG_SERVICE_KEY=<service-key> pnpm run readiness:full-port
  ```

  The packaged OCR gate tries Llama 3.2 Vision first, then Llama 4 Scout.
  Cloudflare requires the account to accept the Meta license once for
  `@cf/meta/llama-3.2-11b-vision-instruct` by sending `{ "prompt": "agree" }`
  to the Workers AI REST endpoint with account credentials. Use
  `pnpm run workers-ai:accept-llama32-vision-license -- --dry-run` to preview
  the request, then run `pnpm run workers-ai:accept-llama32-vision-license`
  with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_AUTH_TOKEN` in the shell. Keep
  those credentials out of tracked files.

  The dry-run uses no network or AI calls and prints the chosen Cloudflare
  vision model chain, deployed base URL, `--require-cases`, and
  `--min-pass-rate 1` gate before the live command is run. `readiness:full-port`
  intentionally fails while the deployed Worker still reports an old
  fingerprint, deployed legacy route aliases are not smoke-clean, the sibling
  `rag-service` retirement audit finds deployable surfaces or active
  references, or the Worker-local Node full-port gate still reports blockers.
  The historical live scanned-PDF OCR proof has already passed; rerun it only
  when the vision model chain or parser fallback changes.
- `/v1/kb/source-sets` and `/v1/kb/source-sets/:id/actions` expose domain-backed
  source-set summaries, dry-run bulk actions, requeue/archive controls, and
  Vectorize/R2/D1 cleanup for delete actions.
- Upload and ingest routes now create D1 ingest job rows; `/v1/kb/jobs` exposes
  job state. `/v1/kb/ingest/run` defaults to the `KbIngestWorkflow` Workflow
  binding, which durably validates the run and enqueues the Cloudflare Queue
  `knowledgebase-ingest`; direct Queue dispatch remains the fallback when the
  Workflow binding is absent. `async:false` is the explicit inline/debug
  override. Queued and inline runs carry durable `run_id` values through
  Workflow instances, Queue messages, and D1 `workflow_id` fields;
  `/v1/kb/ingest/runs/:run_id` exposes run-level progress, Workflow status, and
  completion summaries for the hosted UI; failed per-file jobs increment
  attempts. Ingest writes normalized parse artifacts to R2 and registers them in D1;
  `/v1/kb/parse-artifacts/:hash` exposes artifact metadata.
- Schema inference now extracts records from nested arbitrary JSON wrappers,
  handles quoted CSV fields, strips HTML, extracts digital PDF text plus
  coordinate-derived table rows, and reads XLSX row data, DOCX paragraph text,
  and PPTX slide text without leaving the Worker runtime; for scanned or
  unsupported rich inputs it can infer from Cloudflare-converted markdown.
- Schema inference emits parent/ref relationship declarations from structured
  fields such as `parent_id`, `owner_id`, and `related_ids`, plus prefixed
  cross-type entities such as `customer_id/customer_name`. `/v1/kb/ingest/run`
  uses active inferred schemas to extract structured entities, mentions,
  relationship edges, provenance spans, and chunk/entity links into D1; edges can
  resolve targets already present from earlier ingests by exact identity or
  canonicalized identity/display-name aliases.
  `/v1/kb/relationships/backfill` rebuilds graph edges for historical D1
  entities from active schemas. `/v1/kb/entities` and `/v1/kb/relationships`
  expose the stored graph view.
- `/v1/kb/entities/search` provides a zero-AI D1 fast path for exact structured
  lookups over identity, display name, and stored JSON fields. `/v1/kb/query`
  plans explicit field filters such as `counterparty: Acme` against stored D1
  entity JSON and expands matching D1 entities with stored D1 relationship edges
  as graph evidence before citation/trace persistence.
- `/v1/kb/search`, `/v1/indexes/:id/query`, and `/v1/kb/query` support
  explicit `hybrid` mode, which fuses BM25-style D1 sparse lexical and Vectorize
  results with RRF and applies local keyword rerank/MMR while preserving the
  faster exact lexical `auto` path. Set `rerank_model: "workers_ai"` to run Cloudflare's
  `@cf/baai/bge-reranker-base` neural reranker over the bounded candidate set.
  `rerank: false` and `mmr: false` are supported for benchmarks.
- `/v1/kb/query` defaults to zero-extra-AI extractive cited answers for speed.
  `/v1/kb/query/stream` reuses that same answer path and emits SSE `started`,
  `stage`, and final `answer` or `error` events for clients that need the
  retired FastAPI stream contract.
  Set `answer_mode: "workers_ai"` to run Cloudflare Workers AI answer synthesis
  over bounded cited evidence. The Worker uses `answer_model`, then
  `RAG_ANSWER_MODEL`, then `@cf/meta/llama-3.1-8b-instruct`; empty, uncited, or
  failed synthesis falls back to the deterministic extractive answer.
- Lexical paths now run deterministic query rewrite/decompose fanout for
  multi-part questions inside the Worker. The planner strips common question
  framing, splits obvious `and`/`or`/`versus` clauses, fuses results with
  query-plan metadata, and can be disabled with `query_rewrite: false` or
  `query_decompose: false` for before/after benchmarks.
- Explicit `semantic` queries now run a corrective retrieval step when Vectorize
  evidence is empty or below the conservative score threshold: the Worker fetches
  D1 lexical candidates, fuses them with semantic evidence via RRF, and applies
  the same local rerank/MMR without making a second Workers AI call.
- `/v1/kb/query`, `/v1/kb/query/traces`, and `/v1/kb/query/trace/:id` add
  cited answers and D1-backed query trace inspection. `/v1/kb/query/traces/export`,
  `/v1/kb/query/traces/compare`, and `/v1/kb/query/trace/:id/drilldown` provide
  Cloudflare-hosted trace export, deterministic trace comparison, and zero-AI
  answer-quality support checks for eval/debug loops. `/v1/kb/query` applies
  deterministic question-token span selection to citations, can synthesize
  richer cited answers with Workers AI, and attaches
  deterministic answer/evidence verification to response confidence and D1
  traces, and tries the zero-AI D1 entity route before falling back to
  Vectorize/Workers AI.
- `/v1/kb/sessions`, `/v1/kb/sessions/:id`, and
  `/v1/kb/sessions/:id/messages` expose D1-backed query sessions; `/v1/kb/query`
  appends bounded user/assistant history whenever a `session_id` is supplied.
- `cloudflare/worker/scripts/migrate-raw-files.mjs` migrates local directories
  or manifest exports into `/v1/kb/files/upload` or
  `/v1/kb/schemas/infer-upload`, can apply the latest inferred schema per
  domain, and can queue `/v1/kb/ingest/run` after upload. Object-root mode reads
  mirrored MinIO/S3 exports shaped as `<domain>/<content_hash>/<filename>` and
  rejects direct MinIO disk/erasure layouts containing `xl.meta` so migration
  plans cannot silently undercount objects. Dry-runs emit per-file SHA-256
  plans, and live uploads fail on returned hash mismatches when the Worker
  response includes a content hash. The local legacy MinIO mirror at
  `/tmp/kb-raw-export/raw` accounts for 48 files / 20,395,043 bytes across
  `legal`, `notes`, `personal_notes`, `sec`, and `stack-notes`; pointing
  `--object-root` at `data/minio/kb-bucket/raw` now fails with a mirror-first
  error. Those raw files were uploaded to R2 under both the legacy
  `raw/<domain>/<hash>/<filename>` keys used by imported D1 rows and the current
  Worker `raw/<domain>/<hash>` keys. The legacy parse prefix mirror accounts
  for 34 `parse/<hash>/elements.json` artifacts. Remote R2 verification fetched
  and hash-checked all D1-referenced raw files (22) and parse artifacts (28).
  Dry-run checked-in fixtures with `pnpm run migrate:raw:dry-run` or
  `pnpm run migrate:raw:objects:dry-run`.
- `cloudflare/worker/scripts/migrate-d1-metadata.mjs` converts a JSON export of
  the legacy Postgres product-state tables into idempotent SQL for the `kb_*`
  D1 tables. It normalizes UUID/JSONB/array fields to D1 text/JSON columns,
  derives missing legacy mention/provenance domains from referenced
  file/entity/schema rows, orders self-referenced entities/chunks before their
  children, inserts in foreign-key order, emits per-table counts plus a
  normalized SHA-256 checksum, dedupes by each D1 conflict key, supports
  `--no-transaction` for remote D1 imports, and warns on missing references
  before any remote D1 write. The real local Postgres export validates to 2,199
  D1 rows, applies cleanly to a disposable D1-shaped SQLite database, and has
  been imported into remote D1 with matching counts: 9 projects, 9 domains, 22
  schemas, 22 files, 51 entities, 70 entity mentions, 7 relationships, 106
  provenance spans, 19 ingest jobs, 944 sessions, and 910 query traces. Generate
  the source export query with
  `pnpm run migrate:d1:export-sql`, dry-run it with
  `pnpm run migrate:d1:dry-run`, and apply the generated SQL explicitly with
  `wrangler d1 execute rag-db --remote --file d1-metadata.remote.sql` after
  generating with `--no-transaction` and comparing counts/checksums against the
  source export.
- `RAG_SERVICE_KEYS_APPEND` is supported as a non-disruptive append-only key map
  for temporary verification/cutover keys. It was used to run authenticated
  deployed readiness plus product-state route smokes without overwriting the
  primary fleet `RAG_SERVICE_KEYS` map. The 2026-06-21 cutover minted a fresh
  ephemeral key into this slot to run `readiness:full-port` (deployed auth, live
  OCR) and `readiness:sibling-retirement`, then deleted the
  `RAG_SERVICE_KEYS_APPEND` secret once the gates passed, leaving only the primary
  `RAG_SERVICE_KEYS` map active. Re-mint a temporary append key for future
  authenticated readiness runs and revoke it afterward.
