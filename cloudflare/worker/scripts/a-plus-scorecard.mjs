#!/usr/bin/env node

import { readFile } from 'node:fs/promises';

const GRADE_RANK = {
  S: 5,
  'A+': 4,
  A: 3,
  B: 2,
  C: 1,
  F: 0,
};

const PERFORMANCE_THRESHOLDS = {
  lexical: {
    aPlusP95Ms: 300,
    aP95Ms: 500,
    aPlusServerP95Ms: 250,
    aServerP95Ms: 400,
  },
  hybrid: {
    aPlusP95Ms: 1000,
    aP95Ms: 1500,
    aPlusServerP95Ms: 800,
    aServerP95Ms: 1200,
  },
  semantic: {
    aPlusP95Ms: 2000,
    aP95Ms: 3000,
    aPlusServerP95Ms: 1500,
    aServerP95Ms: 2500,
  },
};

function usage() {
  console.error(`Usage:
  node scripts/a-plus-scorecard.mjs --input <operator-or-benchmark-report.json> [--require-grade A|A+|S]
  node scripts/a-plus-scorecard.mjs --operator-report <report.json> --benchmark <bench.json> [--benchmark <bench.json> ...]

Input can be:
  - operator-report JSON
  - benchmark-rag JSON
  - {"operator_report": {...}, "benchmarks": [{...}], "query_evals": [{...}], "readiness_reports": [{...}], "capabilities": {...}}

Options:
  --readiness-report <report.json>       Include deploy-readiness JSON evidence. Repeatable.
  --query-eval-report <report.json>      Include /v1/kb/evals/query JSON evidence. Repeatable.
  --require-readiness-report             Fail if no deploy-readiness report is provided.
  --expected-deploy-fingerprint <value> Require operator report health to match this deploy fingerprint.
  --require-domain <domain>             Require operator report and domain benchmarks to match this domain.
  --require-benchmark-mode <mode>       Require lexical, semantic, or hybrid evidence. Repeatable.
  --require-benchmark-surface <surface> Require index, kb-search, or kb-query evidence. Repeatable.
  --min-benchmark-repeat <n>            Require each benchmark report to have repeat >= n.
  --min-benchmark-samples <n>           Require each benchmark report to include at least n measured requests.
  --require-eval-kind <kind>            Require query, search, parse, or other eval report kind. Repeatable.

The scorecard is read-only and deterministic. It grades evidence only; it does
not call the deployed Worker or spend AI/Vectorize requests.`);
}

function parseArgs(argv) {
  const out = {
    input: '',
    operatorReport: '',
    benchmarks: [],
    readinessReports: [],
    queryEvalReports: [],
    requireReadinessReport: false,
    requireGrade: 'A',
    expectedDeployFingerprint: process.env.RAG_EXPECTED_DEPLOY_FINGERPRINT || '',
    requiredDomain: process.env.RAG_SCORECARD_DOMAIN || '',
    requiredBenchmarkModes: [],
    requiredBenchmarkSurfaces: [],
    minBenchmarkRepeat: 0,
    minBenchmarkSamples: 0,
    requiredEvalKinds: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--require-readiness-report') {
      out.requireReadinessReport = true;
      continue;
    }
    const value = argv[i + 1];
    if (!value) throw new Error(`missing value for ${arg}`);
    i += 1;
    if (arg === '--input') out.input = value;
    else if (arg === '--operator-report') out.operatorReport = value;
    else if (arg === '--benchmark') out.benchmarks.push(value);
    else if (arg === '--readiness-report') out.readinessReports.push(value);
    else if (arg === '--query-eval-report') out.queryEvalReports.push(value);
    else if (arg === '--require-grade') out.requireGrade = normalizeGrade(value);
    else if (arg === '--expected-deploy-fingerprint') out.expectedDeployFingerprint = value.trim();
    else if (arg === '--require-domain') out.requiredDomain = normalizeDomain(value);
    else if (arg === '--require-benchmark-mode') out.requiredBenchmarkModes.push(normalizeBenchmarkMode(value));
    else if (arg === '--require-benchmark-surface') out.requiredBenchmarkSurfaces.push(normalizeBenchmarkSurface(value));
    else if (arg === '--min-benchmark-repeat') out.minBenchmarkRepeat = parseNonNegativeInteger(value, arg);
    else if (arg === '--min-benchmark-samples') out.minBenchmarkSamples = parseNonNegativeInteger(value, arg);
    else if (arg === '--require-eval-kind') out.requiredEvalKinds.push(normalizeEvalKind(value));
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!out.input && !out.operatorReport && out.benchmarks.length === 0 && out.readinessReports.length === 0 && out.queryEvalReports.length === 0) {
    throw new Error('--input, --operator-report/--benchmark, --readiness-report, or --query-eval-report is required');
  }
  return out;
}

function normalizeDomain(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeEvalKind(value) {
  const kind = String(value || '').trim().toLowerCase();
  if (!kind) throw new Error(`unsupported eval kind: ${value}`);
  return kind;
}

function parseNonNegativeInteger(value, label) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0 || String(parsed) !== String(value).trim()) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function normalizeBenchmarkMode(value) {
  const mode = String(value || '').trim();
  if (!PERFORMANCE_THRESHOLDS[mode]) throw new Error(`unsupported benchmark mode: ${value}`);
  return mode;
}

function normalizeBenchmarkSurface(value) {
  const surface = String(value || '').trim();
  if (!['index', 'kb-search', 'kb-query'].includes(surface)) {
    throw new Error(`unsupported benchmark surface: ${value}`);
  }
  return surface;
}

function normalizeGrade(value) {
  const grade = String(value || '').toUpperCase();
  if (!(grade in GRADE_RANK)) throw new Error(`unsupported grade: ${value}`);
  return grade;
}

function minGrade(grades) {
  return grades.reduce((min, grade) => (GRADE_RANK[grade] < GRADE_RANK[min] ? grade : min), 'S');
}

function gradeAtLeast(grade, required) {
  return GRADE_RANK[grade] >= GRADE_RANK[required];
}

function gradeCheck({ aPlus, a, evidence, missing = false }) {
  if (missing) return { grade: 'C', ok: false, evidence };
  if (aPlus) return { grade: 'A+', ok: true, evidence };
  if (a) return { grade: 'A', ok: true, evidence };
  return { grade: 'B', ok: false, evidence };
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function detectBenchmarkMode(benchmark) {
  const explicit = benchmark?.mode ?? benchmark?.query_mode ?? benchmark?.retrieval_mode;
  if (explicit && PERFORMANCE_THRESHOLDS[String(explicit)]) return String(explicit);

  const retrievals = new Set(
    asArray(benchmark?.measurements)
      .map((row) => row?.timing?.retrieval)
      .filter(Boolean),
  );
  if ([...retrievals].some((value) => String(value).includes('hybrid'))) return 'hybrid';
  if ([...retrievals].some((value) => String(value).includes('lexical'))) return 'lexical';
  return 'semantic';
}

function detectBenchmarkSurface(benchmark) {
  const surface = benchmark?.surface ?? benchmark?.query_surface;
  if (surface && ['index', 'kb-search', 'kb-query'].includes(String(surface))) return String(surface);
  return 'index';
}

function benchmarkSampleCount(benchmark) {
  const queries = asArray(benchmark?.queries);
  if (queries.length > 0) return queries.length;
  const measurements = asArray(benchmark?.measurements);
  if (measurements.length > 0) return measurements.length;
  const samples = asArray(benchmark?.samples);
  if (samples.length > 0) return samples.length;
  return null;
}

function normalizeEvidence(raw) {
  if (raw?.operator_report || raw?.operatorReport || raw?.benchmarks || raw?.readiness_reports || raw?.readinessReports || raw?.readiness_report || raw?.readinessReport || raw?.query_evals || raw?.queryEvals || raw?.query_eval || raw?.queryEval) {
    return {
      operatorReport: raw.operator_report ?? raw.operatorReport ?? null,
      benchmarks: asArray(raw.benchmarks),
      queryEvals: [
        ...asArray(raw.query_evals),
        ...asArray(raw.queryEvals),
        ...(raw.query_eval ? [raw.query_eval] : []),
        ...(raw.queryEval ? [raw.queryEval] : []),
      ],
      readinessReports: [
        ...asArray(raw.readiness_reports),
        ...asArray(raw.readinessReports),
        ...(raw.readiness_report ? [raw.readiness_report] : []),
        ...(raw.readinessReport ? [raw.readinessReport] : []),
      ],
      capabilities: raw.capabilities ?? {},
    };
  }
  if (raw?.inventory || raw?.checks || raw?.cost_signals) {
    return { operatorReport: raw, benchmarks: raw.benchmark ? [raw.benchmark] : [], queryEvals: [], readinessReports: [], capabilities: {} };
  }
  if (raw?.capabilities) {
    return { operatorReport: null, benchmarks: [], queryEvals: [], readinessReports: [], capabilities: raw.capabilities };
  }
  if (raw?.latency || raw?.server_latency || raw?.hit_rate !== undefined) {
    return { operatorReport: null, benchmarks: [raw], queryEvals: [], readinessReports: [], capabilities: {} };
  }
  return { operatorReport: null, benchmarks: [], queryEvals: [], readinessReports: [], capabilities: {} };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function loadScorecardEvidence(args) {
  if (!args.operatorReport && args.benchmarks.length === 0 && args.readinessReports.length === 0 && args.queryEvalReports.length === 0) return readJson(args.input);

  const base = args.input ? normalizeEvidence(await readJson(args.input)) : {
    operatorReport: null,
    benchmarks: [],
    queryEvals: [],
    readinessReports: [],
    capabilities: {},
  };
  const operatorReport = args.operatorReport
    ? await readJson(args.operatorReport)
    : base.operatorReport;
  const benchmarkFiles = await Promise.all(args.benchmarks.map((path) => readJson(path)));
  const readinessFiles = await Promise.all(args.readinessReports.map((path) => readJson(path)));
  const queryEvalFiles = await Promise.all(args.queryEvalReports.map((path) => readJson(path)));
  return {
    operator_report: operatorReport,
    benchmarks: [...base.benchmarks, ...benchmarkFiles],
    query_evals: [...base.queryEvals, ...queryEvalFiles],
    readiness_reports: [...base.readinessReports, ...readinessFiles],
    capabilities: base.capabilities,
  };
}

function scoreReliability(operatorReport, requirements = {}) {
  if (!operatorReport) {
    return {
      name: 'reliability',
      grade: 'C',
      ok: false,
      blockers: ['missing_operator_report'],
      evidence: {},
    };
  }
  const checks = asArray(operatorReport.checks);
  const failedChecks = checks.filter((check) => check?.ok !== true).map((check) => check?.name ?? 'unknown');
  const healthCheck = checks.find((check) => check?.name === 'public_health');
  const deployFingerprint = typeof healthCheck?.deploy_fingerprint === 'string'
    ? healthCheck.deploy_fingerprint
    : typeof operatorReport.deploy_fingerprint === 'string'
      ? operatorReport.deploy_fingerprint
      : null;
  const expectedDeployFingerprint = typeof requirements.expectedDeployFingerprint === 'string'
    ? requirements.expectedDeployFingerprint.trim()
    : '';
  const fingerprintBlockers = expectedDeployFingerprint
    ? deployFingerprint === expectedDeployFingerprint
      ? []
      : [deployFingerprint ? 'stale_deploy_fingerprint' : 'missing_deploy_fingerprint']
    : [];
  const blockers = [...asArray(operatorReport.blockers), ...failedChecks, ...fingerprintBlockers];
  const authenticated = operatorReport.authenticated === true;
  const a = operatorReport.ok === true && blockers.length === 0;
  const aPlus = a && authenticated && checks.length >= 2;
  const result = gradeCheck({
    aPlus,
    a,
    evidence: {
      authenticated,
      check_count: checks.length,
      failed_checks: failedChecks,
      blocker_count: blockers.length,
      deploy_fingerprint: deployFingerprint,
      expected_deploy_fingerprint: expectedDeployFingerprint || null,
    },
  });
  return { name: 'reliability', ...result, blockers };
}

function scoreDeployReadiness(readinessReports, requirements = {}) {
  const requireReport = requirements.requireReport === true;
  if (readinessReports.length === 0) {
    return {
      name: 'deploy_readiness',
      grade: requireReport ? 'C' : 'A+',
      ok: !requireReport,
      blockers: requireReport ? ['missing_deploy_readiness_report'] : [],
      evidence: { required: requireReport, report_count: 0, reports: [] },
    };
  }

  const reports = readinessReports.map((report) => {
    const checks = asArray(report?.checks);
    const failedChecks = checks
      .filter((check) => check?.ok !== true)
      .map((check) => check?.name ?? 'unknown');
    return {
      ok: report?.ok === true && failedChecks.length === 0,
      base_url: report?.base_url ?? null,
      check_count: checks.length,
      failed_checks: failedChecks,
      deploy_fingerprint: (
        checks.find((check) => check?.name === 'deployed-worker-fingerprint' && typeof check?.deploy_fingerprint === 'string')
        ?? checks.find((check) => typeof check?.deploy_fingerprint === 'string')
      )?.deploy_fingerprint ?? null,
    };
  });
  const failedReports = reports.filter((report) => !report.ok);
  const blockers = failedReports.flatMap((report) => (
    report.failed_checks.length > 0
      ? report.failed_checks.map((name) => `readiness_${name}`)
      : ['deploy_readiness_failed']
  ));
  return {
    name: 'deploy_readiness',
    grade: failedReports.length === 0 ? 'A+' : 'C',
    ok: failedReports.length === 0,
    blockers,
    evidence: {
      required: requireReport,
      report_count: readinessReports.length,
      reports,
    },
  };
}

function scoreScope(operatorReport, benchmarks, requirements = {}) {
  const requiredDomain = normalizeDomain(requirements.domain);
  const operatorDomain = normalizeDomain(operatorReport?.domain);
  const domainBenchmarks = benchmarks
    .map((benchmark) => ({
      surface: detectBenchmarkSurface(benchmark),
      domain: normalizeDomain(benchmark?.domain),
    }))
    .filter((benchmark) => benchmark.surface !== 'index');
  if (!requiredDomain) {
    return {
      name: 'evidence_scope',
      grade: 'A+',
      ok: true,
      blockers: [],
      evidence: {
        required_domain: null,
        operator_domain: operatorDomain || null,
        benchmark_domains: domainBenchmarks,
      },
    };
  }

  const blockers = [];
  if (!operatorDomain) blockers.push('missing_operator_domain_scope');
  else if (operatorDomain !== requiredDomain) blockers.push('operator_domain_scope_mismatch');

  const missingBenchmarkDomains = domainBenchmarks
    .filter((benchmark) => !benchmark.domain)
    .map((benchmark) => benchmark.surface);
  const mismatchedBenchmarkDomains = domainBenchmarks
    .filter((benchmark) => benchmark.domain && benchmark.domain !== requiredDomain)
    .map((benchmark) => `${benchmark.surface}:${benchmark.domain}`);
  if (missingBenchmarkDomains.length > 0) blockers.push('missing_benchmark_domain_scope');
  if (mismatchedBenchmarkDomains.length > 0) blockers.push('benchmark_domain_scope_mismatch');

  return {
    name: 'evidence_scope',
    grade: blockers.length === 0 ? 'A+' : 'C',
    ok: blockers.length === 0,
    blockers,
    evidence: {
      required_domain: requiredDomain,
      operator_domain: operatorDomain || null,
      benchmark_domains: domainBenchmarks,
      missing_benchmark_domain_surfaces: missingBenchmarkDomains,
      mismatched_benchmark_domains: mismatchedBenchmarkDomains,
    },
  };
}

function scorePerformance(benchmarks, requirements = {}) {
  const requiredModes = asArray(requirements.modes).map(normalizeBenchmarkMode);
  const requiredSurfaces = asArray(requirements.surfaces).map(normalizeBenchmarkSurface);
  const minBenchmarkRepeat = asNumber(requirements.minRepeat) ?? 0;
  const minBenchmarkSamples = asNumber(requirements.minSamples) ?? 0;
  if (benchmarks.length === 0) {
    return {
      name: 'retrieval_performance',
      grade: 'C',
      ok: false,
      blockers: [
        'missing_benchmark',
        ...requiredModes.map((mode) => `missing_${mode}_benchmark`),
        ...requiredSurfaces.map((surface) => `missing_${surface}_benchmark`),
      ],
      evidence: {
        required_modes: requiredModes,
        required_surfaces: requiredSurfaces,
        min_benchmark_repeat: minBenchmarkRepeat,
        min_benchmark_samples: minBenchmarkSamples,
        missing_modes: requiredModes,
        missing_surfaces: requiredSurfaces,
      },
    };
  }
  const rows = benchmarks.map((benchmark) => {
    const mode = detectBenchmarkMode(benchmark);
    const surface = detectBenchmarkSurface(benchmark);
    const thresholds = PERFORMANCE_THRESHOLDS[mode];
    const p95 = asNumber(benchmark?.latency?.p95_ms);
    const serverP95 = asNumber(benchmark?.server_latency?.p95_ms);
    const repeat = asNumber(benchmark?.repeat);
    const sampleCount = benchmarkSampleCount(benchmark);
    const missing = p95 === null && serverP95 === null;
    const tooFewRepeats = minBenchmarkRepeat > 0 && (repeat === null || repeat < minBenchmarkRepeat);
    const tooFewSamples = minBenchmarkSamples > 0 && (sampleCount === null || sampleCount < minBenchmarkSamples);
    const aPlus = !missing
      && !tooFewRepeats
      && !tooFewSamples
      && (p95 === null || p95 <= thresholds.aPlusP95Ms)
      && (serverP95 === null || serverP95 <= thresholds.aPlusServerP95Ms);
    const a = !missing
      && !tooFewRepeats
      && !tooFewSamples
      && (p95 === null || p95 <= thresholds.aP95Ms)
      && (serverP95 === null || serverP95 <= thresholds.aServerP95Ms);
    return {
      mode,
      surface,
      grade: gradeCheck({ aPlus, a, missing }).grade,
      p95_ms: p95,
      server_p95_ms: serverP95,
      repeat,
      sample_count: sampleCount,
      min_repeat: minBenchmarkRepeat,
      min_samples: minBenchmarkSamples,
      too_few_repeats: tooFewRepeats,
      too_few_samples: tooFewSamples,
      thresholds,
    };
  });
  const missingModes = requiredModes.filter((mode) => !rows.some((row) => row.mode === mode));
  const missingSurfaces = requiredSurfaces.filter((surface) => !rows.some((row) => row.surface === surface));
  const grade = missingModes.length > 0 || missingSurfaces.length > 0
    ? 'C'
    : minGrade(rows.map((row) => row.grade));
  const belowABlockers = rows
    .filter((row) => !gradeAtLeast(row.grade, 'A'))
    .map((row) => `${row.surface}_${row.mode}_benchmark_below_a`);
  const sampleBlockers = rows.flatMap((row) => [
    ...(row.too_few_repeats ? [`${row.surface}_${row.mode}_benchmark_repeat_below_min`] : []),
    ...(row.too_few_samples ? [`${row.surface}_${row.mode}_benchmark_samples_below_min`] : []),
  ]);
  return {
    name: 'retrieval_performance',
    grade,
    ok: gradeAtLeast(grade, 'A') && missingModes.length === 0 && missingSurfaces.length === 0,
    blockers: [
      ...missingModes.map((mode) => `missing_${mode}_benchmark`),
      ...missingSurfaces.map((surface) => `missing_${surface}_benchmark`),
      ...sampleBlockers,
      ...belowABlockers,
    ],
    evidence: {
      benchmarks: rows,
      required_modes: requiredModes,
      required_surfaces: requiredSurfaces,
      min_benchmark_repeat: minBenchmarkRepeat,
      min_benchmark_samples: minBenchmarkSamples,
      missing_modes: missingModes,
      missing_surfaces: missingSurfaces,
    },
  };
}

function scoreQuality(operatorReport, benchmarks, queryEvals, requirements = {}) {
  const requiredEvalKinds = asArray(requirements.evalKinds).map(normalizeEvalKind);
  const evalKinds = [
    ...asArray(operatorReport?.inventory?.eval_kinds).map(normalizeEvalKind).filter(Boolean),
    ...(queryEvals.length > 0 ? ['query'] : []),
  ].filter((kind, index, values) => values.indexOf(kind) === index);
  const missingEvalKinds = requiredEvalKinds.filter((kind) => !evalKinds.includes(kind));
  const hitRates = benchmarks
    .map((benchmark) => asNumber(benchmark?.hit_rate))
    .filter((value) => value !== null);
  const queryEvalHitRates = queryEvals
    .map((report) => asNumber(report?.hit_rate))
    .filter((value) => value !== null);
  const hitRate = hitRates.length ? Math.min(...hitRates) : null;
  const queryEvalHitRate = queryEvalHitRates.length ? Math.min(...queryEvalHitRates) : null;
  const recentTraceCount = asNumber(operatorReport?.cost_signals?.recent_trace_count)
    ?? asNumber(operatorReport?.inventory?.recent_trace_count);
  const tracesWithCitations = asNumber(operatorReport?.cost_signals?.traces_with_citations);
  const traceCitationRate = recentTraceCount && tracesWithCitations !== null
    ? tracesWithCitations / recentTraceCount
    : null;
  const queryEvalCitationRates = queryEvals
    .map((report) => asNumber(report?.citation_rate))
    .filter((value) => value !== null);
  const queryEvalCitationRate = queryEvalCitationRates.length ? Math.min(...queryEvalCitationRates) : null;
  const citationRate = queryEvalCitationRate ?? traceCitationRate;
  const evalReportCount = (asNumber(operatorReport?.inventory?.eval_report_count) ?? 0) + queryEvals.length;

  const hasHitEvidence = hitRate !== null || queryEvalHitRate !== null;
  const hasCitationEvidence = citationRate !== null || (evalReportCount ?? 0) > 0;
  if (!hasHitEvidence && !hasCitationEvidence) {
    return {
      name: 'retrieval_quality',
      grade: 'C',
      ok: false,
      blockers: [
        'missing_quality_evidence',
        ...missingEvalKinds.map((kind) => `missing_${kind}_eval_report`),
      ],
      evidence: {
        hit_rate: hitRate,
        query_eval_hit_rate: queryEvalHitRate,
        citation_rate: citationRate,
        query_eval_citation_rate: queryEvalCitationRate,
        eval_report_count: evalReportCount,
        query_eval_count: queryEvals.length,
        eval_kinds: evalKinds,
        required_eval_kinds: requiredEvalKinds,
        missing_eval_kinds: missingEvalKinds,
      },
    };
  }

  const hasRequiredEvalKinds = missingEvalKinds.length === 0;
  const aPlus = hasRequiredEvalKinds
    && (hitRate === null || hitRate >= 0.92)
    && (queryEvalHitRate === null || queryEvalHitRate >= 0.92)
    && (citationRate === null || citationRate >= 0.95)
    && (evalReportCount === null || evalReportCount >= 1);
  const a = hasRequiredEvalKinds
    && (hitRate === null || hitRate >= 0.85)
    && (queryEvalHitRate === null || queryEvalHitRate >= 0.85)
    && (citationRate === null || citationRate >= 0.9)
    && (evalReportCount === null || evalReportCount >= 1);
  const result = gradeCheck({
    aPlus,
    a,
    evidence: {
      hit_rate: hitRate,
      query_eval_hit_rate: queryEvalHitRate,
      citation_rate: citationRate,
      query_eval_citation_rate: queryEvalCitationRate,
      eval_report_count: evalReportCount,
      query_eval_count: queryEvals.length,
      eval_kinds: evalKinds,
      required_eval_kinds: requiredEvalKinds,
      missing_eval_kinds: missingEvalKinds,
    },
  });
  return {
    name: 'retrieval_quality',
    ...result,
    blockers: result.ok
      ? []
      : [
        ...missingEvalKinds.map((kind) => `missing_${kind}_eval_report`),
        'quality_below_a',
      ],
  };
}

function scoreIngestion(operatorReport) {
  const inventory = operatorReport?.inventory;
  if (!inventory) {
    return {
      name: 'ingestion_reliability',
      grade: 'C',
      ok: false,
      blockers: ['missing_inventory'],
      evidence: {},
    };
  }
  const fileCount = asNumber(inventory.file_count) ?? 0;
  const jobCount = asNumber(inventory.job_count) ?? 0;
  const filesByStatus = inventory.files_by_status ?? {};
  const jobsByStatus = inventory.jobs_by_status ?? {};
  const failedFiles = Number(filesByStatus.failed ?? filesByStatus.error ?? 0);
  const failedJobs = Number(jobsByStatus.failed ?? jobsByStatus.error ?? 0);
  const readyFiles = Number(filesByStatus.ready ?? 0);
  const hasEvidence = fileCount > 0 || jobCount > 0;
  const aPlus = hasEvidence && failedFiles === 0 && failedJobs === 0 && readyFiles === fileCount && (inventory.source_set_count ?? 0) > 0;
  const a = hasEvidence && failedFiles === 0 && failedJobs === 0;
  const result = gradeCheck({
    aPlus,
    a,
    missing: !hasEvidence,
    evidence: {
      file_count: fileCount,
      job_count: jobCount,
      source_set_count: inventory.source_set_count ?? 0,
      failed_files: failedFiles,
      failed_jobs: failedJobs,
      ready_files: readyFiles,
    },
  });
  return {
    name: 'ingestion_reliability',
    ...result,
    blockers: result.ok ? [] : ['ingestion_evidence_missing_or_failed'],
  };
}

function scoreObservability(operatorReport, queryEvals = []) {
  const inventory = operatorReport?.inventory;
  const recentTraceCount = asNumber(inventory?.recent_trace_count) ?? 0;
  const evalReportCount = (asNumber(inventory?.eval_report_count) ?? 0) + queryEvals.length;
  const avgTraceLatencyMs = asNumber(inventory?.avg_trace_latency_ms);
  const aPlus = recentTraceCount >= 10 && evalReportCount >= 1 && (avgTraceLatencyMs === null || avgTraceLatencyMs <= 1000);
  const a = recentTraceCount >= 1 && evalReportCount >= 1;
  const result = gradeCheck({
    aPlus,
    a,
    missing: !inventory,
    evidence: {
      recent_trace_count: recentTraceCount,
      eval_report_count: evalReportCount,
      query_eval_count: queryEvals.length,
      avg_trace_latency_ms: avgTraceLatencyMs,
    },
  });
  return {
    name: 'observability',
    ...result,
    blockers: result.ok ? [] : ['missing_traces_or_eval_reports'],
  };
}

function scoreEaseOfUse(operatorReport, capabilities = {}) {
  const reported = operatorReport?.capabilities ?? {};
  const hostedUi = capabilities.hosted_ui === true
    || reported.hosted_ui === true
    || operatorReport?.checks?.some?.((check) => check?.name === 'hosted_ui' && check?.ok);
  const customInput = capabilities.custom_input === true || reported.custom_input === true;
  const asyncStatus = capabilities.async_status === true
    || reported.async_status === true
    || (operatorReport?.inventory?.job_count ?? 0) > 0;
  const hidesRagInternals = capabilities.hides_rag_internals === true || reported.hides_rag_internals === true;
  const aPlus = hostedUi && customInput && asyncStatus && hidesRagInternals;
  const a = hostedUi && customInput && asyncStatus;
  const result = gradeCheck({
    aPlus,
    a,
    evidence: {
      hosted_ui: Boolean(hostedUi),
      custom_input: Boolean(customInput),
      async_status: Boolean(asyncStatus),
      hides_rag_internals: Boolean(hidesRagInternals),
    },
  });
  return {
    name: 'ease_of_use',
    ...result,
    blockers: result.ok ? [] : ['missing_ease_of_use_evidence'],
  };
}

export function buildAPlusScorecard(rawEvidence, options = {}) {
  const requiredGrade = normalizeGrade(options.requireGrade ?? 'A');
  const evidence = normalizeEvidence(rawEvidence);
  const categories = [
    scoreReliability(evidence.operatorReport, {
      expectedDeployFingerprint: options.expectedDeployFingerprint,
    }),
    scoreDeployReadiness(evidence.readinessReports, {
      requireReport: options.requireReadinessReport,
    }),
    scoreScope(evidence.operatorReport, evidence.benchmarks, {
      domain: options.requiredDomain,
    }),
    scorePerformance(evidence.benchmarks, {
      modes: options.requiredBenchmarkModes,
      surfaces: options.requiredBenchmarkSurfaces,
      minRepeat: options.minBenchmarkRepeat,
      minSamples: options.minBenchmarkSamples,
    }),
    scoreQuality(evidence.operatorReport, evidence.benchmarks, evidence.queryEvals, {
      evalKinds: options.requiredEvalKinds,
    }),
    scoreIngestion(evidence.operatorReport),
    scoreObservability(evidence.operatorReport, evidence.queryEvals),
    scoreEaseOfUse(evidence.operatorReport, evidence.capabilities),
  ];
  const overallGrade = minGrade(categories.map((category) => category.grade));
  const blockers = categories.flatMap((category) => category.blockers ?? []);
  return {
    ok: gradeAtLeast(overallGrade, requiredGrade) && blockers.length === 0,
    required_grade: requiredGrade,
    overall_grade: overallGrade,
    categories,
    blockers,
    note: 'A/A+ is evidence-gated: missing benchmarks, evals, traces, or ingestion status lower the grade instead of assuming success.',
  };
}

function printHuman(scorecard) {
  console.log(`${scorecard.ok ? 'READY' : 'NOT READY'} knowledgebase A/A+ scorecard`);
  console.log(`overall=${scorecard.overall_grade} required=${scorecard.required_grade}`);
  for (const category of scorecard.categories) {
    console.log(`  ${category.ok ? 'PASS' : 'CHECK'} ${category.name} grade=${category.grade}`);
  }
  if (scorecard.blockers.length > 0) console.log(`blockers=${scorecard.blockers.join(',')}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const input = await loadScorecardEvidence(args);
    const scorecard = buildAPlusScorecard(input, {
      requireGrade: args.requireGrade,
      requireReadinessReport: args.requireReadinessReport,
      expectedDeployFingerprint: args.expectedDeployFingerprint,
      requiredDomain: args.requiredDomain,
      requiredBenchmarkModes: args.requiredBenchmarkModes,
      requiredBenchmarkSurfaces: args.requiredBenchmarkSurfaces,
      minBenchmarkRepeat: args.minBenchmarkRepeat,
      minBenchmarkSamples: args.minBenchmarkSamples,
      requiredEvalKinds: args.requiredEvalKinds,
    });
    console.log(JSON.stringify(scorecard, null, 2));
    if (!scorecard.ok) process.exitCode = 1;
  } catch (error) {
    usage();
    console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

export { loadScorecardEvidence, parseArgs, printHuman };
