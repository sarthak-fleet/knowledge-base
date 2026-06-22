import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  auditVectorizeMetadataIndexes,
  parseMetadataIndexes,
} from '../scripts/audit-vectorize-metadata-indexes.mjs';

async function writeConfig(config: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'kb-vectorize-metadata-'));
  const path = join(dir, 'wrangler.jsonc');
  await writeFile(path, JSON.stringify(config, null, 2));
  return path;
}

function ok(stdout: unknown) {
  return { status: 0, stdout: JSON.stringify(stdout), stderr: '' };
}

describe('audit-vectorize-metadata-indexes', () => {
  it('passes when every configured Vectorize index has tenant and index_id string metadata indexes', async () => {
    const configPath = await writeConfig({
      vectorize: [{ binding: 'VECTORIZE', index_name: 'rag-gemini-1536' }],
    });
    const report = auditVectorizeMetadataIndexes({
      configPath,
      runner: (command) => {
        expect(command).toEqual([
          'pnpm',
          'exec',
          'wrangler',
          'vectorize',
          'list-metadata-index',
          'rag-gemini-1536',
          '--json',
        ]);
        return ok({
          result: [
            { propertyName: 'tenant', type: 'string' },
            { propertyName: 'index_id', type: 'string' },
          ],
        });
      },
    });

    expect(report.ok).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.indexes[0]).toMatchObject({
      binding: 'VECTORIZE',
      index_name: 'rag-gemini-1536',
      ok: true,
    });
  });

  it('fails when a required metadata index is missing', async () => {
    const configPath = await writeConfig({
      vectorize: [{ binding: 'VECTORIZE', index_name: 'rag-gemini-1536' }],
    });
    const report = auditVectorizeMetadataIndexes({
      configPath,
      runner: () => ok([{ property_name: 'tenant', type: 'string' }]),
    });

    expect(report.ok).toBe(false);
    expect(report.blockers).toEqual([
      expect.objectContaining({
        binding: 'VECTORIZE',
        index_name: 'rag-gemini-1536',
        missing_metadata_indexes: [{ property_name: 'index_id', type: 'string' }],
        remediation_commands: [[
          'pnpm',
          'exec',
          'wrangler',
          'vectorize',
          'create-metadata-index',
          'rag-gemini-1536',
          '--propertyName',
          'index_id',
          '--type',
          'string',
        ]],
      }),
    ]);
  });

  it('fails when wrangler returns an error for a configured index', async () => {
    const configPath = await writeConfig({
      vectorize: [{ binding: 'VECTORIZE_1024', index_name: 'rag-embedding-1024' }],
    });
    const report = auditVectorizeMetadataIndexes({
      configPath,
      runner: () => ({ status: 1, stdout: '', stderr: 'not authenticated' }),
    });

    expect(report.ok).toBe(false);
    expect(report.indexes[0]).toMatchObject({
      ok: false,
      error: 'not authenticated',
      missing_metadata_indexes: [
        { property_name: 'tenant', type: 'string' },
        { property_name: 'index_id', type: 'string' },
      ],
    });
  });

  it('fails when wrangler JSON is invalid', async () => {
    const configPath = await writeConfig({
      vectorize: [{ binding: 'VECTORIZE', index_name: 'rag-gemini-1536' }],
    });
    const report = auditVectorizeMetadataIndexes({
      configPath,
      runner: () => ({ status: 0, stdout: 'not-json', stderr: '' }),
    });

    expect(report.ok).toBe(false);
    expect(report.indexes[0]?.error).toContain('failed to parse wrangler JSON');
  });

  it('parses common Wrangler metadata index JSON shapes', () => {
    expect(parseMetadataIndexes(JSON.stringify({
      metadata_indexes: [
        { property_name: 'tenant', type: 'string' },
        { name: 'index_id', index_type: 'string' },
      ],
    }))).toEqual([
      { property_name: 'tenant', type: 'string' },
      { property_name: 'index_id', type: 'string' },
    ]);
    expect(parseMetadataIndexes(JSON.stringify({
      result: {
        metadataIndexes: [
          { propertyName: 'tenant', indexType: 'String' },
        ],
      },
    }))).toEqual([{ property_name: 'tenant', type: 'string' }]);
  });
});
