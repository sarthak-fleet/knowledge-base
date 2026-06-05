# Personal Hosting Runbook

This is the safe path to make the service usable for yourself. It avoids
enterprise concerns such as multi-tenant ACLs and connector sync.

## What To Host

Minimum services:

- FastAPI app;
- worker process;
- Postgres;
- Qdrant;
- object storage compatible with S3 or the local object-store adapter;
- Streamlit UI, optional but useful for onboarding corpora.

## Pre-Deploy Checklist

- Pick a single personal deployment target.
- Provision persistent Postgres storage.
- Provision persistent Qdrant storage.
- Provision persistent object storage.
- Configure backups for Postgres and object storage.
- Set model/API secrets outside the repo.
- Set resource limits for worker concurrency and model cache size.
- Confirm `/readyz` passes.
- Run a project-local smoke: create project, infer draft, apply schema, ingest,
  search, query.

## Required Environment

Do not commit these values. Set them in the host's secret manager or local
service environment:

```text
AI_API_KEY
AI_BASE_URL
AI_MODEL
KB_POSTGRES_DSN
KB_QDRANT_URL
KB_MINIO_ENDPOINT or object-store equivalent
KB_EMBED_MODEL
KB_EMBED_DIM
```

## Smoke Test

After deploy:

```bash
curl -fsS "$KB_API_URL/readyz" | jq
```

Create a project:

```bash
curl -fsS -X POST "$KB_API_URL/projects" \
  -H 'Content-Type: application/json' \
  -d '{"name":"personal-docs","description":"Personal private corpus"}' | jq
```

Infer from representative files:

```bash
curl -fsS -X POST "$KB_API_URL/schemas/infer/files" \
  -F project=personal-docs \
  -F domain=research-papers \
  -F stage_files=true \
  -F "files=@sample.pdf" | jq '{draft_id, sample_count, staged_files: (.staged_files | length)}'
```

Apply the draft through the UI or:

```bash
curl -fsS -X POST "$KB_API_URL/schemas/drafts/$DRAFT_ID/apply" \
  -H 'Content-Type: application/json' \
  -d '{"project":"personal-docs","ingest_staged_files":true}' | jq
```

Watch status:

```bash
curl -fsS "$KB_API_URL/projects/personal-docs/status" | jq
```

Search:

```bash
curl -fsS -X POST "$KB_API_URL/search" \
  -H 'Content-Type: application/json' \
  -d '{
    "project":"personal-docs",
    "domain":"research-papers",
    "query":"What is this corpus about?",
    "top_k":5
  }' | jq '.results[] | {filename, page_start, excerpt, highlights}'
```

## Deployment Boundary

Do not host this as a public multi-user product yet unless you add:

- authentication;
- per-project authorization;
- upload limits;
- rate limits per endpoint;
- job cancellation;
- backup restore drills;
- log redaction checks.

For personal use, keep it behind a private network, VPN, or authenticated
reverse proxy.
