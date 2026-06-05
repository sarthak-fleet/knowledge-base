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

Slack, Google Drive, Notion, and similar connectors can be useful later, but
they are not required for the core workflow.

## Flow

1. Create a project.
2. Choose a kind key such as `research-papers`, `company-info`, or `contracts`.
3. Upload a few representative files or paste representative text.
4. Call schema inference.
5. Review and edit the schema.
6. Apply the confirmed schema.
7. Ingest the staged files.
8. Use `/search` for ranked cited evidence or `/query` for cited answers.

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

Apply the reviewed schema:

```bash
curl -s -X POST http://localhost:8000/schemas \
  -H 'Content-Type: application/json' \
  -d @confirmed-schema.json
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

## Current Limitations

- Pending inferred schemas live in the Streamlit session until they are applied.
- Inference quality depends on representative sample files.
- Parsing scanned PDFs can be slow and depends on local OCR support.
- The UI does not yet show live parse progress during schema inference.
- Search snippets do not yet include highlights or facet explanations.
