import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { runWorkerPreflight } from '../scripts/preflight.mjs';

async function writeConfig(config: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kb-worker-preflight-'));
  const path = join(dir, 'wrangler.jsonc');
  await writeFile(path, JSON.stringify(config, null, 2));
  return path;
}

describe('worker preflight', () => {
  it('accepts the current Cloudflare binding set', async () => {
    const result = await runWorkerPreflight();

    expect(result.ok).toBe(true);
    expect(result.errors).toBe(0);
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'ai_binding', severity: 'ok' }),
      expect.objectContaining({ name: 'vector_store', severity: 'ok' }),
      expect.objectContaining({ name: 'free_ai_service_binding', severity: 'ok' }),
      expect.objectContaining({ name: 'free_ai_default_embedding_config', severity: 'ok' }),
      expect.objectContaining({ name: 'vector_store_default_dimension', severity: 'ok' }),
      expect.objectContaining({ name: 'relational_store', severity: 'ok' }),
      expect.objectContaining({ name: 'object_store', severity: 'ok' }),
      expect.objectContaining({ name: 'ingest_queue', severity: 'ok' }),
      expect.objectContaining({ name: 'ingest_workflow', severity: 'ok' }),
      expect.objectContaining({ name: 'legacy_route_parity', severity: 'ok' }),
      expect.objectContaining({ name: 'python_runtime_retirement', severity: 'ok' }),
      expect.objectContaining({ name: 'd1_migrations', severity: 'ok' }),
    ]));
  });

  it('fails when required durable bindings are missing', async () => {
    const configPath = await writeConfig({
      ai: { binding: 'AI' },
      vectorize: [],
      d1_databases: [],
      r2_buckets: [],
    });

    const result = await runWorkerPreflight({ configPath });

    expect(result.ok).toBe(false);
    expect(result.errors).toBe(3);
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'vector_store', severity: 'error' }),
      expect.objectContaining({ name: 'relational_store', severity: 'error' }),
      expect.objectContaining({ name: 'object_store', severity: 'error' }),
    ]));
  });

  it('fails when free-ai embeddings are selected without a service binding or complete default model config', async () => {
    const configPath = await writeConfig({
      ai: { binding: 'AI' },
      vectorize: [{ binding: 'VECTORIZE' }],
      d1_databases: [{ binding: 'DB' }],
      r2_buckets: [{ binding: 'RAW_DOCS' }],
      vars: {
        RAG_EMBED_PROVIDER: 'free_ai',
        FREE_AI_EMBED_MODEL: '',
        FREE_AI_EMBED_PROVIDER: 'gemini',
        FREE_AI_EMBED_DIMENSIONS: '0',
      },
    });

    const result = await runWorkerPreflight({ configPath });

    expect(result.ok).toBe(false);
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'free_ai_service_binding',
        severity: 'error',
        message: 'RAG_EMBED_PROVIDER=free_ai requires the FREE_AI service binding',
      }),
      expect.objectContaining({
        name: 'free_ai_default_embedding_config',
        severity: 'error',
        detail: expect.stringContaining('FREE_AI_EMBED_MODEL is missing'),
      }),
      expect.objectContaining({
        name: 'free_ai_default_embedding_config',
        detail: expect.stringContaining('FREE_AI_EMBED_DIMENSIONS must be a positive integer'),
      }),
    ]));
  });

  it('fails when the default free-ai embedding dimensions do not match the bound Vectorize index name', async () => {
    const configPath = await writeConfig({
      ai: { binding: 'AI' },
      services: [{ binding: 'FREE_AI', service: 'free-ai-gateway' }],
      vectorize: [{ binding: 'VECTORIZE', index_name: 'rag-gemini-1536' }],
      d1_databases: [{ binding: 'DB' }],
      r2_buckets: [{ binding: 'RAW_DOCS' }],
      vars: {
        RAG_EMBED_PROVIDER: 'free_ai',
        FREE_AI_EMBED_MODEL: 'voyage-3.5-lite',
        FREE_AI_EMBED_PROVIDER: 'voyage_ai',
        FREE_AI_EMBED_DIMENSIONS: '1024',
      },
    });

    const result = await runWorkerPreflight({ configPath });

    expect(result.ok).toBe(false);
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: 'free_ai_service_binding',
        severity: 'ok',
      }),
      expect.objectContaining({
        name: 'free_ai_default_embedding_config',
        severity: 'ok',
      }),
      expect.objectContaining({
        name: 'vector_store_default_dimension',
        severity: 'error',
        message: 'default free-ai embedding dimensions 1024 do not match VECTORIZE index rag-gemini-1536',
      }),
    ]));
  });
});
