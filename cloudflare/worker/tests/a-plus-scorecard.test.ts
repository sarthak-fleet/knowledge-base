import { describe, expect, it } from 'vitest';
import { buildAPlusScorecard, parseArgs } from '../scripts/a-plus-scorecard.mjs';

const aPlusOperatorReport = {
  ok: true,
  authenticated: true,
  checks: [
    { name: 'public_health', ok: true, status: 200 },
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
    expect(parseArgs(['--', '--input', '/tmp/report.json', '--require-grade', 'A+'])).toEqual({
      input: '/tmp/report.json',
      requireGrade: 'A+',
    });
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
    }, { requireGrade: 'A' });

    expect(scorecard.ok).toBe(false);
    expect(scorecard.overall_grade).toBe('C');
    expect(scorecard.blockers).toEqual(expect.arrayContaining([
      'missing_benchmark',
      'missing_quality_evidence',
      'missing_traces_or_eval_reports',
    ]));
  });
});
