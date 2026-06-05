# Agent Search Direction

## Positioning

This project is now best framed as:

> Exa-style search for private, specialized document collections, with schemas,
> citations, and provenance for agents.

The product is not a generic chatbot over files and it should not start as a
connector marketplace. It is a private search and evidence layer that agents can
call when they need reliable answers from niche documents and company memory:
research papers, company private information, filings, contracts, policies,
manuals, notes, spreadsheets, Slack exports, Linear issues, meeting transcripts,
and other sources that are too small or private for web-scale search.

## What Is Real Today

- Project-scoped corpora: each project has its own schemas, files, entities,
  sessions, traces, and indexed chunks.
- Bring-your-own corpus: users can start from pasted samples or representative
  files, infer a durable schema draft, confirm it, and then ingest those staged
  files.
- Bring-your-own schema: schemas are user-defined, versioned, and can be
  inferred before confirmation.
- Schema-driven ingestion: files and records produce structured entities,
  provenance spans, relationships, and searchable chunks.
- Source input: manual upload, schema-inference sample files, structured
  records/text, EDGAR demos, and URL fetches. The source adapter boundary should
  also support future company-memory imports such as Slack, Linear, meeting
  recordings/transcripts, docs, tickets, and support logs.
- Agent search API: `POST /search` and `POST /agent/search` return ranked cited
  evidence without answer synthesis.
- Answer API: `POST /query` synthesizes cited answers and records traces.
- Citation hard gate: configured citation verification can refuse unsupported
  generated claims.
- Lifecycle controls: file delete, file reprocess, and schema-version reprocess.
- Eval hooks: project-aware eval runner plus quick UI eval.
- Search eval: `POST /search/eval` reports precision, recall, MRR, and p95
  latency for ranked evidence.
- Corpus status: `GET /projects/{project}/status` reports per-kind readiness
  state.
- Agent docs: `docs/agent-tool-contract.md` describes when to call `/search`
  versus `/query`.
- Bring-your-own-corpus docs: `docs/bring-your-own-corpus.md` covers upload,
  infer, confirm, ingest, and search.

## Product Wedge

Use this when an agent needs:

- private corpus retrieval, not open-web search;
- exact file/page/excerpt evidence;
- schema-aware filters and scoped queries;
- repeatable ingestion with provenance;
- smaller specialized source sets where quality matters more than scale.
- a way to expose a private mini-index to agents without building retrieval
  infrastructure from scratch.

Do not pitch this as:

- a web-scale search engine;
- a complete enterprise knowledge platform;
- a connector-first sync product;
- a generic document-chat app;
- a guaranteed parser for every arbitrary file on day one.

## Gaps From Here

1. **Search ranking evals**

   A v1 `/search/eval` endpoint exists with precision, recall, MRR, and p95
   latency. The next step is saved eval reports per project/kind, trend history,
   and per-filter/per-kind breakdowns.

2. **Agent tool contract**

   A v1 contract doc exists. The next step is framework-specific examples for
   common agent runners and a small compatibility test that verifies the tool
   response remains stable.

3. **Bring-your-own corpus onboarding**

   The self-serve path now exists: upload representative files, infer a durable
   schema draft, confirm it, and ingest staged files. It still needs hardening:
   live progress visibility while sample files are parsed and clearer handling
   when schema inference fails.

4. **Company-memory ingestion**

   Manual upload is first-class, but nothing in the architecture should block
   company-memory sources. Slack, Linear, meeting recordings/transcripts, docs,
   tickets, support logs, and similar inputs should enter through the same
   adapter contract: collect source objects, normalize them into files or
   records, infer/confirm schema when needed, preserve source metadata, ingest,
   and expose cited search.

   The missing pieces are source-set management and sync state: bulk replace,
   file grouping, collection metadata, cursors, deletion handling, stale/failed
   counts, and transcript/media normalization.

5. **Search snippets and metadata**

   `/search` returns cited spans, highlights, and neighboring context. Better
   search would add matched fields, structured metadata facets, source-level
   summaries, and explicit "why this matched" explanations.

6. **Schema evolution UX**

   Schema reprocess exists, but migrations are still operator-driven. The product
   flow should show old/new schema diffs, impacted files/entities, and a safe
   "apply and reprocess" wizard.

7. **Parser strategy maturity**

   Strategy selection is configurable and Docling is optionally supported, but
   parser choice is not yet auto-evaluated per file. The next step is parser
   benchmarking by source type and explicit parse-quality diagnostics.

8. **Latency**

   `/search` avoids synthesis and is the right fast path, but first-call model
   loading and cross-encoder reranking can still be slow. Production agent use
   needs warm model caches, smaller rerank modes, and latency budgets per tool.

9. **Hosted personal product**

   The local stack works and `docs/hosting-personal.md` defines the safe hosting
   checklist. A real hosted version still needs durable storage policy, backups,
   observability, usage limits, background ingest jobs, and a deployment target.
   ACLs are intentionally out of scope while this stays personal.

10. **Templates**

   SEC and legal demos exist. The direction needs smaller "starter projects":
   research papers, company knowledge, manuals, contracts, personal notes, and
   docs-site snapshots, each with schema, sample data, and eval questions.

## Near-Term Roadmap

1. Persist `/search/eval` reports and trend them per project/kind.
2. Add framework-specific agent examples around the stable HTTP contract.
3. Add live progress for sample-file parsing and schema inference.
4. Add source-set management for uploaded and imported company-memory sources.
5. Add project templates for research papers, company knowledge, notes, manuals,
   and contracts.
6. Add a schema-diff/reprocess wizard in the UI.
