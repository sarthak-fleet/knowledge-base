#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_CONFIG_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../wrangler.jsonc');

export const REQUIRED_METADATA_INDEXES = [
  { property_name: 'tenant', type: 'string' },
  { property_name: 'index_id', type: 'string' },
];

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function runCommand(command) {
  const result = spawnSync(command[0], command.slice(1), {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: typeof result.status === 'number' ? result.status : 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? String(result.error?.message ?? ''),
  };
}

export function configuredVectorizeIndexes(config) {
  const vectorize = Array.isArray(config.vectorize) ? config.vectorize : [];
  return vectorize
    .map((entry) => ({
      binding: typeof entry?.binding === 'string' ? entry.binding : null,
      index_name: typeof entry?.index_name === 'string' ? entry.index_name : null,
    }))
    .filter((entry) => entry.binding && entry.index_name);
}

function firstArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.result)) return payload.result;
  if (Array.isArray(payload?.metadataIndexes)) return payload.metadataIndexes;
  if (Array.isArray(payload?.metadata_indexes)) return payload.metadata_indexes;
  if (Array.isArray(payload?.indexes)) return payload.indexes;
  if (Array.isArray(payload?.result?.metadataIndexes)) return payload.result.metadataIndexes;
  if (Array.isArray(payload?.result?.metadata_indexes)) return payload.result.metadata_indexes;
  if (Array.isArray(payload?.result?.indexes)) return payload.result.indexes;
  return [];
}

function normalizeMetadataIndex(entry) {
  const propertyName = entry?.propertyName ?? entry?.property_name ?? entry?.name ?? null;
  const type = entry?.type ?? entry?.indexType ?? entry?.index_type ?? null;
  return {
    property_name: typeof propertyName === 'string' ? propertyName : null,
    type: typeof type === 'string' ? type.toLowerCase() : null,
  };
}

export function parseMetadataIndexes(stdout) {
  const payload = JSON.parse(stdout || 'null');
  return firstArray(payload)
    .map(normalizeMetadataIndex)
    .filter((entry) => entry.property_name);
}

function missingRequiredMetadataIndexes(metadataIndexes) {
  return REQUIRED_METADATA_INDEXES.filter((required) => !metadataIndexes.some((entry) => (
    entry.property_name === required.property_name && entry.type === required.type
  )));
}

function commandForIndex(indexName) {
  return ['pnpm', 'exec', 'wrangler', 'vectorize', 'list-metadata-index', indexName, '--json'];
}

export function createMetadataCommand(indexName, metadataIndex) {
  return [
    'pnpm',
    'exec',
    'wrangler',
    'vectorize',
    'create-metadata-index',
    indexName,
    '--propertyName',
    metadataIndex.property_name,
    '--type',
    metadataIndex.type,
  ];
}

export function configuredVectorizeMetadataProvisioningCommands({
  configPath = DEFAULT_CONFIG_PATH,
} = {}) {
  const config = readJson(configPath);
  return configuredVectorizeIndexes(config).flatMap((entry) => REQUIRED_METADATA_INDEXES.map((metadataIndex) => ({
    binding: entry.binding,
    index_name: entry.index_name,
    property_name: metadataIndex.property_name,
    type: metadataIndex.type,
    command: createMetadataCommand(entry.index_name, metadataIndex),
  })));
}

export function auditVectorizeMetadataIndexes({
  configPath = DEFAULT_CONFIG_PATH,
  runner = runCommand,
} = {}) {
  const config = readJson(configPath);
  const indexes = configuredVectorizeIndexes(config).map((entry) => {
    const command = commandForIndex(entry.index_name);
    const result = runner(command);
    if (result.status !== 0) {
      return {
        ...entry,
        ok: false,
        command,
        metadata_indexes: [],
        missing_metadata_indexes: REQUIRED_METADATA_INDEXES,
        remediation_commands: REQUIRED_METADATA_INDEXES.map((metadataIndex) => createMetadataCommand(entry.index_name, metadataIndex)),
        error: (result.stderr || result.stdout || `wrangler exited ${result.status}`).trim(),
      };
    }

    try {
      const metadataIndexes = parseMetadataIndexes(result.stdout);
      const missing = missingRequiredMetadataIndexes(metadataIndexes);
      return {
        ...entry,
        ok: missing.length === 0,
        command,
        metadata_indexes: metadataIndexes,
        missing_metadata_indexes: missing,
        remediation_commands: missing.map((metadataIndex) => createMetadataCommand(entry.index_name, metadataIndex)),
      };
    } catch (error) {
      return {
        ...entry,
        ok: false,
        command,
        metadata_indexes: [],
        missing_metadata_indexes: REQUIRED_METADATA_INDEXES,
        remediation_commands: REQUIRED_METADATA_INDEXES.map((metadataIndex) => createMetadataCommand(entry.index_name, metadataIndex)),
        error: `failed to parse wrangler JSON: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });
  const blockers = indexes
    .filter((entry) => !entry.ok)
    .map((entry) => ({
      binding: entry.binding,
      index_name: entry.index_name,
      missing_metadata_indexes: entry.missing_metadata_indexes,
      remediation_commands: entry.remediation_commands,
      error: entry.error ?? null,
    }));

  return {
    ok: blockers.length === 0,
    config_path: configPath,
    required_metadata_indexes: REQUIRED_METADATA_INDEXES,
    indexes,
    blockers,
  };
}

function usage() {
  console.error(`Usage:
  node scripts/audit-vectorize-metadata-indexes.mjs [--config wrangler.jsonc] [--json] [--require-complete]

Read-only audit for configured Cloudflare Vectorize indexes. It calls
wrangler vectorize list-metadata-index <index> --json for each configured
wrangler.jsonc Vectorize binding and verifies the tenant/index_id string
metadata indexes required by server-enforced RAG filters.`);
}

function parseArgs(argv) {
  const args = { configPath: DEFAULT_CONFIG_PATH, jsonOnly: false, requireComplete: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--json') {
      args.jsonOnly = true;
      continue;
    }
    if (arg === '--require-complete') {
      args.requireComplete = true;
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
  for (const index of report.indexes) {
    console.log(`${index.ok ? 'OK' : 'FAIL'} ${index.binding} ${index.index_name}`);
    for (const missing of index.missing_metadata_indexes) {
      console.log(`  missing ${missing.property_name}:${missing.type}`);
    }
    for (const command of index.remediation_commands) {
      console.log(`  provision ${command.join(' ')}`);
    }
    if (index.error) console.log(`  ${index.error}`);
  }
  console.log(`\n${report.ok ? 'PASS' : 'FAIL'} vectorize-metadata-indexes blockers=${report.blockers.length}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = auditVectorizeMetadataIndexes({ configPath: args.configPath });
    if (args.jsonOnly) console.log(JSON.stringify(report, null, 2));
    else printHuman(report);
    if (args.requireComplete && !report.ok) process.exitCode = 1;
  } catch (error) {
    usage();
    console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
