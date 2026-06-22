import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildPlan, parseArgs, queryEvalCases, runAPlusProof, runQueryEvalProof } from '../scripts/a-plus-proof.mjs';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('a-plus-proof', () => {
  it('accepts the pnpm run argument separator and normalizes options', () => {
    expect(parseArgs([
      '--',
      '--base-url',
      'https://kb.example/',
      '--domain',
      'manuals',
      '--input',
      'fixtures/benchmark.sample.json',
      '--output-dir',
      '/tmp/kb-proof',
      '--repeat',
      '5',
      '--top-k',
      '7',
      '--continue-after-readiness-failure',
      '--dry-run',
      '--json',
    ])).toMatchObject({
      baseUrl: 'https://kb.example',
      domain: 'manuals',
      input: 'fixtures/benchmark.sample.json',
      outputDir: '/tmp/kb-proof',
      repeat: 5,
      topK: 7,
      continueAfterReadinessFailure: true,
      dryRun: true,
      jsonOnly: true,
    });
  });

  it('builds the current A plus proof plan', () => {
    expect(buildPlan({
      baseUrl: 'https://kb.example',
      domain: 'manuals',
      input: 'fixtures/benchmark.sample.json',
      outputDir: '/tmp/kb-proof',
      repeat: 5,
      topK: 5,
      expectedDeployFingerprint: 'fp',
      requireGrade: 'A+',
      continueAfterReadinessFailure: false,
    })).toMatchObject({
      base_url: 'https://kb.example',
      domain: 'manuals',
      continue_after_readiness_failure: false,
      steps: [
        'deploy-readiness',
        'query-eval',
        'operator-report',
        'benchmark:kb-search:lexical',
        'benchmark:kb-query:semantic',
        'scorecard:a-plus',
      ],
      scorecard_requirements: {
        require_readiness_report: true,
        required_domain: 'manuals',
        required_benchmark_modes: ['lexical', 'semantic'],
        required_benchmark_surfaces: ['kb-search', 'kb-query'],
        min_benchmark_repeat: 5,
        min_benchmark_samples: 10,
        required_eval_kinds: ['query'],
      },
    });
  });

  it('builds query eval cases from benchmark input expectations', () => {
    expect(queryEvalCases({
      queries: [
        { query: 'What mentions cache?', expected_contains: ['dashboard cache'] },
        { id: 'custom', query: 'What mentions billing?', expected_contains: ['billing guardrails'] },
      ],
    })).toEqual([
      { id: 'q1', question: 'What mentions cache?', expected_text: 'dashboard cache' },
      { id: 'custom', question: 'What mentions billing?', expected_text: 'billing guardrails' },
    ]);
  });

  it('runs deterministic query eval proof without enabling AI judge', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      calls.push({ url: href, body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify({ report_id: 'eval-1', hit_rate: 1, citation_rate: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    await expect(runQueryEvalProof({
      baseUrl: 'https://kb.example',
      key: 'service-key',
      domain: 'manuals',
      input: {
        queries: [{ query: 'What mentions cache?', expected_contains: ['dashboard cache'] }],
      },
      topK: 5,
    })).resolves.toMatchObject({ report_id: 'eval-1' });

    expect(calls).toEqual([{
      url: 'https://kb.example/v1/kb/evals/query',
      body: {
        domain: 'manuals',
        mode: 'semantic',
        top_k: 5,
        answer_mode: 'extractive',
        ai_judge: false,
        cases: [{ id: 'q1', question: 'What mentions cache?', expected_text: 'dashboard cache' }],
      },
    }]);
  });

  it('does not require a service key or network calls for dry-run proof planning', async () => {
    const result = await runAPlusProof({
      ...parseArgs([
        '--domain',
        'manuals',
        '--dry-run',
      ]),
      key: '',
    });

    expect(result).toMatchObject({
      ok: true,
      dry_run: true,
      plan: {
        domain: 'manuals',
      },
      artifacts: {},
    });
  });

  it('stops before eval and benchmark work when deploy readiness fails', async () => {
    const readiness = {
      ok: false,
      base_url: 'https://kb.example',
      checks: [
        { name: 'deployed-worker-fingerprint', ok: false, deploy_fingerprint: 'old-fp' },
      ],
    };
    const result = await runAPlusProof({
      ...parseArgs([
        '--base-url',
        'https://kb.example',
        '--domain',
        'manuals',
      ]),
      key: 'service-key',
      input: 'fixtures/benchmark.sample.json',
      readinessRunner: async () => readiness,
    });

    expect(result).toMatchObject({
      ok: false,
      stopped_after_readiness: true,
      stop_reason: 'deploy_readiness_failed',
      readiness,
      query_eval: null,
      operator_report: null,
      benchmarks: [],
      scorecard: {
        ok: false,
        blockers: expect.arrayContaining([
          'readiness_deployed-worker-fingerprint',
          'missing_operator_report',
          'missing_benchmark',
          'missing_query_eval_report',
        ]),
      },
    });
  });
});
