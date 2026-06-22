#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED_MODELS } from './audit-free-ai-embedding-contract.mjs';

const DEFAULT_CONFIG_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../wrangler.jsonc');

function trailingDimension(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/(?:^|[-_])(\d{2,5})$/);
  if (!match) return null;
  const dimension = Number(match[1]);
  return Number.isInteger(dimension) && dimension > 0 ? dimension : null;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function uniqueNumbers(values) {
  return [...new Set(values)].sort((a, b) => a - b);
}

function bindingForDimension(dimensions) {
  return dimensions === 1536 ? 'VECTORIZE' : `VECTORIZE_${dimensions}`;
}

function indexNameForDimension(dimensions) {
  if (dimensions === 1536) return 'rag-gemini-1536';
  return `rag-embedding-${dimensions}`;
}

function provisioningPlanForDimensions(dimensions) {
  return dimensions.map((dimension) => {
    const binding = bindingForDimension(dimension);
    const indexName = indexNameForDimension(dimension);
    const metadataCommands = ['tenant', 'index_id'].map((propertyName) => [
      'pnpm',
      'exec',
      'wrangler',
      'vectorize',
      'create-metadata-index',
      indexName,
      '--propertyName',
      propertyName,
      '--type',
      'string',
    ]);
    return {
      dimensions: dimension,
      binding,
      index_name: indexName,
      command: [
        'pnpm',
        'exec',
        'wrangler',
        'vectorize',
        'create',
        indexName,
        '--dimensions',
        String(dimension),
        '--metric',
        'cosine',
        '--binding',
        binding,
        '--update-config',
      ],
      metadata_commands: metadataCommands,
      wrangler_config_entry: {
        binding,
        index_name: indexName,
      },
    };
  });
}

export function auditVectorizeEmbeddingBindings({ configPath = DEFAULT_CONFIG_PATH, requireAll = false } = {}) {
  const config = readJson(configPath);
  const vectorize = Array.isArray(config.vectorize) ? config.vectorize : [];
  const configuredBindings = vectorize.map((entry) => ({
    binding: typeof entry?.binding === 'string' ? entry.binding : null,
    index_name: typeof entry?.index_name === 'string' ? entry.index_name : null,
    dimensions: trailingDimension(entry?.index_name),
  }));
  const configuredDimensions = uniqueNumbers(configuredBindings
    .map((entry) => entry.dimensions)
    .filter((value) => typeof value === 'number'));
  const missingDimensions = uniqueNumbers(REQUIRED_MODELS
    .map((model) => model.dimensions)
    .filter((dimensions) => !configuredDimensions.includes(dimensions)));
  const models = REQUIRED_MODELS.map((model) => {
    const binding = configuredBindings.find((entry) => entry.dimensions === model.dimensions);
    return {
      id: model.id,
      provider: model.provider,
      dimensions: model.dimensions,
      selectable: Boolean(binding),
      vectorize_binding: binding?.binding ?? null,
      vectorize_index: binding?.index_name ?? null,
      blocker: binding ? null : `no Vectorize binding configured for ${model.dimensions} dimensions`,
    };
  });
  const unparseableBindings = configuredBindings.filter((entry) => entry.binding && entry.dimensions === null);
  const blockers = [
    ...(requireAll ? models.filter((model) => !model.selectable) : []),
    ...unparseableBindings.map((entry) => ({
      binding: entry.binding,
      index_name: entry.index_name,
      blocker: 'Vectorize index name does not expose a trailing dimension',
    })),
  ];

  return {
    ok: blockers.length === 0,
    config_path: configPath,
    require_all: requireAll,
    configured_dimensions: configuredDimensions,
    missing_dimensions: missingDimensions,
    configured_bindings: configuredBindings,
    models,
    selectable_models: models.filter((model) => model.selectable).map((model) => model.id),
    blocked_models: models.filter((model) => !model.selectable).map((model) => model.id),
    provisioning_plan: provisioningPlanForDimensions(missingDimensions),
    blockers,
  };
}

function usage() {
  console.error(`Usage:
  node scripts/audit-vectorize-embedding-bindings.mjs [--config wrangler.jsonc] [--json] [--require-all]

Reports which required free-ai embedding models are selectable with the currently
configured Cloudflare Vectorize bindings. The report includes non-mutating
Wrangler commands for missing dimensions; run them only after explicit production
provisioning approval. Use --require-all only after every required embedding
dimension has a provisioned Vectorize index and binding.`);
}

function parseArgs(argv) {
  const args = { configPath: DEFAULT_CONFIG_PATH, jsonOnly: false, requireAll: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--json') {
      args.jsonOnly = true;
      continue;
    }
    if (arg === '--require-all') {
      args.requireAll = true;
      continue;
    }
    if (arg === '--config') {
      const value = argv[i + 1];
      if (!value) throw new Error('missing value for --config');
      args.configPath = resolve(process.cwd(), value);
      i += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function printHuman(report) {
  for (const model of report.models) {
    const status = model.selectable ? 'SELECTABLE' : 'BLOCKED';
    console.log(`${status} ${model.id} ${model.dimensions}d${model.vectorize_binding ? ` via ${model.vectorize_binding}` : ''}`);
    if (model.blocker) console.log(`  ${model.blocker}`);
  }
  if (report.missing_dimensions.length > 0) {
    console.log(`\nmissing_dimensions=${report.missing_dimensions.join(',')}`);
    for (const item of report.provisioning_plan) {
      console.log(`provision ${item.dimensions}d: ${item.command.join(' ')}`);
      for (const command of item.metadata_commands) {
        console.log(`metadata ${item.dimensions}d: ${command.join(' ')}`);
      }
    }
  }
  console.log(`\n${report.ok ? 'PASS' : 'FAIL'} vectorize-embedding-bindings blockers=${report.blockers.length}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = auditVectorizeEmbeddingBindings({ configPath: args.configPath, requireAll: args.requireAll });
    if (args.jsonOnly) console.log(JSON.stringify(report, null, 2));
    else printHuman(report);
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    usage();
    console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
