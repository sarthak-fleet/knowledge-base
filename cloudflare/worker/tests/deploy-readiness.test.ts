import { describe, expect, it, vi } from 'vitest';
import { runDeployedLegacyRouteSmoke, runDeployedTestingUiSmoke, runDeployReadiness } from '../scripts/deploy-readiness.mjs';

const retiredSiblingAudit = async () => ({
  ok: true,
  sibling_exists: false,
  sibling_deployable_surfaces: [],
  active_external_references: [],
  blockers: [],
});

const deployedLegacyRoutesOk = async () => ({
  ok: true,
  checked: 11,
  failed: [],
  deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23',
  expected_deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23',
  fingerprint_ok: true,
  checks: [],
});

const testingUiHtml = [
  '<!doctype html>',
  '<title>Knowledgebase Cloudflare</title>',
  '<select id="embeddingModel"></select>',
  '<script>',
  'function applyEmbeddingSelectionForm(form) { return form; }',
  "await call('/v1/kb/domains', {});",
  "await call('/v1/kb/ingest/text', {});",
  "await call('/v1/kb/search', {});",
  '</script>',
].join('\n');

function testingUiResponse(html = testingUiHtml) {
  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

describe('deploy-readiness', () => {
  it('passes public checks and marks auth as skipped without a key', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/v1/healthz')) {
        return Response.json({
          ok: true,
          d1: true,
          d1_schema: true,
          vectorize: true,
          r2: true,
          version: '0.1.0',
          deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23',
        });
      }
      if (url.endsWith('/v1/indexes')) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }));

    const result = await runDeployReadiness({
      baseUrl: 'http://rag.local',
      key: '',
      exportInput: '',
      requireAuth: false,
    });

    expect(result.ok).toBe(true);
    expect(result.checks).toEqual([
      expect.objectContaining({
        name: 'public-health',
        ok: true,
        deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23',
      }),
      expect.objectContaining({
        name: 'deployed-worker-fingerprint',
        ok: true,
        deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23',
        expected_deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23',
      }),
      expect.objectContaining({ name: 'protected-indexes-require-auth', ok: true }),
      expect.objectContaining({ name: 'authenticated-key-present', ok: true, skipped: true }),
    ]);
  });

  it('fails default readiness when the deployed health fingerprint is stale', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/v1/healthz')) {
        return Response.json({
          ok: true,
          d1: true,
          d1_schema: true,
          vectorize: true,
          r2: true,
          deploy_fingerprint: 'knowledgebase-cloudflare-full-port-2026-06-21',
        });
      }
      if (url.endsWith('/v1/indexes')) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }));

    const result = await runDeployReadiness({
      baseUrl: 'http://rag.local',
      key: '',
      exportInput: '',
      requireAuth: false,
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'deployed-worker-fingerprint',
      ok: false,
      deploy_fingerprint: 'knowledgebase-cloudflare-full-port-2026-06-21',
      expected_deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23',
    }));
  });

  it('fails when authenticated checks are required without a key', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/v1/healthz')) {
        return Response.json({ ok: true, d1: true, d1_schema: true, vectorize: true, r2: true, deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23' });
      }
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }));

    const result = await runDeployReadiness({
      baseUrl: 'http://rag.local',
      key: '',
      exportInput: '',
      requireAuth: true,
    });

    expect(result.ok).toBe(false);
    expect(result.checks.at(-1)).toMatchObject({
      name: 'authenticated-key-present',
      ok: false,
    });
  });

  it('fails public health when the deployed D1 schema is not migrated', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/v1/healthz')) {
        return Response.json({
          ok: false,
          d1: true,
          d1_schema: false,
          vectorize: true,
          error: 'no such column: embedding_model',
        }, { status: 503 });
      }
      if (url.endsWith('/v1/indexes')) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }));

    const result = await runDeployReadiness({
      baseUrl: 'http://rag.local',
      key: '',
      exportInput: '',
      requireAuth: false,
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'public-health',
      ok: false,
      status: 503,
      d1_schema: false,
    }));
  });

  it('fails public health when schema checks were skipped in a deployed health payload', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/v1/healthz')) {
        return Response.json({
          ok: true,
          d1: true,
          d1_schema: false,
          d1_schema_check_skipped: true,
          vectorize: true,
        });
      }
      if (url.endsWith('/v1/indexes')) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }));

    const result = await runDeployReadiness({
      baseUrl: 'http://rag.local',
      key: '',
      exportInput: '',
      requireAuth: false,
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'public-health',
      ok: false,
      status: 200,
      d1_schema: false,
    }));
  });

  it('fails public health when R2 is not bound on the deployed Worker', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/v1/healthz')) {
        return Response.json({
          ok: true,
          d1: true,
          d1_schema: true,
          vectorize: true,
          r2: false,
        });
      }
      if (url.endsWith('/v1/indexes')) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }));

    const result = await runDeployReadiness({
      baseUrl: 'http://rag.local',
      key: '',
      exportInput: '',
      requireAuth: false,
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'public-health',
      ok: false,
      status: 200,
      d1_schema: true,
      r2: false,
    }));
  });

  it('runs authenticated list check when a key is available', async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, auth: new Headers(init?.headers).get('authorization') });
      if (url.endsWith('/v1/healthz')) {
        return Response.json({ ok: true, d1: true, d1_schema: true, vectorize: true, r2: true, deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23' });
      }
      if (url.endsWith('/v1/indexes') && !new Headers(init?.headers).has('authorization')) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      if (url.endsWith('/v1/indexes')) {
        return Response.json({ data: [] });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }));

    const result = await runDeployReadiness({
      baseUrl: 'http://rag.local',
      key: 'service-key',
      exportInput: '',
      requireAuth: true,
    });

    expect(result.ok).toBe(true);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'authenticated-index-list',
      ok: true,
      count: 0,
    }));
    expect(calls.at(-1)?.auth).toBe('Bearer service-key');
  });

  it('passes the read-only embedding model catalog check when free-ai rows are live', async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, auth: new Headers(init?.headers).get('authorization') });
      if (url.endsWith('/v1/healthz')) {
        return Response.json({ ok: true, d1: true, d1_schema: true, vectorize: true, r2: true, deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23' });
      }
      if (url.endsWith('/v1/indexes') && !new Headers(init?.headers).has('authorization')) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      if (url.endsWith('/v1/indexes')) {
        return Response.json({ data: [] });
      }
      if (url.endsWith('/v1/embedding-models')) {
        return Response.json({
          catalog_source: 'free_ai',
          free_ai_models: [{
            id: 'gemini-embedding-001',
            provider: 'gemini',
            dimensions: 1536,
            enabled: true,
            compatible_profile: 'base',
            vectorize_binding: 'VECTORIZE',
          }],
        });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }));

    const result = await runDeployReadiness({
      baseUrl: 'http://rag.local',
      key: 'service-key',
      exportInput: '',
      requireAuth: true,
      requireEmbeddingModel: 'gemini-embedding-001',
    });

    expect(result.ok).toBe(true);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'embedding-model-catalog',
      ok: true,
      embedding_model: 'gemini-embedding-001',
      catalog_source: 'free_ai',
      provider: 'gemini',
      dimensions: 1536,
      compatible_profile: 'base',
      vectorize_binding: 'VECTORIZE',
    }));
    expect(calls.at(-1)).toMatchObject({
      url: 'http://rag.local/v1/embedding-models',
      auth: 'Bearer service-key',
    });
  });

  it('fails the embedding model catalog check when it is static fallback', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/healthz')) {
        return Response.json({ ok: true, d1: true, d1_schema: true, vectorize: true, r2: true, deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23' });
      }
      if (url.endsWith('/v1/indexes') && !new Headers(init?.headers).has('authorization')) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      if (url.endsWith('/v1/indexes')) {
        return Response.json({ data: [] });
      }
      if (url.endsWith('/v1/embedding-models')) {
        return Response.json({
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
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }));

    const result = await runDeployReadiness({
      baseUrl: 'http://rag.local',
      key: 'service-key',
      exportInput: '',
      requireAuth: true,
      requireEmbeddingModel: 'gemini-embedding-001',
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'embedding-model-catalog',
      ok: false,
      embedding_model: 'gemini-embedding-001',
      catalog_source: 'static',
      catalog_error: 'free-ai model catalog returned no embedding models',
    }));
  });

  it('fails the embedding model catalog check when the model has no configured Vectorize binding', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/healthz')) {
        return Response.json({ ok: true, d1: true, d1_schema: true, vectorize: true, r2: true, deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23' });
      }
      if (url.endsWith('/v1/indexes') && !new Headers(init?.headers).has('authorization')) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      if (url.endsWith('/v1/indexes')) {
        return Response.json({ data: [] });
      }
      if (url.endsWith('/v1/embedding-models')) {
        return Response.json({
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
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }));

    const result = await runDeployReadiness({
      baseUrl: 'http://rag.local',
      key: 'service-key',
      exportInput: '',
      requireAuth: true,
      requireEmbeddingModel: 'voyage-3.5-lite',
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'embedding-model-catalog',
      ok: false,
      embedding_model: 'voyage-3.5-lite',
      catalog_source: 'free_ai',
      provider: 'voyage_ai',
      dimensions: 1024,
      compatible_profile: null,
      vectorize_binding: null,
    }));
  });

  it('fails the embedding model catalog check without a service key', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/v1/healthz')) {
        return Response.json({ ok: true, d1: true, d1_schema: true, vectorize: true, r2: true, deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23' });
      }
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }));

    const result = await runDeployReadiness({
      baseUrl: 'http://rag.local',
      key: '',
      exportInput: '',
      requireAuth: false,
      requireEmbeddingModel: 'gemini-embedding-001',
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'embedding-model-catalog',
      ok: false,
      skipped: true,
      embedding_model: 'gemini-embedding-001',
    }));
  });

  it('passes deployed legacy route smoke checks for public aliases and protected alias auth boundaries', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method });
      if (url.endsWith('/healthz')) {
        return Response.json({ ok: true, deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23' });
      }
      if (url.endsWith('/readyz') || url.endsWith('/metrics')) {
        return new Response('{}', { status: 200 });
      }
      return new Response('unauthorized', { status: 401 });
    }));

    const result = await runDeployedLegacyRouteSmoke({ baseUrl: 'http://rag.local' });

    expect(result.ok).toBe(true);
    expect(result.checked).toBe(11);
    expect(result.failed).toEqual([]);
    expect(result.deploy_fingerprint).toBe('knowledgebase-a-plus-evidence-2026-06-23');
    expect(result.checks).toContainEqual(expect.objectContaining({
      path: '/healthz',
      deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23',
    }));
    expect(calls).toEqual(expect.arrayContaining([
      { url: 'http://rag.local/healthz', method: 'GET' },
      { url: 'http://rag.local/readyz', method: 'GET' },
      { url: 'http://rag.local/metrics', method: 'GET' },
      { url: 'http://rag.local/search', method: 'POST' },
      { url: 'http://rag.local/query/stream', method: 'POST' },
    ]));
  });

  it('fails deployed legacy route smoke checks when an alias is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/healthz')) {
        return Response.json({ ok: true, deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23' });
      }
      if (url.endsWith('/readyz') || url.endsWith('/metrics')) {
        return new Response('{}', { status: 200 });
      }
      if (url === 'http://rag.local/search') return new Response('missing', { status: 404 });
      return new Response('unauthorized', { status: 401 });
    }));

    const result = await runDeployedLegacyRouteSmoke({ baseUrl: 'http://rag.local' });

    expect(result.ok).toBe(false);
    expect(result.failed).toEqual([
      expect.objectContaining({ path: '/search', status: 404 }),
    ]);
  });

  it('fails deployed legacy route smoke checks when the Worker fingerprint is stale', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/healthz')) {
        return Response.json({ ok: true, deploy_fingerprint: 'old-worker-build' });
      }
      if (url.endsWith('/readyz') || url.endsWith('/metrics')) {
        return new Response('{}', { status: 200 });
      }
      return new Response('unauthorized', { status: 401 });
    }));

    const result = await runDeployedLegacyRouteSmoke({ baseUrl: 'http://rag.local' });

    expect(result.ok).toBe(false);
    expect(result.fingerprint_ok).toBe(false);
    expect(result.failed).toContainEqual(expect.objectContaining({
      path: '/healthz',
      deploy_fingerprint: 'old-worker-build',
      expected_deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23',
      error: 'unexpected deploy fingerprint',
    }));
  });

  it('passes deployed testing UI smoke for root and /ui when custom-input controls are present', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      if (url === 'http://rag.local/' || url === 'http://rag.local/ui') return testingUiResponse();
      return new Response('missing', { status: 404 });
    }));

    const result = await runDeployedTestingUiSmoke({ baseUrl: 'http://rag.local' });

    expect(result.ok).toBe(true);
    expect(result.checked).toBe(2);
    expect(result.failed).toEqual([]);
    expect(calls).toEqual(['http://rag.local/', 'http://rag.local/ui']);
  });

  it('fails deployed testing UI smoke when the custom-input selected-model controls are missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => testingUiResponse('<title>Knowledgebase Cloudflare</title>')));

    const result = await runDeployedTestingUiSmoke({ baseUrl: 'http://rag.local' });

    expect(result.ok).toBe(false);
    expect(result.failed).toEqual([
      expect.objectContaining({
        path: '/',
        status: 200,
        missing_markers: expect.arrayContaining([
          'id="embeddingModel"',
          'function applyEmbeddingSelectionForm(form)',
          '/v1/kb/ingest/text',
        ]),
      }),
      expect.objectContaining({
        path: '/ui',
        status: 200,
        missing_markers: expect.arrayContaining([
          'id="embeddingModel"',
          'function applyEmbeddingSelectionForm(form)',
          '/v1/kb/search',
        ]),
      }),
    ]);
  });

  it('skips the live OCR eval in full-port mode until deployed aliases and fingerprint are current', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/healthz')) {
        return Response.json({ ok: true, d1: true, d1_schema: true, vectorize: true, r2: true, deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23' });
      }
      if (url.endsWith('/v1/indexes') && !new Headers(init?.headers).has('authorization')) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      if (url.endsWith('/v1/indexes')) {
        return Response.json({ data: [] });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }));
    const nvdaOcrRunner = vi.fn(async () => ({ ok: true, summary: { pass_rate: 1, n: 1 } }));

    const result = await runDeployReadiness({
      baseUrl: 'http://rag.local',
      key: 'service-key',
      exportInput: '',
      requireAuth: true,
      requireNvdaOcr: true,
      requireFullPort: true,
      legacyRouteRunner: async () => ({
        ok: false,
        checked: 11,
        failed: [{ path: '/search', status: 404 }],
        deploy_fingerprint: null,
        expected_deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23',
        fingerprint_ok: false,
        checks: [],
      }),
      nvdaOcrRunner,
      siblingAuditRunner: retiredSiblingAudit,
      fullPortRunner: async () => ({
        ok: false,
        exit_code: 1,
        payload: { ok: false, remaining: 2, items: [{ feature: 'deployed_worker_cutover', status: 'partial' }] },
      }),
    });

    expect(nvdaOcrRunner).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'nvda-scanned-ocr-live',
      ok: false,
      skipped: true,
      reason: 'deployed legacy aliases and deploy fingerprint must pass before running the live OCR eval',
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'deployed-testing-ui',
      ok: false,
      skipped: true,
      reason: 'deployed legacy aliases and deploy fingerprint must pass before checking the hosted testing UI',
    }));
  });

  it('fails full-port readiness when the root gap gate reports remaining blockers', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/v1/healthz')) {
        return Response.json({ ok: true, d1: true, d1_schema: true, vectorize: true, r2: true, deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23' });
      }
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }));

    const result = await runDeployReadiness({
      baseUrl: 'http://rag.local',
      key: '',
      exportInput: '',
      requireAuth: false,
      requireFullPort: true,
      legacyRouteRunner: deployedLegacyRoutesOk,
      siblingAuditRunner: retiredSiblingAudit,
      fullPortRunner: async () => ({
        ok: false,
        exit_code: 1,
        payload: {
          ok: false,
          remaining: 3,
          items: [
            { feature: 'shared_rag_api', status: 'done' },
            { feature: 'sibling_rag_service_retirement', status: 'partial' },
            { feature: 'deployed_worker_cutover', status: 'partial' },
            { feature: 'python_runtime_retirement', status: 'done' },
            { feature: 'schema_driven_ingestion', status: 'done' },
            { feature: 'ocr_and_office_parsing', status: 'partial' },
          ],
        },
      }),
      testingUiRunner: async () => ({
        ok: true,
        checked: 2,
        failed: [],
        checks: [],
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'worker-local-preflight',
      ok: true,
      errors: 0,
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'cloudflare-full-port-complete',
      ok: false,
      remaining: 3,
      remaining_features: [
        'sibling_rag_service_retirement',
        'deployed_worker_cutover',
        'ocr_and_office_parsing',
      ],
    }));
  });

  it('fails full-port readiness when the sibling rag-service audit still finds deployable surfaces', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/healthz')) {
        return Response.json({ ok: true, d1: true, d1_schema: true, vectorize: true, r2: true, deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23' });
      }
      if (url.endsWith('/v1/indexes') && !new Headers(init?.headers).has('authorization')) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      if (url.endsWith('/v1/indexes')) {
        return Response.json({ data: [] });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }));

    const result = await runDeployReadiness({
      baseUrl: 'http://rag.local',
      key: 'service-key',
      exportInput: '',
      requireAuth: true,
      requireFullPort: true,
      legacyRouteRunner: deployedLegacyRoutesOk,
      siblingAuditRunner: async () => ({
        ok: false,
        sibling_exists: true,
        sibling_deployable_surfaces: [
          'rag-service/package.json',
          'rag-service/wrangler.jsonc',
        ],
        active_external_references: [],
        blockers: [
          'sibling_directory_exists',
          'sibling_deployable_surfaces_exist',
        ],
      }),
      fullPortRunner: async () => ({
        ok: true,
        exit_code: 0,
        payload: { ok: true, remaining: 0, items: [] },
      }),
      testingUiRunner: async () => ({
        ok: true,
        checked: 2,
        failed: [],
        checks: [],
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'sibling-rag-service-retired',
      ok: false,
      sibling_exists: true,
      sibling_deployable_surfaces: [
        'rag-service/package.json',
        'rag-service/wrangler.jsonc',
      ],
      active_external_reference_count: 0,
      blockers: [
        'sibling_directory_exists',
        'sibling_deployable_surfaces_exist',
      ],
    }));
  });

  it('fails full-port readiness when deployed aliases pass but the Worker fingerprint is stale', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/healthz')) {
        return Response.json({ ok: true, d1: true, d1_schema: true, vectorize: true, r2: true, deploy_fingerprint: 'old-worker-build' });
      }
      if (url.endsWith('/v1/indexes') && !new Headers(init?.headers).has('authorization')) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      if (url.endsWith('/v1/indexes')) {
        return Response.json({ data: [] });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }));

    const result = await runDeployReadiness({
      baseUrl: 'http://rag.local',
      key: 'service-key',
      exportInput: '',
      requireAuth: true,
      requireFullPort: true,
      legacyRouteRunner: async () => ({
        ok: true,
        checked: 11,
        failed: [],
        deploy_fingerprint: 'old-worker-build',
        expected_deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23',
        fingerprint_ok: false,
        checks: [],
      }),
      siblingAuditRunner: retiredSiblingAudit,
      fullPortRunner: async () => ({
        ok: true,
        exit_code: 0,
        payload: { ok: true, remaining: 0, items: [] },
      }),
      testingUiRunner: async () => ({
        ok: true,
        checked: 2,
        failed: [],
        checks: [],
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'deployed-worker-fingerprint',
      ok: false,
      deploy_fingerprint: 'old-worker-build',
      expected_deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23',
    }));
  });

  it('fails the live NVDA OCR check when it is required without a key', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/v1/healthz')) {
        return Response.json({ ok: true, d1: true, d1_schema: true, vectorize: true, r2: true, deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23' });
      }
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }));

    const result = await runDeployReadiness({
      baseUrl: 'http://rag.local',
      key: '',
      exportInput: '',
      requireAuth: false,
      requireNvdaOcr: true,
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'nvda-scanned-ocr-live',
      ok: false,
      skipped: true,
    }));
  });

  it('passes the live NVDA OCR check when the deployed parse eval passes', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/healthz')) {
        return Response.json({ ok: true, d1: true, d1_schema: true, vectorize: true, r2: true, deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23' });
      }
      if (url.endsWith('/v1/indexes') && !new Headers(init?.headers).has('authorization')) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      if (url.endsWith('/v1/indexes')) {
        return Response.json({ data: [] });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }));

    const result = await runDeployReadiness({
      baseUrl: 'http://rag.local',
      key: 'service-key',
      exportInput: '',
      requireAuth: true,
      requireNvdaOcr: true,
      allowLiveOcr: true,
      nvdaOcrRunner: async () => ({
        ok: true,
        summary: {
          n: 1,
          pass_rate: 1,
          failed: [],
          report_ids: ['report-1'],
        },
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'nvda-scanned-ocr-live',
      ok: true,
      pass_rate: 1,
      n: 1,
      report_ids: ['report-1'],
    }));
  });

  it('skips the live NVDA OCR check without an explicit live OCR opt-in', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/healthz')) {
        return Response.json({ ok: true, d1: true, d1_schema: true, vectorize: true, r2: true, deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23' });
      }
      if (url.endsWith('/v1/indexes') && !new Headers(init?.headers).has('authorization')) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      if (url.endsWith('/v1/indexes')) {
        return Response.json({ data: [] });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }));
    const nvdaOcrRunner = vi.fn(async () => ({ ok: true, summary: { n: 1, pass_rate: 1 } }));

    const result = await runDeployReadiness({
      baseUrl: 'http://rag.local',
      key: 'service-key',
      exportInput: '',
      requireAuth: true,
      requireNvdaOcr: true,
      nvdaOcrRunner,
    });

    expect(nvdaOcrRunner).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'nvda-scanned-ocr-live',
      ok: false,
      skipped: true,
      reason: 'set RAG_ALLOW_LIVE_OCR=1 or pass --allow-live-ocr to run the live Workers AI OCR eval',
    }));
  });

  it('fails the live NVDA OCR check when the deployed parse eval misses expected text', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/healthz')) {
        return Response.json({ ok: true, d1: true, d1_schema: true, vectorize: true, r2: true, deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23' });
      }
      if (url.endsWith('/v1/indexes') && !new Headers(init?.headers).has('authorization')) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      if (url.endsWith('/v1/indexes')) {
        return Response.json({ data: [] });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }));

    const result = await runDeployReadiness({
      baseUrl: 'http://rag.local',
      key: 'service-key',
      exportInput: '',
      requireAuth: true,
      requireNvdaOcr: true,
      allowLiveOcr: true,
      nvdaOcrRunner: async () => ({
        ok: false,
        summary: {
          n: 1,
          pass_rate: 0,
          failed: [{ id: 'sec:hash', missing_text: ['Customer concentration'] }],
          report_ids: ['report-1'],
        },
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'nvda-scanned-ocr-live',
      ok: false,
      pass_rate: 0,
      failed: [{ id: 'sec:hash', missing_text: ['Customer concentration'] }],
    }));
  });

  it('explains how to fix Llama 3.2 Vision license failures in the live OCR gate', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/healthz')) {
        return Response.json({ ok: true, d1: true, d1_schema: true, vectorize: true, r2: true, deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23' });
      }
      if (url.endsWith('/v1/indexes') && !new Headers(init?.headers).has('authorization')) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      if (url.endsWith('/v1/indexes')) {
        return Response.json({ data: [] });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }));

    const result = await runDeployReadiness({
      baseUrl: 'http://rag.local',
      key: 'service-key',
      exportInput: '',
      requireAuth: true,
      requireNvdaOcr: true,
      allowLiveOcr: true,
      nvdaOcrRunner: async () => ({
        ok: false,
        error: 'Workers AI error: llama-3.2 vision license must be accepted with prompt agree',
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'nvda-scanned-ocr-live',
      ok: false,
      error: 'Workers AI error: llama-3.2 vision license must be accepted with prompt agree',
      remediation: expect.stringContaining('workers-ai:accept-llama32-vision-license'),
    }));
  });

  it('passes full-port readiness when the root gap gate is complete', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/healthz')) {
        return Response.json({ ok: true, d1: true, d1_schema: true, vectorize: true, r2: true, deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23' });
      }
      if (url.endsWith('/v1/indexes') && !new Headers(init?.headers).has('authorization')) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      if (url.endsWith('/v1/indexes')) {
        return Response.json({ data: [] });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }));

    const result = await runDeployReadiness({
      baseUrl: 'http://rag.local',
      key: 'service-key',
      exportInput: '',
      requireAuth: true,
      requireFullPort: true,
      legacyRouteRunner: deployedLegacyRoutesOk,
      siblingAuditRunner: retiredSiblingAudit,
      fullPortRunner: async () => ({
        ok: true,
        exit_code: 0,
        payload: { ok: true, remaining: 0, items: [] },
      }),
      testingUiRunner: async () => ({
        ok: true,
        checked: 2,
        failed: [],
        checks: [],
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'worker-local-preflight',
      ok: true,
      errors: 0,
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'sibling-rag-service-retired',
      ok: true,
      sibling_exists: false,
      active_external_reference_count: 0,
      blockers: [],
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'deployed-worker-fingerprint',
      ok: true,
      deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23',
      expected_deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23',
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'deployed-testing-ui',
      ok: true,
      checked: 2,
      failed: [],
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'cloudflare-full-port-complete',
      ok: true,
      remaining: 0,
      remaining_features: [],
    }));
  });

  it('fails full-port readiness when local Worker preflight fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/v1/healthz')) {
        return Response.json({ ok: true, d1: true, d1_schema: true, vectorize: true, r2: true, deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23' });
      }
      if (url.endsWith('/v1/indexes') && !new Headers(init?.headers).has('authorization')) {
        return Response.json({ error: 'unauthorized' }, { status: 401 });
      }
      if (url.endsWith('/v1/indexes')) {
        return Response.json({ data: [] });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }));

    const result = await runDeployReadiness({
      baseUrl: 'http://rag.local',
      key: 'service-key',
      exportInput: '',
      requireAuth: true,
      requireFullPort: true,
      legacyRouteRunner: deployedLegacyRoutesOk,
      siblingAuditRunner: retiredSiblingAudit,
      preflightRunner: async () => ({
        ok: false,
        errors: 1,
        warnings: 0,
        checks: [{ name: 'object_store', severity: 'error' }],
      }),
      fullPortRunner: async () => ({
        ok: true,
        exit_code: 0,
        payload: { ok: true, remaining: 0, items: [] },
      }),
      testingUiRunner: async () => ({
        ok: true,
        checked: 2,
        failed: [],
        checks: [],
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'worker-local-preflight',
      ok: false,
      errors: 1,
      failed_checks: ['object_store'],
    }));
  });
});
