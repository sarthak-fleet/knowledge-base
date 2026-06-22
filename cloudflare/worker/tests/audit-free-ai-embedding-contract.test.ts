import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditFreeAiEmbeddingContract } from '../scripts/audit-free-ai-embedding-contract.mjs';

function makeFreeAiRepo() {
  const freeAiRepo = mkdtempSync(resolve(tmpdir(), 'kb-free-ai-contract-'));
  return {
    freeAiRepo,
    cleanup: () => rmSync(freeAiRepo, { recursive: true, force: true }),
  };
}

function write(path: string, content: string) {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

function writeHealthyFreeAi(repo: string) {
  write(resolve(repo, 'package.json'), JSON.stringify({
    scripts: {
      deploy: 'pnpm audit:cloudflare-costs && wrangler deploy',
      'audit:cloudflare-costs': 'node scripts/audit-cloudflare-costs.mjs',
      'smoke:embedding-models': 'node scripts/smoke-embedding-models.mjs',
    },
  }));
  write(resolve(repo, 'scripts/smoke-embedding-models.mjs'), 'export {};\n');
  write(resolve(repo, 'test/embedding-model-smoke.spec.ts'), [
    'it("passes when the required embedding model is enabled", () => {});',
    'it("matches aliases for OpenAI-compatible embedding names", () => {});',
    'expect(report.selected?.supports_dimensions).toBe(true);',
    'expect(report.selected?.aliases).toContain("text-embedding-3-small");',
    'it("fails when the required embedding model is disabled", () => {});',
    'it("fails when the deployed catalog has no embedding rows", () => {});',
  ].join('\n'));
  write(resolve(repo, 'src/index.ts'), `
const EMBEDDING_CANDIDATES = [
  { provider: 'gemini', model: 'gemini-embedding-001', dimensions: 1536, supportsDimensions: true, aliases: ['text-embedding-3-small', 'text-embedding-3-large', 'text-embedding-004'], priority: 0.95 },
  { provider: 'voyage_ai', model: 'voyage-3.5-lite', dimensions: 1024, priority: 0.91 },
  { provider: 'voyage_ai', model: 'voyage-3-lite', dimensions: 1024, priority: 0.88 },
  { provider: 'workers_ai', model: '@cf/baai/bge-large-en-v1.5', dimensions: 1024, priority: 0.87 },
  { provider: 'workers_ai', model: '@cf/baai/bge-base-en-v1.5', dimensions: 768, priority: 0.85 },
  { provider: 'workers_ai', model: '@cf/baai/bge-small-en-v1.5', dimensions: 384, priority: 0.80 },
];
const embeddings = EMBEDDING_CANDIDATES.map((candidate) => ({
  type: 'embedding' as const,
  enabled: embeddingCandidateEnabled(env, candidate),
  dimensions: candidate.dimensions,
  supports_dimensions: candidate.supportsDimensions ?? false,
  aliases: candidate.aliases ?? [],
  priority: candidate.priority,
}));
`);
}

describe('audit-free-ai-embedding-contract', () => {
  it('passes for the current sibling free-ai contract', () => {
    const report = auditFreeAiEmbeddingContract();

    expect(report.ok).toBe(true);
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'source_embedding_candidates',
      ok: true,
    }));
  });

  it('passes when the free-ai fixture exposes all embedding rows and smoke coverage', () => {
    const { freeAiRepo, cleanup } = makeFreeAiRepo();
    try {
      writeHealthyFreeAi(freeAiRepo);

      const report = auditFreeAiEmbeddingContract({ freeAiRepo });

      expect(report.ok).toBe(true);
      expect(report.blockers).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('fails when free-ai does not expose all required embedding candidates', () => {
    const { freeAiRepo, cleanup } = makeFreeAiRepo();
    try {
      writeHealthyFreeAi(freeAiRepo);
      write(resolve(freeAiRepo, 'src/index.ts'), `
const EMBEDDING_CANDIDATES = [
  { provider: 'gemini', model: 'gemini-embedding-001', dimensions: 1536, supportsDimensions: true, aliases: ['text-embedding-3-small', 'text-embedding-3-large', 'text-embedding-004'], priority: 0.95 },
];
const embeddings = EMBEDDING_CANDIDATES.map((candidate) => ({
  type: 'embedding' as const,
  enabled: embeddingCandidateEnabled(env, candidate),
  dimensions: candidate.dimensions,
  supports_dimensions: candidate.supportsDimensions ?? false,
  aliases: candidate.aliases ?? [],
  priority: candidate.priority,
}));
`);

      const report = auditFreeAiEmbeddingContract({ freeAiRepo });

      expect(report.ok).toBe(false);
      expect(report.blockers).toContainEqual(expect.objectContaining({
        name: 'source_embedding_candidates',
        ok: false,
        missing_models: expect.arrayContaining(['voyage-3.5-lite', '@cf/baai/bge-small-en-v1.5']),
      }));
    } finally {
      cleanup();
    }
  });

  it('fails when the live embedding catalog smoke script is absent', () => {
    const { freeAiRepo, cleanup } = makeFreeAiRepo();
    try {
      writeHealthyFreeAi(freeAiRepo);
      rmSync(resolve(freeAiRepo, 'scripts/smoke-embedding-models.mjs'));

      const report = auditFreeAiEmbeddingContract({ freeAiRepo });

      expect(report.ok).toBe(false);
      expect(report.blockers).toContainEqual(expect.objectContaining({
        name: 'smoke_embedding_models_script',
        ok: false,
        file: 'scripts/smoke-embedding-models.mjs',
      }));
    } finally {
      cleanup();
    }
  });

  it('fails when the free-ai deploy script is not cost-audited Cloudflare deploy', () => {
    const { freeAiRepo, cleanup } = makeFreeAiRepo();
    try {
      writeHealthyFreeAi(freeAiRepo);
      write(resolve(freeAiRepo, 'package.json'), JSON.stringify({
        scripts: {
          deploy: 'wrangler deploy',
          'smoke:embedding-models': 'node scripts/smoke-embedding-models.mjs',
        },
      }));

      const report = auditFreeAiEmbeddingContract({ freeAiRepo });

      expect(report.ok).toBe(false);
      expect(report.blockers).toContainEqual(expect.objectContaining({
        name: 'package_script_deploy_cloudflare',
        ok: false,
        file: 'package.json',
      }));
    } finally {
      cleanup();
    }
  });
});
