# Knowledgebase Cloudflare Worker

Cloudflare-native Knowledgebase RAG Worker for fleet projects.

This Worker is the Cloudflare-native shared RAG surface owned by `knowledgebase`: Hono, free-ai/Workers AI embeddings, Vectorize search, D1 for chunk text and metadata, and optional R2 for raw document blobs.

## Local Checks

```bash
pnpm install
pnpm check
pnpm run backfill:dry-run
pnpm run benchmark:dry-run
pnpm run migrate:raw:dry-run
pnpm run migrate:raw:objects:dry-run
pnpm run predeploy:local
pnpm run readiness
pnpm run smoke:export:dry-run
pnpm run smoke:local-cutover
pnpm run audit:legacy-route-parity
pnpm run audit:python-runtime-retirement -- --require-complete
```

## Cloudflare Resources

Create these before a real deploy:

```bash
wrangler vectorize create rag-gemini-1536 --dimensions=1536 --metric=cosine
wrangler vectorize create-metadata-index rag-gemini-1536 --propertyName=tenant --type=string
wrangler vectorize create-metadata-index rag-gemini-1536 --propertyName=index_id --type=string
wrangler d1 create rag-db
wrangler d1 migrations apply rag-db
wrangler r2 bucket create rag-raw-docs
wrangler secret put RAG_SERVICE_KEYS
# Optional, non-disruptive extra key map for temporary verification/cutover keys:
wrangler secret put RAG_SERVICE_KEYS_APPEND
```

`RAG_ANALYTICS` is configured in `wrangler.jsonc`; Analytics Engine creates
the `knowledgebase_rag_events` dataset on first write.

`RAG_SERVICE_KEYS` is a JSON object mapping service keys to tenant names:

```json
{
  "replace-with-random-key": "saas-maker"
}
```

`RAG_SERVICE_KEYS_APPEND` has the same shape and is merged after
`RAG_SERVICE_KEYS`. Use it for temporary verification/cutover keys when you
must avoid overwriting the primary fleet key map.

Do not commit real keys.

Fleet-level verification lives in SaaS Maker:

```bash
cd ../../../saas-maker
pnpm fleet:secret-audit -- --project knowledgebase --fail-on-missing
```

After the secret is set, run the standalone deployed-readiness smoke:

```bash
RAG_SERVICE_KEY=<service-key> pnpm run readiness:auth
```

Without a service key, `pnpm run readiness` still verifies that the deployed
health endpoint is live, D1 reports the required schema migrations through
`d1_schema: true`, Vectorize and R2 are bound, and protected `/v1/*` routes
reject anonymous access.
`pnpm run readiness:full-port` also checks deployed retired FastAPI aliases:
public `/healthz`/`/readyz`/`/metrics` must work and protected legacy aliases
such as `/search`, `/query`, and `/domains` must reject anonymous access. It
also verifies the deployed `/` and `/ui` hosted testing surface contains the
embedding-model selector and custom-input `/v1/kb/*` controls.
Run `pnpm run predeploy:local` before the real deploy. It runs Worker
tests/typecheck, binding and D1 migration preflight, Python runtime retirement audit, the
no-external-`rag-service` reference guard, the Linkchat/Starboard consumer
knowledgebase RAG integration audit, local Linkchat/Starboard Cloudflare bundle
builds, the local `../../../free-ai` embedding catalog and cost-audited
Cloudflare deploy-script audit, the upstream free-ai cost/type/test check, the
Vectorize embedding binding selectability audit, the
full-port gap matrix, the no-network NVDA scanned-PDF OCR eval payload dry-run,
the read-only embedding-model release plan, local cutover smoke, and Wrangler
deploy dry-run as a single gate. Run
`pnpm run deploy:dry-run` and
`pnpm run audit:python-runtime-retirement -- --require-complete` before the real
deploy. `pnpm run smoke:local-cutover` starts `wrangler dev --local` on an
ephemeral port and proves the same root aliases plus deploy fingerprint against
the locally bundled Worker. It only hits health/readiness/metrics and anonymous
auth-boundary routes; it does not run an embedding, OCR, or answer-generation
path. The local smoke sets `RAG_ALLOW_UNMIGRATED_LOCAL_D1=true` because
`wrangler dev --local` may start with an empty local D1; deployed readiness still
requires `d1_schema: true`. The selected embedding-model path is live in the
current release: deployed `free-ai` `/v1/models` returns enabled embedding rows
with dimensions, aliases, custom-dimension support, priority, and availability;
static fallback is not accepted as proof. The selected model must also report
`selectable: true` plus a compatible Vectorize binding from
`/v1/embedding-models`; otherwise the readiness gate and mutating CRUD smoke
fail before treating the model as deployable. Before future approved live
embedding/catalog actions, print the ordered checklist with `pnpm run
release-plan:embedding-model -- --json`; it is read-only, marks mutating steps,
and includes `cd ../../../free-ai && pnpm run check` before free-ai deploys so
the upstream cost audit/typecheck/tests are current. The JSON also prints
`configured_vectorize_metadata_index_commands` for the currently configured
Vectorize indexes. `RAG_SERVICE_KEY=<service-key> pnpm run
release-status:embedding-model -- --json --check-vectorize-metadata-indexes
--check-knowledgebase-embedding-models` is the full read-only live status gate
for the same release; with `RAG_SERVICE_KEY` it also proves deployed
`/v1/embedding-models` is backed by live free-ai rows whose selected model is
explicitly `selectable: true` with a compatible Vectorize binding, valid
provider, and positive numeric dimensions. It separately
checks configured Vectorize metadata indexes, the selected deployed model's
Vectorize binding/index detail, and every enabled embedding dimension advertised
by the deployed `free-ai` catalog; enabled free-ai embedding rows must include a
valid provider and positive numeric dimensions. The current deployed release is
green for every dimension advertised by deployed `free-ai`. The JSON report
includes `release_plan_steps` on each failed check, a de-duplicated
top-level `blocker_steps` list, and `blocker_commands` entries with command,
mutating, approval, optional, and required-env metadata so live blockers map
directly back to the ordered release plan. If the knowledgebase catalog check is
skipped because `RAG_SERVICE_KEY` is missing, it maps only to the read-only
`live-release-status` invocation step. When Vectorize metadata indexes are
missing, `blocker_commands` expands to the exact
`create-metadata-index` commands reported by the audit plus the follow-up
readiness audit. After future Vectorize provisioning/config updates, run
`pnpm run audit:vectorize-metadata-indexes -- --json --require-complete` to
verify each configured remote index has the `tenant` and `index_id` string
metadata indexes required by query filters. If it reports blockers, apply only
the `remediation_commands` from the audit output after explicit provisioning
approval, then rerun the audit with `--require-complete`; the release-plan
command candidates are for review, not a blanket instruction to create indexes
that already exist. After future D1 migrations and deploys, first run the
read-only catalog gate:

```bash
RAG_SERVICE_KEY=<service-key> pnpm run readiness:embedding-model
```

Then run `RAG_SERVICE_KEY=<service-key> RAG_BASE_URL=<worker-url> pnpm run
smoke:rag-crud:embedding-model` to prove the live RAG create/ingest/query/delete
path, the `/v1/kb/ingest/text` custom-input domain path, `/v1/kb/search`, and
free-ai embedding-model selection. When the requested model is an alias, the
smoke expects both `POST /v1/indexes` and the temporary KB domain to persist the
canonical free-ai model id, provider, and dimensions from `/v1/embedding-models`.
The smoke first checks authenticated `/v1/healthz` and requires
`d1_schema: true`, Vectorize, R2 readiness, and the expected
`deploy_fingerprint` before creating the temporary index; it still mutates and
spends embedding calls after that gate, so it is intentionally not part of
`predeploy:local`. The release plan keeps consumer proof split into targeted
re-runs and live proof: local source audit (`audit:consumer-rag-integrations`)
and local Cloudflare consumer builds (`build:consumer-cloudflare`, which runs
`../../../karte` `cf:build` and `../../../starboard` `build:cf`) are already
included in `predeploy:local` and can be rerun directly after consumer-only
changes; approved consumer deploys (`../../../karte` and `../../../starboard`
`deploy:cf`) and manual deployed consumer smoke for karte profile memory plus
Starboard sync/search remain separate live steps. The local
consumer audit proves karte's profile-memory create/ingest/delete/search client
contract including document content/metadata and query/top_k payloads, plus
Starboard's user-scoped semantic search and ingest content/metadata contract,
rejects the old `src/lib/rag-service.ts` client filename in both consumers, and
verifies both checked-out consumer repos expose Cloudflare-backed `deploy:cf`
scripts that run the repo's Cloudflare build pipeline before deploy. The local
consumer builds prove those build pipelines bundle successfully; they still do
not deploy or prove live consumer bindings. Then run
full-port readiness after deploying the current
`cloudflare/worker` code; a 404 on these aliases means the deployed Worker is
behind local route parity.
For a focused alias check, run
`pnpm run smoke:legacy-routes -- --base-url <worker-url> --require-complete`.
The `/healthz` row should include
`deploy_fingerprint=knowledgebase-cloudflare-embedding-models-2026-06-21` and
`d1_schema: true` after the current Cloudflare port and D1 migrations are
deployed. The smoke and full-port readiness gates
enforce that fingerprint by default; pass
`--expected-deploy-fingerprint <value>` only when intentionally deploying a
custom `RAG_DEPLOY_FINGERPRINT`.
The sibling `../rag-service` repo is already retired. Use
`pnpm run audit:sibling-rag-service -- --json --require-retired` to prove it
stays gone, and keep all fleet RAG runtime in this Worker package.
For a narrower read-only proof that fleet repos no longer actively point at the
old sibling service, run
`pnpm run audit:no-external-rag-service-references -- --json`. As of the
2026-06-21 retirement, `../rag-service` has been deleted and
`pnpm run audit:sibling-rag-service -- --json --require-retired` reports
`ok: true`, `retirement_ok: true`, and `sibling_exists: false`. This
guard scans fleet repos for old `rag-service` Worker bindings and URLs across
JSON/JSONC, JS/TS, TOML, YAML, and env-style `RAG_*` config references.
The sibling-retirement readiness gate also checks that the filesystem audit and
`../full-port-gaps.json` agree: the `sibling_rag_service_retirement` gap must
remain open while `../rag-service` exists, and must be closed after the folder is
removed.

## API

All `/v1/*` routes and retired FastAPI compatibility aliases require
`Authorization: Bearer <service-key>` or `X-RAG-Key: <service-key>`, except the
public health/readiness/metrics probes.

- `GET /v1/healthz`
- `GET /readyz`
- `GET /metrics`
- `POST /v1/indexes`
- `GET /v1/indexes`
- `DELETE /v1/indexes/:id`
- `POST /v1/indexes/:id/ingest`
- `POST /v1/indexes/:id/ingest-vectors`
- `GET /v1/indexes/:id/documents`
- `DELETE /v1/documents/:id`
- `POST /v1/indexes/:id/query`
- `POST /v1/indexes/:id/query-vector`
- `GET /v1/kb/projects`
- `POST /v1/kb/projects`
- `GET /v1/kb/projects/:project/status`
- `GET /v1/kb/domains`
- `POST /v1/kb/domains`
- `GET /v1/kb/files`
- `POST /v1/kb/files`
- `GET /v1/kb/files/:file_id`
- `POST /v1/kb/files/:file_id/reprocess`
- `DELETE /v1/kb/files/:file_id`
- `POST /v1/kb/files/upload`
- `GET /v1/kb/sources`
- `POST /v1/kb/sources/import`
- `GET /v1/kb/source-sets`
- `POST /v1/kb/source-sets/:id/actions`
- `GET /v1/kb/status`
- `GET /v1/kb/jobs`
- `GET /v1/kb/ingest/jobs/:job_id`
- `GET /v1/kb/schemas`
- `POST /v1/kb/schemas`
- `GET /v1/kb/schemas/:domain/active`
- `POST /v1/kb/schemas/:domain/reprocess`
- `POST /v1/kb/schemas/infer`
- `POST /v1/kb/schemas/infer-upload`
- `GET /v1/kb/schemas/drafts`
- `GET /v1/kb/schemas/drafts/:draft_id`
- `POST /v1/kb/schemas/drafts/:draft_id/apply`
- `POST /v1/kb/schemas/drafts/:draft_id/discard`
- `POST /v1/kb/ingest/run`
- `POST /v1/kb/ingest/record`
- `POST /v1/kb/ingest/text`
- `GET /v1/kb/ingest/runs/:run_id`
- `GET /v1/kb/entities/find`
- `GET /v1/kb/entities/:entity_id`
- `GET /v1/kb/entities/:entity_id/lineage`
- `GET /v1/kb/entities/:entity_id/relationships`
- `POST /v1/kb/search`
- `POST /v1/kb/query`
- `POST /v1/kb/query/stream`
- `GET /v1/kb/query/traces`
- `GET /v1/kb/query/traces/export`
- `POST /v1/kb/query/traces/compare`
- `GET /v1/kb/query/trace/:id`
- `GET /v1/kb/query/trace/:id/drilldown`
- `POST /v1/kb/evals/search`
- `POST /v1/kb/evals/query`
- `GET /v1/kb/evals/reports`
- `GET /v1/kb/evals/reports/:id`
- `GET /v1/kb/evals/summary`

Direct vector ingestion/query endpoints validate caller-supplied embeddings
against the index/profile dimensions before they reach Vectorize.

The retired FastAPI surface is preserved as Worker-side aliases that forward to
the Cloudflare-native handlers: `/search`, `/agent/search`, `/search/eval`,
`/query`, `/query/stream`, `/query/traces`, `/query/trace/:id`, `/projects`,
`/domains`, `/schemas`, `/files`, `/sources`, `/entities`, and `/ingest/*`.
`pnpm run audit:legacy-route-parity` is the Node-only release gate for this
inventory. `pnpm run preflight` runs it automatically and also fails if retired
Python runtime surfaces such as `src/kb`, `pyproject.toml`, or the root pytest
suite reappear.

The default deployed path chunks raw document text, embeds through `free-ai` with
`gemini-embedding-001` at 1536 dimensions, upserts vectors to the
`rag-gemini-1536` Vectorize index, stores hydrated chunk text in D1, and queries
Vectorize with server-enforced `tenant + index_id` metadata filters. Use
`GET /v1/embedding-models` to see the configured Vectorize dimension profiles
and the live free-ai embedding catalog when the `FREE_AI` binding or base URL is
reachable. `POST /v1/indexes` accepts `embedding_profile: "base" | "small"` or
an explicit `embedding_model` from free-ai when `RAG_EMBED_PROVIDER=free_ai`;
explicit model selection fails closed under Workers AI fallback. With
`RAG_EMBED_PROVIDER=free_ai`, default profile creation also validates that the
configured default model is present and enabled in the live free-ai catalog
before creating an index. `/v1/kb/domains` and first-touch custom input routes
accept an explicit `embedding_model` from the live free-ai catalog, persist the
canonical model/provider on the domain, and the hosted testing UI sends that
selected model with domain save, upload, infer-upload, schema inference, source
import, direct record/text ingest, and queued/inline domain ingest actions.
Auto-created `/v1/kb/*` domain indexes use the stored domain model when present,
otherwise the default base model, and persist the canonical model/provider. KB
staging and scheduling
entry points (`/v1/kb/files`, uploads, infer-upload, source import with
auto-ingest, schema/file reprocess, source-set requeue, async text, and queued
ingest) run the same readiness check before R2/D1 job mutation or
Queue/Workflow enqueue, so stale embedding config does not create doomed files,
jobs, or run messages. Inline record/text ingest also checks before staging raw
input, and existing stored KB index models are revalidated against the live
free-ai catalog before new work is scheduled. In the hosted testing UI, choosing an explicit model makes that model authoritative and omits
`embedding_profile`, so the model's dimensions choose the compatible Vectorize
binding. The Worker persists the selected embedding model/provider on the index
so later ingests and queries cannot drift if defaults change. A selected or default free-ai model must be
enabled in free-ai and its dimensions must match a configured Vectorize binding.
The hosted testing UI only lists explicit model choices when
`/v1/embedding-models` reports `catalog_source: "free_ai"` and model rows have
`selectable: true`; if the live
catalog is unavailable it falls back to profile defaults instead of offering
static model guesses. `VECTORIZE`
remains the default 1536-dim profile. `VECTORIZE_SMALL`, `VECTORIZE_1024`,
`VECTORIZE_768`, and `VECTORIZE_384` are configured in the current Cloudflare
release because deployed `free-ai` advertises enabled 384/768/1024/1536-dim
embedding rows. Models are listed in the testing UI only when their row is live,
enabled, and `selectable: true` with a compatible Vectorize binding. `pnpm run
audit:vectorize-embedding-bindings -- --json --require-all` reports all current
deployed free-ai dimensions configured. `pnpm run
audit:vectorize-metadata-indexes -- --json --require-complete` is the read-only
remote audit that confirms the required `tenant` and `index_id` metadata indexes
exist on every configured Vectorize index. The audit output includes
`remediation_commands` for missing metadata indexes on existing configured
indexes. The read-only
`release-plan:embedding-model -- --json` output mirrors the configured
metadata-index command candidates under
`configured_vectorize_metadata_index_commands` so approval can reference the
exact commands before provisioning.

The `/v1/kb/*` routes are the Cloudflare-native `knowledgebase` product state
surface. They use the D1 `kb_*` metadata tables for tenant-scoped domains,
R2-backed file upload/registration, corpus status, jobs, schemas, entities,
relationships, traces, and eval reports. The Worker now replaces the Python
runtime paths with TypeScript/Worker ingestion, parser, retrieval, and eval
tooling. The full Cloudflare port is live as of 2026-06-22: the current
embedding-model release is deployed, D1 migrations `0005_index_embedding_model.sql`
and `0006_kb_domain_embedding_model.sql` are applied, all deployed free-ai
embedding dimensions have Vectorize bindings plus metadata indexes,
`release-status:embedding-model`, `readiness:embedding-model`,
`smoke:rag-crud:embedding-model`, and `readiness:full-port` report green, live
scanned-PDF OCR parity is proven, sibling `../rag-service` retirement is proven,
and `pnpm run gaps:full-port` reports 0 remaining.

Consumer index policy:

- Karte/Linkchat uses one lazily-created profile-memory index per account
  (`users.smIndexId`, index name `linkchat-${userId}`) and scopes profile memory
  documents with `userId`, `pageId`, `pageSlug`, and `blockId` metadata. The
  `/api/settings/knowledgebase` route exposes account index status and repair.
- Starboard uses one shared application index from `STARBOARD_RAG_INDEX_ID` and
  scopes every query and ingest with `user_id` metadata because each account's
  corpus is small and relevance needs to cross that account's saved repos.
- Prefer account indexes when a product has user-owned mutable memory that needs
  cheap deletes and no cross-account fanout. Prefer a shared app index plus
  metadata filters when each account's slice is small and the product benefits
  from fewer Vectorize indexes. Split further by domain/page only after measured
  p95 latency, file count, or delete/rebuild volume shows the account index is
  too large.
- Do not rely on caller-supplied tenant/index filters for isolation. The Worker
  always enforces service-key tenant and `index_id` server-side before Vectorize.

Schema inference accepts structured records, JSON/NDJSON/CSV-like input, HTML,
digital PDF text with coordinate-derived table rows, XLSX rows, DOCX paragraph text, PPTX slide text, or
text samples and produces a reviewable schema draft. It also declares inferred
parent/ref relationships from fields such as `parent_id`, `owner_id`, and
`related_ids`, plus prefixed cross-type entities such as
`customer_id/customer_name`; ingest persists those edges in D1 and can resolve
targets already present from earlier ingests by exact identity or canonicalized
identity/display-name aliases. `/v1/kb/relationships/backfill`
rebuilds graph edges for historical D1 entities from active schemas. Search evals score the live Worker retrieval path
with hit rate, MRR, and latency summaries. `/v1/kb/ingest/run` queues staged R2
files for a domain through `KbIngestWorkflow` plus the bound Cloudflare Queue by
default, then parses those Worker-native formats, indexes them into the domain
Vectorize index, and marks the D1 file state ready/failed. Direct Queue dispatch
remains the fallback if the Workflow binding is absent. Send `async: false` only
for explicit inline debug runs. Queued and inline ingestion carry durable
`run_id` values; use `/v1/kb/ingest/runs/:run_id` or the hosted UI's run
progress control to watch Workflow status, job status, stages, and completion.
`/v1/kb/ingest/record` writes virtual JSON records to R2, indexes them, and
persists D1 structured entities immediately. When the domain has no active
schema, it infers and activates one from the posted records; when a schema
already exists, it still validates the requested type against that schema.
`/v1/kb/ingest/text` writes virtual text files to R2 and indexes them inline by
default, without requiring an active schema; pass `async: true` to stage the
normal parser job instead.
`/v1/kb/sources/import` supports
`source: "url"` and `source: "edgar"`; EDGAR config accepts `tickers`, `ciks`,
`forms`, `days`, `per_ticker_per_form`, `limit_total`, and `user_agent`.
Set `RAG_SEC_USER_AGENT` or pass `config.user_agent` so SEC requests are
identified. The hosted UI exposes URL and EDGAR source import controls alongside
source-set management, schema inference, direct structured-record/domain-text
input controls, and ingest run controls.
`/readyz` and `/metrics` preserve the retired FastAPI meta surface with
Cloudflare-native dependency checks and Prometheus-compatible text output.
`/v1/kb/search` queries that domain without exposing low-level index IDs.
`/v1/kb/query/stream` preserves the retired FastAPI SSE contract for clients
that want immediate first-byte feedback: it emits `started`, replayed `stage`,
and final `answer` or `error` events over `text/event-stream` while reusing the
same Worker answer path as `/v1/kb/query`.
Digital PDF ingestion includes a dependency-free layout pass that preserves
coordinate-derived row text and emits markdown table documents for table-like
pages. `RAG_MARKDOWN_CONVERSION=auto` falls back to Workers AI Markdown
Conversion for scanned PDFs, images, legacy Excel, ODF/ODT, Apple Numbers, and
weak local parses; use `always` to force conversion for complex PDFs or `off`
to disable it. `RAG_VISION_OCR_MODEL` can opt in direct Workers AI image OCR for
standalone JPEG/PNG/WebP uploads and image-only PDFs; the Worker sends upload
image bytes or embedded PDF JPEG/JPX images directly and converts basic Flate
RGB/grayscale PDF image streams to PNG for vision models. Use a comma-separated
model chain to try one Cloudflare vision model before the next. PDF vision OCR
filters/prioritizes page-like images before calling Workers AI so tiny embedded
logos and decorative assets do not consume the first OCR calls when a scanned
page image is present.
Upload schema inference, `/v1/kb/ingest/run`, and parse eval payloads can set
`markdown_conversion` and `vision_ocr_model` per request to test a model chain
without changing Worker secrets; queued and Workflow-backed ingestion preserve
those parser options in the run payload. Parse evals retry later models when the
first model returns text but still misses required `expected_text` snippets.
When explicit vision OCR and Markdown Conversion both return text, the parser stores a merged
`workers-ai-vision-markdown-ocr-v1` artifact instead of discarding one output.
Vision OCR is intentionally unset by default until an accepted model proves both
accurate and fast enough. `POST /v1/kb/evals/parse` runs parser-quality eval
cases over inline `content` or `content_base64` fixture bytes, persists D1
reports with `kind: "parse"`, and is available from the hosted testing UI.
`scripts/legacy-parse-eval.mjs` builds those evals from the
migrated legacy D1 export and mirrored raw/parse object roots. Earlier deployed
evidence was 18/19 migrated legacy parser cases passing, with exact scanned-PDF
OCR as the one miss. That gap is now closed: the deployed live OCR gate
(`readiness:full-port` `nvda-scanned-ocr-live`, `RAG_ALLOW_LIVE_OCR=1`) passed
with pass_rate 1 on the Cloudflare vision model chain. Pass
`--vision-ocr-model @cf/meta/llama-3.2-11b-vision-instruct,@cf/meta/llama-4-scout-17b-16e-instruct`
to `scripts/legacy-parse-eval.mjs` with
`--filename-contains NVDA_riskfactors_sample_scanned.pdf` to re-test only that
scanned fixture through the merged vision/Markdown path. If no D1 export is
available, the same script can build a one-file case from the local MinIO mirror
with `--direct-domain sec --direct-content-hash <hash> --direct-filename
NVDA_riskfactors_sample_scanned.pdf`; it can read MinIO inline `xl.meta` objects
for this targeted parity proof. Use `--require-cases --min-pass-rate 1` for the
final live parity gate so the command fails on a missing case or any OCR miss.
`pnpm run eval:parse:nvda-scanned:dry-run` verifies the local one-case payload
without network or AI usage and prints the selected vision OCR model chain, base
URL, and pass-rate gate. After `RAG_SERVICE_KEY` is available,
`pnpm run eval:parse:nvda-scanned:live` runs the same one-case fail-closed gate
against the deployed Worker. Use `pnpm run readiness:full-port` as the final
release gate after `pnpm run deploy:dry-run` passes, the current Worker code is
deployed, the live OCR eval is explicitly allowed, and sibling retirement
remains complete; it combines deployed health/auth checks, deployed legacy-alias
smoke checks, the deployed hosted testing UI check, the deploy fingerprint check,
the live OCR eval, `pnpm run preflight`, the Python runtime retirement audit,
the sibling `rag-service` retirement audit, and the Worker-local Node full-port
gap gate.
In full-port mode the live OCR eval is cost-guarded: it is skipped until the
deployed root aliases and `deploy_fingerprint` prove the current Worker build,
and still requires `RAG_ALLOW_LIVE_OCR=1` or `--allow-live-ocr` before spending
Workers AI OCR.
`readiness:sibling-retirement` was used between the post-deploy/live-OCR proof
and the actual sibling-folder deletion. After retirement, use
`pnpm run audit:sibling-rag-service -- --json` plus
`pnpm run gaps:full-port -- --json` to prove the sibling remains gone and the
gap matrix stays complete.
`pnpm run gaps:full-port` prints the same Worker-local gap gate without needing
the Python toolchain; the matrix is shared with the root CLI through
`../full-port-gaps.json`.
Explicit `hybrid` query mode fuses BM25-style fuzzy D1 sparse lexical and Vectorize evidence with RRF
and local keyword rerank/MMR. Set `rerank_model: "workers_ai"` to run the
Cloudflare `@cf/baai/bge-reranker-base` neural reranker over the bounded
candidate set before returning results. Lexical timing reports
`lexical_scoring: "bm25_fuzzy_sparse_v2"` and `lexical_prefilter:
"d1_like_fuzzy_candidates"` when that zero-AI sparse scorer is used; the
prefilter uses bounded exact/stem/subtoken candidates and keeps non-cache
lexical/hybrid queries from loading every chunk before scoring.
`/v1/kb/query` defaults to the fast
extractive cited answer path; set `answer_mode: "workers_ai"` to synthesize a
richer cited answer with Workers AI using `answer_model`, `RAG_ANSWER_MODEL`, or
`@cf/meta/llama-3.1-8b-instruct`, with deterministic extractive fallback when the
model returns no usable citations. Lexical paths apply deterministic rewrite and
decompose fanout for multi-part questions, with `query_rewrite: false` and
`query_decompose: false` available for benchmark comparisons. Explicit
`semantic` mode corrects weak or empty Vectorize evidence with a D1 lexical
fallback before returning, without making a second Workers AI embedding call.
`/v1/kb/query` responses include deterministic answer/evidence verification in
`confidence` and persist the same verification fields into D1 query traces.
`/v1/kb/evals/query` keeps deterministic scoring as the default and accepts
`ai_judge: true` with an optional `judge_model` to add Workers AI model-judged
AIS-style support scores to rows, summaries, and D1 reports.
Successful query traces and eval reports also emit compact data points to the
`RAG_ANALYTICS` Analytics Engine dataset when bound.
Source-set management is domain-backed: `/v1/kb/source-sets` summarizes files,
statuses, bytes, and MIME groups; `/v1/kb/source-sets/domain:<domain>/actions`
supports dry-run requeue/archive/delete actions with Vectorize/R2/D1 cleanup for
deletes.

## Backfill Existing SaaS Maker Chunks

The import script accepts a JSON export of existing saas-maker chunks with precomputed embeddings. It calls `POST /v1/indexes/:id/ingest-vectors`, so no Workers AI re-embedding is needed during migration.

```bash
RAG_BASE_URL=https://knowledgebase.<your-subdomain>.workers.dev \
RAG_SERVICE_KEY=<service-key> \
node scripts/backfill-saas-maker.mjs \
  --input saas-maker-chunks.json \
  --index-name "SaaS Maker Knowledge" \
  --external-id <saas-maker-index-id>
```

Dry-run a fixture locally:

```bash
pnpm run backfill:dry-run
```

## Migrate Raw Files Into R2/D1

Use `scripts/migrate-raw-files.mjs` when existing local or MinIO-exported raw
files need to become Cloudflare-owned R2/D1 state. Directory mode applies one
domain to all discovered files; manifest mode can assign per-file domains and
filenames; object-root mode reads exports shaped like
`<domain>/<content_hash>/<filename>`. Dry-runs emit per-file SHA-256 plans; live
uploads fail if the Worker returns a different content hash.

```bash
RAG_BASE_URL=https://knowledgebase.<your-subdomain>.workers.dev \
RAG_SERVICE_KEY=<service-key> \
node scripts/migrate-raw-files.mjs \
  --manifest raw-migration.json \
  --infer-schema \
  --apply-schema \
  --queue-ingest
```

Dry-run the sample manifest locally:

```bash
pnpm run migrate:raw:dry-run
pnpm run migrate:raw:objects:dry-run
```

For a legacy MinIO export, mirror the raw object prefix into a plain directory
outside this repo first, then run object-root mode:

```bash
# Do not point --object-root at data/minio/kb-bucket/raw directly. That is
# MinIO's disk/erasure layout; it contains xl.meta files and will be rejected.

RAG_BASE_URL=https://knowledgebase.<your-subdomain>.workers.dev \
RAG_SERVICE_KEY=<service-key> \
node scripts/migrate-raw-files.mjs \
  --object-root exports/raw \
  --infer-schema \
  --apply-schema \
  --queue-ingest
```

## Migrate Legacy Metadata To D1

Export the legacy Postgres product-state tables as JSON, then generate D1 SQL:

```bash
pnpm run migrate:d1:export-sql > legacy-kb-export.sql
psql "$DATABASE_URL" -At -f legacy-kb-export.sql > legacy-kb-export.json

node scripts/migrate-d1-metadata.mjs \
  --input legacy-kb-export.json \
  --out d1-metadata.sql
```

Dry-run the checked-in fixture first:

```bash
pnpm run migrate:d1:dry-run
```

The generated SQL targets the `kb_*` D1 tables, inserts rows in foreign-key
order, dedupes by each D1 conflict key, and reports a normalized SHA-256
checksum for count/checksum comparison before applying:

```bash
wrangler d1 execute rag-db --remote --file d1-metadata.sql
```

## Smoke A SaaS Maker Export

After exporting an index from SaaS Maker with
`GET /v1/knowledge/indexes/:id/export`, smoke the exact pre-embedded migration
path through `knowledgebase`:

```bash
RAG_BASE_URL=https://knowledgebase.<your-subdomain>.workers.dev \
RAG_SERVICE_KEY=<service-key> \
node scripts/smoke-saas-maker-export.mjs \
  --input saas-maker-knowledge-export.json \
  --limit 10
```

The smoke creates a temporary RAG index, imports the exported vectors, waits and
polls until Vectorize makes them queryable, queries by vector, reports latency and
hit rate, and deletes the temporary index unless `--keep-index` is passed.

The same exported-vector smoke can be run through the readiness wrapper:

```bash
RAG_SERVICE_KEY=<service-key> \
node scripts/deploy-readiness.mjs \
  --require-auth \
  --export-input saas-maker-knowledge-export.json
```

## Benchmark Latency And Hit Rate

The benchmark harness can hit local `wrangler dev` or a deployed Worker. It can create
a temporary index from raw documents, run repeated text queries, and report latency
percentiles, cache hits, and simple expected-result hit rate.

```bash
RAG_BASE_URL=https://knowledgebase.<your-subdomain>.workers.dev \
RAG_SERVICE_KEY=<service-key> \
node scripts/benchmark-rag.mjs \
  --input fixtures/benchmark.sample.json \
  --repeat 5 \
  --top-k 5
```

Use `--index-id <id>` to benchmark an existing populated index. Add `--cleanup` only
when the script created the benchmark index and you want it deleted after the run.
Fresh-index runs wait 15 seconds after ingest by default so Vectorize can make
newly-upserted vectors queryable before accuracy is scored.

## Operator Performance Report

Use the read-only operator report to inspect existing projects, domains, indexes,
files, jobs, source sets, recent traces, eval summaries, selectable embedding
models, and cost-risk signals from one command:

```bash
RAG_BASE_URL=https://knowledgebase.<your-subdomain>.workers.dev \
RAG_SERVICE_KEY=<service-key> \
pnpm run operator:report -- --domain <domain>
```

Add an existing index benchmark when you want speed numbers without ingesting new
data:

```bash
RAG_SERVICE_KEY=<service-key> \
pnpm run operator:report -- \
  --index-id <index-id> \
  --query "what should this account remember?" \
  --repeat 5 \
  --top-k 5
```

The default report performs only GET requests after health/auth-boundary checks.
The benchmark option calls `/v1/indexes/:id/benchmark-query` on an existing
index; it does not create, ingest, or delete data.
