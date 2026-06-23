#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function usage() {
  console.error(`Usage:
  node scripts/audit-client-contract.mjs [--json] [--require-complete]`);
}

export async function auditClientContract({ root = ROOT } = {}) {
  const path = resolve(root, 'src/client.ts');
  const checks = [];
  let source = '';
  try {
    source = await readFile(path, 'utf8');
    checks.push({ name: 'client_source_exists', ok: true, file: 'src/client.ts' });
  } catch (error) {
    checks.push({ name: 'client_source_exists', ok: false, file: 'src/client.ts', error: error instanceof Error ? error.message : String(error) });
  }
  const required = [
    ['KnowledgebaseClient', /export\s+class\s+KnowledgebaseClient\b/],
    ['KnowledgebaseClientOptions', /export\s+interface\s+KnowledgebaseClientOptions\b/],
    ['ingestText', /\bingestText\s*\(/],
    ['search', /\bsearch\s*\(/],
    ['query', /\bquery\s*\(/],
    ['service_key_auth', /Authorization:\s*`Bearer\s+\$\{this\.serviceKey\}`/],
    ['custom_input_route', /\/v1\/kb\/ingest\/text/],
    ['query_route', /\/v1\/kb\/query/],
  ];
  for (const [name, pattern] of required) {
    checks.push({ name, ok: pattern.test(source), file: 'src/client.ts' });
  }
  const blockers = checks.filter((check) => !check.ok).map((check) => check.name);
  return {
    ok: blockers.length === 0,
    checks,
    blockers,
  };
}

function parseArgs(argv) {
  const out = { jsonOnly: false, requireComplete: false };
  for (const arg of argv) {
    if (arg === '--') continue;
    if (arg === '--json') out.jsonOnly = true;
    else if (arg === '--require-complete') out.requireComplete = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function printHuman(report) {
  console.log(`${report.ok ? 'READY' : 'NOT READY'} typed client contract`);
  for (const check of report.checks) {
    console.log(`  ${check.ok ? 'PASS' : 'FAIL'} ${check.name}`);
  }
  if (report.blockers.length > 0) console.log(`blockers=${report.blockers.join(',')}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = await auditClientContract();
    if (args.jsonOnly) console.log(JSON.stringify(report, null, 2));
    else printHuman(report);
    if (args.requireComplete && !report.ok) process.exitCode = 1;
  } catch (error) {
    usage();
    console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
