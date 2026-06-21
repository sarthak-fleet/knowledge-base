# AGENTS.md — knowledgebase

## Shared Fleet Standard

Also read and follow the shared fleet-level agent standard at `../AGENTS.md`. Treat this repository as owned product code: protect production stability, keep changes scoped, verify work, and record durable follow-up tasks when something remains incomplete or blocked.

## Project

- **Stack**: Cloudflare Worker, Hono, Workers AI, Vectorize, D1, R2.
- **Local dev**: see README — Worker checks under `cloudflare/worker`.
- **Checks**: Worker test suite per README (`cd cloudflare/worker && pnpm run check`).
- **Do not** commit corpus secrets, API keys, or private document paths.
