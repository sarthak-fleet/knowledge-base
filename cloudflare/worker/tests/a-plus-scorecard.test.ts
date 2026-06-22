import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAPlusScorecard, loadScorecardEvidence, parseArgs } from '../scripts/a-plus-scorecard.mjs';

const aPlusOperatorReport = {
  ok: true,
  authenticated: true,
  domain: 'demo.example',
  checks: [
    { name: 'public_health', ok: true, status: 200, deploy_fingerprint: 'current-fp' },
    { name: 'auth_boundary', ok: true, status: 401 },
    { name: 'hosted_ui', ok: true, status: 200 },
  ],
  blockers: [],
  inventory: {
    file_count: 3,
    files_by_status: { ready: 3 },
    job_count: 2,
    jobs_by_status: { complete: 2 },
    source_set_count: 1,
    recent_trace_count: 12,
    eval_report_count: 2,
    eval_kinds: ['query', 'search'],
    avg_trace_latency_ms: 420,
  },
  capabilities: {
    hosted_ui: true,
    custom_input: true,
    async_status: true,
    hides_rag_internals: true,
  },
  cost_signals: {
    recent_trace_count: 12,
    traces_with_citations: 12,
  },
};

const aPlusReadinessReport = {
  ok: true,
  base_url: 'https://knowledgebase.example.workers.dev',
  checks: [
    {
      name: 'public-health',
      ok: true,
      status: 200,
      deploy_fingerprint: 'current-fp',
    },
    {
      name: 'deployed-worker-fingerprint',
      ok: true,
      deploy_fingerprint: 'current-fp',
      expected_deploy_fingerprint: 'current-fp',
    },
    {
      name: 'protected-indexes-require-auth',
      ok: true,
      status: 401,
    },
  ],
};

const aPlusQueryEvalReport = {
  report_id: 'eval-query-1',
  domain: 'demo.example',
  n: 2,
  hit_rate: 0.95,
  citation_rate: 1,
  ai_use_rate: 0,
  rows: [
    { id: 'q1', hit: true, cited: true },
    { id: 'q2', hit: true, cited: true },
  ],
};

describe('a-plus-scorecard', () => {
  it('accepts the pnpm run argument separator', () => {
    expect(parseArgs([
      '--',
      '--input',
      '/tmp/report.json',
      '--readiness-report',
      '/tmp/readiness.json',
      '--query-eval-report',
      '/tmp/query-eval.json',
      '--require-readiness-report',
      '--require-grade',
      'A+',
      '--require-domain',
      'Demo.Example',
      '--require-benchmark-mode',
      'lexical',
      '--require-benchmark-surface',
      'kb-query',
      '--min-benchmark-repeat',
      '5',
      '--min-benchmark-samples',
      '10',
      '--min-query-eval-rows',
      '2',
      '--require-eval-kind',
      'query',
    ])).toEqual({
      input: '/tmp/report.json',
      operatorReport: '',
      benchmarks: [],
      readinessReports: ['/tmp/readiness.json'],
      queryEvalReports: ['/tmp/query-eval.json'],
      requireReadinessReport: true,
      requireGrade: 'A+',
      expectedDeployFingerprint: '',
      requiredDomain: 'demo.example',
      requiredBenchmarkModes: ['lexical'],
      requiredBenchmarkSurfaces: ['kb-query'],
      minBenchmarkRepeat: 5,
      minBenchmarkSamples: 10,
      minQueryEvalRows: 2,
      requiredEvalKinds: ['query'],
    });
  });

  it('loads an operator report with repeated benchmark files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kb-scorecard-'));
    try {
      const operatorPath = join(dir, 'operator.json');
      const readinessPath = join(dir, 'readiness.json');
      const queryEvalPath = join(dir, 'query-eval.json');
      const lexicalPath = join(dir, 'lexical.json');
      const semanticPath = join(dir, 'semantic.json');
      await writeFile(operatorPath, JSON.stringify(aPlusOperatorReport));
      await writeFile(readinessPath, JSON.stringify(aPlusReadinessReport));
      await writeFile(queryEvalPath, JSON.stringify(aPlusQueryEvalReport));
      await writeFile(lexicalPath, JSON.stringify({ mode: 'lexical', hit_rate: 0.96, latency: { p95_ms: 120 } }));
      await writeFile(semanticPath, JSON.stringify({ mode: 'semantic', hit_rate: 0.93, latency: { p95_ms: 1100 } }));

      const evidence = await loadScorecardEvidence(parseArgs([
        '--operator-report',
        operatorPath,
        '--readiness-report',
        readinessPath,
        '--query-eval-report',
        queryEvalPath,
        '--benchmark',
        lexicalPath,
        '--benchmark',
        semanticPath,
      ]));

      expect(evidence).toMatchObject({
        operator_report: { ok: true },
        readiness_reports: [{ ok: true }],
        query_evals: [{ hit_rate: 0.95 }],
        benchmarks: [
          { mode: 'lexical', hit_rate: 0.96 },
          { mode: 'semantic', hit_rate: 0.93 },
        ],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('grades complete fast evidence as A+', () => {
    const scorecard = buildAPlusScorecard({
      operator_report: aPlusOperatorReport,
      readiness_reports: [aPlusReadinessReport],
      query_evals: [aPlusQueryEvalReport],
      benchmarks: [
        {
          mode: 'lexical',
          hit_rate: 0.98,
          latency: { p95_ms: 180 },
          server_latency: { p95_ms: 140 },
        },
        {
          mode: 'semantic',
          hit_rate: 0.93,
          latency: { p95_ms: 1300 },
          server_latency: { p95_ms: 980 },
        },
      ],
    }, { requireGrade: 'A+', requireReadinessReport: true });

    expect(scorecard.ok).toBe(true);
    expect(scorecard.overall_grade).toBe('A+');
    expect(scorecard.blockers).toEqual([]);
  });

  it('fails when deploy-readiness evidence is required but missing', () => {
    const scorecard = buildAPlusScorecard({
      operator_report: aPlusOperatorReport,
      benchmarks: [
        {
          mode: 'semantic',
          hit_rate: 0.94,
          latency: { p95_ms: 1200 },
          server_latency: { p95_ms: 900 },
        },
      ],
    }, { requireGrade: 'A', requireReadinessReport: true });

    expect(scorecard.ok).toBe(false);
    expect(scorecard.blockers).toContain('missing_deploy_readiness_report');
    expect(scorecard.categories.find((category) => category.name === 'deploy_readiness'))
      .toMatchObject({ grade: 'C', ok: false });
  });

  it('fails when deploy-readiness reports failed checks', () => {
    const scorecard = buildAPlusScorecard({
      operator_report: aPlusOperatorReport,
      readiness_reports: [
        {
          ...aPlusReadinessReport,
          ok: false,
          checks: [
            aPlusReadinessReport.checks[0],
            {
              name: 'deployed-worker-fingerprint',
              ok: false,
              deploy_fingerprint: 'old-fp',
              expected_deploy_fingerprint: 'current-fp',
            },
          ],
        },
      ],
      benchmarks: [
        {
          mode: 'semantic',
          hit_rate: 0.94,
          latency: { p95_ms: 1200 },
          server_latency: { p95_ms: 900 },
        },
      ],
    }, { requireGrade: 'A', requireReadinessReport: true });

    expect(scorecard.ok).toBe(false);
    expect(scorecard.blockers).toContain('readiness_deployed-worker-fingerprint');
    expect(scorecard.categories.find((category) => category.name === 'deploy_readiness'))
      .toMatchObject({
        grade: 'C',
        evidence: {
          reports: [
            {
              ok: false,
              failed_checks: ['deployed-worker-fingerprint'],
              deploy_fingerprint: 'old-fp',
            },
          ],
        },
      });
  });

  it('fails reliability when the operator report fingerprint is stale', () => {
    const scorecard = buildAPlusScorecard({
      operator_report: {
        ...aPlusOperatorReport,
        checks: [
          { name: 'public_health', ok: true, status: 200, deploy_fingerprint: 'old-fp' },
          { name: 'auth_boundary', ok: true, status: 401 },
          { name: 'hosted_ui', ok: true, status: 200 },
        ],
      },
      benchmarks: [
        {
          surface: 'kb-search',
          domain: 'demo.example',
          mode: 'lexical',
          repeat: 5,
          hit_rate: 0.98,
          latency: { p95_ms: 180 },
          server_latency: { p95_ms: 140 },
          queries: Array.from({ length: 10 }, (_, i) => ({ query: `lexical ${i}` })),
        },
        {
          surface: 'kb-query',
          domain: 'demo.example',
          mode: 'semantic',
          repeat: 5,
          hit_rate: 0.93,
          latency: { p95_ms: 1300 },
          server_latency: { p95_ms: 980 },
          queries: Array.from({ length: 10 }, (_, i) => ({ query: `semantic ${i}` })),
        },
      ],
    }, {
      requireGrade: 'A',
      expectedDeployFingerprint: 'current-fp',
      requiredBenchmarkModes: ['lexical', 'semantic'],
      requiredBenchmarkSurfaces: ['kb-search', 'kb-query'],
    });

    expect(scorecard.ok).toBe(false);
    expect(scorecard.blockers).toContain('stale_deploy_fingerprint');
    expect(scorecard.categories.find((category) => category.name === 'reliability'))
      .toMatchObject({
        grade: 'B',
        evidence: {
          deploy_fingerprint: 'old-fp',
          expected_deploy_fingerprint: 'current-fp',
        },
      });
  });

  it('fails when required benchmark modes or surfaces are missing', () => {
    const scorecard = buildAPlusScorecard({
      operator_report: aPlusOperatorReport,
      benchmarks: [
        {
          surface: 'kb-search',
          domain: 'demo.example',
          mode: 'lexical',
          hit_rate: 0.98,
          latency: { p95_ms: 180 },
          server_latency: { p95_ms: 140 },
        },
      ],
    }, {
      requireGrade: 'A',
      requiredBenchmarkModes: ['lexical', 'semantic'],
      requiredBenchmarkSurfaces: ['kb-search', 'kb-query'],
    });

    expect(scorecard.ok).toBe(false);
    expect(scorecard.categories.find((category) => category.name === 'retrieval_performance'))
      .toMatchObject({
        grade: 'C',
        blockers: ['missing_semantic_benchmark', 'missing_kb-query_benchmark'],
      });
  });

  it('passes required benchmark mode and surface coverage when all evidence exists', () => {
    const scorecard = buildAPlusScorecard({
      operator_report: aPlusOperatorReport,
      benchmarks: [
        {
          surface: 'kb-search',
          domain: 'demo.example',
          mode: 'lexical',
          repeat: 5,
          hit_rate: 0.98,
          latency: { p95_ms: 180 },
          server_latency: { p95_ms: 140 },
          queries: Array.from({ length: 10 }, (_, i) => ({ query: `lexical ${i}` })),
        },
        {
          surface: 'kb-query',
          domain: 'demo.example',
          mode: 'semantic',
          repeat: 5,
          hit_rate: 0.93,
          latency: { p95_ms: 1300 },
          server_latency: { p95_ms: 980 },
          queries: Array.from({ length: 10 }, (_, i) => ({ query: `semantic ${i}` })),
        },
      ],
    }, {
      requireGrade: 'A+',
      expectedDeployFingerprint: 'current-fp',
      requiredDomain: 'demo.example',
      requiredBenchmarkModes: ['lexical', 'semantic'],
      requiredBenchmarkSurfaces: ['kb-search', 'kb-query'],
      minBenchmarkRepeat: 5,
      minBenchmarkSamples: 10,
      requiredEvalKinds: ['query', 'search'],
    });

    expect(scorecard.ok).toBe(true);
    expect(scorecard.overall_grade).toBe('A+');
  });

  it('fails retrieval performance when benchmark evidence is too small', () => {
    const scorecard = buildAPlusScorecard({
      operator_report: aPlusOperatorReport,
      benchmarks: [
        {
          surface: 'kb-query',
          domain: 'demo.example',
          mode: 'semantic',
          repeat: 1,
          hit_rate: 1,
          latency: { p95_ms: 100 },
          server_latency: { p95_ms: 80 },
          queries: [{ query: 'one lucky query' }],
        },
      ],
    }, {
      requireGrade: 'A',
      minBenchmarkRepeat: 5,
      minBenchmarkSamples: 10,
    });

    expect(scorecard.ok).toBe(false);
    expect(scorecard.blockers).toEqual(expect.arrayContaining([
      'kb-query_semantic_benchmark_repeat_below_min',
      'kb-query_semantic_benchmark_samples_below_min',
    ]));
    expect(scorecard.categories.find((category) => category.name === 'retrieval_performance'))
      .toMatchObject({
        grade: 'B',
        evidence: {
          min_benchmark_repeat: 5,
          min_benchmark_samples: 10,
          benchmarks: [
            {
              repeat: 1,
              sample_count: 1,
              too_few_repeats: true,
              too_few_samples: true,
            },
          ],
        },
      });
  });

  it('fails evidence scope when domain benchmark evidence is for the wrong account', () => {
    const scorecard = buildAPlusScorecard({
      operator_report: aPlusOperatorReport,
      benchmarks: [
        {
          surface: 'kb-query',
          domain: 'other.example',
          mode: 'semantic',
          hit_rate: 0.93,
          latency: { p95_ms: 1300 },
          server_latency: { p95_ms: 980 },
        },
      ],
    }, {
      requireGrade: 'A',
      requiredDomain: 'demo.example',
    });

    expect(scorecard.ok).toBe(false);
    expect(scorecard.blockers).toContain('benchmark_domain_scope_mismatch');
    expect(scorecard.categories.find((category) => category.name === 'evidence_scope'))
      .toMatchObject({
        grade: 'C',
        evidence: {
          required_domain: 'demo.example',
          operator_domain: 'demo.example',
          mismatched_benchmark_domains: ['kb-query:other.example'],
        },
      });
  });

  it('fails evidence scope when query eval evidence is for the wrong account', () => {
    const scorecard = buildAPlusScorecard({
      operator_report: aPlusOperatorReport,
      query_evals: [{ ...aPlusQueryEvalReport, domain: 'other.example' }],
      benchmarks: [
        {
          surface: 'kb-query',
          domain: 'demo.example',
          mode: 'semantic',
          hit_rate: 0.93,
          latency: { p95_ms: 1300 },
          server_latency: { p95_ms: 980 },
        },
      ],
    }, {
      requireGrade: 'A',
      requiredDomain: 'demo.example',
    });

    expect(scorecard.ok).toBe(false);
    expect(scorecard.blockers).toContain('query_eval_domain_scope_mismatch');
    expect(scorecard.categories.find((category) => category.name === 'evidence_scope'))
      .toMatchObject({
        grade: 'C',
        evidence: {
          required_domain: 'demo.example',
          query_eval_domains: ['other.example'],
          mismatched_query_eval_domains: ['other.example'],
        },
      });
  });

  it('fails retrieval quality when required eval kinds are missing', () => {
    const scorecard = buildAPlusScorecard({
      operator_report: {
        ...aPlusOperatorReport,
        inventory: {
          ...aPlusOperatorReport.inventory,
          eval_kinds: ['search'],
        },
      },
      benchmarks: [
        {
          surface: 'kb-query',
          mode: 'semantic',
          hit_rate: 0.93,
          latency: { p95_ms: 1300 },
          server_latency: { p95_ms: 980 },
        },
      ],
    }, {
      requireGrade: 'A',
      requiredEvalKinds: ['query'],
    });

    expect(scorecard.ok).toBe(false);
    expect(scorecard.blockers).toContain('missing_query_eval_report');
    expect(scorecard.categories.find((category) => category.name === 'retrieval_quality'))
      .toMatchObject({
        grade: 'B',
        evidence: {
          eval_kinds: ['search'],
          required_eval_kinds: ['query'],
          missing_eval_kinds: ['query'],
        },
      });
  });

  it('uses direct query eval reports as retrieval quality evidence', () => {
    const scorecard = buildAPlusScorecard({
      operator_report: {
        ...aPlusOperatorReport,
        inventory: {
          ...aPlusOperatorReport.inventory,
          eval_report_count: 0,
          eval_kinds: [],
        },
      },
      query_evals: [aPlusQueryEvalReport],
      benchmarks: [
        {
          surface: 'kb-query',
          mode: 'semantic',
          hit_rate: 0.93,
          latency: { p95_ms: 1300 },
          server_latency: { p95_ms: 980 },
        },
      ],
    }, {
      requireGrade: 'A+',
      requiredEvalKinds: ['query'],
      minQueryEvalRows: 2,
    });

    expect(scorecard.ok).toBe(true);
    expect(scorecard.categories.find((category) => category.name === 'retrieval_quality'))
      .toMatchObject({
        grade: 'A+',
        evidence: {
          query_eval_count: 1,
          query_eval_hit_rate: 0.95,
          query_eval_citation_rate: 1,
          query_eval_rows: [{ report_id: 'eval-query-1', row_count: 2 }],
          min_query_eval_rows: 2,
          eval_kinds: ['query'],
          missing_eval_kinds: [],
        },
      });
  });

  it('fails retrieval quality when direct query eval evidence is too small', () => {
    const scorecard = buildAPlusScorecard({
      operator_report: aPlusOperatorReport,
      query_evals: [{ ...aPlusQueryEvalReport, report_id: 'eval-small', n: 1, rows: [{ id: 'q1', hit: true, cited: true }] }],
      benchmarks: [
        {
          surface: 'kb-query',
          mode: 'semantic',
          hit_rate: 0.93,
          latency: { p95_ms: 1300 },
          server_latency: { p95_ms: 980 },
        },
      ],
    }, {
      requireGrade: 'A',
      requiredEvalKinds: ['query'],
      minQueryEvalRows: 2,
    });

    expect(scorecard.ok).toBe(false);
    expect(scorecard.blockers).toContain('eval-small_rows_below_min');
    expect(scorecard.categories.find((category) => category.name === 'retrieval_quality'))
      .toMatchObject({
        grade: 'B',
        evidence: {
          query_eval_rows: [{ report_id: 'eval-small', row_count: 1 }],
          min_query_eval_rows: 2,
        },
      });
  });

  it('fails retrieval quality when direct query eval accuracy is below A', () => {
    const scorecard = buildAPlusScorecard({
      operator_report: aPlusOperatorReport,
      query_evals: [{ ...aPlusQueryEvalReport, hit_rate: 0.5, citation_rate: 1 }],
      benchmarks: [
        {
          surface: 'kb-query',
          mode: 'semantic',
          hit_rate: 0.93,
          latency: { p95_ms: 1300 },
          server_latency: { p95_ms: 980 },
        },
      ],
    }, {
      requireGrade: 'A',
      requiredEvalKinds: ['query'],
    });

    expect(scorecard.ok).toBe(false);
    expect(scorecard.blockers).toContain('quality_below_a');
    expect(scorecard.categories.find((category) => category.name === 'retrieval_quality'))
      .toMatchObject({
        grade: 'B',
        evidence: {
          query_eval_hit_rate: 0.5,
        },
      });
  });

  it('passes retrieval quality when required eval kinds are present', () => {
    const scorecard = buildAPlusScorecard({
      operator_report: aPlusOperatorReport,
      benchmarks: [
        {
          surface: 'kb-query',
          mode: 'semantic',
          hit_rate: 0.93,
          latency: { p95_ms: 1300 },
          server_latency: { p95_ms: 980 },
        },
      ],
    }, {
      requireGrade: 'A+',
      requiredEvalKinds: ['query'],
    });

    expect(scorecard.ok).toBe(true);
    expect(scorecard.overall_grade).toBe('A+');
  });

  it('treats direct operator-report JSON with capabilities as the operator report', () => {
    const scorecard = buildAPlusScorecard({
      ...aPlusOperatorReport,
      benchmark: {
        mode: 'semantic',
        hit_rate: 0.94,
        latency: { p95_ms: 1200 },
        server_latency: { p95_ms: 900 },
      },
    }, { requireGrade: 'A' });

    expect(scorecard.categories.find((category) => category.name === 'reliability')).toMatchObject({
      grade: 'A+',
      ok: true,
    });
    expect(scorecard.blockers).not.toContain('missing_operator_report');
  });

  it('does not allow missing benchmarks and evals to pass as A', () => {
    const scorecard = buildAPlusScorecard({
      operator_report: {
        ok: true,
        authenticated: true,
        checks: [{ name: 'public_health', ok: true, status: 200 }],
        blockers: [],
        inventory: {
          file_count: 0,
          files_by_status: {},
          job_count: 0,
          jobs_by_status: {},
          recent_trace_count: 0,
          eval_report_count: 0,
        },
      },
    }, {
      requireGrade: 'A',
      requiredBenchmarkModes: ['lexical'],
      requiredBenchmarkSurfaces: ['kb-query'],
    });

    expect(scorecard.ok).toBe(false);
    expect(scorecard.overall_grade).toBe('C');
    expect(scorecard.blockers).toEqual(expect.arrayContaining([
      'missing_benchmark',
      'missing_lexical_benchmark',
      'missing_kb-query_benchmark',
      'missing_quality_evidence',
      'missing_traces_or_eval_reports',
    ]));
  });
});
