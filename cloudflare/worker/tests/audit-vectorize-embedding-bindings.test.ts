import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { auditVectorizeEmbeddingBindings } from '../scripts/audit-vectorize-embedding-bindings.mjs';

async function writeConfig(config: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kb-vectorize-bindings-'));
  const path = join(dir, 'wrangler.jsonc');
  await writeFile(path, JSON.stringify(config, null, 2));
  return path;
}

describe('audit-vectorize-embedding-bindings', () => {
  it('reports every free-ai embedding dimension as selectable when all Vectorize bindings are configured', () => {
    const report = auditVectorizeEmbeddingBindings();

    expect(report.ok).toBe(true);
    expect(report.configured_dimensions).toEqual([384, 768, 1024, 1536]);
    expect(report.selectable_models).toEqual(expect.arrayContaining([
      'gemini-embedding-001',
      'voyage-3.5-lite',
      '@cf/baai/bge-base-en-v1.5',
      '@cf/baai/bge-small-en-v1.5',
    ]));
    expect(report.blocked_models).toEqual([]);
    expect(report.missing_dimensions).toEqual([]);
    expect(report.provisioning_plan).toEqual([]);
  });

  it('passes strict mode when every required free-ai embedding dimension has a Vectorize binding', () => {
    const report = auditVectorizeEmbeddingBindings({ requireAll: true });

    expect(report.ok).toBe(true);
    expect(report.blockers).toEqual([]);
  });

  it('passes strict mode when all required embedding dimensions have matching Vectorize bindings', async () => {
    const configPath = await writeConfig({
      vectorize: [
        { binding: 'VECTORIZE', index_name: 'rag-gemini-1536' },
        { binding: 'VECTORIZE_1024', index_name: 'rag-embedding-1024' },
        { binding: 'VECTORIZE_768', index_name: 'rag-embedding-768' },
        { binding: 'VECTORIZE_384', index_name: 'rag-embedding-384' },
      ],
    });

    const report = auditVectorizeEmbeddingBindings({ configPath, requireAll: true });

    expect(report.ok).toBe(true);
    expect(report.missing_dimensions).toEqual([]);
    expect(report.blocked_models).toEqual([]);
    expect(report.provisioning_plan).toEqual([]);
  });

  it('fails when a configured Vectorize binding does not expose a parseable dimension', async () => {
    const configPath = await writeConfig({
      vectorize: [
        { binding: 'VECTORIZE', index_name: 'rag-gemini-1536' },
        { binding: 'VECTORIZE_1024', index_name: 'rag-voyage' },
      ],
    });

    const report = auditVectorizeEmbeddingBindings({ configPath });

    expect(report.ok).toBe(false);
    expect(report.blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        binding: 'VECTORIZE_1024',
        index_name: 'rag-voyage',
        blocker: 'Vectorize index name does not expose a trailing dimension',
      }),
    ]));
  });
});
