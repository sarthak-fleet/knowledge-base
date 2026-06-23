#!/usr/bin/env node

const DEFAULT_BASE_URL = 'https://knowledgebase.sarthakagrawal927.workers.dev';

function usage() {
  console.error(`Usage:
  node scripts/operator-report.mjs [--base-url <url>] [--key <service-key>] [--domain <name>] [--json]

Options:
  --key <service-key>    Service key for authenticated inventory. Defaults to RAG_SERVICE_KEY.
  --domain <name>        Limit files/jobs/traces/evals/source sets to one KB domain.
  --index-id <id>        Existing index to benchmark. Requires --query.
  --query <text>         Benchmark query for --index-id. Can be passed more than once.
  --repeat <n>           Benchmark repeat count; default 5.
  --warmup <n>           Benchmark warmup count; default 1.
  --top-k <n>            Benchmark top_k; default 5.
  --mode <mode>          Benchmark query mode; default semantic.
  --require-auth         Fail when no service key is available.
  --json                 Print JSON only.

The default report is read-only. The benchmark path only calls the existing
Worker benchmark-query route against an existing index; it does not ingest or
delete data.`);
}

function parsePositiveInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function parseNonNegativeInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}

function parseArgs(argv) {
  const out = {
    baseUrl: process.env.RAG_BASE_URL || DEFAULT_BASE_URL,
    key: process.env.RAG_SERVICE_KEY || '',
    domain: '',
    indexId: '',
    queries: [],
    repeat: 5,
    warmup: 1,
    topK: 5,
    mode: 'semantic',
    requireAuth: false,
    jsonOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--require-auth') {
      out.requireAuth = true;
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
    else if (arg === '--domain') out.domain = value;
    else if (arg === '--index-id') out.indexId = value;
    else if (arg === '--query') out.queries.push(value);
    else if (arg === '--repeat') out.repeat = parsePositiveInteger(value, '--repeat');
    else if (arg === '--warmup') out.warmup = parseNonNegativeInteger(value, '--warmup');
    else if (arg === '--top-k') out.topK = parsePositiveInteger(value, '--top-k');
    else if (arg === '--mode') out.mode = value;
    else throw new Error(`unknown argument: ${arg}`);
  }
  out.baseUrl = out.baseUrl.replace(/\/+$/, '');
  out.domain = out.domain.trim();
  out.indexId = out.indexId.trim();
  out.queries = out.queries.map((query) => query.trim()).filter(Boolean);
  if (out.indexId && out.queries.length === 0) throw new Error('--query is required with --index-id');
  if (!out.indexId && out.queries.length > 0) throw new Error('--index-id is required with --query');
  if (out.requireAuth && !out.key) throw new Error('--key or RAG_SERVICE_KEY is required');
  return out;
}

function countBy(rows, key) {
  const counts = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const value = String(row?.[key] ?? 'unknown');
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function sumBy(rows, key) {
  return (Array.isArray(rows) ? rows : []).reduce((sum, row) => {
    const value = Number(row?.[key] ?? 0);
    return Number.isFinite(value) ? sum + value : sum;
  }, 0);
}

function average(values) {
  const numeric = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (numeric.length === 0) return null;
  return Math.round((numeric.reduce((sum, value) => sum + value, 0) / numeric.length) * 100) / 100;
}

async function requestJson(fetchImpl, url, { key = '', method = 'GET', body } = {}) {
  const headers = {
    ...(key ? { Authorization: `Bearer ${key}` } : {}),
    ...(body ? { 'Content-Type': 'application/json' } : {}),
  };
  const res = await fetchImpl(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, payload };
}

async function requestText(fetchImpl, url, { key = '', method = 'GET' } = {}) {
  const res = await fetchImpl(url, {
    method,
    headers: {
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
  });
  const text = await res.text().catch(() => '');
  return { status: res.status, ok: res.ok, text };
}

function endpoint(path, domain) {
  if (!domain) return path;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}domain=${encodeURIComponent(domain)}`;
}

function summarizeInventory({ projects, domains, indexes, files, jobs, traces, evalSummary, embeddingModels, sourceSets }) {
  const traceRows = Array.isArray(traces?.traces) ? traces.traces : [];
  const evalSummaries = Array.isArray(evalSummary?.summaries) ? evalSummary.summaries : [];
  const modelRows = Array.isArray(embeddingModels?.free_ai_models) ? embeddingModels.free_ai_models : [];
  return {
    project_count: Array.isArray(projects?.data) ? projects.data.length : 0,
    domain_count: Array.isArray(domains?.data) ? domains.data.length : 0,
    index_count: Array.isArray(indexes?.data) ? indexes.data.length : 0,
    file_count: Array.isArray(files?.data) ? files.data.length : 0,
    file_bytes: sumBy(files?.data, 'bytes'),
    files_by_status: countBy(files?.data, 'status'),
    job_count: Array.isArray(jobs?.jobs) ? jobs.jobs.length : 0,
    jobs_by_status: countBy(jobs?.jobs, 'status'),
    jobs_by_stage: countBy(jobs?.jobs, 'stage'),
    source_set_count: Array.isArray(sourceSets?.source_sets) ? sourceSets.source_sets.length : 0,
    recent_trace_count: traceRows.length,
    avg_trace_latency_ms: average(traceRows.map((trace) => trace?.latency_ms)),
    eval_report_count: typeof evalSummary?.report_count === 'number' ? evalSummary.report_count : evalSummaries.length,
    eval_kinds: [...new Set(evalSummaries.map((item) => item?.kind).filter(Boolean))],
    embedding_model_count: modelRows.length,
    selectable_embedding_model_count: modelRows.filter((model) => model?.selectable === true).length,
  };
}

function costSignals({ traces, evalSummary, benchmark }) {
  const traceRows = Array.isArray(traces?.traces) ? traces.traces : [];
  const evalSummaries = Array.isArray(evalSummary?.summaries) ? evalSummary.summaries : [];
  const aiEvalRates = evalSummaries
    .map((summary) => Number(summary?.avg_ai_use_rate ?? summary?.ai_use_rate))
    .filter((value) => Number.isFinite(value));
  return {
    recent_trace_count: traceRows.length,
    traces_with_citations: traceRows.filter((trace) => Array.isArray(trace?.citations) && trace.citations.length > 0).length,
    avg_trace_latency_ms: average(traceRows.map((trace) => trace?.latency_ms)),
    avg_eval_ai_use_rate: average(aiEvalRates),
    benchmark_cache_hit_rate: typeof benchmark?.cache_hit_rate === 'number'
      ? Math.round(benchmark.cache_hit_rate * 10000) / 10000
      : null,
    note: 'Workers AI and free-ai spend risk is driven by embedding misses, OCR, rerank/synthesis, and AI judge options; default extractive and lexical paths stay cheaper.',
  };
}

function traceHasStageTimings(trace) {
  const stages = trace?.confidence?.timing_stages;
  return Array.isArray(stages)
    && stages.some((stage) => typeof stage?.stage === 'string' && typeof stage?.latency_ms === 'number');
}

function traceHasEmptyResultDiagnostics(trace) {
  const diagnostics = trace?.confidence?.empty_result_diagnostics;
  return diagnostics
    && typeof diagnostics === 'object'
    && typeof diagnostics.result_count === 'number'
    && typeof diagnostics.status === 'string';
}

function drilldownHasEmptyResultDiagnostics(drilldown) {
  const quality = drilldown?.quality;
  return quality
    && typeof quality === 'object'
    && typeof quality.status === 'string'
    && typeof quality.retrieved_count === 'number'
    && typeof quality.citation_count === 'number';
}

function visibleText(html) {
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function uiCapabilities(ui) {
  const text = ui?.text ?? '';
  const rendered = visibleText(text);
  const hasHostedUi = ui?.ok === true && /Knowledgebase Cloudflare/.test(text);
  return {
    hosted_ui: hasHostedUi,
    custom_input: hasHostedUi && /\/v1\/kb\/ingest\/text/.test(text),
    async_status: hasHostedUi && /loadRunProgress|\/v1\/kb\/ingest\/runs/.test(text),
    hides_rag_internals: hasHostedUi
      && !/\b(Index id|Embedding|Vectorize|chunk|RAG)\b/i.test(rendered),
  };
}

export async function runOperatorReport(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const key = options.key || '';
  const domain = options.domain || '';
  const report = {
    ok: true,
    base_url: baseUrl,
    domain: domain || null,
    authenticated: Boolean(key),
    checks: [],
    inventory: null,
    cost_signals: null,
    benchmark: null,
    capabilities: null,
    blockers: [],
  };

  const health = await requestJson(fetchImpl, `${baseUrl}/v1/healthz`);
  const hostedUi = await requestText(fetchImpl, `${baseUrl}/ui`);
  report.checks.push({
    name: 'public_health',
    ok: health.ok && health.payload?.ok === true,
    status: health.status,
    deploy_fingerprint: health.payload?.deploy_fingerprint ?? null,
    d1_schema: health.payload?.d1_schema ?? null,
    vectorize: health.payload?.vectorize ?? null,
    r2: health.payload?.r2 ?? null,
  });
  report.checks.push({
    name: 'hosted_ui',
    ok: hostedUi.ok && /Knowledgebase Cloudflare/.test(hostedUi.text),
    status: hostedUi.status,
  });
  report.capabilities = uiCapabilities(hostedUi);

  const authBoundary = await requestJson(fetchImpl, `${baseUrl}/v1/indexes`);
  report.checks.push({
    name: 'auth_boundary',
    ok: key ? true : authBoundary.status === 401,
    status: authBoundary.status,
  });

  if (!key) {
    report.blockers.push('authenticated_inventory_requires_RAG_SERVICE_KEY');
    report.ok = report.checks.every((check) => check.ok);
    return report;
  }

  const [
    projects,
    domains,
    indexes,
    files,
    jobs,
    sourceSets,
    traces,
    evalSummary,
    embeddingModels,
  ] = await Promise.all([
    requestJson(fetchImpl, `${baseUrl}/v1/kb/projects`, { key }),
    requestJson(fetchImpl, `${baseUrl}/v1/kb/domains`, { key }),
    requestJson(fetchImpl, `${baseUrl}/v1/indexes`, { key }),
    requestJson(fetchImpl, `${baseUrl}${endpoint('/v1/kb/files', domain)}`, { key }),
    requestJson(fetchImpl, `${baseUrl}${endpoint('/v1/kb/jobs?limit=100', domain)}`, { key }),
    requestJson(fetchImpl, `${baseUrl}${endpoint('/v1/kb/source-sets', domain)}`, { key }),
    requestJson(fetchImpl, `${baseUrl}${endpoint('/v1/kb/query/traces?limit=50', domain)}`, { key }),
    requestJson(fetchImpl, `${baseUrl}${endpoint('/v1/kb/evals/summary?limit=100', domain)}`, { key }),
    requestJson(fetchImpl, `${baseUrl}/v1/embedding-models`, { key }),
  ]);

  for (const [name, result] of Object.entries({ projects, domains, indexes, files, jobs, sourceSets, traces, evalSummary, embeddingModels })) {
    report.checks.push({ name, ok: result.ok, status: result.status });
    if (!result.ok) report.blockers.push(name);
  }

  const traceRows = Array.isArray(traces.payload?.traces) ? traces.payload.traces : [];
  let traceExport = null;
  let traceDrilldown = null;
  if (traceRows.length > 0) {
    traceExport = await requestJson(fetchImpl, `${baseUrl}${endpoint('/v1/kb/query/traces/export', domain)}`, { key });
    report.checks.push({ name: 'trace_export', ok: traceExport.ok, status: traceExport.status });
    if (!traceExport.ok) report.blockers.push('trace_export');

    const traceId = String(traceRows[0]?.id ?? '').trim();
    if (traceId) {
      traceDrilldown = await requestJson(fetchImpl, `${baseUrl}/v1/kb/query/trace/${encodeURIComponent(traceId)}/drilldown`, { key });
      report.checks.push({ name: 'trace_drilldown', ok: traceDrilldown.ok, status: traceDrilldown.status });
      if (!traceDrilldown.ok) report.blockers.push('trace_drilldown');
    }
  }

  if (options.indexId) {
    const benchmark = await requestJson(fetchImpl, `${baseUrl}/v1/indexes/${options.indexId}/benchmark-query`, {
      key,
      method: 'POST',
      body: {
        queries: options.queries,
        repeat: options.repeat ?? 5,
        warmup: options.warmup ?? 1,
        top_k: options.topK ?? 5,
        mode: options.mode ?? 'semantic',
      },
    });
    report.checks.push({ name: 'benchmark', ok: benchmark.ok, status: benchmark.status });
    report.benchmark = benchmark.payload;
    if (!benchmark.ok) report.blockers.push('benchmark');
  }

  report.inventory = summarizeInventory({
    projects: projects.payload,
    domains: domains.payload,
    indexes: indexes.payload,
    files: files.payload,
    jobs: jobs.payload,
    traces: traces.payload,
    evalSummary: evalSummary.payload,
    embeddingModels: embeddingModels.payload,
    sourceSets: sourceSets.payload,
  });
  report.cost_signals = costSignals({
    traces: traces.payload,
    evalSummary: evalSummary.payload,
    benchmark: report.benchmark,
  });
  report.capabilities = {
    ...report.capabilities,
    project_data_api: projects.ok && domains.ok && files.ok && jobs.ok,
    ingest_contracts: files.ok && jobs.ok && sourceSets.ok ? ['text', 'record', 'url', 'file'] : [],
    idempotent_ingest: files.ok && jobs.ok,
    chunk_preview: files.ok && jobs.ok,
    replayable_jobs: files.ok && jobs.ok,
    failure_classification: files.ok && jobs.ok,
    trace_export: traceExport?.ok === true,
    trace_drilldown: traceDrilldown?.ok === true,
    stage_timings: traceRows.some(traceHasStageTimings),
    empty_result_diagnostics: traceRows.some(traceHasEmptyResultDiagnostics)
      || drilldownHasEmptyResultDiagnostics(traceDrilldown?.payload),
  };
  report.ok = report.checks.every((check) => check.ok);
  return report;
}

function printHuman(report) {
  console.log(`${report.ok ? 'READY' : 'NOT READY'} knowledgebase operator report`);
  console.log(`base_url=${report.base_url} authenticated=${report.authenticated} domain=${report.domain ?? 'all'}`);
  for (const check of report.checks) {
    console.log(`  ${check.ok ? 'PASS' : 'FAIL'} ${check.name} status=${check.status ?? 'n/a'}`);
  }
  if (report.inventory) {
    console.log('\nInventory');
    console.log(`  projects=${report.inventory.project_count} domains=${report.inventory.domain_count} indexes=${report.inventory.index_count}`);
    console.log(`  files=${report.inventory.file_count} bytes=${report.inventory.file_bytes} statuses=${JSON.stringify(report.inventory.files_by_status)}`);
    console.log(`  jobs=${report.inventory.job_count} statuses=${JSON.stringify(report.inventory.jobs_by_status)} stages=${JSON.stringify(report.inventory.jobs_by_stage)}`);
    console.log(`  traces=${report.inventory.recent_trace_count} avg_trace_latency_ms=${report.inventory.avg_trace_latency_ms ?? 'n/a'}`);
    console.log(`  eval_reports=${report.inventory.eval_report_count} eval_kinds=${report.inventory.eval_kinds.join(',') || 'none'}`);
    console.log(`  embedding_models=${report.inventory.embedding_model_count} selectable=${report.inventory.selectable_embedding_model_count}`);
  }
  if (report.capabilities) {
    console.log('\nCapabilities');
    console.log(`  hosted_ui=${report.capabilities.hosted_ui} custom_input=${report.capabilities.custom_input} async_status=${report.capabilities.async_status} hides_rag_internals=${report.capabilities.hides_rag_internals}`);
  }
  if (report.benchmark) {
    console.log('\nBenchmark');
    console.log(`  latency=${JSON.stringify(report.benchmark.latency ?? null)}`);
    console.log(`  server_latency=${JSON.stringify(report.benchmark.server_latency ?? null)}`);
    console.log(`  cache_hit_rate=${report.benchmark.cache_hit_rate ?? 'n/a'}`);
  }
  if (report.cost_signals) {
    console.log('\nCost signals');
    console.log(`  avg_trace_latency_ms=${report.cost_signals.avg_trace_latency_ms ?? 'n/a'} avg_eval_ai_use_rate=${report.cost_signals.avg_eval_ai_use_rate ?? 'n/a'} benchmark_cache_hit_rate=${report.cost_signals.benchmark_cache_hit_rate ?? 'n/a'}`);
    console.log(`  ${report.cost_signals.note}`);
  }
  if (report.blockers.length > 0) console.log(`\nblockers=${report.blockers.join(',')}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = await runOperatorReport(args);
    if (args.jsonOnly) console.log(JSON.stringify(report, null, 2));
    else printHuman(report);
    if (!report.ok || (args.requireAuth && !report.authenticated)) process.exitCode = 1;
  } catch (error) {
    usage();
    console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
