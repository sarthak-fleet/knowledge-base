#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const FLEET_ROOT = resolve(REPO_ROOT, '..');

function usage() {
  console.error(`Usage:
  node scripts/audit-consumer-rag-integrations.mjs [--json] [--require-complete]

Checks fleet consumers that should use knowledgebase as the only RAG service:
  - linkchat has RAG_SERVICE bound to knowledgebase and no legacy SaasMaker RAG helper
  - starboard has RAG_SERVICE bound to knowledgebase and STARBOARD_RAG_INDEX_ID configured
  - both consumers route RAG calls through their knowledgebase client modules`);
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

function stripJsonComments(input) {
  return input
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function readText(path) {
  return readFileSync(path, 'utf8');
}

function readJsonc(path) {
  return JSON.parse(stripJsonComments(readText(path)));
}

function readPackageJson(repo) {
  const path = resolve(repo, 'package.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readText(path));
}

function pass(name, detail = '') {
  return { name, ok: true, detail };
}

function fail(name, detail = '') {
  return { name, ok: false, detail };
}

function serviceBinding(config, binding) {
  return Array.isArray(config?.services)
    ? config.services.find((entry) => entry?.binding === binding) ?? null
    : null;
}

function containsAll(text, patterns) {
  return patterns.every((pattern) => pattern.test(text));
}

function knowledgebaseFallbackUrlOk(text) {
  return text.includes('https://knowledgebase.sarthakagrawal927.workers.dev')
    && !/https:\/\/[^"'\s]*rag-service[^"'\s]*/i.test(text);
}

function resolveFirstExistingRepo(fleetRoot, names) {
  for (const name of names) {
    const repo = resolve(fleetRoot, name);
    if (existsSync(repo)) return { name, repo };
  }
  return { name: names[0], repo: resolve(fleetRoot, names[0]) };
}

function deployCfScriptCheck(repo, consumerName) {
  const pkg = readPackageJson(repo);
  const script = typeof pkg?.scripts?.['deploy:cf'] === 'string'
    ? pkg.scripts['deploy:cf'].trim()
    : '';
  if (!script) return fail('deploy_cf_script', `${consumerName} package.json is missing scripts.deploy:cf`);
  if (!/\b(opennextjs-cloudflare|wrangler)\b/.test(script)) {
    return fail('deploy_cf_script', `deploy:cf must use Cloudflare deploy tooling, got ${script}`);
  }
  const hasCfBuild = typeof pkg?.scripts?.['cf:build'] === 'string';
  const hasBuildCf = typeof pkg?.scripts?.['build:cf'] === 'string';
  const runsCfBuild = /\bpnpm\s+(run\s+)?cf:build\b/.test(script);
  const runsBuildCf = /\bpnpm\s+(run\s+)?build:cf\b/.test(script);
  if ((hasCfBuild || hasBuildCf) && !runsCfBuild && !runsBuildCf) {
    const expected = [
      hasCfBuild ? 'cf:build' : null,
      hasBuildCf ? 'build:cf' : null,
    ].filter(Boolean).join(' or ');
    return fail('deploy_cf_script', `deploy:cf must run ${expected} before deploy, got ${script}`);
  }
  return pass('deploy_cf_script', `deploy:cf = ${script}`);
}

function auditLinkchat(fleetRoot) {
  const resolved = resolveFirstExistingRepo(fleetRoot, ['linkchat', 'karte']);
  const repo = resolved.repo;
  const checks = [];
  if (!existsSync(repo)) {
    return {
      repo: 'linkchat',
      ok: false,
      checks: [fail('repo_exists', 'linkchat/karte repo is missing')],
    };
  }
  checks.push(pass('repo_exists', `using ${relative(fleetRoot, repo)}`));
  checks.push(deployCfScriptCheck(repo, 'linkchat/karte'));

  const wranglerPath = resolve(repo, 'wrangler.jsonc');
  if (!existsSync(wranglerPath)) {
    checks.push(fail('wrangler_config', 'wrangler.jsonc is missing'));
  } else {
    const config = readJsonc(wranglerPath);
    const binding = serviceBinding(config, 'RAG_SERVICE');
    checks.push(binding?.service === 'knowledgebase'
      ? pass('rag_service_binding', 'RAG_SERVICE -> knowledgebase')
      : fail('rag_service_binding', `expected RAG_SERVICE -> knowledgebase, got ${JSON.stringify(binding)}`));
  }

  const clientPath = resolve(repo, 'src/lib/knowledgebase.ts');
  if (!existsSync(clientPath)) {
    checks.push(fail('rag_client', 'src/lib/knowledgebase.ts is missing'));
  } else {
    const client = readText(clientPath);
    checks.push(containsAll(client, [/getCloudflareContext/, /RAG_SERVICE_KEY/, /RAG_SERVICE/, /knowledgebase/])
      ? pass('rag_client', 'knowledgebase client reads Cloudflare binding/key')
      : fail('rag_client', 'knowledgebase.ts is missing Cloudflare binding/key or knowledgebase references'));
    checks.push(containsAll(client, [
      /createIndex/,
      /ingestDocument/,
      /deleteDocument/,
      /search/,
      /\/v1\/indexes/,
      /\/v1\/indexes\/\$\{indexId\}\/ingest/,
      /\/v1\/documents\/\$\{docId\}/,
      /\/v1\/indexes\/\$\{indexId\}\/query/,
    ])
      ? pass('rag_client_crud_contract', 'knowledgebase client supports profile-memory create/ingest/delete/search')
      : fail('rag_client_crud_contract', 'knowledgebase.ts must expose the full profile-memory RAG CRUD/search contract'));
    checks.push(containsAll(client, [
      /documents:\s*\[\s*\{\s*content,\s*metadata\s*\}\s*\]/,
      /body:\s*JSON\.stringify\(\s*\{\s*query,\s*top_k:\s*topK\s*\}\s*\)/,
    ])
      ? pass('rag_client_payload_contract', 'knowledgebase client sends document content/metadata and query/top_k payloads')
      : fail('rag_client_payload_contract', 'knowledgebase.ts must send knowledgebase document content/metadata and query/top_k payloads'));
    checks.push(knowledgebaseFallbackUrlOk(client)
      ? pass('rag_service_url_fallback', 'public fallback URL points at knowledgebase')
      : fail('rag_service_url_fallback', 'public fallback URL must point at knowledgebase, not the retired rag-service'));
    checks.push(/SAASMAKER_API_URL|SAASMAKER_ADMIN_KEY/.test(client)
      ? fail('no_legacy_saas_maker_client_refs', 'knowledgebase.ts still references legacy SaasMaker RAG env')
      : pass('no_legacy_saas_maker_client_refs'));
  }

  const legacyHelper = resolve(repo, 'src/lib/saasmaker.ts');
  checks.push(existsSync(legacyHelper)
    ? fail('legacy_saas_maker_helper_removed', 'src/lib/saasmaker.ts still exists')
    : pass('legacy_saas_maker_helper_removed'));
  const legacyRagClient = resolve(repo, 'src/lib/rag-service.ts');
  checks.push(existsSync(legacyRagClient)
    ? fail('legacy_rag_service_client_removed', 'src/lib/rag-service.ts still exists; use src/lib/knowledgebase.ts')
    : pass('legacy_rag_service_client_removed'));

  const routePaths = [
    'src/app/api/settings/ai-key/route.ts',
    'src/app/api/pages/[pageId]/info/route.ts',
    'src/app/api/pages/[pageId]/info/[blockId]/route.ts',
    'src/app/api/chat/[slug]/route.ts',
  ];
  for (const route of routePaths) {
    const absolute = resolve(repo, route);
    if (!existsSync(absolute)) {
      checks.push(fail(`route_${route}`, `${route} is missing`));
      continue;
    }
    const source = readText(absolute);
    checks.push(source.includes('@/lib/knowledgebase') && !/@\/lib\/saasmaker|SAASMAKER_API_URL|SAASMAKER_ADMIN_KEY/.test(source)
      ? pass(`route_${route}`, 'uses knowledgebase RAG client')
      : fail(`route_${route}`, 'route does not use knowledgebase RAG client cleanly'));
  }

  return { repo: 'linkchat', ok: checks.every((check) => check.ok), checks };
}

function auditStarboard(fleetRoot) {
  const repo = resolve(fleetRoot, 'starboard');
  const checks = [];
  if (!existsSync(repo)) {
    return {
      repo: 'starboard',
      ok: false,
      checks: [fail('repo_exists', `${relative(fleetRoot, repo)} is missing`)],
    };
  }
  checks.push(pass('repo_exists', 'using starboard'));
  checks.push(deployCfScriptCheck(repo, 'starboard'));

  const wranglerPath = resolve(repo, 'wrangler.jsonc');
  if (!existsSync(wranglerPath)) {
    checks.push(fail('wrangler_config', 'wrangler.jsonc is missing'));
  } else {
    const config = readJsonc(wranglerPath);
    const binding = serviceBinding(config, 'RAG_SERVICE');
    checks.push(binding?.service === 'knowledgebase'
      ? pass('rag_service_binding', 'RAG_SERVICE -> knowledgebase')
      : fail('rag_service_binding', `expected RAG_SERVICE -> knowledgebase, got ${JSON.stringify(binding)}`));
    const indexId = String(config?.vars?.STARBOARD_RAG_INDEX_ID ?? '').trim();
    checks.push(indexId
      ? pass('starboard_rag_index_var', 'STARBOARD_RAG_INDEX_ID is configured as a Worker var')
      : fail('starboard_rag_index_var', 'STARBOARD_RAG_INDEX_ID is missing from wrangler vars'));
  }

  const clientPath = resolve(repo, 'src/lib/knowledgebase.ts');
  if (!existsSync(clientPath)) {
    checks.push(fail('rag_client', 'src/lib/knowledgebase.ts is missing'));
  } else {
    const client = readText(clientPath);
    checks.push(containsAll(client, [/getCloudflareContext/, /cloudflareEnv\(\)\.RAG_SERVICE_KEY/, /cloudflareEnv\(\)\.STARBOARD_RAG_INDEX_ID/, /RAG_SERVICE/, /knowledgebase/])
      ? pass('rag_client', 'knowledgebase client reads Cloudflare binding/key/index')
      : fail('rag_client', 'knowledgebase.ts is missing Cloudflare binding/key/index or knowledgebase references'));
    checks.push(containsAll(client, [/searchStarboardRag/, /ingestStarboardRagDocuments/, /\/v1\/indexes\/\$\{ragIndexId\}\/query/, /\/v1\/indexes\/\$\{ragIndexId\}\/ingest/])
      ? pass('rag_client_search_and_ingest', 'knowledgebase client supports search and ingest')
      : fail('rag_client_search_and_ingest', 'knowledgebase.ts must route both Starboard search and ingest through knowledgebase'));
    checks.push(containsAll(client, [/filter:\s*\{\s*user_id:\s*userId\s*\}/, /metadata\.repo_id/, /top_k:\s*topK/, /mode:\s*["']semantic["']/])
      ? pass('rag_client_user_scope', 'knowledgebase search is scoped by user_id, semantic mode, top_k, and maps repo_id metadata')
      : fail('rag_client_user_scope', 'knowledgebase.ts must filter by user_id, send semantic mode/top_k, and map repo_id metadata from knowledgebase results'));
    checks.push(knowledgebaseFallbackUrlOk(client)
      ? pass('rag_service_url_fallback', 'public fallback URL points at knowledgebase')
      : fail('rag_service_url_fallback', 'public fallback URL must point at knowledgebase, not the retired rag-service'));
  }

  const starsRoute = resolve(repo, 'src/app/api/stars/route.ts');
  if (!existsSync(starsRoute)) {
    checks.push(fail('stars_route', 'src/app/api/stars/route.ts is missing'));
  } else {
    const route = readText(starsRoute);
    checks.push(route.includes('searchStarboardRag') && !/generateEmbedding|vector_top_k/.test(route)
      ? pass('stars_route', 'relevance route uses knowledgebase RAG without local vector fallback')
      : fail('stars_route', 'relevance route still has local semantic fallback or missing shared RAG call'));
  }

  const syncRoute = resolve(repo, 'src/app/api/stars/sync/route.ts');
  if (!existsSync(syncRoute)) {
    checks.push(fail('stars_sync_route', 'src/app/api/stars/sync/route.ts is missing'));
  } else {
    const route = readText(syncRoute);
    checks.push(route.includes('ingestStarboardRagDocuments') && route.includes('@/lib/knowledgebase')
      ? pass('stars_sync_route', 'sync route ingests repo documents through knowledgebase RAG')
      : fail('stars_sync_route', 'sync route must use ingestStarboardRagDocuments from the knowledgebase RAG client'));
    checks.push(containsAll(route, [/metadata:\s*\{[\s\S]*user_id:\s*userId[\s\S]*repo_id:\s*repo\.id[\s\S]*full_name:\s*repo\.full_name/])
      ? pass('stars_sync_metadata_contract', 'sync route sends user_id/repo_id/full_name metadata to knowledgebase')
      : fail('stars_sync_metadata_contract', 'sync route must send user_id, repo_id, and full_name metadata for knowledgebase filtering/results'));
    checks.push(containsAll(route, [/content:\s*texts\[i\]\s*\?\?\s*["']["']/, /language:\s*repo\.language/])
      ? pass('stars_sync_content_contract', 'sync route sends repo text content and language metadata to knowledgebase')
      : fail('stars_sync_content_contract', 'sync route must send repo text content and language metadata to knowledgebase ingest'));
  }

  const legacyRagClient = resolve(repo, 'src/lib/rag-service.ts');
  checks.push(existsSync(legacyRagClient)
    ? fail('legacy_rag_service_client_removed', 'src/lib/rag-service.ts still exists; use src/lib/knowledgebase.ts')
    : pass('legacy_rag_service_client_removed'));

  return { repo: 'starboard', ok: checks.every((check) => check.ok), checks };
}

export function auditConsumerRagIntegrations(options = {}) {
  const fleetRoot = resolve(options.fleetRoot ?? FLEET_ROOT);
  const consumers = [
    auditLinkchat(fleetRoot),
    auditStarboard(fleetRoot),
  ];
  return {
    ok: consumers.every((consumer) => consumer.ok),
    fleet_root: fleetRoot,
    consumers,
    blockers: consumers.flatMap((consumer) =>
      consumer.checks
        .filter((check) => !check.ok)
        .map((check) => `${consumer.repo}:${check.name}`),
    ),
  };
}

function printHuman(report) {
  console.log(`${report.ok ? 'READY' : 'NOT READY'} consumer knowledgebase RAG integrations`);
  for (const consumer of report.consumers) {
    console.log(`\n${consumer.ok ? 'PASS' : 'FAIL'} ${consumer.repo}`);
    for (const check of consumer.checks) {
      console.log(`  ${check.ok ? 'PASS' : 'FAIL'} ${check.name}${check.detail ? ` - ${check.detail}` : ''}`);
    }
  }
  if (report.blockers.length > 0) console.log(`\nblockers=${report.blockers.join(',')}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = auditConsumerRagIntegrations();
    if (args.jsonOnly) console.log(JSON.stringify(report, null, 2));
    else printHuman(report);
    if (args.requireComplete && !report.ok) process.exitCode = 1;
  } catch (error) {
    usage();
    console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
