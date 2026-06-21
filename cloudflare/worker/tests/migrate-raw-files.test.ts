import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { migrateRawFiles, normalizeMigrationInput } from '../scripts/migrate-raw-files.mjs';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('migrate-raw-files', () => {
  it('normalizes directory input recursively with inferred mime types', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-raw-dir-'));
    await writeFile(join(root, 'guide.txt'), 'Alpha manual');
    await writeFile(join(root, 'records.jsonl'), '{"id":"one"}\n');

    const files = await normalizeMigrationInput({ input: root, domain: 'manuals' });

    expect(files.map((file) => ({ domain: file.domain, filename: file.filename, mime: file.mime }))).toEqual([
      { domain: 'manuals', filename: 'guide.txt', mime: 'text/plain' },
      { domain: 'manuals', filename: 'records.jsonl', mime: 'application/x-ndjson' },
    ]);
    expect(files.every((file) => file.bytes > 0)).toBe(true);
  });

  it('resolves manifest-relative file paths and per-file domains', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-raw-manifest-'));
    await writeFile(join(root, 'guide.md'), '# Guide\n');
    await writeFile(join(root, 'rows.csv'), 'id,title\n1,Alpha\n');
    const manifest = join(root, 'manifest.json');
    await writeFile(
      manifest,
      JSON.stringify({
        domain: 'manuals',
        files: [
          { path: 'guide.md' },
          { path: 'rows.csv', domain: 'tables', filename: 'rows.csv' },
        ],
      }),
    );

    const files = await normalizeMigrationInput({ manifest });

    expect(files.map((file) => ({ domain: file.domain, filename: file.filename, mime: file.mime }))).toEqual([
      { domain: 'manuals', filename: 'guide.md', mime: 'text/markdown' },
      { domain: 'tables', filename: 'rows.csv', mime: 'text/csv' },
    ]);
    expect(files[0]?.path).toBe(join(root, 'guide.md'));
  });

  it('normalizes object-root exports', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-object-root-'));
    await mkdir(join(root, 'sec', 'hash-a'), { recursive: true });
    await writeFile(join(root, 'sec', 'hash-a', 'report.txt'), 'SEC filing text');
    await mkdir(join(root, 'legal', 'hash-b'), { recursive: true });
    await writeFile(join(root, 'legal', 'hash-b', 'LICENSE.txt'), 'License terms');
    await mkdir(join(root, 'sec', 'hash-c'), { recursive: true });
    await writeFile(join(root, 'sec', 'hash-c', 'large.pdf'), 'PDF bytes');

    const files = await normalizeMigrationInput({ objectRoot: root });

    expect(files.map((file) => ({ domain: file.domain, filename: file.filename, mime: file.mime }))).toEqual([
      { domain: 'legal', filename: 'LICENSE.txt', mime: 'text/plain' },
      { domain: 'sec', filename: 'large.pdf', mime: 'application/pdf' },
      { domain: 'sec', filename: 'report.txt', mime: 'text/plain' },
    ]);
    expect(files.map((file) => file.path)).toContain(resolve(root, 'sec', 'hash-c', 'large.pdf'));
  });

  it('rejects MinIO disk internals in object-root mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-object-root-internal-'));
    await mkdir(join(root, 'sec', 'hash-c', 'large.pdf', 'part-id'), { recursive: true });
    await writeFile(join(root, 'sec', 'hash-c', 'large.pdf', 'xl.meta'), 'metadata only');
    await writeFile(join(root, 'sec', 'hash-c', 'large.pdf', 'part-id', 'part.1'), 'PDF bytes');

    await expect(normalizeMigrationInput({ objectRoot: root })).rejects.toThrow(/MinIO disk internals/);
  });

  it('summarizes dry runs without a service key', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-raw-dry-'));
    await writeFile(join(root, 'guide.txt'), 'Alpha manual');

    const result = await migrateRawFiles({
      input: root,
      domain: 'manuals',
      inferSchema: true,
      applySchema: true,
      queueIngest: true,
      dryRun: true,
    });

    expect(result).toMatchObject({
      dry_run: true,
      files: 1,
      domains: ['manuals'],
      infer_schema: true,
      apply_schema: true,
      queue_ingest: true,
    });
    expect(result.content_hashes).toEqual([
      expect.objectContaining({
        domain: 'manuals',
        filename: 'guide.txt',
        bytes: 12,
        sha256: '46f912829a2e7e1346d63cd26ca7a51f1db39baee77bbfd51fc5161aa36e10dd',
      }),
    ]);
  });

  it('fails live uploads when the returned content hash differs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-raw-mismatch-'));
    await writeFile(join(root, 'guide.txt'), 'Alpha manual');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ content_hash: 'bad-hash' })),
    );

    await expect(migrateRawFiles({
      baseUrl: 'http://rag.local/',
      key: 'service-key',
      input: root,
      domain: 'manuals',
      dryRun: false,
    })).rejects.toThrow(/checksum mismatch/);
  });

  it('uploads files, applies inferred schemas, and queues touched domains', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-raw-upload-'));
    await writeFile(join(root, 'guide.txt'), 'Alpha manual');
    await writeFile(join(root, 'rows.csv'), 'id,title\n1,Alpha\n');
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url.endsWith('/v1/kb/schemas/infer-upload')) {
          return Response.json({ spec: { fields: [{ name: 'title', type: 'string' }] } });
        }
        if (url.endsWith('/v1/kb/schemas')) {
          return Response.json({ ok: true });
        }
        if (url.endsWith('/v1/kb/ingest/run')) {
          return Response.json({ queued: true });
        }
        return Response.json({ error: 'unexpected' }, { status: 500 });
      }),
    );

    const result = await migrateRawFiles({
      baseUrl: 'http://rag.local/',
      key: 'service-key',
      input: root,
      domain: 'manuals',
      inferSchema: true,
      applySchema: true,
      queueIngest: true,
      runId: 'raw-migration',
      dryRun: false,
    });

    expect(result).toMatchObject({
      dry_run: false,
      uploaded: 2,
      domains: ['manuals'],
      applied: 1,
      queued: 1,
    });
    expect(result.verified).toHaveLength(2);
    expect(calls.map((call) => call.url)).toEqual([
      'http://rag.local/v1/kb/schemas/infer-upload',
      'http://rag.local/v1/kb/schemas/infer-upload',
      'http://rag.local/v1/kb/schemas',
      'http://rag.local/v1/kb/ingest/run',
    ]);
    expect(calls[0]?.init?.headers).toMatchObject({ Authorization: 'Bearer service-key' });
    expect(JSON.parse(String(calls[3]?.init?.body))).toEqual({
      domain: 'manuals',
      async: true,
      run_id: 'raw-migration-manuals',
    });
  });
});
