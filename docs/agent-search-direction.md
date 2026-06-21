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
  records/text, EDGAR imports, and URL fetches through the Cloudflare Worker.
  Future company-memory imports such as Slack, Linear, meeting
  recordings/transcripts, docs, tickets, and support logs should enter through
  the same Worker source/import boundary.
- Agent search API: `POST /v1/kb/search` returns ranked cited evidence without
  answer synthesis; retired `POST /search` and `POST /agent/search` paths are
  authenticated compatibility aliases.
- Answer API: `POST /v1/kb/query` returns cited answers and records traces;
  `POST /v1/kb/query/stream` provides SSE lifecycle events, with retired
  `/query` and `/query/stream` paths kept as compatibility aliases.
- Citation hard gate: configured citation verification can refuse unsupported
  generated claims.
- Lifecycle controls: file delete, file reprocess, and schema-version reprocess.
- Eval hooks: Worker routes persist search/query/parse eval reports and expose
  summary/history.
- Search eval: `POST /v1/kb/evals/search` reports hit rate, MRR, and latency
  for ranked evidence; retired `/search/eval` is a compatibility alias.
- Corpus status: `GET /v1/kb/projects/{project}/status` reports per-domain
  readiness state.
- Agent docs: `docs/agent-tool-contract.md` describes the current Worker
  contract and compatibility aliases.
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

   Worker eval endpoints now persist reports and expose summary/history. The
   next step is stronger trend views per project/kind and per-filter breakdowns.

2. **Agent tool contract**

   A v1 contract doc exists. The next step is framework-specific examples for
   common agent runners and a small compatibility test that verifies the tool
   response remains stable.

3. **Bring-your-own corpus onboarding**

   The self-serve Worker path now exists: upload representative files, infer a
   durable schema draft, confirm it, queue or inline ingest staged files, and
   inspect run progress. It still needs clearer live progress while schema
   inference itself is parsing samples and better failure repair UX.

4. **Company-memory ingestion**

   Manual upload is first-class, but nothing in the architecture should block
   company-memory sources. Slack, Linear, meeting recordings/transcripts, docs,
   tickets, support logs, and similar inputs should enter through the same
   adapter contract: collect source objects, normalize them into files or
   records, infer/confirm schema when needed, preserve source metadata, ingest,
   and expose cited search.

   Source-set summaries and several bulk actions now exist. Remaining work is
   deeper sync state: cursors, deletion handling, stale counts, and
   transcript/media normalization.

5. **Search snippets and metadata**

   `/search` returns cited spans, highlights, and neighboring context. Better
   search would add matched fields, structured metadata facets, source-level
   summaries, and explicit "why this matched" explanations.

6. **Schema evolution UX**

   Schema reprocess exists, but migrations are still operator-driven. The product
   flow should show old/new schema diffs, impacted files/entities, and a safe
   "apply and reprocess" wizard.

7. **Parser strategy maturity**

   Parser choice is Cloudflare-native now: TypeScript parsers plus Workers AI
   Markdown Conversion and opt-in vision OCR. The next step is closing exact
   scanned-PDF OCR parity and adding clearer parse-quality diagnostics by
   source type.

8. **Latency**

   `/v1/kb/search` and lexical/entity query paths avoid synthesis and are the
   fast path. Unique semantic misses still pay Workers AI embedding plus
   Vectorize latency; production agent use needs cached popular queries,
   precomputed query vectors where appropriate, and per-tool latency budgets.

9. **Hosted personal product**

   The deployed target is the `knowledgebase` Cloudflare Worker. Remaining
   hosted-product work is durable backup/restore drills, usage limits, live OCR
   parity proof, and final sibling `rag-service` retirement.

10. **Templates**

   SEC and legal demos exist. The direction needs smaller "starter projects":
   research papers, company knowledge, manuals, contracts, personal notes, and
   docs-site snapshots, each with schema, sample data, and eval questions.

## Near-Term Roadmap

1. Improve eval trend views per project/kind.
2. Add framework-specific agent examples around the stable HTTP contract.
3. Add live progress for sample-file parsing and schema inference.
4. Add source-set management for uploaded and imported company-memory sources.
5. Add project templates for research papers, company knowledge, notes, manuals,
   and contracts.
6. Add a schema-diff/reprocess wizard in the UI.
