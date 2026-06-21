# Agent Integration Examples

Agents integrate with the Cloudflare Worker RAG service, not the retired local
Python API.

## Tool Contract

Name:

```text
private_corpus_query
```

Description:

```text
Query a private project corpus through the knowledgebase Cloudflare Worker.
Returns a cited answer, ranked evidence, filename/page excerpts, confidence, and
trace metadata. Use this before making factual claims about private documents.
```

Input schema:

```json
{
  "type": "object",
  "properties": {
    "project": {"type": "string"},
    "domain": {"type": "string"},
    "question": {"type": "string"},
    "top_k": {"type": "integer", "minimum": 1, "maximum": 50},
    "mode": {"type": "string", "enum": ["auto", "hybrid", "semantic", "lexical"]},
    "answer_mode": {"type": "string", "enum": ["extractive", "workers_ai"]}
  },
  "required": ["domain", "question"]
}
```

## TypeScript Wrapper

```ts
export async function privateCorpusQuery(input: {
  baseUrl: string;
  serviceKey: string;
  project?: string;
  domain: string;
  question: string;
  topK?: number;
}) {
  const response = await fetch(`${input.baseUrl.replace(/\/$/, "")}/v1/kb/query`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      project: input.project ?? "default",
      domain: input.domain,
      question: input.question,
      top_k: input.topK ?? 8,
      mode: "hybrid",
      answer_mode: "extractive",
    }),
  });
  if (!response.ok) throw new Error(`knowledgebase query failed: ${response.status}`);
  return response.json();
}
```

## Agent Policy

Use the tool before answering when the question depends on private project facts,
source excerpts, citations, document comparison, or domain-specific evidence. If
the tool returns no relevant evidence, say the corpus does not currently support
the answer.
