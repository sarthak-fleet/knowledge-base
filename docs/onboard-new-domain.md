# Onboarding a New Domain

The current onboarding path is the Cloudflare Worker `/ui` plus `/v1/kb/*`
routes. The retired local Python/Docker path is no longer the product surface.

## Steps

1. Choose a domain key such as `patents`, `contracts`, or `research-papers`.
2. Upload representative files in the Worker `/ui`.
3. Infer or draft the schema.
4. Review the schema and apply it.
5. Queue ingestion.
6. Query with `/v1/kb/query`.
7. Add retrieval/answer/parse eval cases for the domain.

## Schema Shape

Schemas still declare entity types, fields, identities, descriptions, and
relationships. The Worker persists active schemas in D1 and uses them during
ingestion, entity extraction, relationship resolution, structured lookup, and
query-time graph expansion.

## Verification

For a new domain, verify:

- file upload creates R2 objects and D1 file rows;
- ingestion creates D1 entities, relationships, chunks, and Vectorize entries;
- `/v1/kb/query` returns cited answers;
- trace and eval reports appear in the Worker `/ui`.
