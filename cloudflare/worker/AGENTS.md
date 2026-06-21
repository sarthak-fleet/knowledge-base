# AGENTS.md — knowledgebase Cloudflare Worker

## Shared Fleet Standard

Also read and follow the shared fleet-level agent standard at `../AGENTS.md`. Treat this repository as owned product code: protect production stability, keep changes scoped, verify work, and record durable follow-up tasks when something remains incomplete or blocked.

## Project

- **Stack**: Cloudflare Worker, Hono, Workers AI embeddings, Vectorize, D1, R2.
- **Local checks**: `pnpm install` · `pnpm check` · `pnpm run readiness`
- **Deploy**: `wrangler deploy` (requires Cloudflare bindings/secrets — ask before touching prod).
