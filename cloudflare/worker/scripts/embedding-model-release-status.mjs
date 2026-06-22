#!/usr/bin/env node

import { EXPECTED_DEPLOY_FINGERPRINT } from './deploy-readiness.mjs';
import { auditVectorizeEmbeddingBindings } from './audit-vectorize-embedding-bindings.mjs';
import { auditVectorizeMetadataIndexes } from './audit-vectorize-metadata-indexes.mjs';
import { embeddingModelReleasePlan } from './embedding-model-release-plan.mjs';

const DEFAULT_RAG_BASE_URL = process.env.RAG_BASE_URL || 'https://knowledgebase.sarthakagrawal927.workers.dev';
const DEFAULT_FREE_AI_BASE_URL = process.env.FREE_AI_BASE_URL || 'https://free-ai-gateway.sarthakagrawal927.workers.dev';
const DEFAULT_MODEL = process.env.RAG_REQUIRED_EMBEDDING_MODEL || 'gemini-embedding-001';
const DEFAULT_RAG_SERVICE_KEY = process.env.RAG_SERVICE_KEY || '';
/** @type {any} */
const DEFAULT_VECTORIZE_METADATA_REPORT = null;

const CHECK_RELEASE_PLAN_STEPS = {
  'knowledgebase-public-health-current': ['d1-migration', 'worker-deploy', 'readiness-embedding-model'],
  'free-ai-deployed-embedding-catalog': ['free-ai-local-check', 'free-ai-deploy', 'free-ai-catalog-smoke'],
  'knowledgebase-embedding-model-catalog': [
    'free-ai-local-check',
    'free-ai-deploy',
    'free-ai-catalog-smoke',
    'vectorize-embedding-provisioning',
    'worker-deploy',
    'readiness-embedding-model',
  ],
  'vectorize-selected-embedding-model-configured': [
    'free-ai-local-check',
    'free-ai-deploy',
    'free-ai-catalog-smoke',
    'vectorize-embedding-provisioning',
    'readiness-embedding-model',
  ],
  'vectorize-all-free-ai-dimensions-configured': ['vectorize-embedding-provisioning'],
  'vectorize-configured-metadata-indexes': [
    'vectorize-configured-metadata-provisioning',
    'vectorize-metadata-index-readiness',
  ],
};

function check(name, ok, detail = {}) {
  return { name, ok, release_plan_steps: CHECK_RELEASE_PLAN_STEPS[name] ?? [], ...detail };
}

function normalizeBaseUrl(value) {
  return String(value || '').replace(/\/+$/, '');
}

async function requestJson(fetchImpl, url, { key = '' } = {}) {
  const headers = { Accept: 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await fetchImpl(url, { headers });
  const payload = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, payload };
}

function embeddingRows(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  return rows.filter((item) => item && item.type === 'embedding');
}

function selectedEmbeddingModel(rows, model) {
  return rows.find((item) => item.id === model || item.aliases?.includes?.(model)) ?? null;
}

function uniqueNumbers(values) {
  return [...new Set(values.filter((value) => typeof value === 'number' && Number.isFinite(value)).map((value) => Math.trunc(value)))].sort((a, b) => a - b);
}

function deployedEmbeddingModelDetail(item) {
  return {
    id: typeof item.id === 'string' ? item.id : null,
    provider: typeof item.provider === 'string' ? item.provider : null,
    dimensions: typeof item.dimensions === 'number' && Number.isFinite(item.dimensions) ? Math.trunc(item.dimensions) : null,
    enabled: item.enabled !== false,
  };
}

function commandText(command) {
  return Array.isArray(command) ? command.join(' ') : String(command || '').trim();
}

function uniqueCommandTexts(commands) {
  return [...new Set(commands.map(commandText).filter(Boolean))];
}

function vectorizeMetadataRemediationCommandTexts(report) {
  const commands = [];
  for (const item of report?.blockers ?? []) {
    if (Array.isArray(item?.remediation_commands)) commands.push(...item.remediation_commands);
  }
  for (const item of report?.indexes ?? []) {
    if (Array.isArray(item?.remediation_commands)) commands.push(...item.remediation_commands);
  }
  return uniqueCommandTexts(commands);
}

function validEmbeddingModelDetail(item) {
  return typeof item.id === 'string'
    && item.id.length > 0
    && typeof item.provider === 'string'
    && item.provider.length > 0
    && typeof item.dimensions === 'number'
    && Number.isFinite(item.dimensions)
    && item.dimensions > 0;
}

function embeddingModelInvalidReasons(item) {
  const reasons = [];
  if (typeof item.id !== 'string' || item.id.length === 0) reasons.push('missing_id');
  if (typeof item.provider !== 'string' || item.provider.length === 0) reasons.push('missing_provider');
  if (typeof item.dimensions !== 'number' || !Number.isFinite(item.dimensions) || item.dimensions <= 0) {
    reasons.push('invalid_dimensions');
  }
  return reasons;
}

export async function embeddingModelReleaseStatus({
  ragBaseUrl = DEFAULT_RAG_BASE_URL,
  freeAiBaseUrl = DEFAULT_FREE_AI_BASE_URL,
  model = DEFAULT_MODEL,
  key = DEFAULT_RAG_SERVICE_KEY,
  expectedDeployFingerprint = EXPECTED_DEPLOY_FINGERPRINT,
  fetchImpl = fetch,
  vectorizeReport = auditVectorizeEmbeddingBindings(),
  vectorizeMetadataReport = DEFAULT_VECTORIZE_METADATA_REPORT,
  checkKnowledgebaseEmbeddingModels = false,
} = {}) {
  const normalizedRagBaseUrl = normalizeBaseUrl(ragBaseUrl);
  const normalizedFreeAiBaseUrl = normalizeBaseUrl(freeAiBaseUrl);
  const checks = [];
  let selectedDeployedModel = null;
  let deployedEmbeddingModels = [];
  let freeAiEmbeddingCatalogReady = false;

  try {
    const health = await requestJson(fetchImpl, `${normalizedRagBaseUrl}/v1/healthz`);
    checks.push(check('knowledgebase-public-health-current', health.ok
      && health.payload?.ok === true
      && health.payload?.d1 === true
      && health.payload?.d1_schema === true
      && health.payload?.vectorize === true
      && health.payload?.r2 === true
      && health.payload?.deploy_fingerprint === expectedDeployFingerprint, {
      status: health.status,
      deploy_fingerprint: typeof health.payload?.deploy_fingerprint === 'string' ? health.payload.deploy_fingerprint : null,
      expected_deploy_fingerprint: expectedDeployFingerprint,
      d1_schema: typeof health.payload?.d1_schema === 'boolean' ? health.payload.d1_schema : null,
      vectorize: typeof health.payload?.vectorize === 'boolean' ? health.payload.vectorize : null,
      r2: typeof health.payload?.r2 === 'boolean' ? health.payload.r2 : null,
    }));
  } catch (error) {
    checks.push(check('knowledgebase-public-health-current', false, {
      error: String(error instanceof Error ? error.message : error),
    }));
  }

  try {
    const models = await requestJson(fetchImpl, `${normalizedFreeAiBaseUrl}/v1/models`);
    const embeddings = embeddingRows(models.payload);
    deployedEmbeddingModels = embeddings.map(deployedEmbeddingModelDetail);
    const selected = selectedEmbeddingModel(embeddings, model);
    const validEnabledEmbeddings = embeddings.filter((item) => item.enabled !== false && validEmbeddingModelDetail(item));
    const invalidEnabledEmbeddings = embeddings
      .filter((item) => item.enabled !== false && !validEmbeddingModelDetail(item))
      .map((item) => ({
        ...deployedEmbeddingModelDetail(item),
        invalid_reasons: embeddingModelInvalidReasons(item),
      }));
    const selectedReady = Boolean(selected) && selected.enabled !== false && validEmbeddingModelDetail(selected);
    freeAiEmbeddingCatalogReady = models.ok && validEnabledEmbeddings.length > 0 && invalidEnabledEmbeddings.length === 0;
    selectedDeployedModel = selected
      ? {
        id: selected.id,
        provider: typeof selected.provider === 'string' ? selected.provider : null,
        dimensions: typeof selected.dimensions === 'number' ? selected.dimensions : null,
        supports_dimensions: selected.supports_dimensions === true,
        aliases: Array.isArray(selected.aliases) ? selected.aliases : [],
        priority: typeof selected.priority === 'number' ? selected.priority : null,
        enabled: selected.enabled !== false,
      }
      : null;
    checks.push(check('free-ai-deployed-embedding-catalog', models.ok
      && freeAiEmbeddingCatalogReady
      && selectedReady, {
      status: models.status,
      embedding_model_count: embeddings.length,
      valid_embedding_model_count: validEnabledEmbeddings.length,
      invalid_embedding_models: invalidEnabledEmbeddings,
      model,
      selected: selectedDeployedModel,
      selected_invalid_reasons: selected ? embeddingModelInvalidReasons(selected) : ['missing_model'],
    }));
  } catch (error) {
    checks.push(check('free-ai-deployed-embedding-catalog', false, {
      model,
      error: String(error instanceof Error ? error.message : error),
    }));
  }

  if (checkKnowledgebaseEmbeddingModels) {
    if (!key) {
      checks.push(check('knowledgebase-embedding-model-catalog', false, {
        release_plan_steps: ['live-release-status'],
        skipped: true,
        model,
        error: 'RAG_SERVICE_KEY or --key is required for the knowledgebase embedding model catalog check',
      }));
    } else {
      try {
        const models = await requestJson(fetchImpl, `${normalizedRagBaseUrl}/v1/embedding-models`, { key });
        const rows = Array.isArray(models.payload?.free_ai_models) ? models.payload.free_ai_models : [];
        const selected = selectedEmbeddingModel(rows, model);
        const selectedReady = Boolean(selected)
          && selected.enabled !== false
          && validEmbeddingModelDetail(selected)
          && Boolean(selected.compatible_profile)
          && Boolean(selected.vectorize_binding)
          && selected.selectable === true;
        const selectedKnowledgebaseModel = selected
          ? {
            id: selected.id,
            provider: typeof selected.provider === 'string' ? selected.provider : null,
            dimensions: typeof selected.dimensions === 'number' ? selected.dimensions : null,
            compatible_profile: typeof selected.compatible_profile === 'string' ? selected.compatible_profile : null,
            vectorize_binding: typeof selected.vectorize_binding === 'string' ? selected.vectorize_binding : null,
            selectable: selected.selectable === true,
            enabled: selected.enabled !== false,
          }
          : null;
        checks.push(check('knowledgebase-embedding-model-catalog', models.ok
          && models.payload?.catalog_source === 'free_ai'
          && selectedReady, {
          status: models.status,
          model,
          catalog_source: typeof models.payload?.catalog_source === 'string' ? models.payload.catalog_source : null,
          catalog_error: typeof models.payload?.catalog_error === 'string' ? models.payload.catalog_error : null,
          selected: selectedKnowledgebaseModel,
          selected_invalid_reasons: selected ? embeddingModelInvalidReasons(selected) : ['missing_model'],
        }));
      } catch (error) {
        checks.push(check('knowledgebase-embedding-model-catalog', false, {
          model,
          error: String(error instanceof Error ? error.message : error),
        }));
      }
    }
  }

  const selectedDimensions = typeof selectedDeployedModel?.dimensions === 'number'
    ? selectedDeployedModel.dimensions
    : null;
  const selectedVectorizeModel = selectedDimensions === null
    ? null
    : vectorizeReport.models.find((item) => item.dimensions === selectedDimensions && item.id === selectedDeployedModel.id)
      ?? vectorizeReport.models.find((item) => item.dimensions === selectedDimensions)
      ?? null;
  const selectedVectorizeReady = selectedDimensions !== null
    && selectedVectorizeModel?.selectable === true
    && typeof selectedVectorizeModel.vectorize_binding === 'string'
    && selectedVectorizeModel.vectorize_binding.length > 0
    && typeof selectedVectorizeModel.vectorize_index === 'string'
    && selectedVectorizeModel.vectorize_index.length > 0;
  const selectedVectorizeReleasePlanSteps = !freeAiEmbeddingCatalogReady || !selectedDeployedModel
    ? ['free-ai-local-check', 'free-ai-deploy', 'free-ai-catalog-smoke']
    : ['vectorize-embedding-provisioning', 'readiness-embedding-model'];
  checks.push(check('vectorize-selected-embedding-model-configured', selectedVectorizeReady, {
    release_plan_steps: selectedVectorizeReleasePlanSteps,
    model,
    selected: selectedDeployedModel,
    dimensions: selectedDimensions,
    configured_dimensions: vectorizeReport.configured_dimensions,
    vectorize_binding: selectedVectorizeModel?.vectorize_binding ?? null,
    vectorize_index: selectedVectorizeModel?.vectorize_index ?? null,
  }));

  const enabledDeployedEmbeddingModels = deployedEmbeddingModels.filter((item) => item.enabled === true && item.dimensions !== null);
  const deployedEmbeddingDimensions = uniqueNumbers(enabledDeployedEmbeddingModels.map((item) => item.dimensions));
  const configuredDimensions = new Set(vectorizeReport.configured_dimensions);
  const missingDeployedDimensions = deployedEmbeddingDimensions.filter((dimension) => !configuredDimensions.has(dimension));
  const missingDimensions = uniqueNumbers(missingDeployedDimensions);
  const deployedBlockedModels = enabledDeployedEmbeddingModels.filter((item) => (
    item.dimensions !== null && missingDeployedDimensions.includes(item.dimensions)
  ));
  const allDimensionsReleasePlanSteps = freeAiEmbeddingCatalogReady
    ? ['vectorize-embedding-provisioning']
    : ['free-ai-local-check', 'free-ai-deploy', 'free-ai-catalog-smoke'];
  checks.push(check('vectorize-all-free-ai-dimensions-configured', freeAiEmbeddingCatalogReady
    && vectorizeReport.ok === true
    && missingDeployedDimensions.length === 0, {
    release_plan_steps: allDimensionsReleasePlanSteps,
    free_ai_catalog_ready: freeAiEmbeddingCatalogReady,
    configured_dimensions: vectorizeReport.configured_dimensions,
    deployed_embedding_dimensions: deployedEmbeddingDimensions,
    local_optional_missing_dimensions: vectorizeReport.missing_dimensions,
    missing_deployed_dimensions: missingDeployedDimensions,
    missing_dimensions: missingDimensions,
    selectable_models: vectorizeReport.selectable_models,
    blocked_models: vectorizeReport.blocked_models,
    deployed_blocked_models: deployedBlockedModels,
    provisioning_plan: vectorizeReport.provisioning_plan,
    audit_blockers: vectorizeReport.blockers ?? [],
  }));

  if (vectorizeMetadataReport) {
    checks.push(check('vectorize-configured-metadata-indexes', vectorizeMetadataReport.ok === true, {
      required_metadata_indexes: vectorizeMetadataReport.required_metadata_indexes ?? [],
      indexes: vectorizeMetadataReport.indexes ?? [],
      blockers: vectorizeMetadataReport.blockers ?? [],
    }));
  }

  const failedChecks = checks.filter((item) => !item.ok);
  const blockers = failedChecks.map((item) => item.name);
  const blockerSteps = [];
  for (const item of failedChecks) {
    for (const step of item.release_plan_steps ?? []) {
      if (!blockerSteps.includes(step)) blockerSteps.push(step);
    }
  }
  const releasePlan = embeddingModelReleasePlan({
    baseUrl: normalizedRagBaseUrl,
    model,
    expectedDeployFingerprint,
  });
  const stepsById = new Map(releasePlan.steps.map((item) => [item.id, item]));
  const vectorizeMetadataRemediationCommands = vectorizeMetadataRemediationCommandTexts(vectorizeMetadataReport);
  const blockerCommands = blockerSteps.map((stepId) => {
    const planStep = stepsById.get(stepId);
    const command = stepId === 'vectorize-configured-metadata-provisioning'
      && vectorizeMetadataRemediationCommands.length > 0
      ? [
        ...vectorizeMetadataRemediationCommands,
        'pnpm run audit:vectorize-metadata-indexes -- --json --require-complete',
      ].join(' && ')
      : planStep?.command ?? null;
    return {
      step_id: stepId,
      title: planStep?.title ?? null,
      command,
      mutating: planStep?.mutating === true,
      requires_approval: planStep?.requires_approval === true,
      optional: planStep?.optional === true,
      required_env: Array.isArray(planStep?.required_env) ? planStep.required_env : [],
    };
  });
  return {
    ok: blockers.length === 0,
    rag_base_url: normalizedRagBaseUrl,
    free_ai_base_url: normalizedFreeAiBaseUrl,
    embedding_model: model,
    expected_deploy_fingerprint: expectedDeployFingerprint,
    blockers,
    blocker_steps: blockerSteps,
    blocker_commands: blockerCommands,
    checks,
  };
}

function usage() {
  console.error(`Usage:
  node scripts/embedding-model-release-status.mjs [--rag-base-url <url>] [--free-ai-base-url <url>] [--model <id>] [--key <service-key>] [--expected-deploy-fingerprint <value>] [--check-vectorize-metadata-indexes] [--check-knowledgebase-embedding-models] [--json]

Read-only status gate for the embedding-model production release. It fetches
public knowledgebase health, public free-ai model catalog rows, and local
Vectorize binding config. With --check-knowledgebase-embedding-models it also
uses RAG_SERVICE_KEY or --key to fetch deployed /v1/embedding-models and prove
the selected model is backed by live free-ai rows plus a compatible Vectorize
binding. With --check-vectorize-metadata-indexes it also calls Wrangler
read-only metadata-index listing for configured Vectorize indexes. It does not
deploy, migrate, provision, or mutate data.`);
}

function parseArgs(argv) {
  const args = {
    ragBaseUrl: DEFAULT_RAG_BASE_URL,
    freeAiBaseUrl: DEFAULT_FREE_AI_BASE_URL,
    model: DEFAULT_MODEL,
    key: DEFAULT_RAG_SERVICE_KEY,
    expectedDeployFingerprint: EXPECTED_DEPLOY_FINGERPRINT,
    checkVectorizeMetadataIndexes: false,
    checkKnowledgebaseEmbeddingModels: false,
    jsonOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--json') {
      args.jsonOnly = true;
      continue;
    }
    if (arg === '--check-vectorize-metadata-indexes') {
      args.checkVectorizeMetadataIndexes = true;
      continue;
    }
    if (arg === '--check-knowledgebase-embedding-models') {
      args.checkKnowledgebaseEmbeddingModels = true;
      continue;
    }
    const value = argv[i + 1];
    if (!value) throw new Error(`missing value for ${arg}`);
    i += 1;
    if (arg === '--rag-base-url') args.ragBaseUrl = value;
    else if (arg === '--free-ai-base-url') args.freeAiBaseUrl = value;
    else if (arg === '--model') args.model = value;
    else if (arg === '--key') args.key = value;
    else if (arg === '--expected-deploy-fingerprint') args.expectedDeployFingerprint = value;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function compact(value) {
  if (Array.isArray(value)) return value.length ? value.join(',') : 'none';
  if (value === null || value === undefined || value === '') return 'none';
  return String(value);
}

function modelLabel(model) {
  if (!model) return 'none';
  const id = compact(model.id);
  const dimensions = model.dimensions === null || model.dimensions === undefined ? 'unknown' : `${model.dimensions}d`;
  const provider = model.provider ? ` provider=${model.provider}` : '';
  const enabled = typeof model.enabled === 'boolean' ? ` enabled=${model.enabled}` : '';
  return `${id} ${dimensions}${provider}${enabled}`;
}

function checkDetailLines(item) {
  if (item.error) return [`error=${item.error}`];
  if (item.name === 'knowledgebase-public-health-current') {
    return [
      `status=${compact(item.status)} deploy_fingerprint=${compact(item.deploy_fingerprint)} expected=${compact(item.expected_deploy_fingerprint)}`,
      `d1_schema=${compact(item.d1_schema)} vectorize=${compact(item.vectorize)} r2=${compact(item.r2)}`,
    ];
  }
  if (item.name === 'free-ai-deployed-embedding-catalog') {
    const invalidModels = Array.isArray(item.invalid_embedding_models)
      ? item.invalid_embedding_models.map((model) => {
        const reasons = Array.isArray(model.invalid_reasons) ? model.invalid_reasons.join('|') : 'unknown';
        return `${compact(model.id)}:${reasons}`;
      }).join(',') || 'none'
      : 'none';
    return [
      `status=${compact(item.status)} embedding_model_count=${compact(item.embedding_model_count)} valid_embedding_model_count=${compact(item.valid_embedding_model_count)} required_model=${compact(item.model)}`,
      `selected=${modelLabel(item.selected)}`,
      `selected_invalid_reasons=${compact(item.selected_invalid_reasons)} invalid_embedding_models=${invalidModels}`,
    ];
  }
  if (item.name === 'knowledgebase-embedding-model-catalog') {
    return [
      `status=${compact(item.status)} catalog_source=${compact(item.catalog_source)} catalog_error=${compact(item.catalog_error)}`,
      `selected=${modelLabel(item.selected)} compatible_profile=${compact(item.selected?.compatible_profile)} vectorize_binding=${compact(item.selected?.vectorize_binding)} selectable=${compact(item.selected?.selectable)}`,
      `selected_invalid_reasons=${compact(item.selected_invalid_reasons)}`,
    ];
  }
  if (item.name === 'vectorize-selected-embedding-model-configured') {
    return [
      `selected=${modelLabel(item.selected)} configured_dimensions=${compact(item.configured_dimensions)}`,
      `vectorize_binding=${compact(item.vectorize_binding)} vectorize_index=${compact(item.vectorize_index)}`,
    ];
  }
  if (item.name === 'vectorize-all-free-ai-dimensions-configured') {
    const deployedBlocked = Array.isArray(item.deployed_blocked_models)
      ? item.deployed_blocked_models.map((model) => `${model.id}:${model.dimensions}`).join(',') || 'none'
      : 'none';
    return [
      `free_ai_catalog_ready=${compact(item.free_ai_catalog_ready)} configured_dimensions=${compact(item.configured_dimensions)} deployed_embedding_dimensions=${compact(item.deployed_embedding_dimensions)}`,
      `missing_deployed_dimensions=${compact(item.missing_deployed_dimensions)} local_optional_missing_dimensions=${compact(item.local_optional_missing_dimensions)}`,
      `blocked_models=${compact(item.blocked_models)} deployed_blocked_models=${deployedBlocked}`,
    ];
  }
  if (item.name === 'vectorize-configured-metadata-indexes') {
    const blockers = Array.isArray(item.blockers)
      ? item.blockers.map((blocker) => {
        const missing = Array.isArray(blocker.missing_metadata_indexes)
          ? blocker.missing_metadata_indexes.map((entry) => entry.property_name).join(',')
          : 'unknown';
        return `${blocker.binding ?? 'unknown'}:${blocker.index_name ?? 'unknown'} missing=${missing}`;
      }).join('; ') || 'none'
      : 'none';
    return [`metadata_blockers=${blockers}`];
  }
  return [];
}

export function formatHumanReport(report) {
  const lines = [
    `Embedding model release status for ${report.embedding_model}`,
    `knowledgebase=${report.rag_base_url}`,
    `free_ai=${report.free_ai_base_url}`,
  ];
  for (const item of report.checks) {
    lines.push(`${item.ok ? 'PASS' : 'FAIL'} ${item.name}`);
    if (!item.ok && item.release_plan_steps?.length) {
      lines.push(`  release_plan_steps=${item.release_plan_steps.join(',')}`);
    }
    if (!item.ok) {
      for (const line of checkDetailLines(item)) {
        lines.push(`  ${line}`);
      }
    }
  }
  lines.push('');
  lines.push(`${report.ok ? 'READY' : 'NOT_READY'} blockers=${report.blockers.join(',') || 'none'}`);
  if (!report.ok) lines.push(`next_release_plan_steps=${report.blocker_steps.join(',') || 'none'}`);
  if (!report.ok && report.blocker_commands?.length) {
    lines.push('next_commands:');
    for (const item of report.blocker_commands) {
      const approval = item.requires_approval ? ' approval_required' : '';
      const mutating = item.mutating ? ' mutating' : ' read_only';
      lines.push(`  ${item.step_id}:${mutating}${approval}`);
      if (item.command) lines.push(`    ${item.command}`);
    }
  }
  return lines.join('\n');
}

function printHuman(report) {
  console.log(formatHumanReport(report));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = await embeddingModelReleaseStatus({
      ...args,
      vectorizeMetadataReport: args.checkVectorizeMetadataIndexes ? auditVectorizeMetadataIndexes() : null,
    });
    if (args.jsonOnly) console.log(JSON.stringify(report, null, 2));
    else printHuman(report);
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    usage();
    console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
