# KB Service — Design

## Architecture

```
                  ┌────────────────────────────────────────────────────────────┐
                  │                          Clients                           │
                  │     curl / Swagger          Streamlit (8501)               │
                  └──────┬───────────────────────────────────┬─────────────────┘
                         │                                   │
                         ▼                                   ▼
                ┌──────────────────────────────────────────────────┐
                │  FastAPI (8000)                                  │
                │  /healthz /readyz  — db / vector / object probe  │
                │  /domains /schemas — schema CRUD + versioning    │
                │  /files /ingest    — upload + job lifecycle      │
                │  /entities         — list / lineage / refs       │
                │  /query            — cited synthesis + trace     │
                │  /query/trace/{id} — stage-by-stage replay       │
                └─┬────────────────────────────────────────┬───────┘
   ingest pipeline│                                        │ query pipeline
                  ▼                                        ▼
   ┌──────────────────────────────────┐    ┌────────────────────────────────────────┐
   │ Async workers (SKIP LOCKED)      │    │  Query engine                          │
   │  per file:                       │    │   intent (LLM, domain-aware)           │
   │   parse  (Unstructured + cache)  │    │   structured (entities table SQL)      │
   │   extract (schema-driven LLM)    │    │   retrieve (hybrid dense+sparse)       │
   │   resolve (ER: key + fuzzy +     │    │   rerank (cross-encoder)               │
   │            embedding tiebreak)   │    │   synthesize (cited LLM)               │
   │   index  (hierarchical chunks)   │    │   verify (per-claim entailment)        │
   └──────────┬───────────────────────┘    │   span_cite (best-sentence excerpt)    │
              │                            └───────────────┬────────────────────────┘
              ▼                                            ▼
   ┌──────────────────────────┐  ┌────────────────────────┐  ┌────────────────────┐
   │ Object store             │  │ Vector store           │  │ Postgres           │
   │ MinIO (S3) / local       │  │ Qdrant (default)       │  │ + pgvector         │
   │ raw/<hash>/<file>        │  │  hybrid dense+sparse   │  │ + pg_trgm          │
   │ parse/<hash>/elements.json  │ │  payload-filtered    │  │ schemas (versioned)│
   └──────────────────────────┘  │ pgvector adapter       │  │ entities + lineage │
                                 └────────────────────────┘  │ provenance_spans   │
                                                             │ ingest_jobs        │
                                                             │ sessions + traces  │
                                                             └────────────────────┘
```

Same docker-compose brings up: postgres, qdrant, minio (+ init bucket), api, worker, streamlit.
Add a new domain (legal, medical, anything) by dropping a YAML schema and seed loader
under `domains/<name>/`. No code edits required.

## Query pipeline stages

Every `/query` call is recorded on the trace as a sequence of named stages with
per-stage latency and (where applicable) LLM token counts:

| Stage | What it does | Why it's there |
| --- | --- | --- |
| `intent` | LLM classifies kind (lookup / aggregate / compare / negative) and extracts facet filters (ticker, form_type, …). | Lets the next stages narrow scope automatically. |
| `structured` | For aggregate / compare shapes: runs SQL against the entities table directly. | Numeric / "which X have Y > Z?" questions don't need RAG — the fact is already extracted. |
| `retrieve` | Hybrid dense+sparse search (Qdrant) with payload filters; candidate_k=30. | The PRD's "don't rely on vector similarity alone" requirement. |
| `rerank` | Cross-encoder (`Xenova/ms-marco-MiniLM-L-6-v2`) rescores the 30 candidates to top-K. | The single biggest precision lift; configurable on/off. |
| `synthesize` | LLM writes a cited answer with inline `[n]` markers. | The PRD's "cited or it didn't happen" rule is enforced here. |
| `verify` | Second-pass LLM decomposes the answer into atomic claims and checks each against its cited chunk. Failed claims downgrade confidence. | Catches hallucinations that slipped past the `[n]` gate. |
| `span_cite` | Per-citation excerpt narrowed to the most-relevant sentence via dense cosine. | Honours "file → page → **exact** excerpt" precisely. |

## Proving domain-agnosticism

The repo ships **two demo domains** that share the entire code path:

| Domain | Schema | Source adapter | Seed corpus | Eval set |
| --- | --- | --- | --- | --- |
| `sec` | Company / Filing / Section / RiskFactor / FinancialMetric | `edgar` (edgartools) | 10 EDGAR HTML filings + 1 digital PDF + 1 scanned (OCR) PDF + 1 XLSX | 25 Q&A with adversarial paraphrase + refusal cases |
| `legal` | Contract / Party / Clause / Obligation | `upload` (SPDX texts) | 6 open-source license texts (MIT, Apache-2.0, GPL-3.0, BSD-3, MPL-2.0, ISC) | 12 Q&A with negative-case refusal |

Both load with `make seed-all`. Both produce cited answers; both run the same eval
harness. Zero source code is shared between them — only YAML schemas + seed
loaders. That's the demonstration that the system itself contains no
domain-specific assumptions.

## Three trickiest decisions

### 1. The "parse once, re-extract many" boundary

The PRD says re-running the schema-driven part of ingestion must NOT redo expensive parsing.
We picked the seam at the **Unstructured `Element` list**.

- `parse_file` keys the cache on `sha256(file_bytes)`. The raw file lives at
  `raw/<domain>/<hash>/<filename>`; the parsed artifact at `parse/<hash>/elements.json`.
- A `parse_artifacts` table tracks `(content_hash → parser_version, object_key)`.
- The extract stage reads `elements.json` — it never touches the original PDF.
- Schema edits trigger a new `ingest_jobs` row (PK `(file_id, schema_id)`); the parse-cache
  hit means OCR / layout detection (the expensive bits) are skipped.

Alternatives we rejected: caching at the chunk/text level (loses provenance); caching at the
LLM output level (defeats the point — schema changes invalidate this). The element list is
the smallest cache that preserves bbox + page + element type without burning OCR twice.

### 2. Entity resolution lives in our code, not in a library

LlamaIndex has `PropertyGraphIndex` and similar; we considered them and rejected them.
- LlamaIndex ER is a similarity-threshold heuristic over LLM-extracted triples. For "same
  company across 20 filings" we need deterministic behavior, which means a normalized
  identity key from schema-declared identity fields (ticker / CIK / accession_number),
  with a fuzzy fallback (rapidfuzz `token_set_ratio` over the schema's `summary_field`).
- The trade-off: we cannot use the library's PropertyGraphIndex query language. We don't
  need it — Postgres handles relationships + lineage with one CTE.

What this buys us: deterministic merging (same key → same entity), explicit provenance
(every mention recorded as `entity_mentions(entity_id, file_id, schema_id)`), and a
clear path to swap the tiebreak from rapidfuzz to an embedding cosine when ambiguity grows.

### 3. Vector-store abstraction, with Qdrant as the default

We default to **Qdrant** because (a) native hybrid via dense + sparse (BM42-style) is a
hard requirement for "don't rely on vector similarity alone," (b) payload filters fold our
"scoped queries" requirement into the store, and (c) RRF fusion is built in.

We also ship a **pgvector adapter** — same `VectorStore` Protocol, Postgres FTS for lexical,
in-application RRF fusion for hybrid. This matches HighSignal's `python/lab` posture (one
DB to operate), and is one env-var flip (`KB_VECTOR_STORE=pgvector`) away.

The interface is **9 methods**: `ensure_collection`, `upsert`, `delete_by_file`,
`hybrid_search`. Adding a third backend (Weaviate, Vespa, Cloudflare Vectorize for a
HighSignal Worker deploy) is one file.

## What I would do with more time

- **Per-element entity attribution.** Today, indexed chunks attach to the most-recent leaf
  parent entity. A short pass that matches each element's page range against the entity
  provenance spans would give per-chunk `entity_id` precision (and unlock entity-scoped
  retrieval that doesn't depend on Filing → MD&A scope).
- **Embedding tiebreak for ER.** Wire fastembed into `resolve_one` as the third pass when
  the rapidfuzz score is in the ambiguous band (`0.7–0.86`). The plumbing is there
  (`embedding_tiebreak_threshold` in `defaults.yaml`); the call site is stubbed.
- **Long-doc reconciliation.** When two overlapping page-windows extract the same entity
  with conflicting fields, we currently keep both via JSON merge. A reconciliation step
  (LLM as adjudicator over the conflicting records) would shrink the noise.
- **Idempotency on object_key, not just `(file_id, schema_id)`.** A second upload of the
  same bytes under a new filename currently creates a new `files` row (good for audit)
  but re-runs the LLM extract (waste). De-duping the schema-driven stage by content-hash
  is one query away.
- **First-class spreadsheet path.** `partition_xlsx` produces page=0 elements. Today they
  ride the generic chunker; we should split per row and attach to declared column
  identities (e.g. `FinancialMetric.name` becomes a column header).
- **Eval set expansion.** 16 questions is the floor; a real corpus needs ~50 with
  adversarial questions ("answer is NOT in any document") to test refusal.
- **Trace UI.** `/query` writes a full `query_traces` row; the Streamlit demo references
  the trace ID but doesn't render the full retrieval/synthesis decomposition.

## Where the system breaks today

- **Cold start LLM extraction.** Without a real `AI_API_KEY`, extraction yields zero
  entities. The pipeline still ships chunks to Qdrant (so retrieval works), but
  schema-driven outputs are empty.
- **`hi_res` parsing is slow + memory-heavy.** A 300-page 10-K with `strategy=hi_res`
  can take >5 min and >2 GB RAM. The default `auto` will pick `fast` for digital
  PDFs; switch to `hi_res` only via config override.
- **Cross-file entity merging is one-pass.** Resolution sees only one file at a time;
  a duplicate that arrives later with a slightly different display name + no identity
  key will create a near-duplicate canonical entity. A nightly reconciliation pass
  fixes this; we didn't ship one.
- **Citations are file + page + best-sentence accurate, not character-accurate.**
  `provenance_spans` preserves `bbox` from Unstructured; the `span_cite` stage picks the
  best sentence inside the chunk by dense cosine, but a true "highlight this exact
  character range in the original PDF" UX would need the consumer to map the chosen
  sentence back to the element-level bbox.
- **Long sessions truncate context.** We feed the last 3 prior turns into the synthesis
  prompt. No summarization above that — a chatty session will drift.
- **Workers are not bounded by RAM.** Concurrency is set by env var; a `hi_res` 10-K
  on 4 workers can OOM a small VM. We need a per-stage semaphore that knows about
  memory cost, not just count.
- **Schema migration on existing data.** New schema version doesn't backfill or migrate
  existing entities; the previous version's data stays under the old schema_id. A
  user re-uploading the same files re-extracts fresh; we never deleted the prior.

## Domain-agnosticism — the boundary tests

The PRD's hardest property is: "swap schema + data and onboard a new domain without code
changes." A few of the lines that would break this and are kept honest:

- `src/kb/schema/` has no SEC names. `domains/sec/schema.yaml` is the only place where
  "Filing", "RiskFactor", "ticker" appear.
- `src/kb/extract/schema_to_json.py` translates *any* `DomainSchema` to JSON Schema
  for the tool-call extraction. The LLM prompt is parameterized by the schema's
  vocabulary dictionary.
- `src/kb/resolve/keys.py` uses schema-declared `identity: true` fields — no hardcoded
  identity field names.
- `src/kb/vector/*` and `src/kb/query/*` reference `domain` and `entity_type` but never
  enumerate domain-specific values.
- `src/kb/seed/sec_seed.py` *is* domain-specific by design — it's seed glue, not core.

To onboard, say, medical research: drop `domains/medical/schema.yaml`, optionally a
`domains/medical/config.yaml`, run `make schema-apply` against it, upload PDFs with
`domain=medical`, hit `/ingest/run`.
