# new-things — study queue

Short stubs for non-standard tech in this repo. 3–5 lines each. Fill `Why here:`
yourself after learning; never invent rationale.

## Vectorize — multiple binding profiles per Worker
- What: A single Worker can bind multiple Vectorize indexes (different models/dimensions) and route per-request based on the configured profile
- Why here: TBD
- Gotcha (from code): `cloudflare/worker/src/index.ts:821-845` — `configuredVectorizeProfiles()` iterates env vars to discover which Vectorize bindings are active; each profile has its own `key`, `dim`, and `binding`
- Source: https://developers.cloudflare.com/vectorize/

## Workers AI vision OCR (llama-4-scout / llama-3.2-11b-vision)
- What: Using Cloudflare Workers AI vision models to OCR scanned PDFs — the model returns markdown text from page images
- Why here: TBD
- Gotcha (from code): `cloudflare/worker/src/document-parser.ts:748-766` — vision OCR prompt is strict: "You are a strict OCR transcription engine. Return exact OCR text only." — any prose in the response corrupts the corpus
- Source: https://developers.cloudflare.com/workers-ai/models/llama-3.2-11b-vision-instruct/

## PDF parsing in Workers — fflate + manual FlateDecode
- What: Parsing PDFs entirely in the Workers runtime using `fflate` for decompression, with manual PDF object stream parsing
- Why here: TBD
- Gotcha (from code): `cloudflare/worker/src/document-parser.ts:160` — `FlateDecode` filter is handled manually with `decompressSync(bytes)`; the PDF object model is parsed byte-by-byte without a PDF library
- Source: https://pdf-object-model.com/

## Schema inference from unknown JSON
- What: Taking arbitrary JSON (arrays, nested objects, mixed types) and inferring a flat tabular schema with type detection
- Why here: TBD
- Gotcha (from code): `cloudflare/worker/src/schema-inference.ts:161-183` — `recordsFromJsonValue` recursively flattens nested JSON into records with a depth limit of 500 items per array; `inferSchema()` samples text to detect column types
- Source: https://duckdb.org/docs/data/json/overview

## Paragraph-aware chunking with overlap
- What: Text chunking that respects paragraph boundaries while maintaining overlap between chunks for context continuity
- Why here: TBD
- Gotcha (from code): `cloudflare/worker/src/chunk.ts:8-30` — splits on `\n\n` first, then falls back to hard slicing if a single paragraph exceeds `size`; overlap is capped at `size - 1` to prevent infinite loops
- Source: https://www.pinecone.io/learn/chunking-strategies/

## AI Gateway caching with TTL
- What: Routing Workers AI embedding requests through an AI Gateway with cache TTL to avoid re-embedding identical text
- Why here: TBD
- Gotcha (from code): `cloudflare/worker/src/embeddings.ts:14-22` — `gatewayOptions()` returns `{ gateway: { id, skipCache: false, cacheTtl } }` only if `RAG_AI_GATEWAY_ID` is set; without the gateway, every embedding call hits the model directly
- Source: https://developers.cloudflare.com/ai-gateway/

## D1 as metadata store + Vectorize as vector store
- What: Split storage pattern — D1 holds document metadata (titles, sources, parsed text), Vectorize holds only the embeddings and vector IDs
- Why here: TBD
- Gotcha (from code): `cloudflare/worker/src/d1-repository.ts` — D1 stores `documents`, `chunks`, `citations` tables; Vectorize is queried for vector similarity, then results are joined back to D1 for metadata
- Source: https://developers.cloudflare.com/d1/

## Ingest queue with retry via Workers Queues
- What: Document ingestion is async — upload enqueues a message, a consumer worker processes parsing + embedding + storage with automatic retry
- Why here: TBD
- Gotcha (from code): `cloudflare/worker/src/types.ts` — `KbIngestQueueMessage` type defines the queue payload; the consumer must be idempotent because retries can deliver the same message multiple times
- Source: https://developers.cloudflare.com/queues/
