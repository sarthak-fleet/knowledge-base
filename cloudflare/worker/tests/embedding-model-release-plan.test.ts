import { describe, expect, it } from 'vitest';
import { embeddingModelReleasePlan } from '../scripts/embedding-model-release-plan.mjs';

describe('embedding-model-release-plan', () => {
  it('prints the ordered production release checklist without executing live actions', () => {
    const plan = embeddingModelReleasePlan({
      baseUrl: 'https://rag.example.test/',
      model: 'gemini-embedding-001',
      expectedDeployFingerprint: 'expected-fingerprint',
    });

    expect(plan).toMatchObject({
      ok: true,
      base_url: 'https://rag.example.test',
      embedding_model: 'gemini-embedding-001',
      expected_deploy_fingerprint: 'expected-fingerprint',
    });
    expect(plan.steps.map((step) => step.id)).toEqual([
      'local-predeploy',
      'live-release-status',
      'free-ai-local-check',
      'free-ai-deploy',
      'free-ai-catalog-smoke',
      'vectorize-embedding-provisioning',
      'vectorize-configured-metadata-provisioning',
      'vectorize-metadata-index-readiness',
      'd1-migration',
      'worker-deploy',
      'readiness-embedding-model',
      'rag-crud-embedding-model-smoke',
      'consumer-local-audit',
      'consumer-local-builds',
      'consumer-deploys',
      'consumer-deployed-smoke',
    ]);
    expect(plan.approval_required).toEqual([
      'free-ai-deploy',
      'vectorize-configured-metadata-provisioning',
      'd1-migration',
      'worker-deploy',
      'rag-crud-embedding-model-smoke',
      'consumer-deploys',
      'consumer-deployed-smoke',
    ]);
    expect(plan.mutating_steps).toEqual(plan.approval_required);
    expect(plan.required_mutating_steps).toEqual([
      'free-ai-deploy',
      'vectorize-configured-metadata-provisioning',
      'd1-migration',
      'worker-deploy',
      'rag-crud-embedding-model-smoke',
      'consumer-deploys',
      'consumer-deployed-smoke',
    ]);
    expect(plan.optional_mutating_steps).toEqual([]);
    expect(plan.optional_steps).toEqual([
      'vectorize-embedding-provisioning',
      'consumer-local-audit',
      'consumer-local-builds',
    ]);
    expect(plan.steps[1]).toMatchObject({
      id: 'live-release-status',
      mutating: false,
      requires_approval: false,
      required_env: ['RAG_SERVICE_KEY'],
      command: 'RAG_SERVICE_KEY=<service-key> pnpm run release-status:embedding-model -- --json --check-vectorize-metadata-indexes --check-knowledgebase-embedding-models',
    });
    expect(plan.steps[0]?.notes.join(' ')).toContain('consumer source audit and Cloudflare builds');
    expect(plan.steps[0]?.notes.join(' ')).toContain('upstream free-ai cost/type/test check');
    expect(plan.steps[2]).toMatchObject({
      id: 'free-ai-local-check',
      mutating: false,
      requires_approval: false,
      command: 'cd ../../../free-ai && pnpm run check',
    });
    expect(plan.steps[2]?.notes.join(' ')).toContain('cost audit, typecheck, and tests');
    expect(plan.steps.find((step) => step.id === 'free-ai-deploy')).toMatchObject({
      command: 'cd ../../../free-ai && pnpm run deploy',
    });
    expect(plan.steps.find((step) => step.id === 'free-ai-catalog-smoke')?.command).toContain(
      'cd ../../../free-ai && pnpm run smoke:embedding-models',
    );
  });

  it('keeps the read-only readiness before the mutating RAG CRUD smoke', () => {
    const plan = embeddingModelReleasePlan();
    const readinessIndex = plan.steps.findIndex((step) => step.id === 'readiness-embedding-model');
    const crudIndex = plan.steps.findIndex((step) => step.id === 'rag-crud-embedding-model-smoke');

    expect(readinessIndex).toBeGreaterThan(-1);
    expect(crudIndex).toBeGreaterThan(readinessIndex);
    expect(plan.steps[readinessIndex]).toMatchObject({
      mutating: false,
      requires_approval: false,
      required_env: ['RAG_SERVICE_KEY'],
    });
    expect(plan.steps[crudIndex]).toMatchObject({
      mutating: true,
      requires_approval: true,
      required_env: ['RAG_SERVICE_KEY'],
    });
    expect(plan.steps[crudIndex]?.notes.join(' ')).toContain('/v1/kb/ingest/text');
    expect(plan.steps[crudIndex]?.notes.join(' ')).toContain('/v1/kb/search');
  });

  it('marks Vectorize dimension provisioning complete when all free-ai dimensions are configured', () => {
    const plan = embeddingModelReleasePlan();
    const provisioningIndex = plan.steps.findIndex((step) => step.id === 'vectorize-embedding-provisioning');
    const configuredMetadataIndex = plan.steps.findIndex((step) => step.id === 'vectorize-configured-metadata-provisioning');
    const metadataIndex = plan.steps.findIndex((step) => step.id === 'vectorize-metadata-index-readiness');
    const d1Index = plan.steps.findIndex((step) => step.id === 'd1-migration');
    const deployIndex = plan.steps.findIndex((step) => step.id === 'worker-deploy');
    const provisioning = plan.steps[provisioningIndex];

    expect(provisioningIndex).toBeGreaterThan(-1);
    expect(configuredMetadataIndex).toBeGreaterThan(provisioningIndex);
    expect(metadataIndex).toBeGreaterThan(configuredMetadataIndex);
    expect(d1Index).toBeGreaterThan(metadataIndex);
    expect(d1Index).toBeGreaterThan(provisioningIndex);
    expect(deployIndex).toBeGreaterThan(provisioningIndex);
    expect(provisioning).toBeDefined();
    if (!provisioning) throw new Error('expected vectorize provisioning step');
    expect(plan.vectorize_embedding_bindings.missing_dimensions).toEqual([]);
    expect(plan.vectorize_embedding_bindings.configured_dimensions).toEqual([384, 768, 1024, 1536]);
    expect(provisioning).toMatchObject({
      optional: true,
      mutating: false,
      requires_approval: false,
    });
    expect(provisioning.condition).toContain('deployed free-ai advertises enabled embedding models');
    expect(provisioning.notes.join(' ')).toContain('All known optional free-ai embedding dimensions already have matching Vectorize bindings');
    expect(provisioning.command).not.toContain('wrangler vectorize create rag-embedding-384');
    expect(provisioning.command).not.toContain('wrangler vectorize create rag-embedding-768');
    expect(provisioning.command).not.toContain('wrangler vectorize create rag-embedding-1024');
    expect(provisioning.command).toContain('pnpm run audit:vectorize-embedding-bindings -- --json --require-all');
    expect(plan.steps[configuredMetadataIndex]).toMatchObject({
      mutating: true,
      requires_approval: true,
    });
    expect(plan.steps[configuredMetadataIndex]?.command).toContain('audit:vectorize-metadata-indexes');
    expect(plan.steps[configuredMetadataIndex]?.command).toContain('remediation_commands');
    expect(plan.steps[configuredMetadataIndex]?.notes.join(' ')).toContain(
      'configured_vectorize_metadata_index_commands',
    );
    expect(plan.configured_vectorize_metadata_index_commands).toEqual(expect.arrayContaining([
      expect.objectContaining({
        binding: 'VECTORIZE',
        index_name: 'rag-gemini-1536',
        property_name: 'tenant',
        type: 'string',
        command: [
          'pnpm',
          'exec',
          'wrangler',
          'vectorize',
          'create-metadata-index',
          'rag-gemini-1536',
          '--propertyName',
          'tenant',
          '--type',
          'string',
        ],
      }),
      expect.objectContaining({
        binding: 'VECTORIZE',
        index_name: 'rag-gemini-1536',
        property_name: 'index_id',
        type: 'string',
        command: [
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
        ],
      }),
      expect.objectContaining({
        binding: 'VECTORIZE_384',
        index_name: 'rag-embedding-384',
        property_name: 'tenant',
      }),
      expect.objectContaining({
        binding: 'VECTORIZE_384',
        index_name: 'rag-embedding-384',
        property_name: 'index_id',
      }),
      expect.objectContaining({
        binding: 'VECTORIZE_768',
        index_name: 'rag-embedding-768',
        property_name: 'tenant',
      }),
      expect.objectContaining({
        binding: 'VECTORIZE_768',
        index_name: 'rag-embedding-768',
        property_name: 'index_id',
      }),
      expect.objectContaining({
        binding: 'VECTORIZE_1024',
        index_name: 'rag-embedding-1024',
        property_name: 'tenant',
      }),
      expect.objectContaining({
        binding: 'VECTORIZE_1024',
        index_name: 'rag-embedding-1024',
        property_name: 'index_id',
      }),
    ]));
    expect(plan.configured_vectorize_metadata_index_commands).toHaveLength(8);
    expect(plan.steps[metadataIndex]).toMatchObject({
      mutating: false,
      requires_approval: false,
      command: 'pnpm run audit:vectorize-metadata-indexes -- --json --require-complete',
    });
    expect(plan.steps[d1Index]?.notes.join(' ')).toContain('0005_index_embedding_model.sql');
    expect(plan.steps[d1Index]?.notes.join(' ')).toContain('0006_kb_domain_embedding_model.sql');
  });

  it('does not treat the static consumer audit as deployed consumer smoke', () => {
    const plan = embeddingModelReleasePlan();
    const localAudit = plan.steps.find((step) => step.id === 'consumer-local-audit');
    const localBuilds = plan.steps.find((step) => step.id === 'consumer-local-builds');
    const consumerDeploys = plan.steps.find((step) => step.id === 'consumer-deploys');
    const deployedSmoke = plan.steps.find((step) => step.id === 'consumer-deployed-smoke');
    const localAuditIndex = plan.steps.findIndex((step) => step.id === 'consumer-local-audit');
    const localBuildsIndex = plan.steps.findIndex((step) => step.id === 'consumer-local-builds');
    const deployIndex = plan.steps.findIndex((step) => step.id === 'consumer-deploys');

    expect(localAudit).toMatchObject({
      mutating: false,
      requires_approval: false,
      optional: true,
      command: 'pnpm run audit:consumer-rag-integrations -- --json --require-complete',
    });
    expect(localAudit?.condition).toContain('Already included in local-predeploy');
    expect(localBuilds).toMatchObject({
      mutating: false,
      requires_approval: false,
      optional: true,
      command: 'pnpm run build:consumer-cloudflare -- --json',
    });
    expect(localBuilds?.condition).toContain('Already included in local-predeploy');
    expect(localBuilds?.notes.join(' ')).toContain('does not deploy');
    expect(localBuildsIndex).toBeGreaterThan(localAuditIndex);
    expect(deployIndex).toBeGreaterThan(localBuildsIndex);
    expect(consumerDeploys).toMatchObject({
      mutating: true,
      requires_approval: true,
      command: '(cd ../../../karte && pnpm run deploy:cf) && (cd ../../../starboard && pnpm run deploy:cf)',
    });
    expect(deployedSmoke).toMatchObject({
      mutating: true,
      requires_approval: true,
    });
    expect(deployedSmoke?.command).toContain('manual: smoke karte.cc');
    expect(deployedSmoke?.notes.join(' ')).toContain('not the static local audit');
  });
});
