# Agent Integration Examples

Agents should call this service as a private evidence search tool. The tool
returns ranked citations; the agent remains responsible for reasoning and final
wording.

## Tool Contract

Name:

```text
private_corpus_search
```

Description:

```text
Search a private project corpus. Returns ranked evidence with filename, page
range, exact excerpt, neighboring context, highlights, kind, score, and
metadata. Use this before answering questions that require facts from private or
specialized documents.
```

Input schema:

```json
{
  "type": "object",
  "properties": {
    "project": {"type": "string"},
    "domain": {"type": "string"},
    "kinds": {"type": "array", "items": {"type": "string"}},
    "query": {"type": "string"},
    "top_k": {"type": "integer", "minimum": 1, "maximum": 50},
    "filters": {"type": "object"},
    "scope": {"type": "object"}
  },
  "required": ["project", "domain", "query"]
}
```

## HTTP Wrapper

```python
import httpx


def private_corpus_search(
    *,
    api_base: str,
    project: str,
    domain: str,
    query: str,
    kinds: list[str] | None = None,
    top_k: int = 8,
    filters: dict | None = None,
    scope: dict | None = None,
) -> dict:
    response = httpx.post(
        f"{api_base.rstrip('/')}/search",
        json={
            "project": project,
            "domain": domain,
            "kinds": kinds,
            "query": query,
            "top_k": top_k,
            "filters": filters,
            "scope": scope,
        },
        timeout=30,
    )
    response.raise_for_status()
    return response.json()
```

## Agent Policy

Use `/search` before answering when:

- the question depends on private project facts;
- the user asks for evidence, documents, pages, or source excerpts;
- the agent is comparing multiple documents;
- the agent is about to make a claim that should be cited.

Do not answer from memory when `/search` returns no evidence. Ask for more
documents, a narrower query, or a different project/kind.

When using a result, preserve:

- `filename`;
- `page_start` and `page_end`;
- `excerpt`;
- `context_before` / `context_after` when useful.

## Minimal Prompt Snippet

```text
You have access to private_corpus_search. Before making factual claims about
private or specialized documents, search the relevant project. In the final
answer, cite each used fact with the returned filename, page range, and excerpt.
If search returns no relevant evidence, say that the corpus does not currently
support the answer.
```

## Search Eval

Use `POST /search/eval` to measure the search tool directly:

```bash
curl -s -X POST http://localhost:8000/search/eval \
  -H 'Content-Type: application/json' \
  -d '{
    "project": "my-private-corpus",
    "domain": "research-papers",
    "kinds": ["research-papers"],
    "top_k": 8,
    "questions": [
      {
        "id": "q1",
        "query": "retrieval reranking evidence",
        "expected_files": ["paper-1.pdf"]
      }
    ]
  }' | jq '{mean_recall, mean_mrr, mean_precision, p95_latency_ms}'
```
