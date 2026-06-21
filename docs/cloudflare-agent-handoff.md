# Cloudflare Migration Agent Handoff

Last updated: 2026-06-21

## Migration Complete (2026-06-21)

All three remaining blockers are resolved and `pnpm run gaps:full-port` reports
**0 remaining**:

1. **Deployed Worker cutover** — the current `cloudflare/worker` is deployed
   (version `418b60d7-5901-40e1-8948-a92d56cab351`); `smoke:legacy-routes
   --require-complete` confirms the live fingerprint
   `knowledgebase-cloudflare-full-port-2026-06-21`, public aliases return 200,
   protected aliases return 401.
2. **Live scanned-PDF OCR** — `readiness:full-port` with `RAG_ALLOW_LIVE_OCR=1`
   passed `nvda-scanned-ocr-live` (pass_rate 1) on the deployed Worker.
3. **Sibling `rag-service` retirement** — `readiness:sibling-retirement` passed,
   `../rag-service` was deleted (source-only archive at
   `../rag-service-retired-2026-06-21.tgz`), and `audit:sibling-rag-service
   --require-retired` reports `retirement_ok: true` / `sibling_exists: false`.

Verification used a temporary key in `RAG_SERVICE_KEYS_APPEND`, which was deleted
after the gates passed; only the primary `RAG_SERVICE_KEYS` map is active. The
local suite is green (typecheck + 158 tests). The remaining sections below are
retained as historical context for how the cutover was executed.

## Objective

Continue making Knowledgebase the only fleet RAG service, with all runtime functionality ported to Cloudflare and no separate `../rag-service` codebase remaining after the final gates pass.

The target remains 100% feature parity with the old Knowledgebase RAG system, hosted end to end on Cloudflare, with equal or better speed. Runtime code should be TypeScript on Cloudflare Workers. Python has been removed from the product runtime in this worktree.

## Current State

- Canonical implementation: `cloudflare/worker`.
- Stack: Cloudflare Workers, Hono, Workers AI, Vectorize, D1, R2, Queues, Workflows.
- The old root Python runtime has been removed from the working tree.
- The Cloudflare Worker port includes ingestion, schema inference, hosted custom input/testing UI, direct structured-record and schema-free inline domain-text ingestion controls, hybrid retrieval, query streaming, traces, evals, parser tooling, migration tooling, and legacy route aliases.
- `/v1/kb/ingest/record` now auto-infers and activates a schema when the requested domain has no active schema. Dedicated Worker app coverage proves both the no-type inferred schema path and the explicit-type schema rename/alias path.
- The sibling folder `../rag-service` still exists and must not be deleted until the documented gates pass and the user explicitly approves deletion.
- The deployed Worker at `https://knowledgebase.sarthakagrawal927.workers.dev` is not current. A read-only legacy-route smoke on 2026-06-21 showed root compatibility aliases still return 404 and the expected deploy fingerprint is missing.
- The no-external-reference audit is now separated from full sibling-retirement readiness: `pnpm run audit:no-external-rag-service-references -- --json` reports `ok: true` when external fleet repos no longer actively point at the old service, while `retirement_ok: false` remains until `../rag-service` is actually removed. The audit catches old `rag-service` Worker bindings and URLs across JSON/JSONC, JS/TS, TOML, YAML, and env-style `RAG_*` config references.
- The sibling-retirement readiness gate now verifies the static gap matrix agrees with the filesystem audit: `sibling_rag_service_retirement` must be open while `../rag-service` exists and closed after the folder is removed.

## Non-Negotiable Rules

- Do not deploy, migrate, delete, commit, push, or release unless the user explicitly asks.
- Do not touch secrets, `.env` files, cloud credentials, SSH keys, kube configs, or production config.
- Do not run live OCR or Workers AI cost-bearing gates unless explicitly allowed. Use `RAG_ALLOW_LIVE_OCR=1` or `--allow-live-ocr` only after the user approves.
- Do not delete `../rag-service` until the sibling retirement readiness gate passes and the user explicitly asks for deletion.

## Continuation Snapshot

Work has resumed after the earlier pause. Continue local parity work freely, but keep the guarded operations explicit.

The next agent should treat this as an in-progress local migration branch, not a clean completed port:

- `cloudflare/worker` is the canonical implementation and is still untracked in git.
- The root Python runtime, Streamlit UI, Docker runtime, and root pytest suite are deleted in the working tree.
- `../rag-service` still exists and must stay until readiness gates pass plus explicit deletion approval.
- The deployed Worker is stale relative to local code.
- The record-ingest auto-schema code now has dedicated route tests in `cloudflare/worker/tests/app.test.ts`.
- The existing Worker app suite, TypeScript typecheck, gap report, and whitespace check were run after the continuation docs and route edits; they passed except the gap report remains `ok: false` because three documented full-port gaps remain.

Do not assume `git diff` shows all Cloudflare Worker changes, because the Worker tree is currently untracked. Inspect files directly under `cloudflare/worker`.

## Remaining Blockers

### 1. Deployed Worker Cutover

Local Worker code has the compatibility aliases, but the live Worker still appears stale.

Observed readiness failure:

- `/v1/healthz` public health responded.
- Auth with a fake key returned 401, as expected.
- Root aliases such as `/healthz`, `/readyz`, `/metrics`, `/domains`, `/search`, `/query`, `/query/stream`, and `/query/traces` returned 404 on the deployed Worker.
- The expected deploy fingerprint was not present.

Expected fingerprint:

```text
knowledgebase-cloudflare-full-port-2026-06-21
```

Next action after explicit deploy approval:

```bash
cd cloudflare/worker
pnpm run deploy:dry-run
pnpm run deploy
pnpm run smoke:legacy-routes -- --base-url "$RAG_BASE_URL" --require-complete
```

### 2. OCR And Office Parsing Proof

Local no-cost dry-run proves that the NVDA scanned-PDF OCR eval payload can be built. Live deployed OCR parity is not proven yet.

The readiness scripts intentionally skip live OCR until the deployed alias/fingerprint checks prove the live Worker is current. This avoids spending Workers AI calls against stale code.

Next action after deployed Worker cutover and explicit live OCR approval:

```bash
cd cloudflare/worker
RAG_ALLOW_LIVE_OCR=1 RAG_SERVICE_KEY=<service-key> pnpm run readiness:full-port
```

If the live OCR gate fails, decide whether to:

- accept Markdown Conversion description quality,
- tune the Cloudflare vision model chain,
- or add a non-default OCR fallback.

### 3. Sibling `rag-service` Retirement

`../rag-service` still exists as a separate deployable codebase. The latest audit found no active external fleet references, but the folder still has package, Wrangler, source, script, migration, test, and fixture surfaces.

Current read-only external-reference proof:

```bash
cd cloudflare/worker
pnpm run audit:no-external-rag-service-references -- --json
```

Expected current result before deletion:

- `ok: true`
- `gate: "external_rag_service_references"`
- `external_reference_gate_ok: true`
- `retirement_ok: false`
- `retirement_blockers`: `sibling_directory_exists`, `sibling_deployable_surfaces_exist`

Before deletion, run the read-only retirement gate:

```bash
cd cloudflare/worker
RAG_ALLOW_LIVE_OCR=1 RAG_SERVICE_KEY=<service-key> pnpm run readiness:sibling-retirement
pnpm run audit:sibling-rag-service -- --json --require-retired
```

Only after the user explicitly approves deletion should another agent remove `../rag-service`.

After deletion, update `cloudflare/full-port-gaps.json` in the same finishing
slice. `readiness:sibling-retirement` will fail `sibling-retirement-gap-matches-audit`
if the folder and static gap matrix disagree.

## Static Gap Matrix Warning

`cloudflare/full-port-gaps.json` is a static status file. The `gaps:full-port` script reads it; it does not infer live status.

Current partial items:

- `deployed_worker_cutover`
- `ocr_and_office_parsing`
- `sibling_rag_service_retirement`

After successful live deploy and OCR proof, update `cloudflare/full-port-gaps.json`, `PROJECT_STATUS.md`, `README.md`, `cloudflare/worker/README.md`, and `docs/cloudflare-full-port.md` so docs and gates match reality. After `../rag-service` is deleted, update the sibling retirement item too.

## Safe Resume Commands

No-cost local verification:

```bash
cd cloudflare/worker
pnpm run predeploy:local -- --json
pnpm run gaps:full-port -- --json
pnpm run smoke:legacy-routes -- --base-url https://knowledgebase.sarthakagrawal927.workers.dev --json
```

Full local Worker check:

```bash
cd cloudflare/worker
pnpm run check
```

Whitespace check from repo root:

```bash
git diff --check
```

Deploy path, only after explicit user approval:

```bash
cd cloudflare/worker
pnpm run deploy:dry-run
pnpm run deploy
pnpm run smoke:legacy-routes -- --base-url "$RAG_BASE_URL" --require-complete
```

Full readiness path, only after explicit live OCR approval:

```bash
cd cloudflare/worker
RAG_ALLOW_LIVE_OCR=1 RAG_SERVICE_KEY=<service-key> pnpm run readiness:full-port
```

Sibling retirement path, only after the full readiness gate passes:

```bash
cd cloudflare/worker
RAG_ALLOW_LIVE_OCR=1 RAG_SERVICE_KEY=<service-key> pnpm run readiness:sibling-retirement
pnpm run audit:sibling-rag-service -- --json --require-retired
```

## Recent Verification Evidence

Latest known checks:

- `pnpm test -- tests/app.test.ts` passed after adding dedicated direct-record auto-schema coverage; Vitest ran 18 files / 158 tests.
- `pnpm run typecheck` passed after adding dedicated direct-record auto-schema coverage.
- `pnpm run check` passed after adding dedicated direct-record auto-schema coverage; Vitest ran 18 files / 158 tests.
- `pnpm run predeploy:local -- --json` passed after adding dedicated direct-record auto-schema coverage. It ran Worker check, preflight, Python runtime retirement audit, no-external-`rag-service` reference audit, NVDA scanned-PDF dry-run, local cutover smoke, and Wrangler deploy dry-run.
- `pnpm run gaps:full-port -- --json` ran and correctly reported `ok: false` with three remaining gaps: `sibling_rag_service_retirement`, `deployed_worker_cutover`, and `ocr_and_office_parsing`.
- `pnpm run smoke:legacy-routes -- --base-url https://knowledgebase.sarthakagrawal927.workers.dev --json` ran read-only against the deployed Worker and correctly reported `ok: false`: `/healthz`, `/readyz`, `/metrics`, `/domains`, `/search`, `/agent/search`, `/search/eval`, `/query`, `/query/stream`, and `/query/traces` returned 404, with no deploy fingerprint.
- `pnpm test -- tests/predeploy-local.test.ts tests/full-port-gaps.test.ts` passed after the continuation documentation cleanup; Vitest ran 18 files / 158 tests under the current config.
- `git diff --check` passed after the continuation documentation updates.

Earlier checks before the record-ingest auto-schema edit:

- `pnpm run predeploy:local -- --json` passed after the direct-text ingest change; it ran Worker check, preflight, Python retirement audit, no-external-`rag-service` reference audit, NVDA scanned-PDF dry-run, local cutover smoke, and Wrangler deploy dry-run.
- `pnpm test -- tests/app.test.ts` passed after exposing `/v1/kb/ingest/record` and `/v1/kb/ingest/text` in the hosted testing UI and making `/v1/kb/ingest/text` index inline by default without an active schema while preserving explicit `async: true` queued staging; Vitest ran 18 files / 158 tests under the current config.
- `pnpm run smoke:legacy-routes -- --base-url https://knowledgebase.sarthakagrawal927.workers.dev --json` failed as expected because the deployed Worker still returns 404 for root legacy aliases and lacks the expected fingerprint.
- `pnpm run audit:no-external-rag-service-references -- --json` passed the external-reference gate and reported `retirement_ok: false` because the sibling folder still exists.
- `pnpm test -- tests/audit-sibling-rag-service.test.ts` passed after expanding external-reference detection to JS/TOML/YAML/env-style config shapes; Vitest ran 18 files / 158 tests under the current config.
- `pnpm test -- tests/sibling-retirement-readiness.test.ts` passed after adding the matrix/filesystem consistency check; Vitest ran 18 files / 156 tests under the current config.
- `pnpm run readiness:sibling-retirement -- --key fake-readiness-key --json` failed as expected on stale deploy/OCR/full-port gaps, while the new `sibling-retirement-gap-matches-audit` check passed for the current state.
- `pnpm run check` passed after the direct-text ingest change; 18 files / 158 tests.
- `git diff --check` passed after the latest route, test, and doc updates.
- `pnpm run readiness:full-port -- --key fake-readiness-key --json` failed as expected because the deployed Worker is stale and the sibling folder still exists.

Direct-record auto-schema coverage now proves:

- an existing active schema returns `schema_auto_created: false` and still indexes structured records;
- a new structured domain with no `type` returns `schema_auto_created: true`, infers `TicketRecord`, persists the active schema, writes raw/parse R2 artifacts, and exposes D1 entities;
- a new structured domain with explicit `type: "Incident"` returns `schema_auto_created: true`, renames the inferred primary entity while preserving `IncidentRecord` as an alias, persists the active schema, and exposes D1 entities.

Expected failure details:

- deployed legacy route parity: failed with 404s
- deploy fingerprint: missing
- live OCR: skipped until current deployment is proven
- sibling retirement: failed because `../rag-service` still exists

## Important Files And Scripts

- `cloudflare/worker/src/index.ts`: Worker routes, legacy aliases, deploy fingerprint in health/ready/metrics.
- `cloudflare/worker/scripts/predeploy-local.mjs`: no-cost predeploy gate, including scanned-PDF dry-run and external reference gate.
- `cloudflare/worker/scripts/deploy-readiness.mjs`: deployed readiness gate, auth, legacy aliases, fingerprint, OCR guard.
- `cloudflare/worker/scripts/sibling-retirement-readiness.mjs`: read-only pre-delete readiness gate.
- `cloudflare/worker/scripts/audit-sibling-rag-service.mjs`: reports remaining sibling surfaces and external references; CLI output distinguishes external-reference clearance from full retirement readiness.
- `cloudflare/worker/scripts/smoke-legacy-routes.mjs`: deployed legacy route smoke.
- `cloudflare/worker/scripts/smoke-local-cutover.mjs`: local Wrangler alias/fingerprint smoke.
- `cloudflare/worker/scripts/full-port-gaps.mjs`: static gap report from `cloudflare/full-port-gaps.json`.
- `cloudflare/full-port-gaps.json`: source of truth for documented parity gaps.
- `docs/cloudflare-full-port.md`: migration and feature parity status.
- `PROJECT_STATUS.md`: top-level project state.

## Worktree Notes

The worktree is intentionally large because this is a full migration:

- deleted root Python runtime and tests are present in `git status`;
- `cloudflare/worker` is untracked in this branch/worktree;
- `.env.example` is modified, but real env files and secrets should not be touched;
- `docs/cloudflare-agent-handoff.md` is the pause/takeover document.

Before doing anything broad, the next agent should inspect:

```bash
git status --short
git diff --stat
cd cloudflare/worker && pnpm run gaps:full-port -- --json
```

## Recommended Next Agent Order

1. Re-run no-cost local checks if any new implementation edits land.
2. Confirm no new user changes conflict with the migration files.
3. Ask for explicit deploy approval if the user wants live cutover.
4. Deploy only the `cloudflare/worker` Worker after dry-run passes.
5. Run deployed legacy route smoke and fingerprint check.
6. Ask for explicit live OCR approval if the user wants scanned-PDF parity proof.
7. Run `readiness:full-port` with the real service key and OCR opt-in.
8. Update docs and `cloudflare/full-port-gaps.json` to mark proven items done.
9. Ask for explicit deletion approval before removing `../rag-service`.
10. After deletion, run sibling retirement audit and update docs again.
