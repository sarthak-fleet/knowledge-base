#!/usr/bin/env node

import { EXPECTED_DEPLOY_FINGERPRINT } from './deploy-readiness.mjs';
import { auditVectorizeEmbeddingBindings } from './audit-vectorize-embedding-bindings.mjs';
import { configuredVectorizeMetadataProvisioningCommands } from './audit-vectorize-metadata-indexes.mjs';

const DEFAULT_BASE_URL = process.env.RAG_BASE_URL || 'https://knowledgebase.sarthakagrawal927.workers.dev';
const DEFAULT_MODEL = process.env.RAG_REQUIRED_EMBEDDING_MODEL || 'gemini-embedding-001';

function step(
  id,
  title,
  command,
  { mutating = false, requiresApproval = false, requiredEnv = [], optional = false, condition = null, notes = [] } = {},
) {
  return {
    id,
    title,
    command,
    mutating,
    requires_approval: requiresApproval,
    optional,
    condition,
    required_env: requiredEnv,
    notes,
  };
}

function vectorizeProvisioningCommand(report) {
  const commands = report.provisioning_plan.flatMap((item) => [
    item.command.join(' '),
    ...item.metadata_commands.map((command) => command.join(' ')),
  ]);
  if (commands.length === 0) return 'pnpm run audit:vectorize-embedding-bindings -- --json --require-all';
  return [
    ...commands,
    'pnpm run audit:vectorize-embedding-bindings -- --json --require-all',
  ].join(' && ');
}

export function embeddingModelReleasePlan({
  baseUrl = DEFAULT_BASE_URL,
  model = DEFAULT_MODEL,
  expectedDeployFingerprint = EXPECTED_DEPLOY_FINGERPRINT,
} = {}) {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, '');
  const vectorizeReport = auditVectorizeEmbeddingBindings();
  const configuredMetadataCommands = configuredVectorizeMetadataProvisioningCommands();
  const steps = [
    step(
      'local-predeploy',
      'Run the local Cloudflare release gate',
      'pnpm run predeploy:local -- --json',
      {
        notes: [
          'Read-only/local gate; includes Worker check, preflight, consumer source audit and Cloudflare builds, free-ai catalog and deploy-script/vectorize audits, upstream free-ai cost/type/test check, full-port gap matrix, OCR dry-run, local cutover smoke, and deploy dry-run.',
        ],
      },
    ),
    step(
      'live-release-status',
      'Check current live embedding-model release status',
      'RAG_SERVICE_KEY=<service-key> pnpm run release-status:embedding-model -- --json --check-vectorize-metadata-indexes --check-knowledgebase-embedding-models',
      {
        requiredEnv: ['RAG_SERVICE_KEY'],
        notes: [
          'Read-only live gate. It should fail until deployed free-ai, deployed knowledgebase /v1/embedding-models, Vectorize bindings/metadata indexes, D1 schema, and the Worker fingerprint are current.',
        ],
      },
    ),
    step(
      'free-ai-local-check',
      'Run the local free-ai release gate',
      'cd ../../../free-ai && pnpm run check',
      {
        notes: [
          'Read-only/local gate for the upstream embedding catalog service; proves cost audit, typecheck, and tests before any approved free-ai deploy.',
        ],
      },
    ),
    step(
      'free-ai-deploy',
      'Deploy the matching free-ai embedding catalog',
      'cd ../../../free-ai && pnpm run deploy',
      {
        mutating: true,
        requiresApproval: true,
        notes: [
          'Required so live /v1/models returns embedding rows with dimensions, aliases, enabled state, and provider metadata. The local audit requires this deploy path to run audit:cloudflare-costs before wrangler deploy.',
        ],
      },
    ),
    step(
      'free-ai-catalog-smoke',
      'Smoke the deployed free-ai embedding catalog',
      `cd ../../../free-ai && pnpm run smoke:embedding-models -- --model ${model}`,
      {
        requiredEnv: ['FREE_AI_BASE_URL or deployed free-ai default', 'FREE_AI_API_KEY if the gateway requires auth'],
        notes: ['Read-only against the deployed free-ai gateway.'],
      },
    ),
    step(
      'vectorize-embedding-provisioning',
      'Optionally provision Vectorize indexes for future non-1536 free-ai embedding dimensions',
      vectorizeProvisioningCommand(vectorizeReport),
      {
        mutating: vectorizeReport.missing_dimensions.length > 0,
        requiresApproval: vectorizeReport.missing_dimensions.length > 0,
        optional: true,
        condition: 'Run only after deployed free-ai advertises enabled embedding models whose dimensions are not already configured, or when deliberately preparing those future choices.',
        notes: [
          vectorizeReport.missing_dimensions.length > 0
            ? `Not required for the default ${model} rollout when deployed free-ai only exposes 1536d. Required before non-1536 free-ai models become selectable: missing dimensions ${vectorizeReport.missing_dimensions.join(', ')}.`
            : 'All known optional free-ai embedding dimensions already have matching Vectorize bindings.',
          'Vectorize dimensions are fixed at index creation time; provision before enabling model-selection expectations for those dimensions in production.',
        ],
      },
    ),
    step(
      'vectorize-configured-metadata-provisioning',
      'Provision missing metadata indexes on configured Vectorize indexes',
      'manual: run pnpm run audit:vectorize-metadata-indexes -- --json, apply only approved remediation_commands it reports, then rerun with --require-complete',
      {
        mutating: true,
        requiresApproval: true,
        notes: [
          'Required when an existing configured Vectorize index, including the default 1536d index, is missing tenant/index_id metadata indexes.',
          'The audit is read-only; only the reported create-metadata-index remediation_commands are mutating.',
          'Configured command candidates are listed in configured_vectorize_metadata_index_commands for review before approval.',
        ],
      },
    ),
    step(
      'vectorize-metadata-index-readiness',
      'Verify configured Vectorize metadata indexes',
      'pnpm run audit:vectorize-metadata-indexes -- --json --require-complete',
      {
        notes: [
          'Read-only Wrangler audit. Run after approved Vectorize provisioning and config update to prove each configured index has tenant/index_id string metadata indexes.',
        ],
      },
    ),
    step(
      'd1-migration',
      'Apply the embedding metadata D1 migration',
      'pnpm exec wrangler d1 migrations apply rag-db --remote',
      {
        mutating: true,
        requiresApproval: true,
        notes: [
          'Applies migrations including 0005_index_embedding_model.sql and 0006_kb_domain_embedding_model.sql so indexes and knowledgebase domains can persist embedding_model and embedding_provider.',
        ],
      },
    ),
    step(
      'worker-deploy',
      'Deploy the current knowledgebase Worker',
      'pnpm run deploy',
      {
        mutating: true,
        requiresApproval: true,
        notes: [`Live /v1/healthz must report deploy_fingerprint=${expectedDeployFingerprint}.`],
      },
    ),
    step(
      'readiness-embedding-model',
      'Run read-only selected-model readiness',
      `RAG_BASE_URL=${normalizedBaseUrl} RAG_SERVICE_KEY=<service-key> pnpm run readiness:embedding-model`,
      {
        requiredEnv: ['RAG_SERVICE_KEY'],
        notes: [
          'Authenticated read-only check for live health, d1_schema, fingerprint, and dynamic free-ai embedding catalog source.',
        ],
      },
    ),
    step(
      'rag-crud-embedding-model-smoke',
      'Run mutating selected-model RAG CRUD smoke',
      `RAG_BASE_URL=${normalizedBaseUrl} RAG_SERVICE_KEY=<service-key> pnpm run smoke:rag-crud:embedding-model`,
      {
        mutating: true,
        requiresApproval: true,
        requiredEnv: ['RAG_SERVICE_KEY'],
        notes: [
          'Creates a temporary index with the selected embedding model, ingests one document, queries it, and cleans up. The embedding-model script also creates a temporary KB domain through /v1/kb/ingest/text, queries /v1/kb/search, and deletes the generated domain index.',
        ],
      },
    ),
    step(
      'consumer-local-audit',
      'Audit local Linkchat/Karte and Starboard knowledgebase wiring',
      'pnpm run audit:consumer-rag-integrations -- --json --require-complete',
      {
        optional: true,
        condition: 'Already included in local-predeploy; rerun directly when consumer source wiring changed or when local-predeploy was skipped.',
        notes: [
          'Static local audit is read-only and proves source wiring plus Cloudflare deploy scripts that run each consumer build pipeline before deploy; it does not prove deployed consumer bindings or live user flows.',
        ],
      },
    ),
    step(
      'consumer-local-builds',
      'Build local Linkchat/Karte and Starboard Cloudflare bundles',
      'pnpm run build:consumer-cloudflare -- --json',
      {
        optional: true,
        condition: 'Already included in local-predeploy; rerun directly when Karte/Starboard changed or when local-predeploy was skipped.',
        notes: [
          'Read-only/local build verification for the exact Cloudflare build pipelines used by deploy:cf. It does not deploy or prove live bindings.',
        ],
      },
    ),
    step(
      'consumer-deploys',
      'Deploy Linkchat/Karte and Starboard after knowledgebase is live',
      '(cd ../../../karte && pnpm run deploy:cf) && (cd ../../../starboard && pnpm run deploy:cf)',
      {
        mutating: true,
        requiresApproval: true,
        notes: [
          'Requires each deployed app to have RAG_SERVICE bound to knowledgebase plus the matching RAG_SERVICE_KEY configured.',
          'Starboard also requires STARBOARD_RAG_INDEX_ID to point at the deployed knowledgebase index.',
        ],
      },
    ),
    step(
      'consumer-deployed-smoke',
      'Smoke deployed Linkchat/Karte and Starboard RAG flows',
      'manual: smoke karte.cc profile-memory create/ingest/search/delete and Starboard /api/stars/sync plus relevance search against deployed knowledgebase',
      {
        mutating: true,
        requiresApproval: true,
        notes: [
          'This is live application smoke, not the static local audit. Run only after the consumer deploys are approved and complete.',
          'The smoke should prove consumer requests reach the deployed knowledgebase Worker rather than any retired rag-service or local vector fallback.',
        ],
      },
    ),
  ];
  return {
    ok: true,
    base_url: normalizedBaseUrl,
    embedding_model: model,
    expected_deploy_fingerprint: expectedDeployFingerprint,
    vectorize_embedding_bindings: {
      configured_dimensions: vectorizeReport.configured_dimensions,
      missing_dimensions: vectorizeReport.missing_dimensions,
      selectable_models: vectorizeReport.selectable_models,
      blocked_models: vectorizeReport.blocked_models,
      provisioning_plan: vectorizeReport.provisioning_plan,
    },
    configured_vectorize_metadata_index_commands: configuredMetadataCommands,
    mutating_steps: steps.filter((item) => item.mutating).map((item) => item.id),
    approval_required: steps.filter((item) => item.requires_approval).map((item) => item.id),
    required_mutating_steps: steps.filter((item) => item.mutating && !item.optional).map((item) => item.id),
    optional_mutating_steps: steps.filter((item) => item.mutating && item.optional).map((item) => item.id),
    optional_steps: steps.filter((item) => item.optional).map((item) => item.id),
    steps,
  };
}

function usage() {
  console.error(`Usage:
  node scripts/embedding-model-release-plan.mjs [--base-url <url>] [--model <id>] [--expected-deploy-fingerprint <value>] [--json]

Prints the ordered embedding-model production release plan. This script is
read-only and does not deploy, migrate, provision, or run live smoke.`);
}

function parseArgs(argv) {
  const args = {
    baseUrl: DEFAULT_BASE_URL,
    model: DEFAULT_MODEL,
    expectedDeployFingerprint: EXPECTED_DEPLOY_FINGERPRINT,
    jsonOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--json') {
      args.jsonOnly = true;
      continue;
    }
    const value = argv[i + 1];
    if (!value) throw new Error(`missing value for ${arg}`);
    i += 1;
    if (arg === '--base-url') args.baseUrl = value;
    else if (arg === '--model') args.model = value;
    else if (arg === '--expected-deploy-fingerprint') args.expectedDeployFingerprint = value;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function printHuman(plan) {
  console.log(`Embedding model release plan for ${plan.embedding_model}`);
  console.log(`base_url=${plan.base_url}`);
  console.log(`expected_deploy_fingerprint=${plan.expected_deploy_fingerprint}\n`);
  if (plan.configured_vectorize_metadata_index_commands.length > 0) {
    console.log('Configured Vectorize metadata-index command candidates:');
    for (const item of plan.configured_vectorize_metadata_index_commands) {
      console.log(`- ${item.binding} ${item.index_name} ${item.property_name}:${item.type}`);
      console.log(`  ${item.command.join(' ')}`);
    }
    console.log('');
  }
  plan.steps.forEach((item, index) => {
    const approval = item.requires_approval ? ' requires-approval' : '';
    const mutating = item.mutating ? ' mutating' : ' read-only';
    const optional = item.optional ? ' optional' : '';
    console.log(`${index + 1}. ${item.id}${mutating}${approval}${optional}`);
    if (item.condition) console.log(`   condition: ${item.condition}`);
    console.log(`   ${item.command}`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const plan = embeddingModelReleasePlan(args);
    if (args.jsonOnly) console.log(JSON.stringify(plan, null, 2));
    else printHuman(plan);
  } catch (error) {
    usage();
    console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
