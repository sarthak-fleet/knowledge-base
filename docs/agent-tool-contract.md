# Agent Tool Contract

This service exposes a private, cited search layer for agents. Use it when the
agent needs evidence from a project-specific corpus that is not on the open web.

## Choose The Endpoint

Use `POST /search` when the agent needs evidence to reason with:

- ranking documents or excerpts;
- collecting citations before writing;
- comparing multiple sources;
- avoiding answer synthesis inside the KB service.

Use `POST /query` when the user asked for a direct answer and the KB service
should synthesize it:

- cited natural-language answer;
- confidence reason;
- trace ID for audit;
- conversational follow-up through `session_id`.

## Search Request

```json
{
  "project": "my-private-corpus",
  "domain": "research-papers",
  "kinds": ["research-papers"],
  "query": "What evidence supports using retrieval reranking?",
  "top_k": 8,
  "filters": {
    "year": 2025
  },
  "scope": {
    "file_id": "optional-file-id"
  }
}
```

`project` is the corpus namespace. `domain` is the primary kind. `kinds` lets an
agent search multiple kinds in the same project. `filters` and `scope` are
payload filters applied during retrieval.

## Search Response

```json
{
  "project": "my-private-corpus",
  "domain": "research-papers",
  "kinds": ["research-papers"],
  "query": "What evidence supports using retrieval reranking?",
  "results": [
    {
      "rank": 1,
      "score": 0.82,
      "kind": "research-papers",
      "node_id": "chunk-id",
      "file_id": "file-id",
      "filename": "paper.pdf",
      "page_start": 4,
      "page_end": 5,
      "excerpt": "The reranker improved precision on hard negatives...",
      "context_before": "The baseline retriever returned broad topical matches.",
      "context_after": "The ablation showed lower recall when reranking was disabled.",
      "highlights": ["reranker", "precision"],
      "entity_id": "optional-entity-id",
      "metadata": {}
    }
  ]
}
```

The agent should treat each result as evidence, not as a final answer. If it
uses a fact from a result, it should carry the `filename`, page range, and
excerpt forward into its response. `context_before`, `context_after`, and
`highlights` are supporting fields for deciding whether the excerpt is relevant;
the excerpt remains the citeable unit.

## Empty Results

If `/search` returns no results, the agent should not invent an answer. It can:

- ask the user for a narrower query;
- search a different kind in the same project;
- ask the user to upload or ingest more documents;
- call `/query` only if answer synthesis is still useful with the available
  evidence.

## Minimal Tool Description

```text
Search a private project corpus. Returns ranked evidence with filename, page
range, exact excerpt, kind, score, and metadata. Use this before answering
questions that require facts from private or specialized documents.
```

## Curl Example

```bash
curl -s -X POST http://localhost:8000/search \
  -H 'Content-Type: application/json' \
  -d '{
    "project": "my-private-corpus",
    "domain": "research-papers",
    "kinds": ["research-papers"],
    "query": "retrieval reranking evidence",
    "top_k": 5
  }' | jq '.results[] | {rank, filename, page_start, excerpt}'
```
