import { describe, expect, it, vi } from 'vitest';
import { embeddingModelReleasePlan } from '../scripts/embedding-model-release-plan.mjs';
import { embeddingModelReleaseStatus, formatHumanReport } from '../scripts/embedding-model-release-status.mjs';

const vectorizeReady = {
  ok: true,
  config_path: '/tmp/wrangler.jsonc',
  require_all: true,
  configured_dimensions: [384, 768, 1024, 1536],
  configured_bindings: [],
  models: [
    {
      id: 'gemini-embedding-001',
      provider: 'gemini',
      dimensions: 1536,
      selectable: true,
      vectorize_binding: 'VECTORIZE',
      vectorize_index: 'rag-gemini-1536',
      blocker: null,
    },
  ],
  missing_dimensions: [],
  selectable_models: ['gemini-embedding-001'],
  blocked_models: [],
  provisioning_plan: [],
  blockers: [],
};

const vectorizeMissing = {
  ok: false,
  config_path: '/tmp/wrangler.jsonc',
  require_all: true,
  configured_dimensions: [1536],
  configured_bindings: [],
  models: [
    {
      id: 'gemini-embedding-001',
      provider: 'gemini',
      dimensions: 1536,
      selectable: true,
      vectorize_binding: 'VECTORIZE',
      vectorize_index: 'rag-gemini-1536',
      blocker: null,
    },
  ],
  missing_dimensions: [384, 768, 1024],
  selectable_models: ['gemini-embedding-001'],
  blocked_models: ['@cf/baai/bge-small-en-v1.5'],
  provisioning_plan: [
    { dimensions: 384, binding: 'VECTORIZE_384', command: ['pnpm', 'exec', 'wrangler'] },
  ],
  blockers: [],
};

const vectorizeMetadataReady = {
  ok: true,
  required_metadata_indexes: [
    { property_name: 'tenant', type: 'string' },
    { property_name: 'index_id', type: 'string' },
  ],
  indexes: [
    {
      binding: 'VECTORIZE',
      index_name: 'rag-gemini-1536',
      ok: true,
      missing_metadata_indexes: [],
      remediation_commands: [],
    },
  ],
  blockers: [],
};

const vectorizeMetadataMissing = {
  ok: false,
  required_metadata_indexes: vectorizeMetadataReady.required_metadata_indexes,
  indexes: [
    {
      binding: 'VECTORIZE',
      index_name: 'rag-gemini-1536',
      ok: false,
      missing_metadata_indexes: vectorizeMetadataReady.required_metadata_indexes,
      remediation_commands: [
        ['pnpm', 'exec', 'wrangler', 'vectorize', 'create-metadata-index', 'rag-gemini-1536', '--propertyName', 'tenant', '--type', 'string'],
        ['pnpm', 'exec', 'wrangler', 'vectorize', 'create-metadata-index', 'rag-gemini-1536', '--propertyName', 'index_id', '--type', 'string'],
      ],
    },
  ],
  blockers: [
    {
      binding: 'VECTORIZE',
      index_name: 'rag-gemini-1536',
      missing_metadata_indexes: vectorizeMetadataReady.required_metadata_indexes,
    },
  ],
};

describe('embedding-model-release-status', () => {
  it('reports stale deployed knowledgebase, stale free-ai catalog, and missing Vectorize dimensions', async () => {
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => {
      const href = String(url);
      if (href.endsWith('/v1/healthz')) {
        return Response.json({
          ok: true,
          d1: true,
          vectorize: true,
          r2: true,
          deploy_fingerprint: 'knowledgebase-cloudflare-full-port-2026-06-21',
        });
      }
      if (href.endsWith('/v1/models')) {
        return Response.json({ data: [{ id: 'gemini-2.5-flash', type: 'chat', provider: 'gemini' }] });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    });

    const report = await embeddingModelReleaseStatus({
      ragBaseUrl: 'https://rag.example.test/',
      freeAiBaseUrl: 'https://free-ai.example.test/',
      model: 'gemini-embedding-001',
      expectedDeployFingerprint: 'knowledgebase-a-plus-evidence-2026-06-23',
      fetchImpl,
      vectorizeReport: vectorizeMissing,
      vectorizeMetadataReport: vectorizeMetadataMissing,
    });

    expect(report.ok).toBe(false);
    expect(report.rag_base_url).toBe('https://rag.example.test');
    expect(report.free_ai_base_url).toBe('https://free-ai.example.test');
    expect(report.blockers).toEqual([
      'knowledgebase-public-health-current',
      'free-ai-deployed-embedding-catalog',
      'vectorize-selected-embedding-model-configured',
      'vectorize-all-free-ai-dimensions-configured',
      'vectorize-configured-metadata-indexes',
    ]);
    expect(report.blocker_steps).toEqual([
      'd1-migration',
      'worker-deploy',
      'readiness-embedding-model',
      'free-ai-local-check',
      'free-ai-deploy',
      'free-ai-catalog-smoke',
      'vectorize-configured-metadata-provisioning',
      'vectorize-metadata-index-readiness',
    ]);
    expect(report.blocker_commands).toEqual([
      expect.objectContaining({
        step_id: 'd1-migration',
        command: 'pnpm exec wrangler d1 migrations apply rag-db --remote',
        mutating: true,
        requires_approval: true,
      }),
      expect.objectContaining({
        step_id: 'worker-deploy',
        command: 'pnpm run deploy',
        mutating: true,
        requires_approval: true,
      }),
      expect.objectContaining({
        step_id: 'readiness-embedding-model',
        command: 'RAG_BASE_URL=https://rag.example.test RAG_SERVICE_KEY=<service-key> pnpm run readiness:embedding-model',
        mutating: false,
        requires_approval: false,
        required_env: ['RAG_SERVICE_KEY'],
      }),
      expect.objectContaining({
        step_id: 'free-ai-local-check',
        command: 'cd ../../../free-ai && pnpm run check',
        mutating: false,
        requires_approval: false,
      }),
      expect.objectContaining({
        step_id: 'free-ai-deploy',
        command: 'cd ../../../free-ai && pnpm run deploy',
        mutating: true,
        requires_approval: true,
      }),
      expect.objectContaining({
        step_id: 'free-ai-catalog-smoke',
        command: 'cd ../../../free-ai && pnpm run smoke:embedding-models -- --model gemini-embedding-001',
        mutating: false,
        requires_approval: false,
      }),
      expect.objectContaining({
        step_id: 'vectorize-configured-metadata-provisioning',
        command: 'pnpm exec wrangler vectorize create-metadata-index rag-gemini-1536 --propertyName tenant --type string && pnpm exec wrangler vectorize create-metadata-index rag-gemini-1536 --propertyName index_id --type string && pnpm run audit:vectorize-metadata-indexes -- --json --require-complete',
        mutating: true,
        requires_approval: true,
      }),
      expect.objectContaining({
        step_id: 'vectorize-metadata-index-readiness',
        command: 'pnpm run audit:vectorize-metadata-indexes -- --json --require-complete',
        mutating: false,
        requires_approval: false,
      }),
    ]);
    expect(report.checks).toEqual([
      expect.objectContaining({
        name: 'knowledgebase-public-health-current',
        ok: false,
        release_plan_steps: ['d1-migration', 'worker-deploy', 'readiness-embedding-model'],
        deploy_fingerprint: 'knowledgebase-cloudflare-full-port-2026-06-21',
        d1_schema: null,
      }),
      expect.objectContaining({
        name: 'free-ai-deployed-embedding-catalog',
        ok: false,
        release_plan_steps: ['free-ai-local-check', 'free-ai-deploy', 'free-ai-catalog-smoke'],
        embedding_model_count: 0,
        selected: null,
      }),
      expect.objectContaining({
        name: 'vectorize-selected-embedding-model-configured',
        ok: false,
        release_plan_steps: ['free-ai-local-check', 'free-ai-deploy', 'free-ai-catalog-smoke'],
        model: 'gemini-embedding-001',
        dimensions: null,
        vectorize_binding: null,
      }),
      expect.objectContaining({
        name: 'vectorize-all-free-ai-dimensions-configured',
        ok: false,
        release_plan_steps: ['free-ai-local-check', 'free-ai-deploy', 'free-ai-catalog-smoke'],
        free_ai_catalog_ready: false,
        local_optional_missing_dimensions: [384, 768, 1024],
        missing_deployed_dimensions: [],
        missing_dimensions: [],
      }),
      expect.objectContaining({
        name: 'vectorize-configured-metadata-indexes',
        ok: false,
        release_plan_steps: ['vectorize-configured-metadata-provisioning', 'vectorize-metadata-index-readiness'],
        blockers: [
          expect.objectContaining({
            binding: 'VECTORIZE',
            index_name: 'rag-gemini-1536',
          }),
        ],
      }),
    ]);

    expect(formatHumanReport(report)).toContain(
      'deploy_fingerprint=knowledgebase-cloudflare-full-port-2026-06-21 expected=knowledgebase-a-plus-evidence-2026-06-23',
    );
    expect(formatHumanReport(report)).toContain('embedding_model_count=0 valid_embedding_model_count=0 required_model=gemini-embedding-001');
    expect(formatHumanReport(report)).toContain('free_ai_catalog_ready=false configured_dimensions=1536 deployed_embedding_dimensions=none');
    expect(formatHumanReport(report)).toContain('missing_deployed_dimensions=none local_optional_missing_dimensions=384,768,1024');
    expect(formatHumanReport(report)).toContain('metadata_blockers=VECTORIZE:rag-gemini-1536 missing=tenant,index_id');
    expect(formatHumanReport(report)).toContain('next_commands:');
    expect(formatHumanReport(report)).toContain('d1-migration: mutating approval_required');
    expect(formatHumanReport(report)).toContain('readiness-embedding-model: read_only');
  });

  it('only reports blocker steps that exist in the release plan', async () => {
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => {
      const href = String(url);
      if (href.endsWith('/v1/healthz')) {
        return Response.json({
          ok: true,
          d1: true,
          vectorize: true,
          r2: true,
          deploy_fingerprint: 'knowledgebase-cloudflare-full-port-2026-06-21',
        });
      }
      if (href.endsWith('/v1/models')) {
        return Response.json({ data: [{ id: 'gemini-2.5-flash', type: 'chat', provider: 'gemini' }] });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    });

    const report = await embeddingModelReleaseStatus({
      model: 'gemini-embedding-001',
      expectedDeployFingerprint: 'knowledgebase-a-plus-evidence-2026-06-23',
      fetchImpl,
      vectorizeReport: vectorizeMissing,
      vectorizeMetadataReport: vectorizeMetadataMissing,
    });
    const planStepIds = new Set(embeddingModelReleasePlan().steps.map((step) => step.id));
    const reportedSteps = new Set([
      ...report.blocker_steps,
      ...report.checks.flatMap((check) => check.release_plan_steps ?? []),
    ]);

    expect([...reportedSteps].sort()).toEqual([...reportedSteps].filter((step) => planStepIds.has(step)).sort());
    expect(reportedSteps.has('free-ai-local-check')).toBe(true);
  });

  it('does not block on local optional dimensions when deployed free-ai only advertises the selected 1536-dimension model', async () => {
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => {
      const href = String(url);
      if (href.endsWith('/v1/healthz')) {
        return Response.json({
          ok: true,
          d1: true,
          d1_schema: true,
          vectorize: true,
          r2: true,
          deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23',
        });
      }
      if (href.endsWith('/v1/models')) {
        return Response.json({
          data: [{
            id: 'gemini-embedding-001',
            type: 'embedding',
            provider: 'gemini',
            dimensions: 1536,
            enabled: true,
          }],
        });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    });

    const report = await embeddingModelReleaseStatus({
      model: 'gemini-embedding-001',
      fetchImpl,
      vectorizeReport: {
        ...vectorizeReady,
        configured_dimensions: [1536],
        missing_dimensions: [384, 768, 1024],
        blocked_models: ['@cf/baai/bge-small-en-v1.5'],
        provisioning_plan: [
          { dimensions: 384, binding: 'VECTORIZE_384', command: ['pnpm', 'exec', 'wrangler'] },
        ],
      },
    });

    expect(report.ok).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'vectorize-all-free-ai-dimensions-configured',
      ok: true,
      free_ai_catalog_ready: true,
      deployed_embedding_dimensions: [1536],
      local_optional_missing_dimensions: [384, 768, 1024],
      missing_deployed_dimensions: [],
      missing_dimensions: [],
    }));
  });

  it('passes when deployed health, free-ai catalog, and Vectorize dimensions are ready', async () => {
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => {
      const href = String(url);
      if (href.endsWith('/v1/healthz')) {
        return Response.json({
          ok: true,
          d1: true,
          d1_schema: true,
          vectorize: true,
          r2: true,
          deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23',
        });
      }
      if (href.endsWith('/v1/models')) {
        return Response.json({
          data: [{
            id: 'gemini-embedding-001',
            type: 'embedding',
            provider: 'gemini',
            dimensions: 1536,
            supports_dimensions: true,
            enabled: true,
            aliases: ['text-embedding-3-small'],
            priority: 0.95,
          }],
        });
      }
      if (href.endsWith('/v1/embedding-models')) {
        return Response.json({
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
      return Response.json({ error: 'unexpected' }, { status: 500 });
    });

    const report = await embeddingModelReleaseStatus({
      model: 'text-embedding-3-small',
      key: 'service-key',
      fetchImpl,
      vectorizeReport: vectorizeReady,
      vectorizeMetadataReport: vectorizeMetadataReady,
      checkKnowledgebaseEmbeddingModels: true,
    });

    expect(report.ok).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(report.blocker_steps).toEqual([]);
    expect(report.blocker_commands).toEqual([]);
    expect(report.checks).toEqual([
      expect.objectContaining({
        name: 'knowledgebase-public-health-current',
        ok: true,
        d1_schema: true,
      }),
      expect.objectContaining({
        name: 'free-ai-deployed-embedding-catalog',
        ok: true,
        selected: expect.objectContaining({
          id: 'gemini-embedding-001',
          provider: 'gemini',
          dimensions: 1536,
          supports_dimensions: true,
          aliases: ['text-embedding-3-small'],
          priority: 0.95,
          enabled: true,
        }),
      }),
      expect.objectContaining({
        name: 'knowledgebase-embedding-model-catalog',
        ok: true,
        model: 'text-embedding-3-small',
        catalog_source: 'free_ai',
        selected: expect.objectContaining({
          id: 'gemini-embedding-001',
          provider: 'gemini',
          dimensions: 1536,
          compatible_profile: 'base',
          vectorize_binding: 'VECTORIZE',
          selectable: true,
          enabled: true,
        }),
      }),
      expect.objectContaining({
        name: 'vectorize-selected-embedding-model-configured',
        ok: true,
        model: 'text-embedding-3-small',
        dimensions: 1536,
        vectorize_binding: 'VECTORIZE',
        vectorize_index: 'rag-gemini-1536',
      }),
      expect.objectContaining({
        name: 'vectorize-all-free-ai-dimensions-configured',
        ok: true,
        missing_dimensions: [],
      }),
      expect.objectContaining({
        name: 'vectorize-configured-metadata-indexes',
        ok: true,
        blockers: [],
      }),
    ]);
  });

  it('fails when deployed free-ai advertises an enabled embedding dimension without a Vectorize binding', async () => {
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => {
      const href = String(url);
      if (href.endsWith('/v1/healthz')) {
        return Response.json({
          ok: true,
          d1: true,
          d1_schema: true,
          vectorize: true,
          r2: true,
          deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23',
        });
      }
      if (href.endsWith('/v1/models')) {
        return Response.json({
          data: [
            {
              id: 'gemini-embedding-001',
              type: 'embedding',
              provider: 'gemini',
              dimensions: 1536,
              enabled: true,
            },
            {
              id: 'future-free-ai-embedding',
              type: 'embedding',
              provider: 'future_ai',
              dimensions: 2048,
              enabled: true,
            },
          ],
        });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    });

    const report = await embeddingModelReleaseStatus({
      model: 'gemini-embedding-001',
      fetchImpl,
      vectorizeReport: {
        ...vectorizeReady,
        configured_dimensions: [1536],
        missing_dimensions: [],
      },
      vectorizeMetadataReport: vectorizeMetadataReady,
    });

    expect(report.ok).toBe(false);
    expect(report.blockers).toEqual(['vectorize-all-free-ai-dimensions-configured']);
    expect(report.blocker_steps).toEqual(['vectorize-embedding-provisioning']);
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'vectorize-all-free-ai-dimensions-configured',
      ok: false,
      configured_dimensions: [1536],
      deployed_embedding_dimensions: [1536, 2048],
      missing_deployed_dimensions: [2048],
      missing_dimensions: [2048],
      deployed_blocked_models: [
        expect.objectContaining({
          id: 'future-free-ai-embedding',
          provider: 'future_ai',
          dimensions: 2048,
          enabled: true,
        }),
      ],
    }));
  });

  it('fails the deployed free-ai catalog check when the selected embedding row is malformed', async () => {
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => {
      const href = String(url);
      if (href.endsWith('/v1/healthz')) {
        return Response.json({
          ok: true,
          d1: true,
          d1_schema: true,
          vectorize: true,
          r2: true,
          deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23',
        });
      }
      if (href.endsWith('/v1/models')) {
        return Response.json({
          data: [{
            id: 'gemini-embedding-001',
            type: 'embedding',
            enabled: true,
          }],
        });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    });

    const report = await embeddingModelReleaseStatus({
      model: 'gemini-embedding-001',
      fetchImpl,
      vectorizeReport: vectorizeReady,
      vectorizeMetadataReport: vectorizeMetadataReady,
    });

    expect(report.ok).toBe(false);
    expect(report.blockers).toEqual([
      'free-ai-deployed-embedding-catalog',
      'vectorize-selected-embedding-model-configured',
      'vectorize-all-free-ai-dimensions-configured',
    ]);
    expect(report.blocker_steps).toEqual([
      'free-ai-local-check',
      'free-ai-deploy',
      'free-ai-catalog-smoke',
    ]);
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'free-ai-deployed-embedding-catalog',
      ok: false,
      embedding_model_count: 1,
      valid_embedding_model_count: 0,
      invalid_embedding_models: [
        expect.objectContaining({
          id: 'gemini-embedding-001',
          provider: null,
          dimensions: null,
          enabled: true,
          invalid_reasons: ['missing_provider', 'invalid_dimensions'],
        }),
      ],
      selected: expect.objectContaining({
        id: 'gemini-embedding-001',
        provider: null,
        dimensions: null,
        enabled: true,
      }),
      selected_invalid_reasons: ['missing_provider', 'invalid_dimensions'],
    }));
    expect(formatHumanReport(report)).toContain(
      'selected_invalid_reasons=missing_provider,invalid_dimensions invalid_embedding_models=gemini-embedding-001:missing_provider|invalid_dimensions',
    );
  });

  it('fails the deployed knowledgebase embedding model catalog check when the selected row is not explicitly selectable', async () => {
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => {
      const href = String(url);
      if (href.endsWith('/v1/healthz')) {
        return Response.json({
          ok: true,
          d1: true,
          d1_schema: true,
          vectorize: true,
          r2: true,
          deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23',
        });
      }
      if (href.endsWith('/v1/models')) {
        return Response.json({
          data: [{
            id: 'gemini-embedding-001',
            type: 'embedding',
            provider: 'gemini',
            dimensions: 1536,
            enabled: true,
          }],
        });
      }
      if (href.endsWith('/v1/embedding-models')) {
        return Response.json({
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
      return Response.json({ error: 'unexpected' }, { status: 500 });
    });

    const report = await embeddingModelReleaseStatus({
      model: 'gemini-embedding-001',
      key: 'service-key',
      fetchImpl,
      vectorizeReport: vectorizeReady,
      vectorizeMetadataReport: vectorizeMetadataReady,
      checkKnowledgebaseEmbeddingModels: true,
    });

    expect(report.ok).toBe(false);
    expect(report.blockers).toEqual(['knowledgebase-embedding-model-catalog']);
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'knowledgebase-embedding-model-catalog',
      ok: false,
      selected: expect.objectContaining({
        id: 'gemini-embedding-001',
        compatible_profile: 'base',
        vectorize_binding: 'VECTORIZE',
        selectable: false,
      }),
    }));
  });

  it('fails the deployed knowledgebase embedding model catalog check when the selected row is malformed', async () => {
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => {
      const href = String(url);
      if (href.endsWith('/v1/healthz')) {
        return Response.json({
          ok: true,
          d1: true,
          d1_schema: true,
          vectorize: true,
          r2: true,
          deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23',
        });
      }
      if (href.endsWith('/v1/models')) {
        return Response.json({
          data: [{
            id: 'gemini-embedding-001',
            type: 'embedding',
            provider: 'gemini',
            dimensions: 1536,
            enabled: true,
          }],
        });
      }
      if (href.endsWith('/v1/embedding-models')) {
        return Response.json({
          catalog_source: 'free_ai',
          free_ai_models: [{
            id: 'gemini-embedding-001',
            enabled: true,
            compatible_profile: 'base',
            vectorize_binding: 'VECTORIZE',
            selectable: true,
          }],
        });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    });

    const report = await embeddingModelReleaseStatus({
      model: 'gemini-embedding-001',
      key: 'service-key',
      fetchImpl,
      vectorizeReport: vectorizeReady,
      vectorizeMetadataReport: vectorizeMetadataReady,
      checkKnowledgebaseEmbeddingModels: true,
    });

    expect(report.ok).toBe(false);
    expect(report.blockers).toEqual(['knowledgebase-embedding-model-catalog']);
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'knowledgebase-embedding-model-catalog',
      ok: false,
      selected: expect.objectContaining({
        id: 'gemini-embedding-001',
        provider: null,
        dimensions: null,
        compatible_profile: 'base',
        vectorize_binding: 'VECTORIZE',
        selectable: true,
      }),
      selected_invalid_reasons: ['missing_provider', 'invalid_dimensions'],
    }));
    expect(formatHumanReport(report)).toContain('selected_invalid_reasons=missing_provider,invalid_dimensions');
  });

  it('fails the deployed knowledgebase embedding model catalog check without a service key', async () => {
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => {
      const href = String(url);
      if (href.endsWith('/v1/healthz')) {
        return Response.json({
          ok: true,
          d1: true,
          d1_schema: true,
          vectorize: true,
          r2: true,
          deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23',
        });
      }
      if (href.endsWith('/v1/models')) {
        return Response.json({
          data: [{
            id: 'gemini-embedding-001',
            type: 'embedding',
            provider: 'gemini',
            dimensions: 1536,
            enabled: true,
          }],
        });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    });

    const report = await embeddingModelReleaseStatus({
      model: 'gemini-embedding-001',
      key: '',
      fetchImpl,
      vectorizeReport: vectorizeReady,
      vectorizeMetadataReport: vectorizeMetadataReady,
      checkKnowledgebaseEmbeddingModels: true,
    });

    expect(report.ok).toBe(false);
    expect(report.blockers).toEqual(['knowledgebase-embedding-model-catalog']);
    expect(report.blocker_steps).toEqual(['live-release-status']);
    expect(report.blocker_commands).toEqual([
      expect.objectContaining({
        step_id: 'live-release-status',
        command: 'RAG_SERVICE_KEY=<service-key> pnpm run release-status:embedding-model -- --json --check-vectorize-metadata-indexes --check-knowledgebase-embedding-models',
        mutating: false,
        requires_approval: false,
        required_env: ['RAG_SERVICE_KEY'],
      }),
    ]);
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'knowledgebase-embedding-model-catalog',
      ok: false,
      release_plan_steps: ['live-release-status'],
      skipped: true,
      model: 'gemini-embedding-001',
      error: 'RAG_SERVICE_KEY or --key is required for the knowledgebase embedding model catalog check',
    }));
  });

  it('does not treat a configured dimension as ready without binding details', async () => {
    const fetchImpl = vi.fn(async (url: URL | RequestInfo) => {
      const href = String(url);
      if (href.endsWith('/v1/healthz')) {
        return Response.json({
          ok: true,
          d1: true,
          d1_schema: true,
          vectorize: true,
          r2: true,
          deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23',
        });
      }
      if (href.endsWith('/v1/models')) {
        return Response.json({
          data: [{
            id: 'gemini-embedding-001',
            type: 'embedding',
            provider: 'gemini',
            dimensions: 1536,
            enabled: true,
          }],
        });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    });

    const report = await embeddingModelReleaseStatus({
      model: 'gemini-embedding-001',
      fetchImpl,
      vectorizeReport: {
        ...vectorizeReady,
        models: [],
      },
      vectorizeMetadataReport: vectorizeMetadataReady,
    });

    expect(report.ok).toBe(false);
    expect(report.blockers).toEqual(['vectorize-selected-embedding-model-configured']);
    expect(report.blocker_steps).toEqual([
      'vectorize-embedding-provisioning',
      'readiness-embedding-model',
    ]);
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: 'vectorize-selected-embedding-model-configured',
      ok: false,
      release_plan_steps: [
        'vectorize-embedding-provisioning',
        'readiness-embedding-model',
      ],
      dimensions: 1536,
      configured_dimensions: [384, 768, 1024, 1536],
      vectorize_binding: null,
      vectorize_index: null,
    }));
  });
});
