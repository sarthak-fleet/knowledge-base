# HighSignal Integration Notes

`knowledgebase` is now the Cloudflare-owned shared RAG service. HighSignal or
other fleet apps should integrate through `RAG_SERVICE_URL`/service bindings and
`RAG_SERVICE_KEY`, not by embedding a local Python runtime.

## Contract

- Upload/source import: Worker `/v1/kb/files/upload` and `/v1/kb/sources/import`
- Query: Worker `/v1/kb/query`
- Search/eval/trace state: Worker `/v1/kb/*` D1-backed routes
- Raw files and parse artifacts: R2
- Metadata: D1
- Vectors: Vectorize

## HighSignal Flow

1. HighSignal fetches or receives a source artifact.
2. It sends the artifact or source URL to the knowledgebase Worker.
3. The Worker persists raw bytes in R2, tracks product state in D1, queues
   ingestion, and indexes evidence in Vectorize.
4. HighSignal calls `/v1/kb/query` to ground signal claims with cited excerpts.

## Open Questions

- Whether HighSignal needs a dedicated schema template or can use Worker schema
  inference.
- Whether signal publication should store knowledgebase trace IDs alongside
  generated claims.
