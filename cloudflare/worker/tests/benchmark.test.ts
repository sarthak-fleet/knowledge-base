import { describe, expect, it } from 'vitest';
import {
  normalizeBenchmarkInput,
  parseArgs,
  parseTimingHeader,
  runBenchmark,
  scoreResults,
  summarizeLatencies,
  summarizeTimingBreakdown,
} from '../scripts/benchmark-rag.mjs';

describe('benchmark-rag', () => {
  it('accepts the pnpm run argument separator', () => {
    expect(parseArgs([
      '--',
      '--input',
      'fixtures/benchmark.sample.json',
      '--mode',
      'lexical',
      '--cache-mode',
      'bypass-read-write',
      '--warmup',
      '2',
      '--surface',
      'kb-search',
      '--domain',
      'manuals',
      '--dry-run',
    ]))
      .toMatchObject({
        input: 'fixtures/benchmark.sample.json',
        mode: 'lexical',
        cacheMode: 'bypass_read_write',
        warmup: 2,
        surface: 'kb-search',
        domain: 'manuals',
        dryRun: true,
      });
  });

  it('normalizes documents and queries for a benchmark run', () => {
    const normalized = normalizeBenchmarkInput(
      JSON.stringify({
        index: { name: 'Bench' },
        documents: [{ content: 'alpha document' }],
        queries: [{ query: 'alpha', expected_contains: ['alpha'] }],
      }),
    );

    expect(normalized.documents).toHaveLength(1);
    expect(normalized.queries[0]).toMatchObject({ query: 'alpha', expected_contains: ['alpha'] });
  });

  it('allows query-only inputs for existing benchmark targets', () => {
    const normalized = normalizeBenchmarkInput(
      { queries: [{ query: 'alpha', expected_contains: ['alpha'] }] },
      { requireDocuments: false },
    );

    expect(normalized.documents).toEqual([]);
    expect(normalized.queries[0]).toMatchObject({ query: 'alpha', expected_contains: ['alpha'] });
  });

  it('labels dry-run benchmark evidence with the requested mode', async () => {
    const result = await runBenchmark({
      dryRun: true,
      mode: 'lexical',
      input: {
        index: { name: 'Bench' },
        documents: [{ content: 'alpha document', metadata: {} }],
        queries: [{ query: 'alpha', expected_contains: ['alpha'] }],
      },
    });

    expect(result).toMatchObject({
      dry_run: true,
      surface: 'index',
      mode: 'lexical',
      planned_requests: 3,
    });
  });

  it('benchmarks an existing domain search surface', async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const href = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ path: new URL(href).pathname, body });
      return new Response(JSON.stringify({
        data: [{ document_id: 'doc-1', chunk_id: 'chunk-1', chunk_content: 'alpha manual', score: 1 }],
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-RAG-Cache': 'miss',
          'X-RAG-Timing': '{"total_ms":12,"retrieval":"lexical"}',
        },
      });
    };

    const result = await runBenchmark({
      baseUrl: 'https://kb.example',
      key: 'key-a',
      input: {
        index: { name: 'Bench' },
        documents: [{ content: 'alpha manual', metadata: {} }],
        queries: [{ query: 'alpha', expected_contains: ['alpha'] }],
      },
      surface: 'kb-search',
      domain: 'manuals',
      mode: 'lexical',
      repeat: 1,
      topK: 3,
      fetchImpl,
    });

    expect(calls).toEqual([{
      path: '/v1/kb/search',
      body: { domain: 'manuals', query: 'alpha', top_k: 3, mode: 'lexical' },
    }]);
    expect(result).toMatchObject({
      surface: 'kb-search',
      domain: 'manuals',
      mode: 'lexical',
      hit_rate: 1,
      server_latency: { count: 1, p95_ms: 12 },
      cache_latency: {
        hit: { count: 0 },
        non_cache: { count: 1 },
      },
      server_cache_latency: {
        hit: { count: 0 },
        non_cache: { count: 1, p95_ms: 12 },
      },
    });
  });

  it('passes cache bypass controls to live benchmark query requests', async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const href = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      calls.push({ path: new URL(href).pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify({
        data: [{ document_id: 'doc-1', chunk_id: 'chunk-1', chunk_content: 'alpha manual', score: 1 }],
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-RAG-Cache': 'miss',
          'X-RAG-Timing': '{"total_ms":12,"retrieval":"lexical","cache_mode":"bypass_read_write"}',
        },
      });
    };

    const result = await runBenchmark({
      baseUrl: 'https://kb.example',
      key: 'key-a',
      input: { queries: [{ query: 'alpha', expected_contains: ['alpha'] }] },
      surface: 'kb-search',
      domain: 'manuals',
      mode: 'lexical',
      cacheMode: 'bypass_read_write',
      warmup: 1,
      repeat: 1,
      fetchImpl,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(calls[1]);
    expect(calls[0]).toEqual({
      path: '/v1/kb/search',
      body: {
        domain: 'manuals',
        query: 'alpha',
        top_k: 5,
        mode: 'lexical',
        cache_mode: 'bypass_read_write',
      },
    });
    expect(result).toMatchObject({
      cache_mode: 'bypass_read_write',
      warmup: 1,
      cache_hit_rate: 0,
      server_timing: {
        total_ms: { count: 1 },
      },
    });
  });

  it('benchmarks an existing domain answer surface with extractive answers', async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const href = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ path: new URL(href).pathname, body });
      return new Response(JSON.stringify({
        answer: 'alpha manual [1]',
        data: [{ document_id: 'doc-1', chunk_id: 'chunk-1', chunk_content: 'alpha manual', score: 1 }],
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-RAG-Cache': 'hit',
          'X-RAG-Timing': '{"total_ms":9,"retrieval":"lexical"}',
        },
      });
    };

    const result = await runBenchmark({
      baseUrl: 'https://kb.example',
      key: 'key-a',
      input: {
        index: { name: 'Bench' },
        documents: [{ content: 'alpha manual', metadata: {} }],
        queries: [{ query: 'alpha', expected_contains: ['alpha'] }],
      },
      surface: 'kb-query',
      domain: 'manuals',
      mode: 'lexical',
      repeat: 1,
      fetchImpl,
    });

    expect(calls).toEqual([{
      path: '/v1/kb/query',
      body: { domain: 'manuals', question: 'alpha', top_k: 5, mode: 'lexical', answer_mode: 'extractive' },
    }]);
    expect(result).toMatchObject({
      surface: 'kb-query',
      domain: 'manuals',
      cache_hit_rate: 1,
      cache_latency: {
        hit: { count: 1 },
        non_cache: { count: 0 },
      },
      server_cache_latency: {
        hit: { count: 1, p95_ms: 9 },
        non_cache: { count: 0 },
      },
      hit_rate: 1,
    });
  });

  it('summarizes latency percentiles', () => {
    expect(summarizeLatencies([30, 10, 20, 100])).toMatchObject({
      count: 4,
      min_ms: 10,
      p50_ms: 20,
      p95_ms: 100,
      p99_ms: 100,
      max_ms: 100,
    });
  });

  it('parses and summarizes server timing headers', () => {
    expect(parseTimingHeader('{"total_ms":12.5,"cache":"miss"}')).toEqual({
      total_ms: 12.5,
      cache: 'miss',
    });
    expect(parseTimingHeader('not-json')).toBeNull();
    expect(summarizeTimingBreakdown([{ total_ms: 10, embed_ms: 4 }, { total_ms: 30, embed_ms: 6 }]))
      .toMatchObject({
        embed_ms: { count: 2, p95_ms: 6, p99_ms: 6 },
        total_ms: { count: 2, p50_ms: 10, p95_ms: 30, p99_ms: 30 },
      });
  });

  it('scores expected text matches in returned chunks', () => {
    expect(
      scoreResults(
        { expected_contains: ['billing guardrails'], expected_document_ids: [], expected_chunk_ids: [] },
        [{ document_id: 'doc-1', chunk_id: 'chunk-1', chunk_content: 'Cloudflare billing guardrails', score: 1 }],
      ),
    ).toBe(true);
  });
});
