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
    expect(parseArgs(['--', '--input', 'fixtures/benchmark.sample.json', '--mode', 'lexical', '--dry-run']))
      .toMatchObject({
        input: 'fixtures/benchmark.sample.json',
        mode: 'lexical',
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
      mode: 'lexical',
      planned_requests: 3,
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
