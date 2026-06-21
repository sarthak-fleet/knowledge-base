import { afterEach, describe, expect, it, vi } from 'vitest';
import { backfill, normalizeInput } from '../scripts/backfill-saas-maker.mjs';

const sampleExport = {
  index: { name: 'Imported Knowledge', external_id: 'saas-index-1' },
  chunks: [
    {
      id: 'chunk-1',
      document_id: 'doc-1',
      document_content: 'Alpha document',
      content: 'Alpha chunk',
      embedding: [1, 0, 0],
      chunk_index: 0,
      metadata: { source: 'saas-maker' },
    },
    {
      id: 'chunk-2',
      document_id: 'doc-1',
      content: 'Beta chunk',
      embedding: [0, 1, 0],
      chunk_index: 1,
      metadata: { source: 'saas-maker' },
    },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('backfill-saas-maker', () => {
  it('normalizes saas-maker chunk exports and preserves dimensions', () => {
    const normalized = normalizeInput(JSON.stringify(sampleExport));

    expect(normalized.index).toEqual({
      name: 'Imported Knowledge',
      external_id: 'saas-index-1',
    });
    expect(normalized.dimensions).toBe(3);
    expect(normalized.chunks[0]).toMatchObject({
      id: 'chunk-1',
      document_id: 'doc-1',
      document_content: 'Alpha document',
      content: 'Alpha chunk',
      chunk_index: 0,
      metadata: { source: 'saas-maker' },
    });
  });

  it('rejects mixed embedding dimensions before making network calls', async () => {
    await expect(
      backfill({
        baseUrl: 'http://localhost',
        key: '',
        input: {
          index: { name: 'Bad' },
          chunks: [
            { id: 'a', document_id: 'd', content: 'one', embedding: [1] },
            { id: 'b', document_id: 'd', content: 'two', embedding: [1, 2] },
          ],
        },
        indexName: '',
        externalId: '',
        batchSize: 10,
        dryRun: true,
      }),
    ).rejects.toThrow('same dimension');
  });

  it('supports dry-run summaries without a service key', async () => {
    const result = await backfill({
      baseUrl: 'http://localhost:8787',
      key: '',
      input: sampleExport,
      indexName: '',
      externalId: '',
      batchSize: 1,
      dryRun: true,
    });

    expect(result).toEqual({
      dry_run: true,
      index: { name: 'Imported Knowledge', external_id: 'saas-index-1' },
      chunks: 2,
      dimensions: 3,
      batches: 2,
    });
  });

  it('creates a missing index and batches ingest-vectors calls', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url.endsWith('/v1/indexes') && init?.method !== 'POST') {
          return Response.json({ data: [] });
        }
        if (url.endsWith('/v1/indexes') && init?.method === 'POST') {
          return Response.json({ id: 'rag-index-1', name: 'Imported Knowledge', external_id: 'saas-index-1' });
        }
        if (url.endsWith('/v1/indexes/rag-index-1/ingest-vectors')) {
          const body = JSON.parse(String(init?.body)) as { chunks: unknown[] };
          return Response.json({ upserted: body.chunks.length });
        }
        return Response.json({ error: 'unexpected' }, { status: 500 });
      }),
    );

    const result = await backfill({
      baseUrl: 'http://rag.local',
      key: 'service-key',
      input: sampleExport,
      indexName: '',
      externalId: '',
      batchSize: 1,
      dryRun: false,
    });

    expect(result).toMatchObject({ dry_run: false, chunks: 2, upserted: 2 });
    expect(calls.map((call) => call.url)).toEqual([
      'http://rag.local/v1/indexes',
      'http://rag.local/v1/indexes',
      'http://rag.local/v1/indexes/rag-index-1/ingest-vectors',
      'http://rag.local/v1/indexes/rag-index-1/ingest-vectors',
    ]);
    expect(calls[1]?.init?.headers).toMatchObject({ Authorization: 'Bearer service-key' });
  });
});
