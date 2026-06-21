#!/usr/bin/env node

import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const RETIRED_PYTHON_RUNTIME_SURFACES = [
  '.dockerignore',
  'docker-compose.yml',
  'docker/Dockerfile',
  'pyproject.toml',
  'scripts/bench.py',
  'scripts/build_eval_set.py',
  'scripts/chain_legal_evals.sh',
  'scripts/e2e_verify.sh',
  'scripts/measure_abcd.sh',
  'scripts/reembed_missing.py',
  'src/kb',
  'streamlit_app',
  'tests',
];
const GENERATED_PYTHON_CACHE_DIRS = new Set(['__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache']);
const GENERATED_PYTHON_CACHE_FILE_SUFFIXES = ['.pyc', '.pyo'];

function retiredSurfaceExists(surfacePath) {
  if (!existsSync(surfacePath)) return false;
  const stat = statSync(surfacePath);
  if (!stat.isDirectory()) return true;
  const stack = [surfacePath];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const entryPath = resolve(current, entry.name);
      if (entry.isDirectory()) {
        if (!GENERATED_PYTHON_CACHE_DIRS.has(entry.name)) stack.push(entryPath);
        continue;
      }
      if (!GENERATED_PYTHON_CACHE_FILE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) return true;
    }
  }
  return false;
}

function usage() {
  console.error(`Usage:
  node scripts/audit-python-runtime-retirement.mjs [--json] [--require-complete]

Options:
  --json              Print machine-readable JSON.
  --require-complete  Exit non-zero while retired Python runtime surfaces exist.`);
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

export function pythonRuntimeRetirementReport({ repoRoot = REPO_ROOT } = {}) {
  const root = resolve(repoRoot);
  const present = RETIRED_PYTHON_RUNTIME_SURFACES
    .map((surface) => resolve(root, surface))
    .filter((surfacePath) => retiredSurfaceExists(surfacePath))
    .map((surfacePath) => relative(root, surfacePath));
  return {
    ok: present.length === 0,
    total: RETIRED_PYTHON_RUNTIME_SURFACES.length,
    present_count: present.length,
    present,
  };
}

function printHuman(report) {
  if (report.ok) {
    console.log(`READY Python runtime retirement: ${report.total}/${report.total} retired surfaces absent`);
    return;
  }
  console.log(`NOT READY Python runtime retirement: present=${report.present_count}/${report.total}`);
  for (const item of report.present) console.log(`  ${item}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = pythonRuntimeRetirementReport();
    if (args.jsonOnly) console.log(JSON.stringify(report, null, 2));
    else printHuman(report);
    if (args.requireComplete && !report.ok) process.exitCode = 1;
  } catch (error) {
    usage();
    console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
