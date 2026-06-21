#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_INDEX_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../src/index.ts');

export const LEGACY_ROUTE_REQUIREMENTS = Object.freeze([
  { method: 'GET', legacy: '/healthz', target: '/healthz', evidence: "app.get('/healthz'" },
  { method: 'GET', legacy: '/metrics', target: '/metrics', evidence: "app.get('/metrics'" },
  { method: 'GET', legacy: '/readyz', target: '/readyz', evidence: "app.get('/readyz'" },
  { method: 'GET', legacy: '/projects', target: '/v1/kb/projects', evidence: "'/projects'" },
  { method: 'POST', legacy: '/projects', target: '/v1/kb/projects', evidence: "app.post('/v1/kb/projects'" },
  { method: 'GET', legacy: '/projects/:project/status', target: '/v1/kb/projects/:project/status', evidence: "app.get('/v1/kb/projects/:project/status'" },
  { method: 'GET', legacy: '/domains', target: '/v1/kb/domains', evidence: "'/domains'" },
  { method: 'POST', legacy: '/domains', target: '/v1/kb/domains', evidence: "app.post('/v1/kb/domains'" },
  { method: 'GET', legacy: '/schemas', target: '/v1/kb/schemas', evidence: "'/schemas'" },
  { method: 'POST', legacy: '/schemas', target: '/v1/kb/schemas', evidence: "app.post('/v1/kb/schemas'" },
  { method: 'POST', legacy: '/schemas/infer', target: '/v1/kb/schemas/infer', evidence: "app.post('/v1/kb/schemas/infer'" },
  { method: 'POST', legacy: '/schemas/infer/files', target: '/v1/kb/schemas/infer-upload', evidence: "pathname === '/schemas/infer/files'" },
  { method: 'GET', legacy: '/schemas/drafts', target: '/v1/kb/schemas/drafts', evidence: "app.get('/v1/kb/schemas/drafts'" },
  { method: 'GET', legacy: '/schemas/drafts/:draft_id', target: '/v1/kb/schemas/drafts/:draft_id', evidence: "app.get('/v1/kb/schemas/drafts/:draft_id'" },
  { method: 'POST', legacy: '/schemas/drafts/:draft_id/apply', target: '/v1/kb/schemas/drafts/:draft_id/apply', evidence: "app.post('/v1/kb/schemas/drafts/:draft_id/apply'" },
  { method: 'POST', legacy: '/schemas/drafts/:draft_id/discard', target: '/v1/kb/schemas/drafts/:draft_id/discard', evidence: "app.post('/v1/kb/schemas/drafts/:draft_id/discard'" },
  { method: 'GET', legacy: '/schemas/:domain/active', target: '/v1/kb/schemas/:domain/active', evidence: "app.get('/v1/kb/schemas/:domain/active'" },
  { method: 'POST', legacy: '/schemas/:domain/reprocess', target: '/v1/kb/schemas/:domain/reprocess', evidence: "app.post('/v1/kb/schemas/:domain/reprocess'" },
  { method: 'GET', legacy: '/files', target: '/v1/kb/files', evidence: "'/files'" },
  { method: 'POST', legacy: '/files', target: '/v1/kb/files', evidence: "app.post('/v1/kb/files'" },
  { method: 'GET', legacy: '/files/:file_id', target: '/v1/kb/files/:file_id', evidence: "app.get('/v1/kb/files/:file_id'" },
  { method: 'POST', legacy: '/files/:file_id/reprocess', target: '/v1/kb/files/:file_id/reprocess', evidence: "app.post('/v1/kb/files/:file_id/reprocess'" },
  { method: 'DELETE', legacy: '/files/:file_id', target: '/v1/kb/files/:file_id', evidence: "app.delete('/v1/kb/files/:file_id'" },
  { method: 'POST', legacy: '/ingest/run', target: '/v1/kb/ingest/run', evidence: "app.post('/v1/kb/ingest/run'" },
  { method: 'GET', legacy: '/ingest/jobs', target: '/v1/kb/jobs', evidence: "pathname === '/ingest/jobs'" },
  { method: 'GET', legacy: '/ingest/jobs/:job_id', target: '/v1/kb/ingest/jobs/:job_id', evidence: "pathname.startsWith('/ingest/jobs/')" },
  { method: 'POST', legacy: '/ingest/record', target: '/v1/kb/ingest/record', evidence: "app.post('/v1/kb/ingest/record'" },
  { method: 'POST', legacy: '/ingest/text', target: '/v1/kb/ingest/text', evidence: "app.post('/v1/kb/ingest/text'" },
  { method: 'GET', legacy: '/sources', target: '/v1/kb/sources', evidence: "'/sources'" },
  { method: 'POST', legacy: '/sources/import', target: '/v1/kb/sources/import', evidence: "app.post('/v1/kb/sources/import'" },
  { method: 'GET', legacy: '/entities', target: '/v1/kb/entities', evidence: "'/entities'" },
  { method: 'GET', legacy: '/entities/:entity_id', target: '/v1/kb/entities/:entity_id', evidence: "app.get('/v1/kb/entities/:entity_id'" },
  { method: 'GET', legacy: '/entities/:entity_id/lineage', target: '/v1/kb/entities/:entity_id/lineage', evidence: "app.get('/v1/kb/entities/:entity_id/lineage'" },
  { method: 'GET', legacy: '/entities/:entity_id/relationships', target: '/v1/kb/entities/:entity_id/relationships', evidence: "app.get('/v1/kb/entities/:entity_id/relationships'" },
  { method: 'POST', legacy: '/search', target: '/v1/kb/search', evidence: "pathname === '/search'" },
  { method: 'POST', legacy: '/agent/search', target: '/v1/kb/search', evidence: "pathname === '/agent/search'" },
  { method: 'POST', legacy: '/search/eval', target: '/v1/kb/evals/search', evidence: "pathname === '/search/eval'" },
  { method: 'POST', legacy: '/query', target: '/v1/kb/query', evidence: "pathname === '/query'" },
  { method: 'POST', legacy: '/query/stream', target: '/v1/kb/query/stream', evidence: "pathname === '/query/stream'" },
  { method: 'GET', legacy: '/query/traces', target: '/v1/kb/query/traces', evidence: "pathname === '/query/traces'" },
  { method: 'GET', legacy: '/query/trace/:trace_id', target: '/v1/kb/query/trace/:trace_id', evidence: "pathname.startsWith('/query/trace/')" },
]);

function targetEvidence(target) {
  const exact = target.replace(/:project/g, ':project')
    .replace(/:file_id/g, ':file_id')
    .replace(/:draft_id/g, ':draft_id')
    .replace(/:domain/g, ':domain')
    .replace(/:entity_id/g, ':entity_id')
    .replace(/:job_id/g, ':job_id')
    .replace(/:trace_id/g, ':id');
  return exact;
}

export async function legacyRouteParityReport(options = {}) {
  const indexPath = options.indexPath ?? DEFAULT_INDEX_PATH;
  const source = typeof options.sourceText === 'string' ? options.sourceText : await readFile(indexPath, 'utf8');
  const missing = [];
  for (const requirement of LEGACY_ROUTE_REQUIREMENTS) {
    const hasMapping = source.includes(requirement.evidence)
      || source.includes(requirement.legacy)
      || source.includes(requirement.target);
    const hasTarget = source.includes(targetEvidence(requirement.target));
    if (!hasMapping || !hasTarget) {
      missing.push({
        ...requirement,
        has_mapping: hasMapping,
        has_target: hasTarget,
      });
    }
  }
  const aliasMiddleware = source.indexOf("app.all('*'");
  const v1Auth = source.indexOf("app.use('/v1/*'");
  const hasAliasForwarder = source.includes('legacyRouteTarget') && source.includes('forwardLegacyRoute');
  const middlewareOk = hasAliasForwarder && aliasMiddleware >= 0 && v1Auth >= 0 && aliasMiddleware < v1Auth;
  if (!middlewareOk) {
    missing.push({
      method: '*',
      legacy: '*',
      target: '/v1/kb/*',
      evidence: 'legacy alias middleware before /v1 auth middleware',
      has_mapping: hasAliasForwarder,
      has_target: false,
    });
  }

  return {
    ok: missing.length === 0,
    total: LEGACY_ROUTE_REQUIREMENTS.length,
    missing_count: missing.length,
    missing,
    index_path: indexPath,
  };
}

function usage() {
  console.error(`Usage:
  node scripts/audit-legacy-route-parity.mjs [--json] [--require-complete]

Options:
  --json              Print machine-readable JSON.
  --require-complete  Exit non-zero if any retired FastAPI route lacks Worker parity.`);
}

function parseArgs(argv) {
  const args = { jsonOnly: false, requireComplete: false };
  for (const arg of argv) {
    if (arg === '--') continue;
    if (arg === '--json') args.jsonOnly = true;
    else if (arg === '--require-complete') args.requireComplete = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function printHuman(report) {
  if (report.ok) {
    console.log(`READY legacy route parity: ${report.total}/${report.total} covered`);
    return;
  }
  console.log(`NOT READY legacy route parity: missing=${report.missing_count}/${report.total}`);
  for (const item of report.missing) {
    console.log(`  ${item.method} ${item.legacy} -> ${item.target}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = await legacyRouteParityReport();
    if (args.jsonOnly) console.log(JSON.stringify(report, null, 2));
    else printHuman(report);
    if (args.requireComplete && !report.ok) process.exitCode = 1;
  } catch (error) {
    usage();
    console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
