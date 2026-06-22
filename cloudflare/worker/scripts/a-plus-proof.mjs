#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildAPlusScorecard } from './a-plus-scorecard.mjs';
import { runBenchmark } from './benchmark-rag.mjs';
import { EXPECTED_DEPLOY_FINGERPRINT, runDeployReadiness } from './deploy-readiness.mjs';
import { runOperatorReport } from './operator-report.mjs';

const DEFAULT_BASE_URL = 'https://knowledgebase.sarthakagrawal927.workers.dev';
const DEFAULT_QUERY = 'what should this account remember?';

function usage() {
  console.error(`Usage:
  node scripts/a-plus-proof.mjs --domain <domain> --output-dir /tmp/kb-a-plus-proof

Options:
  --base-url <url>        Deployed Worker URL. Defaults to RAG_BASE_URL or ${DEFAULT_BASE_URL}.
  --key <service-key>     Service key. Defaults to RAG_SERVICE_KEY.
  --domain <domain>       Required target KB domain/account scope. Defaults to RAG_SCORECARD_DOMAIN.
  --input <path>          Benchmark input JSON. Defaults to fixtures/benchmark.sample.json.
  --output-dir <path>     Directory for generated JSON proof artifacts.
  --repeat <n>            Benchmark repeat count. Defaults to 5.
  --top-k <n>             Benchmark top_k. Defaults to 5.
  --query <text>          Operator benchmark query. Defaults to "${DEFAULT_QUERY}".
  --index-id <id>         Optional existing index benchmark for the operator report.
  --expected-deploy-fingerprint <value>
                          Expected health deploy fingerprint. Defaults to RAG_EXPECTED_DEPLOY_FINGERPRINT or ${EXPECTED_DEPLOY_FINGERPRINT}.
  --require-grade <grade> Required scorecard grade. Defaults to A+.
  --dry-run               Print the planned proof run without network calls or file writes.
  --json                  Print JSON only.`);
}

function parsePositiveInteger(value, label) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 1 || String(parsed) !== String(value).trim()) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(argv) {
  const out = {
    baseUrl: process.env.RAG_BASE_URL || DEFAULT_BASE_URL,
    key: process.env.RAG_SERVICE_KEY || '',
    domain: process.env.RAG_SCORECARD_DOMAIN || '',
    input: 'fixtures/benchmark.sample.json',
    outputDir: '',
    repeat: 5,
    topK: 5,
    query: DEFAULT_QUERY,
    indexId: '',
    expectedDeployFingerprint: process.env.RAG_EXPECTED_DEPLOY_FINGERPRINT || EXPECTED_DEPLOY_FINGERPRINT,
    requireGrade: 'A+',
    dryRun: false,
    jsonOnly: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--dry-run') {
      out.dryRun = true;
      continue;
    }
    if (arg === '--json') {
      out.jsonOnly = true;
      continue;
    }
    const value = argv[i + 1];
    if (!value) throw new Error(`missing value for ${arg}`);
    i += 1;
    if (arg === '--base-url') out.baseUrl = value;
    else if (arg === '--key') out.key = value;
    else if (arg === '--domain') out.domain = value.trim();
    else if (arg === '--input') out.input = value;
    else if (arg === '--output-dir') out.outputDir = value;
    else if (arg === '--repeat') out.repeat = parsePositiveInteger(value, arg);
    else if (arg === '--top-k') out.topK = parsePositiveInteger(value, arg);
    else if (arg === '--query') out.query = value;
    else if (arg === '--index-id') out.indexId = value;
    else if (arg === '--expected-deploy-fingerprint') out.expectedDeployFingerprint = value.trim();
    else if (arg === '--require-grade') out.requireGrade = value.trim().toUpperCase();
    else throw new Error(`unknown argument: ${arg}`);
  }

  out.baseUrl = out.baseUrl.replace(/\/+$/, '');
  return out;
}

function buildPlan(options) {
  return {
    base_url: options.baseUrl,
    domain: options.domain || null,
    benchmark_input: options.input,
    output_dir: options.outputDir || null,
    repeat: options.repeat,
    top_k: options.topK,
    expected_deploy_fingerprint: options.expectedDeployFingerprint,
    required_grade: options.requireGrade,
    steps: [
      'deploy-readiness',
      'operator-report',
      'benchmark:kb-search:lexical',
      'benchmark:kb-query:semantic',
      'scorecard:a-plus',
    ],
    scorecard_requirements: {
      require_readiness_report: true,
      required_domain: options.domain || null,
      required_benchmark_modes: ['lexical', 'semantic'],
      required_benchmark_surfaces: ['kb-search', 'kb-query'],
      min_benchmark_repeat: options.repeat,
      min_benchmark_samples: options.repeat * 2,
      required_eval_kinds: ['query'],
    },
  };
}

async function writeJson(outputDir, name, payload) {
  if (!outputDir) return null;
  await mkdir(outputDir, { recursive: true });
  const path = join(outputDir, name);
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`);
  return path;
}

export async function runAPlusProof(options) {
  const plan = buildPlan(options);
  if (options.dryRun) {
    return {
      ok: true,
      dry_run: true,
      plan,
      artifacts: {},
    };
  }
  if (!options.domain) throw new Error('--domain or RAG_SCORECARD_DOMAIN is required');
  if (!options.key) throw new Error('--key or RAG_SERVICE_KEY is required');

  const input = await readFile(options.input, 'utf8');
  const readinessReport = await runDeployReadiness({
    baseUrl: options.baseUrl,
    key: options.key,
    expectedDeployFingerprint: options.expectedDeployFingerprint,
  });
  const operatorReport = await runOperatorReport({
    baseUrl: options.baseUrl,
    key: options.key,
    domain: options.domain,
    indexId: options.indexId,
    queries: [options.query],
    repeat: options.repeat,
    topK: options.topK,
    mode: 'semantic',
  });
  const lexicalBenchmark = await runBenchmark({
    baseUrl: options.baseUrl,
    key: options.key,
    input,
    surface: 'kb-search',
    domain: options.domain,
    mode: 'lexical',
    repeat: options.repeat,
    topK: options.topK,
  });
  const semanticBenchmark = await runBenchmark({
    baseUrl: options.baseUrl,
    key: options.key,
    input,
    surface: 'kb-query',
    domain: options.domain,
    mode: 'semantic',
    repeat: options.repeat,
    topK: options.topK,
  });
  const scorecard = buildAPlusScorecard({
    operator_report: operatorReport,
    readiness_reports: [readinessReport],
    benchmarks: [lexicalBenchmark, semanticBenchmark],
  }, {
    requireGrade: options.requireGrade,
    requireReadinessReport: true,
    expectedDeployFingerprint: options.expectedDeployFingerprint,
    requiredDomain: options.domain,
    requiredBenchmarkModes: ['lexical', 'semantic'],
    requiredBenchmarkSurfaces: ['kb-search', 'kb-query'],
    minBenchmarkRepeat: options.repeat,
    minBenchmarkSamples: options.repeat * 2,
    requiredEvalKinds: ['query'],
  });

  const artifacts = {
    readiness: await writeJson(options.outputDir, 'readiness.json', readinessReport),
    operator_report: await writeJson(options.outputDir, 'operator-report.json', operatorReport),
    benchmark_lexical: await writeJson(options.outputDir, 'benchmark-lexical.json', lexicalBenchmark),
    benchmark_semantic: await writeJson(options.outputDir, 'benchmark-semantic.json', semanticBenchmark),
    scorecard: await writeJson(options.outputDir, 'scorecard.json', scorecard),
  };

  return {
    ok: scorecard.ok,
    dry_run: false,
    plan,
    artifacts,
    readiness: readinessReport,
    operator_report: operatorReport,
    benchmarks: [lexicalBenchmark, semanticBenchmark],
    scorecard,
  };
}

function printHuman(result) {
  if (result.dry_run) {
    console.log('READY to run Knowledgebase A/A+ proof');
    console.log(`base_url=${result.plan.base_url}`);
    console.log(`domain=${result.plan.domain ?? 'missing'}`);
    console.log(`repeat=${result.plan.repeat} top_k=${result.plan.top_k}`);
    console.log(`steps=${result.plan.steps.join(',')}`);
    return;
  }
  console.log(`${result.ok ? 'READY' : 'NOT READY'} Knowledgebase A/A+ proof`);
  console.log(`overall=${result.scorecard.overall_grade} required=${result.scorecard.required_grade}`);
  if (Object.values(result.artifacts).some(Boolean)) {
    console.log(`artifacts=${Object.values(result.artifacts).filter(Boolean).join(',')}`);
  }
  if (result.scorecard.blockers.length > 0) console.log(`blockers=${result.scorecard.blockers.join(',')}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await runAPlusProof(args);
    if (args.jsonOnly) console.log(JSON.stringify(result, null, 2));
    else printHuman(result);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    usage();
    console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

export { buildPlan, parseArgs };
