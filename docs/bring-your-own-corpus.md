# Bring Your Own Corpus

This is the first-class product flow: bring specialized private material, infer
the shape of the corpus, confirm it, ingest it, then expose cited search to
agents.

Good starting corpora:

- research papers;
- company private information;
- manuals and SOPs;
- contracts and policies;
- private notes;
- spreadsheets or JSON records;
- small docs-site snapshots.
- future company-memory exports such as Slack threads, Linear issues, meeting
  transcripts, support tickets, and internal docs.

SaaS connectors are not required for the core workflow, but they should fit the
same ingestion shape later: collect source objects, normalize them into files or
records, preserve source metadata, infer or confirm schema, ingest, and return
cited search results.

## Flow

1. Create a project.
2. Choose a kind key such as `research-papers`, `company-info`, or `contracts`.
3. Upload a few representative files or paste representative text.
4. Call schema inference.
5. Review and edit the schema.
6. Apply the confirmed schema.
7. Ingest the staged files.
8. Use `/search` for ranked cited evidence or `/query` for cited answers.
9. Run `/search/eval` against your expected source files.

## API Flow

Infer from representative files:

```bash
curl -s -X POST http://localhost:8000/schemas/infer/files \
  -F project=my-private-corpus \
  -F domain=research-papers \
  -F stage_files=true \
  -F "files=@paper-1.pdf" \
  -F "files=@paper-2.pdf" \
  | jq '{domain, sample_count, staged_files: (.staged_files | length), spec}'
```

Apply the reviewed draft:

```bash
curl -s -X POST http://localhost:8000/schemas/drafts/$DRAFT_ID/apply \
  -H 'Content-Type: application/json' \
  -d '{"project":"my-private-corpus","ingest_staged_files":true}'
```

Ingest the staged files:

```bash
curl -s -X POST http://localhost:8000/ingest/run \
  -H 'Content-Type: application/json' \
  -d '{"project":"my-private-corpus","domain":"research-papers","force":false}'
```

Search the ingested corpus:

```bash
curl -s -X POST http://localhost:8000/search \
  -H 'Content-Type: application/json' \
  -d '{
    "project": "my-private-corpus",
    "domain": "research-papers",
    "query": "What evidence discusses reranking?",
    "top_k": 5
  }' | jq '.results[] | {rank, filename, page_start, excerpt}'
```

Check corpus state:

```bash
curl -s http://localhost:8000/projects/my-private-corpus/status | jq
```

Measure search quality:

```bash
curl -s -X POST http://localhost:8000/search/eval \
  -H 'Content-Type: application/json' \
  -d '{
    "project": "my-private-corpus",
    "domain": "research-papers",
    "questions": [
      {
        "id": "q1",
        "query": "What evidence discusses reranking?",
        "expected_files": ["paper-1.pdf"]
      }
    ]
  }' | jq '{mean_recall, mean_mrr, mean_precision}'
```

## Current Limitations

- Inference quality depends on representative sample files.
- Parsing scanned PDFs can be slow and depends on local OCR support.
- The UI does not yet show live parse progress during schema inference.
- Search snippets include highlights and neighboring context, but not facet
  explanations yet.
