#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const FLEET_ROOT = resolve(REPO_ROOT, '..');
const DEFAULT_FREE_AI_REPO = resolve(FLEET_ROOT, 'free-ai');

export const REQUIRED_MODELS = [
  { id: 'gemini-embedding-001', provider: 'gemini', dimensions: 1536, aliases: ['text-embedding-3-small', 'text-embedding-3-large', 'text-embedding-004'] },
  { id: 'voyage-3.5-lite', provider: 'voyage_ai', dimensions: 1024 },
  { id: 'voyage-3-lite', provider: 'voyage_ai', dimensions: 1024 },
  { id: '@cf/baai/bge-large-en-v1.5', provider: 'workers_ai', dimensions: 1024 },
  { id: '@cf/baai/bge-base-en-v1.5', provider: 'workers_ai', dimensions: 768 },
  { id: '@cf/baai/bge-small-en-v1.5', provider: 'workers_ai', dimensions: 384 },
];

function check(name, ok, detail = {}) {
  return { name, ok, ...detail };
}

function readText(path) {
  return readFileSync(path, 'utf8');
}

function requiredModelPattern(model) {
  return new RegExp(
    `provider:\\s*['"]${model.provider}['"][\\s\\S]*?model:\\s*['"]${model.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"][\\s\\S]*?dimensions:\\s*${model.dimensions}\\b`,
  );
}

function requiredAliasesPresent(source, aliases) {
  return aliases.every((alias) => source.includes(`'${alias}'`) || source.includes(`"${alias}"`));
}

function deployScriptOk(script) {
  if (typeof script !== 'string') return false;
  return /\baudit:cloudflare-costs\b/.test(script)
    && /\bwrangler\s+deploy\b/.test(script);
}

export function auditFreeAiEmbeddingContract({ freeAiRepo = DEFAULT_FREE_AI_REPO } = {}) {
  const repo = resolve(freeAiRepo);
  const checks = [];

  if (!existsSync(repo)) {
    checks.push(check('free_ai_repo', false, {
      repo,
      error: `${relative(FLEET_ROOT, repo)} is missing`,
    }));
    return {
      ok: false,
      free_ai_repo: repo,
      checks,
      blockers: checks.filter((item) => !item.ok),
    };
  }
  checks.push(check('free_ai_repo', true, { repo }));

  const packagePath = resolve(repo, 'package.json');
  if (!existsSync(packagePath)) {
    checks.push(check('package_script_smoke_embedding_models', false, {
      file: 'package.json',
      error: 'package.json is missing',
    }));
    checks.push(check('package_script_deploy_cloudflare', false, {
      file: 'package.json',
      error: 'package.json is missing',
    }));
  } else {
    const pkg = JSON.parse(readText(packagePath));
    checks.push(check('package_script_smoke_embedding_models', pkg?.scripts?.['smoke:embedding-models'] === 'node scripts/smoke-embedding-models.mjs', {
      file: 'package.json',
      script: pkg?.scripts?.['smoke:embedding-models'] ?? null,
    }));
    checks.push(check('package_script_deploy_cloudflare', deployScriptOk(pkg?.scripts?.deploy), {
      file: 'package.json',
      script: pkg?.scripts?.deploy ?? null,
      required: 'deploy must run audit:cloudflare-costs and wrangler deploy',
    }));
  }

  const sourcePath = resolve(repo, 'src/index.ts');
  let source = '';
  if (!existsSync(sourcePath)) {
    checks.push(check('source_embedding_candidates', false, {
      file: 'src/index.ts',
      error: 'src/index.ts is missing',
    }));
  } else {
    source = readText(sourcePath);
    const missingModels = REQUIRED_MODELS
      .filter((model) => !requiredModelPattern(model).test(source))
      .map((model) => model.id);
    const missingAliases = REQUIRED_MODELS
      .filter((model) => model.aliases && !requiredAliasesPresent(source, model.aliases))
      .flatMap((model) => model.aliases ?? []);
    checks.push(check('source_embedding_candidates', missingModels.length === 0 && missingAliases.length === 0, {
      file: 'src/index.ts',
      required_count: REQUIRED_MODELS.length,
      missing_models: missingModels,
      missing_aliases: missingAliases,
    }));

    const modelListPatterns = [
      /type:\s*['"]embedding['"]\s+as\s+const/,
      /enabled:\s*embeddingCandidateEnabled\(env,\s*candidate\)/,
      /dimensions:\s*candidate\.dimensions/,
      /supports_dimensions:\s*candidate\.supportsDimensions\s*\?\?\s*false/,
      /aliases:\s*candidate\.aliases\s*\?\?\s*\[\]/,
      /priority:\s*candidate\.priority/,
    ];
    const missingPatterns = modelListPatterns
      .filter((pattern) => !pattern.test(source))
      .map((pattern) => String(pattern));
    checks.push(check('model_list_embedding_rows', missingPatterns.length === 0, {
      file: 'src/index.ts',
      missing_patterns: missingPatterns,
    }));
  }

  const smokeScriptPath = resolve(repo, 'scripts/smoke-embedding-models.mjs');
  checks.push(check('smoke_embedding_models_script', existsSync(smokeScriptPath), {
    file: 'scripts/smoke-embedding-models.mjs',
  }));

  const smokeTestPath = resolve(repo, 'test/embedding-model-smoke.spec.ts');
  if (!existsSync(smokeTestPath)) {
    checks.push(check('smoke_embedding_models_tests', false, {
      file: 'test/embedding-model-smoke.spec.ts',
      error: 'test file is missing',
    }));
  } else {
    const test = readText(smokeTestPath);
    const missingPatterns = [
      /passes when the required embedding model is enabled/,
      /matches aliases for OpenAI-compatible embedding names/,
      /supports_dimensions/,
      /selected\?\.aliases/,
      /fails when the required embedding model is disabled/,
      /fails when the deployed catalog has no embedding rows/,
    ].filter((pattern) => !pattern.test(test)).map((pattern) => String(pattern));
    checks.push(check('smoke_embedding_models_tests', missingPatterns.length === 0, {
      file: 'test/embedding-model-smoke.spec.ts',
      missing_patterns: missingPatterns,
    }));
  }

  const blockers = checks.filter((item) => !item.ok);
  return {
    ok: blockers.length === 0,
    free_ai_repo: repo,
    required_models: REQUIRED_MODELS.map((model) => ({
      id: model.id,
      provider: model.provider,
      dimensions: model.dimensions,
    })),
    checks,
    blockers,
  };
}

function usage() {
  console.error(`Usage:
  node scripts/audit-free-ai-embedding-contract.mjs [--free-ai-repo ../../../free-ai] [--json] [--require-complete]

Checks the local free-ai gateway contract required by knowledgebase selected
embedding model deployment:
  - /v1/models source includes embedding rows with dimensions, aliases, enabled state, and priority
  - the required free-ai embedding candidates are present
  - the read-only live catalog smoke script and tests exist
  - the production deploy script is Cloudflare-backed and cost-audited`);
}

function parseArgs(argv) {
  const args = {
    freeAiRepo: DEFAULT_FREE_AI_REPO,
    jsonOnly: false,
    requireComplete: false,
  };
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
    if (arg === '--free-ai-repo') {
      const value = argv[i + 1];
      if (!value) throw new Error('missing value for --free-ai-repo');
      args.freeAiRepo = resolve(process.cwd(), value);
      i += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function printHuman(report) {
  for (const item of report.checks) {
    console.log(`${item.ok ? 'OK' : 'FAIL'} ${item.name}${item.file ? ` ${item.file}` : ''}`);
    if (item.error) console.log(`  ${item.error}`);
    if (Array.isArray(item.missing_models) && item.missing_models.length > 0) {
      console.log(`  missing_models=${item.missing_models.join(',')}`);
    }
    if (Array.isArray(item.missing_patterns) && item.missing_patterns.length > 0) {
      for (const pattern of item.missing_patterns) console.log(`  missing ${pattern}`);
    }
  }
  console.log(`\n${report.ok ? 'PASS' : 'FAIL'} free-ai-embedding-contract blockers=${report.blockers.length}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = auditFreeAiEmbeddingContract({ freeAiRepo: args.freeAiRepo });
    if (args.jsonOnly) console.log(JSON.stringify(report, null, 2));
    else printHuman(report);
    if (args.requireComplete && !report.ok) process.exitCode = 1;
  } catch (error) {
    usage();
    console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
