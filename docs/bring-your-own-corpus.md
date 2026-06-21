# Bring Your Own Corpus

The active product flow runs through the Cloudflare Worker.

Good starting corpora:

- research papers;
- company private information;
- manuals and SOPs;
- contracts and policies;
- private notes;
- spreadsheets or JSON records;
- docs-site snapshots.

## Flow

1. Pick a project and domain key.
2. Upload files through Worker `/ui` or `/v1/kb/files/upload`.
3. Confirm or apply a schema draft.
4. Run queued ingestion.
5. Query through `/v1/kb/query`.
6. Use eval reports to track retrieval, answer, and parser quality.

## API Skeleton

```bash
export RAG_BASE_URL="${RAG_BASE_URL:-https://knowledgebase.sarthakagrawal927.workers.dev}"
export RAG_SERVICE_KEY="<service-key>"

curl -s -X POST "$RAG_BASE_URL/v1/kb/query" \
  -H "Authorization: Bearer $RAG_SERVICE_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "project": "my-private-corpus",
    "domain": "research-papers",
    "question": "What evidence discusses reranking?",
    "top_k": 5,
    "mode": "hybrid"
  }' | jq '{answer, citations, confidence}'
```

Use the Worker `/ui` for upload, schema review, ingest progress, traces, and eval
reports when working interactively.

## Current Limitations

- Live scanned-PDF exact OCR parity is still a full-port blocker.
- Inference quality depends on representative sample files.
- Authenticated Worker checks require `RAG_SERVICE_KEY`.
