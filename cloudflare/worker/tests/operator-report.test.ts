import { describe, expect, it } from 'vitest';
import { runOperatorReport } from '../scripts/operator-report.mjs';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(text: string, status = 200): Response {
  return new Response(text, {
    status,
    headers: { 'Content-Type': 'text/html' },
  });
}

function makeFetch() {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url: href, method, body });
    const path = new URL(href).pathname;
    const search = new URL(href).search;
    if (path === '/v1/healthz') {
      return jsonResponse({ ok: true, deploy_fingerprint: 'fp', d1_schema: true, vectorize: true, r2: true });
    }
    if (path === '/ui') {
      return textResponse(`
        <title>Knowledgebase Cloudflare</title>
        <button id="ingestDomainText">Ingest Domain Text</button>
        <button id="loadRunProgress">Load Run Progress</button>
        <script>await call('/v1/kb/ingest/text', { internal: 'RAG Vectorize Embedding chunk Index id' });</script>
      `);
    }
    if (path === '/v1/indexes' && !init?.headers?.['Authorization' as keyof HeadersInit]) {
      return jsonResponse({ error: 'unauthorized' }, 401);
    }
    if (path === '/v1/kb/projects') {
      return jsonResponse({ data: [{ name: 'tenant-a', domain_count: 1 }] });
    }
    if (path === '/v1/kb/domains') {
      return jsonResponse({ data: [{ name: 'docs', embedding_model: 'gemini-embedding-001' }] });
    }
    if (path === '/v1/indexes') {
      return jsonResponse({ data: [{ id: 'idx-1', name: 'Linkchat user' }] });
    }
    if (path === '/v1/kb/files') {
      expect(search).toContain('domain=docs');
      return jsonResponse({ data: [{ id: 'file-1', status: 'ready', bytes: 42 }] });
    }
    if (path === '/v1/kb/jobs') {
      expect(search).toContain('domain=docs');
      return jsonResponse({ jobs: [{ id: 'job-1', status: 'complete', stage: 'index' }] });
    }
    if (path === '/v1/kb/source-sets') {
      expect(search).toContain('domain=docs');
      return jsonResponse({ source_sets: [{ id: 'domain:docs', file_count: 1 }] });
    }
    if (path === '/v1/kb/query/traces') {
      expect(search).toContain('domain=docs');
      return jsonResponse({ traces: [{ id: 'trace-1', latency_ms: 17, citations: [{}] }] });
    }
    if (path === '/v1/kb/query/traces/export') {
      expect(search).toContain('domain=docs');
      return jsonResponse({ summary: { trace_count: 1 }, traces: [{ id: 'trace-1' }] });
    }
    if (path === '/v1/kb/query/trace/trace-1/drilldown') {
      return jsonResponse({ trace_id: 'trace-1', quality: { citations: [] } });
    }
    if (path === '/v1/kb/evals/summary') {
      expect(search).toContain('domain=docs');
      return jsonResponse({ report_count: 1, summaries: [{ kind: 'query', avg_ai_use_rate: 0 }] });
    }
    if (path === '/v1/embedding-models') {
      return jsonResponse({ free_ai_models: [{ id: 'gemini-embedding-001', selectable: true }] });
    }
    if (path === '/v1/indexes/idx-1/benchmark-query') {
      expect(method).toBe('POST');
      expect(body).toMatchObject({ queries: ['hello'], repeat: 2, top_k: 3, mode: 'semantic' });
      return jsonResponse({
        latency: { count: 2, p95_ms: 25 },
        server_latency: { count: 2, p95_ms: 20 },
        cache_hit_rate: 0.5,
      });
    }
    return jsonResponse({ error: `unexpected ${href}` }, 404);
  };
  return { fetchImpl, calls };
}

describe('operator-report', () => {
  it('reports public health and auth boundary without a service key', async () => {
    const { fetchImpl, calls } = makeFetch();

    const report = await runOperatorReport({ baseUrl: 'https://kb.example', fetchImpl });

    expect(report.authenticated).toBe(false);
    expect(report.ok).toBe(true);
    expect(report.blockers).toEqual(['authenticated_inventory_requires_RAG_SERVICE_KEY']);
    expect(report.capabilities).toMatchObject({
      hosted_ui: true,
      custom_input: true,
      async_status: true,
      hides_rag_internals: true,
    });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(['/v1/healthz', '/ui', '/v1/indexes']);
  });

  it('summarizes authenticated tenant inventory and optional benchmark', async () => {
    const { fetchImpl } = makeFetch();

    const report = await runOperatorReport({
      baseUrl: 'https://kb.example',
      key: 'key-a',
      domain: 'docs',
      indexId: 'idx-1',
      queries: ['hello'],
      repeat: 2,
      topK: 3,
      fetchImpl,
    });

    expect(report.ok).toBe(true);
    expect(report.inventory).toMatchObject({
      project_count: 1,
      domain_count: 1,
      index_count: 1,
      file_count: 1,
      file_bytes: 42,
      jobs_by_status: { complete: 1 },
      recent_trace_count: 1,
      eval_report_count: 1,
      selectable_embedding_model_count: 1,
    });
    expect(report.cost_signals).toMatchObject({
      avg_trace_latency_ms: 17,
      avg_eval_ai_use_rate: 0,
      benchmark_cache_hit_rate: 0.5,
    });
    expect(report.capabilities).toMatchObject({
      hosted_ui: true,
      custom_input: true,
      async_status: true,
      project_data_api: true,
      trace_export: true,
      trace_drilldown: true,
    });
    expect(report.benchmark).toMatchObject({ cache_hit_rate: 0.5 });
  });

  it('flags visible hosted UI retrieval jargon', async () => {
    const fetchImpl = async (url: string | URL | Request): Promise<Response> => {
      const href = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      const path = new URL(href).pathname;
      if (path === '/v1/healthz') {
        return jsonResponse({ ok: true, deploy_fingerprint: 'fp', d1_schema: true, vectorize: true, r2: true });
      }
      if (path === '/ui') {
        return textResponse(`
          <title>Knowledgebase Cloudflare</title>
          <label>Embedding model</label>
          <button id="ingestDomainText">Ingest Domain Text</button>
          <button id="loadRunProgress">Load Run Progress</button>
          <script>await call('/v1/kb/ingest/text', {});</script>
        `);
      }
      if (path === '/v1/indexes') return jsonResponse({ error: 'unauthorized' }, 401);
      return jsonResponse({ error: `unexpected ${href}` }, 404);
    };

    const report = await runOperatorReport({ baseUrl: 'https://kb.example', fetchImpl });

    expect(report.capabilities).toMatchObject({
      hosted_ui: true,
      custom_input: true,
      async_status: true,
      hides_rag_internals: false,
    });
  });
});
