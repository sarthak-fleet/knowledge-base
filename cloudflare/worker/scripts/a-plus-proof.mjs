#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildAPlusScorecard } from './a-plus-scorecard.mjs';
import { runBenchmark } from './benchmark-rag.mjs';
import { runConsumerAuthSmokes } from './consumer-auth-smokes.mjs';
import { EXPECTED_DEPLOY_FINGERPRINT, runDeployReadiness } from './deploy-readiness.mjs';
import { runOperatorReport } from './operator-report.mjs';

const DEFAULT_BASE_URL = 'https://knowledgebase.sarthakagrawal927.workers.dev';
const DEFAULT_QUERY = 'what should this account remember?';
const MIN_PROOF_QUERIES = 2;
const MIN_S_PROOF_QUERIES = 4;

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
  --continue-after-readiness-failure
                          Continue into eval and benchmark requests even when deploy readiness fails.
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
    continueAfterReadinessFailure: false,
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
    if (arg === '--continue-after-readiness-failure') {
      out.continueAfterReadinessFailure = true;
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
  const requiresS = options.requireGrade === 'S';
  const minProofQueries = requiresS ? MIN_S_PROOF_QUERIES : MIN_PROOF_QUERIES;
  return {
    base_url: options.baseUrl,
    domain: options.domain || null,
    benchmark_input: options.input,
    output_dir: options.outputDir || null,
    repeat: options.repeat,
    top_k: options.topK,
    expected_deploy_fingerprint: options.expectedDeployFingerprint,
    required_grade: options.requireGrade,
    continue_after_readiness_failure: options.continueAfterReadinessFailure === true,
    steps: [
      'deploy-readiness',
      ...(requiresS ? ['consumer-auth-smokes'] : []),
      'seed-eval-corpus',
      'benchmark:kb-search:lexical',
      'benchmark:kb-query:semantic',
      'query-eval',
      'operator-report',
      requiresS ? 'scorecard:s' : 'scorecard:a-plus',
    ],
    scorecard_requirements: {
      require_readiness_report: true,
      required_domain: options.domain || null,
      required_benchmark_modes: ['lexical', 'semantic'],
      required_benchmark_surfaces: ['kb-search', 'kb-query'],
      min_benchmark_repeat: options.repeat,
      min_benchmark_samples: options.repeat * minProofQueries,
      min_query_eval_rows: minProofQueries,
      required_eval_kinds: ['query'],
    },
  };
}

function detectConsumerEvalPacks(input) {
  const parsed = typeof input === 'string' ? JSON.parse(input) : input;
  const docs = Array.isArray(parsed?.documents) ? parsed.documents : [];
  const queries = Array.isArray(parsed?.queries) ? parsed.queries : [];
  const text = JSON.stringify({ docs, queries }).toLowerCase();
  return [
    text.includes('karte') ? 'karte-memory' : null,
    text.includes('starboard') || text.includes('readme') ? 'starboard-readme' : null,
  ].filter(Boolean);
}

async function writeJson(outputDir, name, payload) {
  if (!outputDir) return null;
  await mkdir(outputDir, { recursive: true });
  const path = join(outputDir, name);
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`);
  return path;
}

function queryEvalCases(input) {
  const parsed = typeof input === 'string' ? JSON.parse(input) : input;
  const queries = Array.isArray(parsed?.queries) ? parsed.queries : [];
  return queries
    .map((query, index) => {
      const question = String(query?.query || '').trim();
      if (!question) return null;
      const expected = Array.isArray(query?.expected_contains)
        ? query.expected_contains.map(String).find((value) => value.trim())
        : null;
      const expectedDocumentIds = Array.isArray(query?.expected_document_ids)
        ? query.expected_document_ids.map(String).filter((value) => value.trim())
        : [];
      const expectedChunkIds = Array.isArray(query?.expected_chunk_ids)
        ? query.expected_chunk_ids.map(String).filter((value) => value.trim())
        : [];
      return {
        id: query?.id ? String(query.id) : `q${index + 1}`,
        question,
        ...(expected ? { expected_text: expected } : {}),
        ...(expectedDocumentIds.length ? { expected_document_ids: expectedDocumentIds } : {}),
        ...(expectedChunkIds.length ? { expected_chunk_ids: expectedChunkIds } : {}),
      };
    })
    .filter(Boolean);
}

function proofDocuments(input) {
  const parsed = typeof input === 'string' ? JSON.parse(input) : input;
  const docs = Array.isArray(parsed?.documents) ? parsed.documents : [];
  return docs
    .map((doc, index) => {
      const content = String(doc?.content ?? '').trim();
      if (!content) return null;
      return {
        id: String(doc?.external_id || doc?.id || `proof-doc-${index + 1}`),
        title: String(doc?.external_id || doc?.id || `proof-doc-${index + 1}`),
        text: content,
      };
    })
    .filter(Boolean);
}

function proofEmbeddingSelection(input) {
  const parsed = typeof input === 'string' ? JSON.parse(input) : input;
  const index = parsed?.index && typeof parsed.index === 'object' ? parsed.index : {};
  const embeddingModel = typeof index.embedding_model === 'string'
    ? index.embedding_model.trim()
    : typeof index.embeddingModel === 'string'
      ? index.embeddingModel.trim()
      : '';
  const embeddingProvider = typeof index.embedding_provider === 'string'
    ? index.embedding_provider.trim()
    : typeof index.embeddingProvider === 'string'
      ? index.embeddingProvider.trim()
      : '';
  return {
    ...(embeddingModel ? { embedding_model: embeddingModel } : {}),
    ...(embeddingProvider ? { embedding_provider: embeddingProvider } : {}),
  };
}

function hasScoringLabel(query) {
  return ['expected_contains', 'expected_document_ids', 'expected_chunk_ids']
    .some((key) => Array.isArray(query?.[key]) && query[key].some((value) => String(value || '').trim()));
}

function validateProofInput(input, { minQueries = MIN_PROOF_QUERIES } = {}) {
  const parsed = typeof input === 'string' ? JSON.parse(input) : input;
  const queries = Array.isArray(parsed?.queries) ? parsed.queries : [];
  const labeledQueries = queries
    .filter((query) => String(query?.query || '').trim())
    .filter(hasScoringLabel);
  const errors = [];
  if (queries.length < minQueries) {
    errors.push(`proof input must include at least ${minQueries} queries`);
  }
  if (labeledQueries.length < minQueries) {
    errors.push(`proof input must include at least ${minQueries} scored queries with expected_contains, expected_document_ids, or expected_chunk_ids`);
  }
  return {
    ok: errors.length === 0,
    errors,
    query_count: queries.length,
    scored_query_count: labeledQueries.length,
    min_queries: minQueries,
  };
}

async function requestJson(url, { key, method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${url} failed ${res.status}: ${JSON.stringify(payload)}`);
  return payload;
}

export async function seedProofCorpus(options) {
  const documents = proofDocuments(options.input);
  if (documents.length === 0) throw new Error('proof input documents are required for live proof seeding');
  const embeddingSelection = proofEmbeddingSelection(options.input);
  const seeded = [];
  for (const doc of documents) {
    const response = await requestJson(`${options.baseUrl}/v1/kb/ingest/text`, {
      key: options.key,
      method: 'POST',
      body: {
        domain: options.domain,
        title: doc.title,
        text: doc.text,
        async: false,
        idempotency_key: `proof:${doc.id}`,
        ...embeddingSelection,
      },
    });
    seeded.push({
      id: doc.id,
      file_id: response.file_id ?? null,
      status: response.idempotent_replay === true ? 'replayed' : 'seeded',
      chunks_indexed: Number(response.chunks_indexed ?? (
        Array.isArray(response.files)
          ? response.files.reduce((sum, file) => sum + Number(file?.chunks_created ?? 0), 0)
          : 0
      )),
      ingest_safety: response.ingest_safety ?? null,
    });
  }
  return {
    domain: options.domain,
    document_count: seeded.length,
    documents: seeded,
  };
}

export async function runQueryEvalProof(options) {
  const cases = queryEvalCases(options.input);
  if (cases.length === 0) throw new Error('benchmark input queries are required for query eval proof');
  return requestJson(`${options.baseUrl}/v1/kb/evals/query`, {
    key: options.key,
    method: 'POST',
    body: {
      domain: options.domain,
      mode: 'semantic',
      top_k: options.topK,
      answer_mode: 'extractive',
      ai_judge: false,
      cases,
    },
  });
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
  const minQueries = options.requireGrade === 'S' ? MIN_S_PROOF_QUERIES : MIN_PROOF_QUERIES;
  const inputValidation = validateProofInput(input, { minQueries });
  if (!inputValidation.ok) {
    throw new Error(`invalid A/A+ proof input: ${inputValidation.errors.join('; ')}`);
  }
  const readinessReport = await (options.readinessRunner ?? runDeployReadiness)({
    baseUrl: options.baseUrl,
    key: options.key,
    expectedDeployFingerprint: options.expectedDeployFingerprint,
  });
  const consumerSmokes = options.requireGrade === 'S'
    ? await (options.consumerSmokeRunner ?? runConsumerAuthSmokes)()
    : null;
  if (!readinessReport.ok && options.continueAfterReadinessFailure !== true) {
    const scorecard = buildAPlusScorecard({
      readiness_reports: [readinessReport],
    }, {
      requireGrade: options.requireGrade,
      requireReadinessReport: true,
      expectedDeployFingerprint: options.expectedDeployFingerprint,
      requiredDomain: options.domain,
      requiredBenchmarkModes: ['lexical', 'semantic'],
      requiredBenchmarkSurfaces: ['kb-search', 'kb-query'],
      minBenchmarkRepeat: options.repeat,
      minBenchmarkSamples: options.repeat * minQueries,
      minQueryEvalRows: minQueries,
      requiredEvalKinds: ['query'],
    });
    const artifacts = {
      readiness: await writeJson(options.outputDir, 'readiness.json', readinessReport),
      seed_eval_corpus: null,
      query_eval: null,
      operator_report: null,
      benchmark_lexical: null,
      benchmark_semantic: null,
      scorecard: await writeJson(options.outputDir, 'scorecard.json', scorecard),
    };
    return {
      ok: false,
      dry_run: false,
      stopped_after_readiness: true,
      stop_reason: 'deploy_readiness_failed',
      plan,
      artifacts,
      readiness: readinessReport,
      seed_eval_corpus: null,
      query_eval: null,
      operator_report: null,
      benchmarks: [],
      scorecard,
    };
  }
  const seedReport = await seedProofCorpus({
    baseUrl: options.baseUrl,
    key: options.key,
    domain: options.domain,
    input,
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
  const queryEval = await runQueryEvalProof({
    baseUrl: options.baseUrl,
    key: options.key,
    domain: options.domain,
    input,
    topK: options.topK,
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
  const scorecard = buildAPlusScorecard({
    operator_report: operatorReport,
    readiness_reports: [readinessReport],
    query_evals: [queryEval],
    benchmarks: [lexicalBenchmark, semanticBenchmark],
    capabilities: {
      ...(consumerSmokes ? { consumer_authenticated_smokes: consumerSmokes.consumers } : {}),
      consumer_eval_packs: detectConsumerEvalPacks(input),
    },
  }, {
    requireGrade: options.requireGrade,
    requireReadinessReport: true,
    expectedDeployFingerprint: options.expectedDeployFingerprint,
    requiredDomain: options.domain,
    requiredBenchmarkModes: ['lexical', 'semantic'],
    requiredBenchmarkSurfaces: ['kb-search', 'kb-query'],
    minBenchmarkRepeat: options.repeat,
    minBenchmarkSamples: options.repeat * minQueries,
    minQueryEvalRows: minQueries,
    requiredEvalKinds: ['query'],
  });

  const artifacts = {
    readiness: await writeJson(options.outputDir, 'readiness.json', readinessReport),
    seed_eval_corpus: await writeJson(options.outputDir, 'seed-eval-corpus.json', seedReport),
    query_eval: await writeJson(options.outputDir, 'query-eval.json', queryEval),
    consumer_smokes: consumerSmokes ? await writeJson(options.outputDir, 'consumer-smokes.json', consumerSmokes) : null,
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
    seed_eval_corpus: seedReport,
    query_eval: queryEval,
    consumer_smokes: consumerSmokes,
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

export { buildPlan, parseArgs, proofDocuments, proofEmbeddingSelection, queryEvalCases, validateProofInput };
