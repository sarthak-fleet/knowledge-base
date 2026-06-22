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

describe('a-plus-scorecard', () => {
  it('accepts the pnpm run argument separator', () => {
    expect(parseArgs([
      '--',
      '--input',
      '/tmp/report.json',
      '--require-grade',
      'A+',
      '--require-domain',
      'Demo.Example',
      '--require-benchmark-mode',
      'lexical',
      '--require-benchmark-surface',
      'kb-query',
      '--require-eval-kind',
      'query',
    ])).toEqual({
      input: '/tmp/report.json',
      operatorReport: '',
      benchmarks: [],
      requireGrade: 'A+',
      expectedDeployFingerprint: '',
      requiredDomain: 'demo.example',
      requiredBenchmarkModes: ['lexical'],
      requiredBenchmarkSurfaces: ['kb-query'],
      requiredEvalKinds: ['query'],
    });
  });

  it('loads an operator report with repeated benchmark files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kb-scorecard-'));
    try {
      const operatorPath = join(dir, 'operator.json');
      const lexicalPath = join(dir, 'lexical.json');
      const semanticPath = join(dir, 'semantic.json');
      await writeFile(operatorPath, JSON.stringify(aPlusOperatorReport));
      await writeFile(lexicalPath, JSON.stringify({ mode: 'lexical', hit_rate: 0.96, latency: { p95_ms: 120 } }));
      await writeFile(semanticPath, JSON.stringify({ mode: 'semantic', hit_rate: 0.93, latency: { p95_ms: 1100 } }));

      const evidence = await loadScorecardEvidence(parseArgs([
        '--operator-report',
        operatorPath,
        '--benchmark',
        lexicalPath,
        '--benchmark',
        semanticPath,
      ]));

      expect(evidence).toMatchObject({
        operator_report: { ok: true },
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
    }, { requireGrade: 'A+' });

    expect(scorecard.ok).toBe(true);
    expect(scorecard.overall_grade).toBe('A+');
    expect(scorecard.blockers).toEqual([]);
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
          hit_rate: 0.98,
          latency: { p95_ms: 180 },
          server_latency: { p95_ms: 140 },
        },
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
          hit_rate: 0.98,
          latency: { p95_ms: 180 },
          server_latency: { p95_ms: 140 },
        },
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
      requireGrade: 'A+',
      expectedDeployFingerprint: 'current-fp',
      requiredDomain: 'demo.example',
      requiredBenchmarkModes: ['lexical', 'semantic'],
      requiredBenchmarkSurfaces: ['kb-search', 'kb-query'],
      requiredEvalKinds: ['query', 'search'],
    });

    expect(scorecard.ok).toBe(true);
    expect(scorecard.overall_grade).toBe('A+');
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
