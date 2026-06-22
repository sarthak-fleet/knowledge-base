#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const FLEET_ROOT = resolve(REPO_ROOT, '..');
const EXCLUDED_FLEET_DIRS = new Set([
  '.git',
  'knowledgebase',
  'rag-service',
  'local-ai',
  'node_modules',
  'port-whisperer',
]);
const SKIP_DIRS = new Set(['.git', '.next', '.symphony', 'build', 'coverage', 'dist', 'node_modules', 'vendor']);
const SCAN_EXTENSIONS = new Set(['.cjs', '.js', '.json', '.jsonc', '.mjs', '.toml', '.ts', '.tsx', '.yaml', '.yml']);
const ACTIVE_REFERENCE_PATTERNS = [
  /(?:["']?service["']?)\s*[:=]\s*["']rag-service["']/i,
  /\bservice\s*:\s*rag-service\b/i,
  /https?:\/\/rag-service[.\w-]*/i,
  /\bRAG_(?:BASE|SERVICE)(?:_URL|_ORIGIN|_SERVICE)?\b[^\n]*rag-service/i,
  /@fleet\/rag-service/i,
];
const SIBLING_RETIREMENT_SURFACES = [
  'package.json',
  'pnpm-lock.yaml',
  'wrangler.jsonc',
  'wrangler.bench.jsonc',
  'worker-configuration.d.ts',
  'tsconfig.json',
  'vitest.config.ts',
  'src',
  'scripts',
  'migrations',
  'tests',
  'fixtures',
];

function usage() {
  console.error(`Usage:
  node scripts/audit-sibling-rag-service.mjs [--json] [--require-retired] [--require-no-external-references]

Options:
  --json                            Print JSON only.
  --require-retired                 Exit non-zero while ../rag-service exists or active external references remain.
  --require-no-external-references  Exit non-zero only when fleet repos still actively reference the old service.`);
}

function parseArgs(argv) {
  const out = { jsonOnly: false, requireRetired: false, requireNoExternalReferences: false };
  for (const arg of argv) {
    if (arg === '--') continue;
    if (arg === '--json') out.jsonOnly = true;
    else if (arg === '--require-retired') out.requireRetired = true;
    else if (arg === '--require-no-external-references') out.requireNoExternalReferences = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function extension(path) {
  const index = path.lastIndexOf('.');
  return index >= 0 ? path.slice(index) : '';
}

function walkFiles(root) {
  if (!existsSync(root)) return [];
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    const stat = statSync(current);
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(current.split('/').pop() ?? '')) continue;
      for (const item of readdirSync(current)) stack.push(resolve(current, item));
      continue;
    }
    if (stat.isFile() && SCAN_EXTENSIONS.has(extension(current))) files.push(current);
  }
  return files;
}

function matchingLines(path, root, patterns) {
  const text = readFileSync(path, 'utf8');
  const matches = [];
  text.split(/\r?\n/).forEach((line, index) => {
    for (const pattern of patterns) {
      if (!pattern.test(line)) continue;
      matches.push({
        file: relative(root, path),
        line: index + 1,
        text: line.trim().slice(0, 220),
      });
      break;
    }
  });
  return matches;
}

function deployableSurfaces(siblingPath, fleetRoot) {
  if (!existsSync(siblingPath)) return [];
  return SIBLING_RETIREMENT_SURFACES
    .filter((item) => existsSync(resolve(siblingPath, item)))
    .map((item) => {
      const absolute = resolve(siblingPath, item);
      return `${relative(fleetRoot, absolute)}${statSync(absolute).isDirectory() ? '/' : ''}`;
    });
}

function defaultExternalRepos(fleetRoot, repoRoot = REPO_ROOT) {
  if (!existsSync(fleetRoot)) return [];
  const currentRepo = resolve(repoRoot);
  return readdirSync(fleetRoot)
    .map((name) => resolve(fleetRoot, name))
    .filter((path) => {
      const name = path.split('/').pop() ?? '';
      if (EXCLUDED_FLEET_DIRS.has(name) || name.startsWith('.')) return false;
      if (resolve(path) === currentRepo) return false;
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    });
}

export function auditSiblingRagService(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? REPO_ROOT);
  const fleetRoot = resolve(options.fleetRoot ?? dirname(repoRoot));
  const siblingPath = resolve(options.siblingPath ?? resolve(fleetRoot, 'rag-service'));
  const externalRepos = options.externalRepos ?? defaultExternalRepos(fleetRoot, repoRoot);
  const activeReferences = [];

  for (const externalRepo of externalRepos) {
    const root = resolve(externalRepo);
    if (!existsSync(root)) continue;
    for (const file of walkFiles(root)) {
      activeReferences.push(...matchingLines(file, root, ACTIVE_REFERENCE_PATTERNS).map((match) => ({
        repo: relative(fleetRoot, root),
        ...match,
      })));
    }
  }
  activeReferences.sort((a, b) => (
    a.repo.localeCompare(b.repo)
      || a.file.localeCompare(b.file)
      || a.line - b.line
  ));

  const siblingExists = existsSync(siblingPath);
  const surfaces = deployableSurfaces(siblingPath, fleetRoot);
  const blockers = [];
  if (siblingExists) blockers.push('sibling_directory_exists');
  if (surfaces.length > 0) blockers.push('sibling_deployable_surfaces_exist');
  if (activeReferences.length > 0) blockers.push('active_external_references_exist');

  return {
    ok: blockers.length === 0,
    sibling_path: relative(fleetRoot, siblingPath),
    sibling_exists: siblingExists,
    sibling_deployable_surfaces: surfaces,
    external_repos_scanned: externalRepos.map((repo) => relative(fleetRoot, resolve(repo))).sort(),
    external_references_ok: activeReferences.length === 0,
    active_external_references: activeReferences,
    blockers,
  };
}

export function formatAuditReportForCli(report, args = {}) {
  const retirementOk = report.ok === true;
  const externalReferencesOk = report.external_references_ok === true;
  const externalReferenceBlockers = externalReferencesOk ? [] : ['active_external_references_exist'];

  if (args.requireNoExternalReferences && !args.requireRetired) {
    return {
      gate: 'external_rag_service_references',
      retirement_ok: retirementOk,
      external_reference_gate_ok: externalReferencesOk,
      ...report,
      ok: externalReferencesOk,
      blockers: externalReferenceBlockers,
      retirement_blockers: report.blockers,
    };
  }

  return {
    gate: 'sibling_rag_service_retirement',
    retirement_ok: retirementOk,
    external_reference_gate_ok: externalReferencesOk,
    ...report,
  };
}

function printHuman(report) {
  const isExternalReferenceGate = report.gate === 'external_rag_service_references';
  console.log(`${report.ok ? 'READY' : 'NOT READY'} ${isExternalReferenceGate ? 'external rag-service references' : 'sibling rag-service retirement'}`);
  console.log(`sibling_exists=${report.sibling_exists}`);
  if (report.sibling_deployable_surfaces.length > 0) {
    console.log('\ndeployable sibling surfaces:');
    for (const item of report.sibling_deployable_surfaces) console.log(`  ${item}`);
  }
  if (report.active_external_references.length > 0) {
    console.log('\nactive external references:');
    for (const item of report.active_external_references) console.log(`  ${item.repo}/${item.file}:${item.line} ${item.text}`);
  }
  if (report.blockers.length > 0) console.log(`\nblockers=${report.blockers.join(',')}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = auditSiblingRagService();
    const cliReport = formatAuditReportForCli(report, args);
    if (args.jsonOnly) console.log(JSON.stringify(cliReport, null, 2));
    else printHuman(cliReport);
    if (args.requireRetired && !report.ok) process.exitCode = 1;
    if (args.requireNoExternalReferences && !report.external_references_ok) process.exitCode = 1;
  } catch (error) {
    usage();
    console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
