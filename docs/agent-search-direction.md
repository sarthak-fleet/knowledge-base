# Agent Search Direction

## Positioning

This project is now best framed as:

> Exa-style search for private, specialized document collections, with schemas,
> citations, and provenance for agents.

The product is not a generic chatbot over files and it is not a connector
platform. It is a private search and evidence layer that agents can call when
they need reliable answers from niche documents: research papers, company
private information, filings, contracts, policies, manuals, notes, spreadsheets,
and other sources that are too small or private for web-scale search.

## What Is Real Today

- Project-scoped corpora: each project has its own schemas, files, entities,
  sessions, traces, and indexed chunks.
- Bring-your-own corpus: users can start from pasted samples or representative
  files, infer a schema, confirm it, and then ingest those staged files.
- Bring-your-own schema: schemas are user-defined, versioned, and can be
  inferred before confirmation.
- Schema-driven ingestion: files and records produce structured entities,
  provenance spans, relationships, and searchable chunks.
- Source input: manual upload, schema-inference sample files, structured
  records/text, EDGAR demos, and URL fetches.
- Agent search API: `POST /search` and `POST /agent/search` return ranked cited
  evidence without answer synthesis.
- Answer API: `POST /query` synthesizes cited answers and records traces.
- Citation hard gate: configured citation verification can refuse unsupported
  generated claims.
- Lifecycle controls: file delete, file reprocess, and schema-version reprocess.
- Eval hooks: project-aware eval runner plus quick UI eval.
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

   `/search` is real, but it needs its own benchmark: recall@k, MRR, citation
   precision, latency, and per-kind breakdown. Current evals are mostly answer
   oriented or retrieval-only scripts, not productized search quality reports.

2. **Agent tool contract**

   A v1 contract doc exists. The next step is framework-specific examples for
   common agent runners and a small compatibility test that verifies the tool
   response remains stable.

3. **Bring-your-own corpus onboarding**

   The self-serve path now exists: upload representative files, infer a schema,
   confirm it, and ingest staged files. It still needs hardening: better
   first-run state, progress visibility while sample files are parsed, clearer
   handling when schema inference fails, and a saved "confirm schema then ingest"
   flow instead of session-local pending state.

4. **Corpus management**

   Manual upload is first-class. The missing piece is source-set management:
   bulk replace, re-run a folder worth of uploaded docs, file grouping,
   collection-level metadata, and clear stale/failed/ready counts per kind.

   Slack or other SaaS connectors can be added later, but they should not define
   the product. The core use case is people bringing research papers, private
   company information, manuals, contracts, notes, and records.

5. **Search snippets and metadata**

   `/search` returns cited spans, but snippet quality is still derived from chunk
   text. Better search would add highlights, matched fields, neighboring context,
   structured metadata facets, and source-level summaries.

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

   The local stack works. A hosted version needs durable storage policy,
   backups, observability, usage limits, background ingest jobs, and a deployment
   target. ACLs are intentionally out of scope while this stays personal.

10. **Templates**

   SEC and legal demos exist. The direction needs smaller "starter projects":
   research papers, company knowledge, manuals, contracts, personal notes, and
   docs-site snapshots, each with schema, sample data, and eval questions.

## Near-Term Roadmap

1. Add `/search` eval reports and a saved eval tab for each project.
2. Write agent tool docs with copy-paste examples for common agent frameworks.
3. Harden the bring-your-own corpus flow: upload samples, infer, confirm,
   ingest, search.
4. Add corpus-level management for uploaded file sets.
5. Add project templates for research papers, company knowledge, notes, manuals,
   and contracts.
6. Add a schema-diff/reprocess wizard in the UI.
