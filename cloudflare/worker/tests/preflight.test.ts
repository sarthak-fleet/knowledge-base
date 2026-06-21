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
      expect.objectContaining({ name: 'relational_store', severity: 'ok' }),
      expect.objectContaining({ name: 'object_store', severity: 'ok' }),
      expect.objectContaining({ name: 'ingest_queue', severity: 'ok' }),
      expect.objectContaining({ name: 'ingest_workflow', severity: 'ok' }),
      expect.objectContaining({ name: 'legacy_route_parity', severity: 'ok' }),
      expect.objectContaining({ name: 'python_runtime_retirement', severity: 'ok' }),
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
});
