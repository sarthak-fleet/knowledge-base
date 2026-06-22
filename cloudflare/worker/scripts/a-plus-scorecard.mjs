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

Input can be:
  - operator-report JSON
  - benchmark-rag JSON
  - {"operator_report": {...}, "benchmarks": [{...}], "capabilities": {...}}

The scorecard is read-only and deterministic. It grades evidence only; it does
not call the deployed Worker or spend AI/Vectorize requests.`);
}

function parseArgs(argv) {
  const out = {
    input: '',
    requireGrade: 'A',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (!value) throw new Error(`missing value for ${arg}`);
    i += 1;
    if (arg === '--input') out.input = value;
    else if (arg === '--require-grade') out.requireGrade = normalizeGrade(value);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!out.input) throw new Error('--input is required');
  return out;
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

function normalizeEvidence(raw) {
  if (raw?.operator_report || raw?.benchmarks || raw?.capabilities) {
    return {
      operatorReport: raw.operator_report ?? raw.operatorReport ?? null,
      benchmarks: asArray(raw.benchmarks),
      capabilities: raw.capabilities ?? {},
    };
  }
  if (raw?.inventory || raw?.checks || raw?.cost_signals) {
    return { operatorReport: raw, benchmarks: raw.benchmark ? [raw.benchmark] : [], capabilities: {} };
  }
  if (raw?.latency || raw?.server_latency || raw?.hit_rate !== undefined) {
    return { operatorReport: null, benchmarks: [raw], capabilities: {} };
  }
  return { operatorReport: null, benchmarks: [], capabilities: {} };
}

function scoreReliability(operatorReport) {
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
  const blockers = [...asArray(operatorReport.blockers), ...failedChecks];
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
    },
  });
  return { name: 'reliability', ...result, blockers };
}

function scorePerformance(benchmarks) {
  if (benchmarks.length === 0) {
    return {
      name: 'retrieval_performance',
      grade: 'C',
      ok: false,
      blockers: ['missing_benchmark'],
      evidence: {},
    };
  }
  const rows = benchmarks.map((benchmark) => {
    const mode = detectBenchmarkMode(benchmark);
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
      grade: gradeCheck({ aPlus, a, missing }).grade,
      p95_ms: p95,
      server_p95_ms: serverP95,
      thresholds,
    };
  });
  const grade = minGrade(rows.map((row) => row.grade));
  return {
    name: 'retrieval_performance',
    grade,
    ok: gradeAtLeast(grade, 'A'),
    blockers: rows.filter((row) => !gradeAtLeast(row.grade, 'A')).map((row) => `${row.mode}_benchmark_below_a`),
    evidence: { benchmarks: rows },
  };
}

function scoreQuality(operatorReport, benchmarks) {
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
      blockers: ['missing_quality_evidence'],
      evidence: { hit_rate: hitRate, citation_rate: citationRate, eval_report_count: evalReportCount },
    };
  }

  const aPlus = (hitRate === null || hitRate >= 0.92)
    && (citationRate === null || citationRate >= 0.95)
    && (evalReportCount === null || evalReportCount >= 1);
  const a = (hitRate === null || hitRate >= 0.85)
    && (citationRate === null || citationRate >= 0.9)
    && (evalReportCount === null || evalReportCount >= 1);
  const result = gradeCheck({
    aPlus,
    a,
    evidence: { hit_rate: hitRate, citation_rate: citationRate, eval_report_count: evalReportCount },
  });
  return {
    name: 'retrieval_quality',
    ...result,
    blockers: result.ok ? [] : ['quality_below_a'],
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
  const hostedUi = capabilities.hosted_ui === true || operatorReport?.checks?.some?.((check) => check?.name === 'hosted_ui' && check?.ok);
  const customInput = capabilities.custom_input === true;
  const asyncStatus = capabilities.async_status === true || (operatorReport?.inventory?.job_count ?? 0) > 0;
  const hidesRagInternals = capabilities.hides_rag_internals === true;
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
    scoreReliability(evidence.operatorReport),
    scorePerformance(evidence.benchmarks),
    scoreQuality(evidence.operatorReport, evidence.benchmarks),
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
    const input = JSON.parse(await readFile(args.input, 'utf8'));
    const scorecard = buildAPlusScorecard(input, { requireGrade: args.requireGrade });
    console.log(JSON.stringify(scorecard, null, 2));
    if (!scorecard.ok) process.exitCode = 1;
  } catch (error) {
    usage();
    console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

export { printHuman };
