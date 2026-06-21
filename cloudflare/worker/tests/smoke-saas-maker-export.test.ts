import { describe, expect, it, vi } from 'vitest';
import { smokeSaasMakerExport } from '../scripts/smoke-saas-maker-export.mjs';

const sampleExport = {
  index: { name: 'Smoke Knowledge', external_id: 'smoke-source' },
  chunks: [
    {
      id: 'chunk-1',
      document_id: 'doc-1',
      document_content: 'Alpha document',
      content: 'Alpha chunk',
      embedding: [1, 0, 0],
      chunk_index: 0,
      metadata: { source: 'test' },
    },
  ],
};

describe('smoke-saas-maker-export', () => {
  it('summarizes dry-run plans without a key', async () => {
    const result = await smokeSaasMakerExport({
      baseUrl: 'http://localhost',
      key: '',
      input: sampleExport,
      topK: 5,
      limit: 2,
      settleMs: 1,
      maxWaitMs: 1,
      pollMs: 1,
      keepIndex: false,
      dryRun: true,
    });

    expect(result).toMatchObject({
      dry_run: true,
      chunks: 1,
      query_vectors: 1,
      dimensions: 3,
      cleanup: true,
    });
  });

  it('backfills, queries by vector, and deletes the temporary index', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/v1/indexes') && init?.method !== 'POST') {
        return Response.json({ data: [] });
      }
      if (url.endsWith('/v1/indexes') && init?.method === 'POST') {
        return Response.json({ id: 'rag-index-1', name: 'Smoke Knowledge', external_id: 'smoke-id' });
      }
      if (url.endsWith('/v1/indexes/rag-index-1/ingest-vectors')) {
        return Response.json({ upserted: 1 }, { status: 201 });
      }
      if (url.endsWith('/v1/indexes/rag-index-1/query-vector')) {
        return Response.json({
          data: [
            {
              document_id: 'doc-1',
              chunk_id: 'chunk-1',
              chunk_content: 'Alpha chunk',
              score: 1,
              metadata: { source: 'test' },
            },
          ],
        });
      }
      if (url.endsWith('/v1/indexes/rag-index-1') && init?.method === 'DELETE') {
        return Response.json({ ok: true });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }));

    const result = await smokeSaasMakerExport({
      baseUrl: 'http://rag.local',
      key: 'service-key',
      input: sampleExport,
      topK: 5,
      limit: 2,
      settleMs: 1,
      maxWaitMs: 1,
      pollMs: 1,
      keepIndex: false,
      dryRun: false,
    });

    expect(result).toMatchObject({
      dry_run: false,
      index_id: 'rag-index-1',
      chunks: 1,
      upserted: 1,
      query_vectors: 1,
      hit_rate: 1,
      attempts: 1,
      cleaned_up: true,
    });
    expect(calls.map((call) => call.url)).toEqual([
      'http://rag.local/v1/indexes',
      'http://rag.local/v1/indexes',
      'http://rag.local/v1/indexes/rag-index-1/ingest-vectors',
      'http://rag.local/v1/indexes/rag-index-1/query-vector',
      'http://rag.local/v1/indexes/rag-index-1',
    ]);
  });
});
