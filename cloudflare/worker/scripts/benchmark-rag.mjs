#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

function usage() {
  console.error(`Usage:
  node scripts/benchmark-rag.mjs --input fixtures/benchmark.sample.json --base-url http://localhost:8787 --key <service-key>

Options:
  --index-id <id>        Query an existing index instead of creating one
  --index-name <name>    Override input.index.name when creating an index
  --repeat <n>           Number of query passes; default 3
  --top-k <n>            Query top_k; default 5
  --settle-ms <n>        Wait after ingest before querying; default 15000 when creating an index
  --cleanup              Delete an index created by this benchmark at the end
  --dry-run              Validate input and print the planned run without network calls`);
}

function parseArgs(argv) {
  const out = {
    baseUrl: process.env.RAG_BASE_URL || 'http://localhost:8787',
    key: process.env.RAG_SERVICE_KEY || '',
    input: '',
    indexId: '',
    indexName: '',
    repeat: 3,
    topK: 5,
    settleMs: 15000,
    cleanup: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--cleanup') {
      out.cleanup = true;
      continue;
    }
    if (arg === '--dry-run') {
      out.dryRun = true;
      continue;
    }
    const value = argv[i + 1];
    if (!value) throw new Error(`missing value for ${arg}`);
    i += 1;
    if (arg === '--base-url') out.baseUrl = value;
    else if (arg === '--key') out.key = value;
    else if (arg === '--input') out.input = value;
    else if (arg === '--index-id') out.indexId = value;
    else if (arg === '--index-name') out.indexName = value;
    else if (arg === '--repeat') out.repeat = parsePositiveInteger(value, '--repeat');
    else if (arg === '--top-k') out.topK = parsePositiveInteger(value, '--top-k');
    else if (arg === '--settle-ms') out.settleMs = parsePositiveInteger(value, '--settle-ms');
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!out.input) throw new Error('--input is required');
  if (!out.key && !out.dryRun) throw new Error('--key or RAG_SERVICE_KEY is required');
  return out;
}

function parsePositiveInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function asObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

export function normalizeBenchmarkInput(raw) {
  const root = asObject(typeof raw === 'string' ? JSON.parse(raw) : raw, 'input');
  const documents = Array.isArray(root.documents) ? root.documents : [];
  const queries = Array.isArray(root.queries) ? root.queries : [];
  if (documents.length === 0) throw new Error('input.documents must be a non-empty array');
  if (queries.length === 0) throw new Error('input.queries must be a non-empty array');
  return {
    index: {
      name: String(asObject(root.index || {}, 'input.index').name || 'RAG Benchmark'),
      external_id: root.index?.external_id || root.index?.externalId
        ? String(root.index.external_id || root.index.externalId)
        : undefined,
    },
    documents: documents.map((doc, i) => {
      const row = asObject(doc, `documents[${i}]`);
      const content = String(row.content || '').trim();
      if (!content) throw new Error(`documents[${i}].content is required`);
      return {
        external_id: row.external_id || row.externalId ? String(row.external_id || row.externalId) : undefined,
        content,
        metadata: asObject(row.metadata || {}, `documents[${i}].metadata`),
      };
    }),
    queries: queries.map((query, i) => {
      const row = asObject(query, `queries[${i}]`);
      const text = String(row.query || '').trim();
      if (!text) throw new Error(`queries[${i}].query is required`);
      return {
        query: text,
        expected_contains: Array.isArray(row.expected_contains)
          ? row.expected_contains.map(String).filter(Boolean)
          : [],
        expected_document_ids: Array.isArray(row.expected_document_ids)
          ? row.expected_document_ids.map(String).filter(Boolean)
          : [],
        expected_chunk_ids: Array.isArray(row.expected_chunk_ids)
          ? row.expected_chunk_ids.map(String).filter(Boolean)
          : [],
      };
    }),
  };
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function requestJson(url, { key, method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${url} failed ${res.status}: ${JSON.stringify(payload)}`);
  return {
    payload,
    cache: res.headers.get('X-RAG-Cache') || 'none',
    timing: parseTimingHeader(res.headers.get('X-RAG-Timing')),
  };
}

export function parseTimingHeader(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

export function summarizeLatencies(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    min_ms: Math.round((sorted[0] ?? 0) * 100) / 100,
    p50_ms: Math.round(percentile(sorted, 50) * 100) / 100,
    p95_ms: Math.round(percentile(sorted, 95) * 100) / 100,
    p99_ms: Math.round(percentile(sorted, 99) * 100) / 100,
    max_ms: Math.round((sorted.at(-1) ?? 0) * 100) / 100,
    mean_ms: Math.round((sorted.length ? total / sorted.length : 0) * 100) / 100,
  };
}

export function summarizeTimingBreakdown(timings) {
  const samplesByKey = new Map();
  for (const timing of timings) {
    if (!timing) continue;
    for (const [key, value] of Object.entries(timing)) {
      if (!key.endsWith('_ms') || typeof value !== 'number') continue;
      const samples = samplesByKey.get(key) ?? [];
      samples.push(value);
      samplesByKey.set(key, samples);
    }
  }
  return Object.fromEntries(
    [...samplesByKey.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, samples]) => [
      key,
      summarizeLatencies(samples),
    ]),
  );
}

export function scoreResults(expectation, results) {
  const expectedChunks = new Set(expectation.expected_chunk_ids);
  const expectedDocs = new Set(expectation.expected_document_ids);
  const expectedContains = expectation.expected_contains.map((value) => value.toLowerCase());
  if (expectedChunks.size === 0 && expectedDocs.size === 0 && expectedContains.length === 0) return null;
  return results.some((result) => {
    if (expectedChunks.has(result.chunk_id)) return true;
    if (expectedDocs.has(result.document_id)) return true;
    const text = String(result.chunk_content || '').toLowerCase();
    return expectedContains.some((needle) => text.includes(needle));
  });
}

export async function runBenchmark(options) {
  const input = normalizeBenchmarkInput(options.input);
  const repeat = Math.max(1, options.repeat || 3);
  const topK = Math.max(1, options.topK || 5);
  if (options.dryRun) {
    return {
      dry_run: true,
      documents: input.documents.length,
      queries: input.queries.length,
      planned_requests: input.queries.length * repeat,
    };
  }

  let indexId = options.indexId || '';
  let createdIndex = false;
  if (!indexId) {
    const created = await requestJson(`${options.baseUrl}/v1/indexes`, {
      key: options.key,
      method: 'POST',
      body: {
        name: options.indexName || input.index.name,
        external_id: input.index.external_id,
      },
    });
    indexId = created.payload.id;
    createdIndex = true;
    await requestJson(`${options.baseUrl}/v1/indexes/${indexId}/ingest`, {
      key: options.key,
      method: 'POST',
      body: { documents: input.documents },
    });
    if (options.settleMs) await sleep(options.settleMs);
  }

  const samples = [];
  const serverSamples = [];
  const serverTimings = [];
  const querySummaries = [];
  let hits = 0;
  let scored = 0;
  let cacheHits = 0;
  try {
    for (let pass = 0; pass < repeat; pass += 1) {
      for (const query of input.queries) {
        const started = performance.now();
        const { payload, cache, timing } = await requestJson(`${options.baseUrl}/v1/indexes/${indexId}/query`, {
          key: options.key,
          method: 'POST',
          body: { query: query.query, top_k: topK },
        });
        const elapsed = performance.now() - started;
        const data = Array.isArray(payload.data) ? payload.data : [];
        const hit = scoreResults(query, data);
        if (cache === 'hit') cacheHits += 1;
        if (hit !== null) {
          scored += 1;
          if (hit) hits += 1;
        }
        samples.push(elapsed);
        if (typeof timing?.total_ms === 'number') serverSamples.push(timing.total_ms);
        if (timing) serverTimings.push(timing);
        querySummaries.push({
          query: query.query,
          pass,
          ms: Math.round(elapsed * 100) / 100,
          server_ms: typeof timing?.total_ms === 'number' ? timing.total_ms : null,
          cache,
          timing,
          result_count: data.length,
          hit,
          top_score: data[0]?.score ?? null,
        });
      }
    }
  } finally {
    if (createdIndex && options.cleanup) {
      await requestJson(`${options.baseUrl}/v1/indexes/${indexId}`, { key: options.key, method: 'DELETE' });
    }
  }

  return {
    dry_run: false,
    index_id: indexId,
    created_index: createdIndex,
    repeat,
    top_k: topK,
    latency: summarizeLatencies(samples),
    server_latency: summarizeLatencies(serverSamples),
    server_timing: summarizeTimingBreakdown(serverTimings),
    cache_hits: cacheHits,
    cache_hit_rate: samples.length ? cacheHits / samples.length : 0,
    scored_queries: scored,
    hit_rate: scored ? hits / scored : null,
    queries: querySummaries,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const input = await readFile(args.input, 'utf8');
    const result = await runBenchmark({ ...args, input });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    usage();
    console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
