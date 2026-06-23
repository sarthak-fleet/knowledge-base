import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { auditD1Migrations } from '../scripts/audit-d1-migrations.mjs';

async function tempMigrationsDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'kb-d1-migrations-'));
}

describe('audit-d1-migrations', () => {
  it('passes for the current Worker migrations', async () => {
    const report = await auditD1Migrations();

    expect(report.ok).toBe(true);
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'index_embedding_model_columns',
      ok: true,
      file: '0005_index_embedding_model.sql',
    }));
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'kb_domain_embedding_model_columns',
      ok: true,
      file: '0006_kb_domain_embedding_model.sql',
    }));
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'embedding_cache_table',
      ok: true,
      file: '0007_embedding_cache.sql',
    }));
  });

  it('fails when the embedding model migration file is missing', async () => {
    const migrationsDir = await tempMigrationsDir();

    const report = await auditD1Migrations({ migrationsDir });

    expect(report.ok).toBe(false);
    expect(report.blockers).toContainEqual(expect.objectContaining({
      name: 'index_embedding_model_columns',
      ok: false,
      file: '0005_index_embedding_model.sql',
      error: 'required migration file is missing',
    }));
  });

  it('fails when the embedding provider column migration is missing', async () => {
    const migrationsDir = await tempMigrationsDir();
    await writeFile(
      join(migrationsDir, '0005_index_embedding_model.sql'),
      'ALTER TABLE indexes ADD COLUMN embedding_model TEXT;\n',
    );

    const report = await auditD1Migrations({ migrationsDir });

    expect(report.ok).toBe(false);
    expect(report.blockers).toContainEqual(expect.objectContaining({
      name: 'index_embedding_model_columns',
      ok: false,
      file: '0005_index_embedding_model.sql',
      missing_patterns: expect.arrayContaining([
        expect.stringContaining('embedding_provider'),
      ]),
    }));
  });

  it('fails when the knowledgebase domain embedding migration is missing', async () => {
    const migrationsDir = await tempMigrationsDir();
    await writeFile(
      join(migrationsDir, '0005_index_embedding_model.sql'),
      'ALTER TABLE indexes ADD COLUMN embedding_model TEXT;\nALTER TABLE indexes ADD COLUMN embedding_provider TEXT;\n',
    );

    const report = await auditD1Migrations({ migrationsDir });

    expect(report.ok).toBe(false);
    expect(report.blockers).toContainEqual(expect.objectContaining({
      name: 'kb_domain_embedding_model_columns',
      ok: false,
      file: '0006_kb_domain_embedding_model.sql',
      error: 'required migration file is missing',
    }));
  });

  it('fails when the embedding cache migration is incomplete', async () => {
    const migrationsDir = await tempMigrationsDir();
    await writeFile(
      join(migrationsDir, '0005_index_embedding_model.sql'),
      'ALTER TABLE indexes ADD COLUMN embedding_model TEXT;\nALTER TABLE indexes ADD COLUMN embedding_provider TEXT;\n',
    );
    await writeFile(
      join(migrationsDir, '0006_kb_domain_embedding_model.sql'),
      'ALTER TABLE kb_domains ADD COLUMN embedding_model TEXT;\nALTER TABLE kb_domains ADD COLUMN embedding_provider TEXT;\n',
    );
    await writeFile(
      join(migrationsDir, '0007_embedding_cache.sql'),
      'CREATE TABLE IF NOT EXISTS embedding_cache (cache_key TEXT PRIMARY KEY);\n',
    );

    const report = await auditD1Migrations({ migrationsDir });

    expect(report.ok).toBe(false);
    expect(report.blockers).toContainEqual(expect.objectContaining({
      name: 'embedding_cache_table',
      ok: false,
      file: '0007_embedding_cache.sql',
      missing_patterns: expect.arrayContaining([
        expect.stringContaining('vector'),
        expect.stringContaining('idx_embedding_cache_expires'),
      ]),
    }));
  });
});
