#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { legacyRouteParityReport } from './audit-legacy-route-parity.mjs';
import { pythonRuntimeRetirementReport } from './audit-python-runtime-retirement.mjs';

const DEFAULT_CONFIG_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../wrangler.jsonc');

function check(name, severity, message, detail = '') {
  return { name, severity, message, detail };
}

function hasBinding(entries, binding) {
  return Array.isArray(entries) && entries.some((entry) => entry?.binding === binding);
}

function hasQueueProducer(queues, binding) {
  return Array.isArray(queues?.producers) && queues.producers.some((entry) => entry?.binding === binding);
}

export async function runWorkerPreflight({ configPath = DEFAULT_CONFIG_PATH } = {}) {
  const checks = [];
  let config = {};

  try {
    config = JSON.parse(await readFile(configPath, 'utf8'));
    checks.push(check('worker_config', 'ok', 'Cloudflare Worker config exists', configPath));
  } catch (error) {
    checks.push(check(
      'worker_config',
      'error',
      'Cloudflare Worker config is missing or invalid JSON',
      String(error instanceof Error ? error.message : error),
    ));
  }

  checks.push(check(
    'ai_binding',
    config?.ai?.binding === 'AI' ? 'ok' : 'error',
    config?.ai?.binding === 'AI' ? 'Workers AI binding is configured' : 'Cloudflare Worker is missing the AI binding',
    'Expected ai binding AI in wrangler.jsonc.',
  ));
  checks.push(check(
    'vector_store',
    hasBinding(config?.vectorize, 'VECTORIZE') ? 'ok' : 'error',
    hasBinding(config?.vectorize, 'VECTORIZE')
      ? 'retrieval is bound to Cloudflare Vectorize plus D1 lexical scoring'
      : 'Cloudflare Worker is missing the VECTORIZE binding',
    'Expected vectorize binding VECTORIZE in wrangler.jsonc.',
  ));
  checks.push(check(
    'vector_store_small',
    hasBinding(config?.vectorize, 'VECTORIZE_SMALL') ? 'ok' : 'warn',
    hasBinding(config?.vectorize, 'VECTORIZE_SMALL')
      ? 'small embedding Vectorize binding is configured'
      : 'Cloudflare Worker is missing the optional VECTORIZE_SMALL binding',
  ));
  checks.push(check(
    'relational_store',
    hasBinding(config?.d1_databases, 'DB') ? 'ok' : 'error',
    hasBinding(config?.d1_databases, 'DB')
      ? 'product metadata and query traces are bound to Cloudflare D1'
      : 'Cloudflare Worker is missing the DB D1 binding',
    'Expected d1_databases binding DB in wrangler.jsonc.',
  ));
  checks.push(check(
    'object_store',
    hasBinding(config?.r2_buckets, 'RAW_DOCS') ? 'ok' : 'error',
    hasBinding(config?.r2_buckets, 'RAW_DOCS')
      ? 'raw files and parse artifacts are bound to Cloudflare R2'
      : 'Cloudflare Worker is missing the RAW_DOCS R2 binding',
    'Expected r2_buckets binding RAW_DOCS in wrangler.jsonc.',
  ));
  checks.push(check(
    'ingest_queue',
    hasQueueProducer(config?.queues, 'INGEST_QUEUE') ? 'ok' : 'warn',
    hasQueueProducer(config?.queues, 'INGEST_QUEUE')
      ? 'Cloudflare Queue binding is configured for async ingestion'
      : 'Cloudflare Queue binding is missing; ingestion can only run inline/fallback paths',
  ));
  checks.push(check(
    'ingest_workflow',
    hasBinding(config?.workflows, 'KB_INGEST_WORKFLOW') ? 'ok' : 'warn',
    hasBinding(config?.workflows, 'KB_INGEST_WORKFLOW')
      ? 'Cloudflare Workflow binding is configured for durable ingest orchestration'
      : 'Cloudflare Workflow binding is missing; queue dispatch will not be workflow-orchestrated',
  ));
  checks.push(check(
    'analytics',
    hasBinding(config?.analytics_engine_datasets, 'RAG_ANALYTICS') ? 'ok' : 'warn',
    hasBinding(config?.analytics_engine_datasets, 'RAG_ANALYTICS')
      ? 'Analytics Engine binding is configured for RAG events'
      : 'Analytics Engine binding is missing; runtime still works but observability is reduced',
  ));

  const routeParity = await legacyRouteParityReport();
  checks.push(check(
    'legacy_route_parity',
    routeParity.ok ? 'ok' : 'error',
    routeParity.ok
      ? `retired FastAPI route aliases are covered (${routeParity.total}/${routeParity.total})`
      : `${routeParity.missing_count} retired FastAPI route aliases are missing Worker parity`,
    routeParity.ok ? '' : JSON.stringify(routeParity.missing),
  ));

  const pythonRuntime = pythonRuntimeRetirementReport();
  checks.push(check(
    'python_runtime_retirement',
    pythonRuntime.ok ? 'ok' : 'error',
    pythonRuntime.ok
      ? `retired Python runtime surfaces are absent (${pythonRuntime.total}/${pythonRuntime.total})`
      : `${pythonRuntime.present_count} retired Python runtime surfaces still exist`,
    pythonRuntime.ok ? '' : JSON.stringify(pythonRuntime.present),
  ));

  const errors = checks.filter((item) => item.severity === 'error').length;
  const warnings = checks.filter((item) => item.severity === 'warn').length;
  return {
    ok: errors === 0,
    errors,
    warnings,
    config_path: configPath,
    checks,
  };
}

function usage() {
  console.error(`Usage:
  node scripts/preflight.mjs [--config wrangler.jsonc] [--json] [--require-clean]

Options:
  --config <path>     Wrangler JSON/JSONC config path. Defaults to ./wrangler.jsonc.
  --json              Print machine-readable JSON.
  --require-clean     Exit non-zero on warnings as well as errors.`);
}

function parseArgs(argv) {
  const args = { configPath: DEFAULT_CONFIG_PATH, jsonOnly: false, requireClean: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--json') {
      args.jsonOnly = true;
      continue;
    }
    if (arg === '--require-clean') {
      args.requireClean = true;
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

function printHuman(result) {
  for (const item of result.checks) {
    const status = item.severity.toUpperCase();
    console.log(`${status} ${item.name}: ${item.message}`);
    if (item.detail) console.log(`  ${item.detail}`);
  }
  console.log(`\n${result.ok ? 'PASS' : 'FAIL'} errors=${result.errors} warnings=${result.warnings}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await runWorkerPreflight({ configPath: args.configPath });
    if (args.jsonOnly) console.log(JSON.stringify(result, null, 2));
    else printHuman(result);
    if (!result.ok || (args.requireClean && result.warnings > 0)) process.exitCode = 1;
  } catch (error) {
    usage();
    console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
