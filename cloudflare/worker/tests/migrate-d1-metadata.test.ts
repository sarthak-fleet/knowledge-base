import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { buildD1MigrationPlan, normalizeLegacyExport } from '../scripts/migrate-d1-metadata.mjs';

async function sampleExport() {
  return JSON.parse(await readFile('fixtures/d1-metadata-export.sample.json', 'utf8'));
}

describe('migrate-d1-metadata', () => {
  it('normalizes a full legacy metadata export into D1 table counts', async () => {
    const result = normalizeLegacyExport(await sampleExport(), '2026-01-02T00:00:00.000Z');

    expect(result.warnings).toEqual([]);
    expect(result.tables.projects).toHaveLength(1);
    expect(result.tables.domains).toHaveLength(1);
    expect(result.tables.schemas?.[0]).toMatchObject({
      id: 'schema-1',
      is_active: 1,
      spec: expect.stringContaining('"entities"'),
    });
    expect(result.tables.provenance_spans?.[0]).toMatchObject({
      bbox: '[0,0,10,10]',
    });
    expect(result.tables.query_traces?.[0]).toMatchObject({
      filters: '{}',
      confidence: '{"supported":true}',
    });
  });

  it('builds idempotent D1 SQL with a stable checksum over normalized rows', async () => {
    const plan = buildD1MigrationPlan(await sampleExport(), '2026-01-02T00:00:00.000Z');

    expect(plan).toMatchObject({
      dry_run: true,
      rows: 12,
      tables: {
        projects: 1,
        domains: 1,
        schemas: 1,
        files: 1,
        parse_artifacts: 1,
        entities: 1,
        entity_mentions: 1,
        provenance_spans: 1,
        ingest_jobs: 1,
        chunks: 1,
        sessions: 1,
        query_traces: 1,
      },
      warnings: [],
    });
    expect(plan.normalized_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.sql).toContain('PRAGMA foreign_keys=ON;');
    expect(plan.sql).toContain('BEGIN TRANSACTION;');
    expect(plan.sql).toContain('INSERT INTO kb_schemas');
    expect(plan.sql).toContain('ON CONFLICT(id) DO UPDATE SET');
    expect(plan.sql).toContain('ON CONFLICT(project, domain, content_hash) DO UPDATE SET');
    expect(plan.sql).toContain('INSERT INTO kb_chunks');
    expect(plan.sql).toContain('COMMIT;');
  });

  it('synthesizes missing project/domain parents and reports broken references', () => {
    const plan = buildD1MigrationPlan({
      files: [
        {
          id: 'file-1',
          project: 'alpha',
          domain: 'manuals',
          filename: 'guide.txt',
          bytes: 10,
          content_hash: 'hash-1',
          object_key: 'raw/manuals/hash-1/guide.txt',
        },
      ],
      chunks: [
        {
          id: 'chunk-1',
          project: 'alpha',
          domain: 'manuals',
          file_id: 'missing-file',
          page_start: 1,
          page_end: 1,
          text: 'orphan chunk',
        },
      ],
    }, '2026-01-02T00:00:00.000Z');

    expect(plan.tables.projects).toBe(2);
    expect(plan.tables.domains).toBe(1);
    expect(plan.warnings).toContain('added missing default project for D1 foreign-key ordering');
    expect(plan.warnings).toContain('added missing project alpha');
    expect(plan.warnings).toContain('added missing domain alpha/manuals');
    expect(plan.warnings).toContain('chunks chunk-1 references missing file missing-file');
  });

  it('dedupes duplicate rows by D1 conflict key', () => {
    const result = normalizeLegacyExport({
      projects: [{ name: 'default' }, { name: 'default', description: 'duplicate' }],
      domains: [{ project: 'default', name: 'manuals' }],
      files: [
        {
          id: 'file-1',
          project: 'default',
          domain: 'manuals',
          filename: 'guide.txt',
          bytes: 10,
          content_hash: 'hash-1',
          object_key: 'raw/manuals/hash-1/guide.txt',
        },
        {
          id: 'file-2',
          project: 'default',
          domain: 'manuals',
          filename: 'duplicate-guide.txt',
          bytes: 10,
          content_hash: 'hash-1',
          object_key: 'raw/manuals/hash-1/duplicate-guide.txt',
        },
      ],
    }, '2026-01-02T00:00:00.000Z');

    expect(result.tables.projects).toHaveLength(1);
    expect(result.tables.files).toHaveLength(1);
    expect(result.warnings).toContain('deduped duplicate projects row for key name=default');
    expect(result.warnings).toContain('deduped duplicate files row for key project,domain,content_hash=default/manuals/hash-1');
  });

  it('applies non-null D1 defaults when legacy rows contain nulls', () => {
    const result = normalizeLegacyExport({
      projects: [{ name: 'default', description: null }],
      domains: [{ project: 'default', name: 'sec', description: null }],
    }, '2026-01-02T00:00:00.000Z');

    expect(result.tables.projects?.[0]).toMatchObject({ description: '' });
    expect(result.tables.domains?.[0]).toMatchObject({ description: '' });
    expect(result.warnings).toEqual([]);
  });

  it('derives missing mention and provenance domains from referenced rows', () => {
    const result = normalizeLegacyExport({
      projects: [{ name: 'default' }],
      domains: [{ project: 'default', name: 'sec' }],
      schemas: [
        {
          id: 'schema-1',
          project: 'default',
          domain: 'sec',
          name: 'filing',
          version: 1,
          spec: {},
        },
      ],
      files: [
        {
          id: 'file-1',
          project: 'default',
          domain: 'sec',
          filename: 'filing.txt',
          bytes: 10,
          content_hash: 'hash-1',
          object_key: 'raw/sec/hash-1/filing.txt',
        },
      ],
      entities: [
        {
          id: 'entity-1',
          project: 'default',
          domain: 'sec',
          type: 'company',
          identity_key: 'nvda',
        },
      ],
      entity_mentions: [
        {
          id: 'mention-1',
          project: 'default',
          domain: '',
          entity_id: 'entity-1',
          file_id: 'file-1',
          schema_id: 'schema-1',
        },
      ],
      provenance_spans: [
        {
          id: 'span-1',
          project: 'default',
          domain: '',
          file_id: 'file-1',
          entity_id: 'entity-1',
          page_start: 1,
          page_end: 1,
          excerpt: 'NVIDIA risk factors',
        },
      ],
    }, '2026-01-02T00:00:00.000Z');

    expect(result.tables.entity_mentions).toHaveLength(1);
    expect(result.tables.entity_mentions?.[0]).toMatchObject({ domain: 'sec' });
    expect(result.tables.provenance_spans).toHaveLength(1);
    expect(result.tables.provenance_spans?.[0]).toMatchObject({ domain: 'sec' });
    expect(result.warnings).toEqual([]);
  });

  it('orders self-referenced entities before dependent child entities', () => {
    const plan = buildD1MigrationPlan({
      projects: [{ name: 'default' }],
      domains: [{ project: 'default', name: 'legal' }],
      entities: [
        {
          id: 'child-1',
          project: 'default',
          domain: 'legal',
          type: 'Clause',
          identity_key: 'notice',
          parent_id: 'parent-1',
        },
        {
          id: 'parent-1',
          project: 'default',
          domain: 'legal',
          type: 'Contract',
          identity_key: 'license',
        },
      ],
    }, '2026-01-02T00:00:00.000Z');

    const parentIndex = plan.sql.indexOf("VALUES ('parent-1'");
    const childIndex = plan.sql.indexOf("VALUES ('child-1'");
    expect(parentIndex).toBeGreaterThan(-1);
    expect(childIndex).toBeGreaterThan(parentIndex);
    expect(plan.warnings).toEqual([]);
  });

  it('can generate remote D1-safe SQL without explicit transaction statements', async () => {
    const plan = buildD1MigrationPlan(await sampleExport(), '2026-01-02T00:00:00.000Z', { noTransaction: true });

    expect(plan.sql).not.toContain('PRAGMA foreign_keys=ON;');
    expect(plan.sql).not.toContain('BEGIN TRANSACTION;');
    expect(plan.sql).not.toContain('COMMIT;');
    expect(plan.sql).toContain('INSERT INTO kb_projects');
  });
});
