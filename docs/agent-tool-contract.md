# Agent Tool Contract

Agents should call the Cloudflare Worker RAG service when they need evidence
from a private or specialized corpus.

## Endpoint

Use `POST /v1/kb/query` for cited answers and ranked evidence. Use
`POST /v1/kb/query/stream` only when the client needs SSE lifecycle events;
the stream emits `started`, `stage`, and final `answer` or `error` events.
Legacy `/query`, `/query/stream`, `/search`, `/agent/search`, and
`/search/eval` paths still work as authenticated compatibility aliases, but new
clients should use `/v1/kb/*`.

Authentication:

```http
Authorization: Bearer <RAG_SERVICE_KEY>
```

## Request

```json
{
  "project": "my-private-corpus",
  "domain": "research-papers",
  "question": "What evidence supports using retrieval reranking?",
  "top_k": 8,
  "mode": "hybrid",
  "answer_mode": "extractive"
}
```

Use `mode: "hybrid"` when quality matters. Use `mode: "lexical"` for
latency-critical exact-term workflows.

## Response Contract

The agent should preserve returned citations. A cited answer is only useful when
the final response can point back to filename/page/excerpt evidence.

If the Worker returns no relevant evidence, do not answer from memory. Ask for a
narrower query, a different domain, or more uploaded documents.

## Curl Example

```bash
export RAG_BASE_URL="${RAG_BASE_URL:-https://knowledgebase.sarthakagrawal927.workers.dev}"
export RAG_SERVICE_KEY="<service-key>"

curl -s -X POST "$RAG_BASE_URL/v1/kb/query" \
  -H "Authorization: Bearer $RAG_SERVICE_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "project": "my-private-corpus",
    "domain": "research-papers",
    "question": "retrieval reranking evidence",
    "top_k": 5,
    "mode": "hybrid"
  }' | jq '{answer, citations, confidence}'
```
