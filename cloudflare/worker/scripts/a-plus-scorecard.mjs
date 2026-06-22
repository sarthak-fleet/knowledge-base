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
  - {"operator_report": {...}, "benchmarks": [{...}], "capabilities": {...}}

Options:
  --expected-deploy-fingerprint <value> Require operator report health to match this deploy fingerprint.
  --require-domain <domain>             Require operator report and domain benchmarks to match this domain.
  --require-benchmark-mode <mode>       Require lexical, semantic, or hybrid evidence. Repeatable.
  --require-benchmark-surface <surface> Require index, kb-search, or kb-query evidence. Repeatable.
  --require-eval-kind <kind>            Require query, search, parse, or other eval report kind. Repeatable.

The scorecard is read-only and deterministic. It grades evidence only; it does
not call the deployed Worker or spend AI/Vectorize requests.`);
}

function parseArgs(argv) {
  const out = {
    input: '',
    operatorReport: '',
    benchmarks: [],
    requireGrade: 'A',
    expectedDeployFingerprint: process.env.RAG_EXPECTED_DEPLOY_FINGERPRINT || '',
    requiredDomain: process.env.RAG_SCORECARD_DOMAIN || '',
    requiredBenchmarkModes: [],
    requiredBenchmarkSurfaces: [],
    requiredEvalKinds: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    const value = argv[i + 1];
    if (!value) throw new Error(`missing value for ${arg}`);
    i += 1;
    if (arg === '--input') out.input = value;
    else if (arg === '--operator-report') out.operatorReport = value;
    else if (arg === '--benchmark') out.benchmarks.push(value);
    else if (arg === '--require-grade') out.requireGrade = normalizeGrade(value);
    else if (arg === '--expected-deploy-fingerprint') out.expectedDeployFingerprint = value.trim();
    else if (arg === '--require-domain') out.requiredDomain = normalizeDomain(value);
    else if (arg === '--require-benchmark-mode') out.requiredBenchmarkModes.push(normalizeBenchmarkMode(value));
    else if (arg === '--require-benchmark-surface') out.requiredBenchmarkSurfaces.push(normalizeBenchmarkSurface(value));
    else if (arg === '--require-eval-kind') out.requiredEvalKinds.push(normalizeEvalKind(value));
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!out.input && !out.operatorReport && out.benchmarks.length === 0) {
    throw new Error('--input or --operator-report/--benchmark is required');
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

function normalizeEvidence(raw) {
  if (raw?.operator_report || raw?.operatorReport || raw?.benchmarks) {
    return {
      operatorReport: raw.operator_report ?? raw.operatorReport ?? null,
      benchmarks: asArray(raw.benchmarks),
      capabilities: raw.capabilities ?? {},
    };
  }
  if (raw?.inventory || raw?.checks || raw?.cost_signals) {
    return { operatorReport: raw, benchmarks: raw.benchmark ? [raw.benchmark] : [], capabilities: {} };
  }
  if (raw?.capabilities) {
    return { operatorReport: null, benchmarks: [], capabilities: raw.capabilities };
  }
  if (raw?.latency || raw?.server_latency || raw?.hit_rate !== undefined) {
    return { operatorReport: null, benchmarks: [raw], capabilities: {} };
  }
  return { operatorReport: null, benchmarks: [], capabilities: {} };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function loadScorecardEvidence(args) {
  if (!args.operatorReport && args.benchmarks.length === 0) return readJson(args.input);

  const base = args.input ? normalizeEvidence(await readJson(args.input)) : {
    operatorReport: null,
    benchmarks: [],
    capabilities: {},
  };
  const operatorReport = args.operatorReport
    ? await readJson(args.operatorReport)
    : base.operatorReport;
  const benchmarkFiles = await Promise.all(args.benchmarks.map((path) => readJson(path)));
  return {
    operator_report: operatorReport,
    benchmarks: [...base.benchmarks, ...benchmarkFiles],
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
    const missing = p95 === null && serverP95 === null;
    const aPlus = !missing
      && (p95 === null || p95 <= thresholds.aPlusP95Ms)
      && (serverP95 === null || serverP95 <= thresholds.aPlusServerP95Ms);
    const a = !missing
      && (p95 === null || p95 <= thresholds.aP95Ms)
      && (serverP95 === null || serverP95 <= thresholds.aServerP95Ms);
    return {
      mode,
      surface,
      grade: gradeCheck({ aPlus, a, missing }).grade,
      p95_ms: p95,
      server_p95_ms: serverP95,
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
  return {
    name: 'retrieval_performance',
    grade,
    ok: gradeAtLeast(grade, 'A') && missingModes.length === 0 && missingSurfaces.length === 0,
    blockers: [
      ...missingModes.map((mode) => `missing_${mode}_benchmark`),
      ...missingSurfaces.map((surface) => `missing_${surface}_benchmark`),
      ...belowABlockers,
    ],
    evidence: {
      benchmarks: rows,
      required_modes: requiredModes,
      required_surfaces: requiredSurfaces,
      missing_modes: missingModes,
      missing_surfaces: missingSurfaces,
    },
  };
}

function scoreQuality(operatorReport, benchmarks, requirements = {}) {
  const requiredEvalKinds = asArray(requirements.evalKinds).map(normalizeEvalKind);
  const evalKinds = asArray(operatorReport?.inventory?.eval_kinds)
    .map(normalizeEvalKind)
    .filter(Boolean);
  const missingEvalKinds = requiredEvalKinds.filter((kind) => !evalKinds.includes(kind));
  const hitRates = benchmarks
    .map((benchmark) => asNumber(benchmark?.hit_rate))
    .filter((value) => value !== null);
  const hitRate = hitRates.length ? Math.min(...hitRates) : null;
  const recentTraceCount = asNumber(operatorReport?.cost_signals?.recent_trace_count)
    ?? asNumber(operatorReport?.inventory?.recent_trace_count);
  const tracesWithCitations = asNumber(operatorReport?.cost_signals?.traces_with_citations);
  const citationRate = recentTraceCount && tracesWithCitations !== null
    ? tracesWithCitations / recentTraceCount
    : null;
  const evalReportCount = asNumber(operatorReport?.inventory?.eval_report_count);

  const hasHitEvidence = hitRate !== null;
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
        citation_rate: citationRate,
        eval_report_count: evalReportCount,
        eval_kinds: evalKinds,
        required_eval_kinds: requiredEvalKinds,
        missing_eval_kinds: missingEvalKinds,
      },
    };
  }

  const hasRequiredEvalKinds = missingEvalKinds.length === 0;
  const aPlus = hasRequiredEvalKinds
    && (hitRate === null || hitRate >= 0.92)
    && (citationRate === null || citationRate >= 0.95)
    && (evalReportCount === null || evalReportCount >= 1);
  const a = hasRequiredEvalKinds
    && (hitRate === null || hitRate >= 0.85)
    && (citationRate === null || citationRate >= 0.9)
    && (evalReportCount === null || evalReportCount >= 1);
  const result = gradeCheck({
    aPlus,
    a,
    evidence: {
      hit_rate: hitRate,
      citation_rate: citationRate,
      eval_report_count: evalReportCount,
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

function scoreObservability(operatorReport) {
  const inventory = operatorReport?.inventory;
  const recentTraceCount = asNumber(inventory?.recent_trace_count) ?? 0;
  const evalReportCount = asNumber(inventory?.eval_report_count) ?? 0;
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
    scoreScope(evidence.operatorReport, evidence.benchmarks, {
      domain: options.requiredDomain,
    }),
    scorePerformance(evidence.benchmarks, {
      modes: options.requiredBenchmarkModes,
      surfaces: options.requiredBenchmarkSurfaces,
    }),
    scoreQuality(evidence.operatorReport, evidence.benchmarks, {
      evalKinds: options.requiredEvalKinds,
    }),
    scoreIngestion(evidence.operatorReport),
    scoreObservability(evidence.operatorReport),
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
      expectedDeployFingerprint: args.expectedDeployFingerprint,
      requiredDomain: args.requiredDomain,
      requiredBenchmarkModes: args.requiredBenchmarkModes,
      requiredBenchmarkSurfaces: args.requiredBenchmarkSurfaces,
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
