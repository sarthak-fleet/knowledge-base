import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8')) as {
  scripts?: Record<string, string>;
};

describe('package scripts', () => {
  it('keeps a named local predeploy gate', () => {
    expect(pkg.scripts?.['predeploy:local']).toBe(
      'node scripts/predeploy-local.mjs',
    );
  });

  it('keeps a named live embedding-model readiness gate', () => {
    expect(pkg.scripts?.['readiness:embedding-model']).toBe(
      'node scripts/deploy-readiness.mjs --require-auth --require-embedding-model gemini-embedding-001',
    );
  });

  it('keeps a named mutating embedding-model RAG CRUD smoke gate', () => {
    expect(pkg.scripts?.['smoke:rag-crud:embedding-model']).toBe(
      'node scripts/smoke-rag-crud.mjs --embedding-model gemini-embedding-001 --include-kb-domain --require-complete',
    );
  });

  it('keeps a named Vectorize binding availability audit for embedding selection', () => {
    expect(pkg.scripts?.['audit:vectorize-embedding-bindings']).toBe(
      'node scripts/audit-vectorize-embedding-bindings.mjs',
    );
  });

  it('keeps a named read-only Vectorize metadata index audit for safe filters', () => {
    expect(pkg.scripts?.['audit:vectorize-metadata-indexes']).toBe(
      'node scripts/audit-vectorize-metadata-indexes.mjs',
    );
  });

  it('keeps a named embedding-model production release plan', () => {
    expect(pkg.scripts?.['release-plan:embedding-model']).toBe(
      'node scripts/embedding-model-release-plan.mjs',
    );
  });

  it('keeps a named local consumer Cloudflare build gate', () => {
    expect(pkg.scripts?.['build:consumer-cloudflare']).toBe(
      'node scripts/consumer-cloudflare-builds.mjs',
    );
  });

  it('keeps a named read-only embedding-model production release status gate', () => {
    expect(pkg.scripts?.['release-status:embedding-model']).toBe(
      'node scripts/embedding-model-release-status.mjs',
    );
  });

  it('keeps a named read-only operator report', () => {
    expect(pkg.scripts?.['operator:report']).toBe(
      'node scripts/operator-report.mjs',
    );
  });

  it('keeps a named RAG benchmark evidence command', () => {
    expect(pkg.scripts?.['benchmark:rag']).toBe(
      'node scripts/benchmark-rag.mjs',
    );
  });

  it('keeps a named A plus proof bundle command', () => {
    expect(pkg.scripts?.['proof:a-plus']).toBe(
      'node scripts/a-plus-proof.mjs',
    );
  });

  it('keeps a named S-grade scorecard command', () => {
    expect(pkg.scripts?.['scorecard:s']).toBe(
      'node scripts/a-plus-scorecard.mjs --require-grade S',
    );
  });

  it('keeps a named S-grade proof bundle command', () => {
    expect(pkg.scripts?.['proof:s']).toBe(
      'node scripts/a-plus-proof.mjs --require-grade S --input fixtures/s-grade-consumer-evals.json --repeat 8',
    );
  });

  it('keeps a named authenticated consumer smoke command', () => {
    expect(pkg.scripts?.['smoke:consumer-auth']).toBe(
      'node scripts/consumer-auth-smokes.mjs',
    );
  });

  it('keeps a named typed client contract audit', () => {
    expect(pkg.scripts?.['audit:client-contract']).toBe(
      'node scripts/audit-client-contract.mjs',
    );
  });
});
