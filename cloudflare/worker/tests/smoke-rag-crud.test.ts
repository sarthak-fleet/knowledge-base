import { describe, expect, it } from 'vitest';
import { runRagCrudSmoke } from '../scripts/smoke-rag-crud.mjs';

function jsonResponse(payload: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function healthyResponse() {
  return jsonResponse({
    ok: true,
    d1: true,
    d1_schema: true,
    vectorize: true,
    r2: true,
    deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23',
  });
}

describe('smoke-rag-crud', () => {
  it('creates, ingests, queries, and deletes a temporary index', async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: href, method, body });

      if (href.endsWith('/v1/healthz') && method === 'GET') {
        return healthyResponse();
      }
      if (href.endsWith('/v1/indexes') && method === 'POST') {
        return jsonResponse({ id: 'idx-smoke', dimensions: 1536 }, { status: 201 });
      }
      if (href.endsWith('/v1/indexes/idx-smoke/ingest') && method === 'POST') {
        return jsonResponse({ documents: [{ document_id: 'doc-1', chunks_created: 1 }] }, { status: 201 });
      }
      if (href.endsWith('/v1/indexes/idx-smoke/query') && method === 'POST') {
        return jsonResponse({
          data: [{
            document_id: 'doc-1',
            chunk_id: 'chunk-1',
            chunk_content: 'contains smoke-query-token',
            score: 0.99,
            metadata: {},
          }],
        });
      }
      if (href.endsWith('/v1/indexes/idx-smoke') && method === 'DELETE') {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: 'unexpected' }, { status: 500 });
    };

    const report = await runRagCrudSmoke({
      baseUrl: 'https://example.test',
      key: 'service-key',
      query: 'smoke-query-token',
      indexName: 'test-index',
      fetchImpl,
    });

    expect(report.ok).toBe(true);
    expect(report.index_id).toBe('idx-smoke');
    expect(report.checks.map((item) => item.name)).toEqual([
      'deployed-health',
      'deployed-worker-fingerprint',
      'create-index',
      'ingest-document',
      'query-document',
      'cleanup-index',
    ]);
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'GET /v1/healthz',
      'POST /v1/indexes',
      'POST /v1/indexes/idx-smoke/ingest',
      'POST /v1/indexes/idx-smoke/query',
      'DELETE /v1/indexes/idx-smoke',
    ]);
  });

  it('verifies and persists a selected embedding model during live smoke', async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: href, method, body });

      if (href.endsWith('/v1/healthz') && method === 'GET') {
        return healthyResponse();
      }
      if (href.endsWith('/v1/embedding-models') && method === 'GET') {
        return jsonResponse({
          catalog_source: 'free_ai',
          free_ai_models: [{
            id: 'gemini-embedding-001',
            provider: 'gemini',
            dimensions: 1536,
            enabled: true,
            aliases: ['text-embedding-3-small'],
            compatible_profile: 'base',
            vectorize_binding: 'VECTORIZE',
            selectable: true,
          }],
        });
      }
      if (href.endsWith('/v1/indexes') && method === 'POST') {
        return jsonResponse({
          id: 'idx-smoke',
          dimensions: 1536,
          embedding_model: 'gemini-embedding-001',
          embedding_provider: 'gemini',
        }, { status: 201 });
      }
      if (href.endsWith('/v1/indexes/idx-smoke/ingest') && method === 'POST') {
        return jsonResponse({ documents: [{ document_id: 'doc-1', chunks_created: 1 }] }, { status: 201 });
      }
      if (href.endsWith('/v1/indexes/idx-smoke/query') && method === 'POST') {
        return jsonResponse({
          data: [{
            document_id: 'doc-1',
            chunk_id: 'chunk-1',
            chunk_content: 'contains smoke-query-token',
            score: 0.99,
            metadata: {},
          }],
        });
      }
      if (href.endsWith('/v1/indexes/idx-smoke') && method === 'DELETE') {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: 'unexpected' }, { status: 500 });
    };

    const report = await runRagCrudSmoke({
      baseUrl: 'https://example.test',
      key: 'service-key',
      query: 'smoke-query-token',
      indexName: 'test-index',
      embeddingModel: 'text-embedding-3-small',
      fetchImpl,
    });

    expect(report.ok).toBe(true);
    expect(report.embedding_model).toBe('text-embedding-3-small');
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'deployed-health',
      ok: true,
      d1_schema: true,
      vectorize: true,
      r2: true,
      deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23',
    }));
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'deployed-worker-fingerprint',
      ok: true,
      deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23',
      expected_deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23',
    }));
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'embedding-model-catalog',
      ok: true,
      catalog_source: 'free_ai',
      provider: 'gemini',
      dimensions: 1536,
      resolved_embedding_model: 'gemini-embedding-001',
      compatible_profile: 'base',
      vectorize_binding: 'VECTORIZE',
      selectable: true,
    }));
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'create-index',
      ok: true,
      requested_embedding_model: 'text-embedding-3-small',
      expected_embedding_model: 'gemini-embedding-001',
      expected_embedding_provider: 'gemini',
      expected_embedding_dimensions: 1536,
      embedding_model: 'gemini-embedding-001',
      embedding_provider: 'gemini',
      dimensions: 1536,
    }));
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'GET /v1/healthz',
      'GET /v1/embedding-models',
      'POST /v1/indexes',
      'POST /v1/indexes/idx-smoke/ingest',
      'POST /v1/indexes/idx-smoke/query',
      'DELETE /v1/indexes/idx-smoke',
    ]);
    expect(calls[2]?.body).toMatchObject({
      name: 'test-index',
      embedding_model: 'text-embedding-3-small',
    });
  });

  it('optionally smokes the knowledgebase custom-input domain path with selected embeddings', async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: href, method, body });

      if (href.endsWith('/v1/healthz') && method === 'GET') {
        return healthyResponse();
      }
      if (href.endsWith('/v1/embedding-models') && method === 'GET') {
        return jsonResponse({
          catalog_source: 'free_ai',
          free_ai_models: [{
            id: 'gemini-embedding-001',
            provider: 'gemini',
            dimensions: 1536,
            enabled: true,
            aliases: ['text-embedding-3-small'],
            compatible_profile: 'base',
            vectorize_binding: 'VECTORIZE',
            selectable: true,
          }],
        });
      }
      if (href.endsWith('/v1/indexes') && method === 'POST') {
        return jsonResponse({
          id: 'idx-smoke',
          dimensions: 1536,
          embedding_model: 'gemini-embedding-001',
          embedding_provider: 'gemini',
        }, { status: 201 });
      }
      if (href.endsWith('/v1/indexes/idx-smoke/ingest') && method === 'POST') {
        return jsonResponse({ documents: [{ document_id: 'doc-1', chunks_created: 1 }] }, { status: 201 });
      }
      if (href.endsWith('/v1/indexes/idx-smoke/query') && method === 'POST') {
        return jsonResponse({
          data: [{
            document_id: 'doc-1',
            chunk_id: 'chunk-1',
            chunk_content: 'contains smoke-query-token',
            score: 0.99,
            metadata: {},
          }],
        });
      }
      if (href.endsWith('/v1/kb/domains') && method === 'POST') {
        return jsonResponse({
          name: 'kb-smoke-domain',
          description: 'temporary live smoke domain',
          embedding_model: 'gemini-embedding-001',
          embedding_provider: 'gemini',
        }, { status: 201 });
      }
      if (href.endsWith('/v1/kb/ingest/text') && method === 'POST') {
        return jsonResponse({
          project: 'tenant-a',
          domain: 'kb-smoke-domain',
          files: [{ file_id: 'file-1', chunks_created: 1 }],
        }, { status: 201 });
      }
      if (href.endsWith('/v1/indexes') && method === 'GET') {
        return jsonResponse({
          data: [{
            id: 'idx-kb-domain',
            name: 'kb-smoke-domain',
            external_id: 'kb:kb-smoke-domain',
            dimensions: 1536,
            embedding_model: 'gemini-embedding-001',
            embedding_provider: 'gemini',
          }],
        });
      }
      if (href.endsWith('/v1/kb/search') && method === 'POST') {
        return jsonResponse({
          project: 'tenant-a',
          domain: 'kb-smoke-domain',
          index_id: 'idx-kb-domain',
          data: [{
            document_id: 'kb-doc-1',
            chunk_id: 'kb-chunk-1',
            chunk_content: 'contains smoke-query-token',
            score: 0.98,
            metadata: {},
          }],
        });
      }
      if ((href.endsWith('/v1/indexes/idx-kb-domain') || href.endsWith('/v1/indexes/idx-smoke')) && method === 'DELETE') {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: 'unexpected' }, { status: 500 });
    };

    const report = await runRagCrudSmoke({
      baseUrl: 'https://example.test',
      key: 'service-key',
      query: 'smoke-query-token',
      indexName: 'test-index',
      includeKbDomain: true,
      kbDomain: 'kb-smoke-domain',
      embeddingModel: 'text-embedding-3-small',
      fetchImpl,
    });

    expect(report.ok).toBe(true);
    expect(report.kb_domain).toBe('kb-smoke-domain');
    expect(report.kb_index_id).toBe('idx-kb-domain');
    expect(report.kb_cleanup).toMatchObject({ ok: true, index_id: 'idx-kb-domain' });
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'kb-domain-upsert',
      ok: true,
      domain: 'kb-smoke-domain',
      requested_embedding_model: 'text-embedding-3-small',
      expected_embedding_model: 'gemini-embedding-001',
      expected_embedding_provider: 'gemini',
      embedding_model: 'gemini-embedding-001',
      embedding_provider: 'gemini',
    }));
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'kb-ingest-text',
      ok: true,
      domain: 'kb-smoke-domain',
      chunks_indexed: 1,
    }));
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'kb-domain-index-discovered',
      ok: true,
      index_id: 'idx-kb-domain',
      external_id: 'kb:kb-smoke-domain',
    }));
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'kb-search-text',
      ok: true,
      index_id: 'idx-kb-domain',
      matched: true,
    }));
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      'GET /v1/healthz',
      'GET /v1/embedding-models',
      'POST /v1/indexes',
      'POST /v1/indexes/idx-smoke/ingest',
      'POST /v1/indexes/idx-smoke/query',
      'POST /v1/kb/domains',
      'POST /v1/kb/ingest/text',
      'GET /v1/indexes',
      'POST /v1/kb/search',
      'DELETE /v1/indexes/idx-kb-domain',
      'DELETE /v1/indexes/idx-smoke',
    ]);
    expect(calls[5]?.body).toMatchObject({
      name: 'kb-smoke-domain',
      embedding_model: 'text-embedding-3-small',
    });
    expect(calls[6]?.body).toMatchObject({
      domain: 'kb-smoke-domain',
      embedding_model: 'text-embedding-3-small',
      async: false,
    });
  });

  it('fails selected-model smoke when create-index does not persist the canonical catalog model', async () => {
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      const method = init?.method ?? 'GET';

      if (href.endsWith('/v1/healthz') && method === 'GET') {
        return healthyResponse();
      }
      if (href.endsWith('/v1/embedding-models') && method === 'GET') {
        return jsonResponse({
          catalog_source: 'free_ai',
          free_ai_models: [{
            id: 'gemini-embedding-001',
            provider: 'gemini',
            dimensions: 1536,
            enabled: true,
            aliases: ['text-embedding-3-small'],
            compatible_profile: 'base',
            vectorize_binding: 'VECTORIZE',
            selectable: true,
          }],
        });
      }
      if (href.endsWith('/v1/indexes') && method === 'POST') {
        return jsonResponse({
          id: 'idx-smoke',
          dimensions: 1536,
          embedding_model: 'text-embedding-3-small',
          embedding_provider: 'gemini',
        }, { status: 201 });
      }
      if (href.endsWith('/v1/indexes/idx-smoke') && method === 'DELETE') {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: 'unexpected' }, { status: 500 });
    };

    const report = await runRagCrudSmoke({
      baseUrl: 'https://example.test',
      key: 'service-key',
      embeddingModel: 'text-embedding-3-small',
      fetchImpl,
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'create-index',
      ok: false,
      requested_embedding_model: 'text-embedding-3-small',
      expected_embedding_model: 'gemini-embedding-001',
      expected_embedding_provider: 'gemini',
      expected_embedding_dimensions: 1536,
      embedding_model: 'text-embedding-3-small',
      embedding_provider: 'gemini',
    }));
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'rag-crud-error',
      ok: false,
      error: 'create-index did not persist selected embedding model gemini-embedding-001 (gemini, 1536d) for request text-embedding-3-small',
    }));
    expect(report.checks).toContainEqual(expect.objectContaining({ name: 'cleanup-index', ok: true }));
  });

  it('does not make live calls without a service key', async () => {
    let calls = 0;
    const report = await runRagCrudSmoke({
      baseUrl: 'https://example.test',
      key: '',
      fetchImpl: async () => {
        calls += 1;
        return jsonResponse({});
      },
    });

    expect(report.ok).toBe(false);
    expect(calls).toBe(0);
    expect(report.checks).toEqual([
      expect.objectContaining({
        name: 'service-key-present',
        ok: false,
        skipped: true,
      }),
    ]);
  });

  it('fails before mutation when deployed D1 schema is not ready', async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${new URL(href).pathname}`);
      if (href.endsWith('/v1/healthz') && method === 'GET') {
        return jsonResponse({
          ok: false,
          d1: true,
          d1_schema: false,
          vectorize: true,
          r2: true,
          error: 'D1_ERROR: no such column: embedding_model',
        }, { status: 503 });
      }
      return jsonResponse({ error: 'unexpected mutation' }, { status: 500 });
    };

    const report = await runRagCrudSmoke({
      baseUrl: 'https://example.test',
      key: 'service-key',
      fetchImpl,
    });

    expect(report.ok).toBe(false);
    expect(report.index_id).toBeNull();
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'deployed-health',
      ok: false,
      status: 503,
      d1: true,
      d1_schema: false,
      vectorize: true,
      r2: true,
    }));
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'rag-crud-error',
      ok: false,
      error: 'deployed health is not ready for mutating RAG CRUD smoke',
    }));
    expect(calls).toEqual(['GET /v1/healthz']);
  });

  it('fails before mutation when the deployed Worker fingerprint is stale', async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${new URL(href).pathname}`);
      if (href.endsWith('/v1/healthz') && method === 'GET') {
        return jsonResponse({
          ok: true,
          d1: true,
          d1_schema: true,
          vectorize: true,
          r2: true,
          deploy_fingerprint: 'knowledgebase-cloudflare-full-port-2026-06-21',
        });
      }
      return jsonResponse({ error: 'unexpected mutation' }, { status: 500 });
    };

    const report = await runRagCrudSmoke({
      baseUrl: 'https://example.test',
      key: 'service-key',
      fetchImpl,
    });

    expect(report.ok).toBe(false);
    expect(report.index_id).toBeNull();
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'deployed-health',
      ok: true,
      deploy_fingerprint: 'knowledgebase-cloudflare-full-port-2026-06-21',
    }));
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'deployed-worker-fingerprint',
      ok: false,
      deploy_fingerprint: 'knowledgebase-cloudflare-full-port-2026-06-21',
      expected_deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23',
    }));
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'rag-crud-error',
      ok: false,
      error: 'deployed fingerprint does not match expected knowledgebase-a-plus-evidence-2026-06-23',
    }));
    expect(calls).toEqual(['GET /v1/healthz']);
  });

  it('fails selected-model smoke when the catalog is static fallback', async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${new URL(href).pathname}`);
      if (href.endsWith('/v1/healthz') && method === 'GET') {
        return healthyResponse();
      }
      if (href.endsWith('/v1/embedding-models') && method === 'GET') {
        return jsonResponse({
          catalog_source: 'static',
          catalog_error: 'free-ai model catalog returned no embedding models',
          free_ai_models: [{
            id: 'gemini-embedding-001',
            provider: 'gemini',
            dimensions: 1536,
            enabled: true,
          }],
        });
      }
      return jsonResponse({ error: 'unexpected' }, { status: 500 });
    };

    const report = await runRagCrudSmoke({
      baseUrl: 'https://example.test',
      key: 'service-key',
      embeddingModel: 'gemini-embedding-001',
      fetchImpl,
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'embedding-model-catalog',
      ok: false,
      catalog_source: 'static',
      catalog_error: 'free-ai model catalog returned no embedding models',
    }));
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'rag-crud-error',
      ok: false,
    }));
    expect(calls).toEqual(['GET /v1/healthz', 'GET /v1/embedding-models']);
  });

  it('fails selected-model smoke before mutation when the catalog row is not explicitly selectable', async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${new URL(href).pathname}`);
      if (href.endsWith('/v1/healthz') && method === 'GET') {
        return healthyResponse();
      }
      if (href.endsWith('/v1/embedding-models') && method === 'GET') {
        return jsonResponse({
          catalog_source: 'free_ai',
          free_ai_models: [{
            id: 'gemini-embedding-001',
            provider: 'gemini',
            dimensions: 1536,
            enabled: true,
            compatible_profile: 'base',
            vectorize_binding: 'VECTORIZE',
            selectable: false,
          }],
        });
      }
      return jsonResponse({ error: 'unexpected mutation' }, { status: 500 });
    };

    const report = await runRagCrudSmoke({
      baseUrl: 'https://example.test',
      key: 'service-key',
      embeddingModel: 'gemini-embedding-001',
      fetchImpl,
    });

    expect(report.ok).toBe(false);
    expect(report.index_id).toBeNull();
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'embedding-model-catalog',
      ok: false,
      catalog_source: 'free_ai',
      provider: 'gemini',
      dimensions: 1536,
      compatible_profile: 'base',
      vectorize_binding: 'VECTORIZE',
      selectable: false,
    }));
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'rag-crud-error',
      ok: false,
      error: 'embedding model is not compatible with a configured Vectorize binding: gemini-embedding-001',
    }));
    expect(calls).toEqual(['GET /v1/healthz', 'GET /v1/embedding-models']);
  });

  it('fails selected-model smoke before mutation when no Vectorize binding is compatible', async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${new URL(href).pathname}`);
      if (href.endsWith('/v1/healthz') && method === 'GET') {
        return healthyResponse();
      }
      if (href.endsWith('/v1/embedding-models') && method === 'GET') {
        return jsonResponse({
          catalog_source: 'free_ai',
          free_ai_models: [{
            id: 'voyage-3.5-lite',
            provider: 'voyage_ai',
            dimensions: 1024,
            enabled: true,
            compatible_profile: null,
            vectorize_binding: null,
          }],
        });
      }
      return jsonResponse({ error: 'unexpected' }, { status: 500 });
    };

    const report = await runRagCrudSmoke({
      baseUrl: 'https://example.test',
      key: 'service-key',
      embeddingModel: 'voyage-3.5-lite',
      fetchImpl,
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'embedding-model-catalog',
      ok: false,
      catalog_source: 'free_ai',
      provider: 'voyage_ai',
      dimensions: 1024,
      compatible_profile: null,
      vectorize_binding: null,
    }));
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'rag-crud-error',
      ok: false,
      error: 'embedding model is not compatible with a configured Vectorize binding: voyage-3.5-lite',
    }));
    expect(calls).toEqual(['GET /v1/healthz', 'GET /v1/embedding-models']);
  });

  it('cleans up the temporary index even when query verification fails', async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${new URL(href).pathname}`);
      if (href.endsWith('/v1/healthz') && method === 'GET') {
        return healthyResponse();
      }
      if (href.endsWith('/v1/indexes') && method === 'POST') {
        return jsonResponse({ id: 'idx-smoke', dimensions: 1536 }, { status: 201 });
      }
      if (href.endsWith('/v1/indexes/idx-smoke/ingest') && method === 'POST') {
        return jsonResponse({ documents: [{ document_id: 'doc-1', chunks_created: 1 }] }, { status: 201 });
      }
      if (href.endsWith('/v1/indexes/idx-smoke/query') && method === 'POST') {
        return jsonResponse({ data: [] });
      }
      if (href.endsWith('/v1/indexes/idx-smoke') && method === 'DELETE') {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ error: 'unexpected' }, { status: 500 });
    };

    const report = await runRagCrudSmoke({
      baseUrl: 'https://example.test',
      key: 'service-key',
      query: 'missing-token',
      fetchImpl,
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toContainEqual(expect.objectContaining({ name: 'query-document', ok: false }));
    expect(report.checks).toContainEqual(expect.objectContaining({ name: 'cleanup-index', ok: true }));
    expect(calls.at(-1)).toBe('DELETE /v1/indexes/idx-smoke');
  });
});
