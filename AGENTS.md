# AGENTS.md — knowledgebase

## Shared Fleet Standard

Also read and follow the shared fleet-level agent standard at `../AGENTS.md`. Treat this repository as owned product code: protect production stability, keep changes scoped, verify work, and record durable follow-up tasks when something remains incomplete or blocked.

## Project

- **Stack**: Cloudflare Worker, Hono, Workers AI (embeddings + vision OCR), Vectorize, D1, R2.
- **Frontend surfaces**: `landing-astro/` (Astro marketing → CF Pages), `app/` (Next.js dashboard → CF Workers via OpenNext), Worker `/ui` (inline operator testing UI).
- **Repo shape**: monorepo with three independently-built packages — no root `package.json`. Each package has its own `pnpm-lock.yaml`.
- **Package manager**: pnpm in all three packages (`cloudflare/worker/`, `app/`, `landing-astro/`). No root workspace — install per package.

## Repo structure
```
cloudflare/worker/       # Hono Worker — RAG ingestion, search, parsing (pnpm)
  src/                   #   Worker source
  tests/                 #   Vitest suite
  scripts/               #   Benchmarks, audits, migration helpers
  migrations/            #   D1 migrations
  fixtures/              #   Sample inputs for scripts
app/                     # Next.js dashboard (pnpm) → CF Workers via OpenNext
landing-astro/           # Astro marketing site → CF Pages
data/                    # Local corpus / Minio bucket (gitignored)
migrations/              # Legacy migration artifacts
docs/                    # Design + learning docs
```

## Key commands
```bash
# Worker (from cloudflare/worker/)
pnpm install
pnpm dev                 # wrangler dev --local
pnpm check               # typecheck + vitest run
pnpm test                # vitest run
pnpm typecheck           # tsc --noEmit
pnpm deploy              # wrangler deploy (ask before touching prod)

# App (from app/)
pnpm install
pnpm dev                 # next dev
pnpm build               # next build
pnpm typecheck           # next typegen && tsc --noEmit

# Landing (from landing-astro/)
pnpm install
pnpm build               # astro build
pnpm preview             # astro preview
```

## Architecture notes
- **Worker is the RAG core**: Hono routes handle ingestion (parse → embed → store in Vectorize + D1 metadata) and search (vector + lexical). Workers AI for embeddings; vision models for OCR on scanned PDFs.
- **D1** stores document metadata; **Vectorize** stores embeddings; **R2** stores raw document bytes.
- **`app/`** is the operator dashboard (Next.js + OpenNext) — corpus management, eval results, ingest triggers.
- **`landing-astro/`** is the public marketing surface.
- **Do not** commit corpus secrets, API keys, or private document paths.
- **Do not** deploy or run migrations against prod without explicit approval.
