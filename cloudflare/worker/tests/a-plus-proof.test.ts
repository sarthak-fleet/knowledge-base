import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildPlan, parseArgs, proofDocuments, proofEmbeddingSelection, queryEvalCases, runAPlusProof, runQueryEvalProof, seedProofCorpus, validateProofInput } from '../scripts/a-plus-proof.mjs';

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
      benchmark_cache_mode: 'default',
      benchmark_warmup: 0,
      continue_after_readiness_failure: false,
      steps: [
        'deploy-readiness',
        'seed-eval-corpus',
        'benchmark:kb-search:lexical',
        'benchmark:kb-query:semantic',
        'query-eval',
        'operator-report',
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

  it('builds an S proof plan with consumer smokes and larger eval samples', () => {
    expect(buildPlan({
      baseUrl: 'https://kb.example',
      domain: 'manuals',
      input: 'fixtures/s-grade-consumer-evals.json',
      outputDir: '/tmp/kb-proof',
      repeat: 8,
      topK: 5,
      expectedDeployFingerprint: 'fp',
      requireGrade: 'S',
      continueAfterReadinessFailure: false,
    })).toMatchObject({
      base_url: 'https://kb.example',
      domain: 'manuals',
      benchmark_cache_mode: 'bypass_read_write',
      benchmark_warmup: 1,
      steps: [
        'deploy-readiness',
        'consumer-auth-smokes',
        'seed-eval-corpus',
        'benchmark:kb-search:lexical',
        'benchmark:kb-query:semantic',
        'query-eval',
        'operator-report',
        'scorecard:s',
      ],
      scorecard_requirements: {
        min_benchmark_repeat: 8,
        min_benchmark_samples: 32,
        min_query_eval_rows: 4,
      },
    });
  });

  it('builds query eval cases from benchmark input expectations', () => {
    expect(queryEvalCases({
      queries: [
        { query: 'What mentions cache?', expected_contains: ['dashboard cache'] },
        {
          id: 'custom',
          query: 'What mentions billing?',
          expected_contains: ['billing guardrails'],
          expected_document_ids: ['doc-1'],
          expected_chunk_ids: ['chunk-1'],
        },
      ],
    })).toEqual([
      { id: 'q1', question: 'What mentions cache?', expected_text: 'dashboard cache' },
      {
        id: 'custom',
        question: 'What mentions billing?',
        expected_text: 'billing guardrails',
        expected_document_ids: ['doc-1'],
        expected_chunk_ids: ['chunk-1'],
      },
    ]);
  });

  it('builds proof documents and seeds them through the KB text ingest API', async () => {
    const input = {
      index: { name: 'Proof' },
      documents: [
        { external_id: 'doc-1', content: 'Alpha proof document.' },
        { external_id: 'empty', content: ' ' },
        { id: 'doc-2', content: 'Beta proof document.' },
      ],
    };
    expect(proofDocuments(input)).toEqual([
      { id: 'doc-1', title: 'doc-1', text: 'Alpha proof document.' },
      { id: 'doc-2', title: 'doc-2', text: 'Beta proof document.' },
    ]);
    expect(proofEmbeddingSelection(input)).toEqual({});

    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url: href, body });
      return new Response(JSON.stringify({
        file_id: `${body.title}-file`,
        files: [{ chunks_created: 1 }],
        ingest_safety: { idempotent: true, replayable: true },
      }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    await expect(seedProofCorpus({
      baseUrl: 'https://kb.example',
      key: 'service-key',
      domain: 'manuals',
      input,
    })).resolves.toMatchObject({
      domain: 'manuals',
      document_count: 2,
      documents: [
        { id: 'doc-1', file_id: 'doc-1-file', status: 'seeded', chunks_indexed: 1 },
        { id: 'doc-2', file_id: 'doc-2-file', status: 'seeded', chunks_indexed: 1 },
      ],
    });

    expect(calls).toEqual([
      {
        url: 'https://kb.example/v1/kb/ingest/text',
        body: {
          domain: 'manuals',
          title: 'doc-1',
          text: 'Alpha proof document.',
          async: false,
          idempotency_key: 'proof:doc-1',
        },
      },
      {
        url: 'https://kb.example/v1/kb/ingest/text',
        body: {
          domain: 'manuals',
          title: 'doc-2',
          text: 'Beta proof document.',
          async: false,
          idempotency_key: 'proof:doc-2',
        },
      },
    ]);
  });

  it('forwards explicit proof embedding selection when a fixture opts in', () => {
    expect(proofEmbeddingSelection({
      index: {
        embedding_model: '@cf/baai/bge-small-en-v1.5',
        embedding_provider: 'workers_ai',
      },
    })).toEqual({
      embedding_model: '@cf/baai/bge-small-en-v1.5',
      embedding_provider: 'workers_ai',
    });
  });

  it('validates proof inputs before live proof requests', () => {
    expect(validateProofInput({
      queries: [
        { query: 'What mentions cache?', expected_contains: ['dashboard cache'] },
        { query: 'Where is billing?', expected_document_ids: ['doc-1'] },
      ],
    })).toMatchObject({
      ok: true,
      query_count: 2,
      scored_query_count: 2,
    });

    expect(validateProofInput({
      queries: [{ query: 'What mentions cache?', expected_contains: ['dashboard cache'] }],
    })).toMatchObject({
      ok: false,
      errors: ['proof input must include at least 2 queries', 'proof input must include at least 2 scored queries with expected_contains, expected_document_ids, or expected_chunk_ids'],
    });

    expect(validateProofInput({
      queries: [{ query: 'What mentions cache?' }, { query: 'Where is billing?' }],
    })).toMatchObject({
      ok: false,
      query_count: 2,
      scored_query_count: 0,
      errors: ['proof input must include at least 2 scored queries with expected_contains, expected_document_ids, or expected_chunk_ids'],
    });

    expect(validateProofInput({
      queries: [
        { query: 'q1', expected_contains: ['a'] },
        { query: 'q2', expected_contains: ['b'] },
      ],
    }, { minQueries: 4 })).toMatchObject({
      ok: false,
      query_count: 2,
      scored_query_count: 2,
      errors: ['proof input must include at least 4 queries', 'proof input must include at least 4 scored queries with expected_contains, expected_document_ids, or expected_chunk_ids'],
    });
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

  it('can request session-backed query eval proof traces', async () => {
    const calls: Array<{ body: unknown }> = [];
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calls.push({ body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify({ n: 1, hit_rate: 1, citation_rate: 1, rows: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    await runQueryEvalProof({
      baseUrl: 'https://kb.example',
      key: 'service-key',
      domain: 'manuals',
      input: {
        queries: [{ id: 'q1', query: 'What mentions cache?', expected_contains: ['dashboard cache'] }],
      },
      topK: 5,
      sessionIdPrefix: 'proof:manuals:1',
      cacheMode: 'bypass_read_write',
    });

    expect(calls[0]?.body).toMatchObject({
      session_id_prefix: 'proof:manuals:1',
      cache_mode: 'bypass_read_write',
    });
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

  it('rejects invalid proof input before readiness requests', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kb-proof-'));
    try {
      const inputPath = join(dir, 'invalid.json');
      await writeFile(inputPath, JSON.stringify({ queries: [{ query: 'unlabeled' }] }));
      await expect(runAPlusProof({
        ...parseArgs([
          '--base-url',
          'https://kb.example',
          '--domain',
          'manuals',
          '--input',
          inputPath,
        ]),
        key: 'service-key',
        readinessRunner: async () => {
          throw new Error('readiness should not run');
        },
      })).rejects.toThrow('invalid A/A+ proof input');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
