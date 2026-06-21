#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { backfill, normalizeInput } from './backfill-saas-maker.mjs';
import { scoreResults, summarizeLatencies } from './benchmark-rag.mjs';

function usage() {
  console.error(`Usage:
  node scripts/smoke-saas-maker-export.mjs --input saas-maker-export.json --base-url http://localhost:8787 --key <service-key>

Options:
  --top-k <n>       Query top_k; default 5
  --limit <n>       Number of exported chunks to query; default 5
  --settle-ms <n>   Initial wait after backfill before querying; default 5000
  --max-wait-ms <n> Maximum total wait for Vectorize queryability; default 60000
  --poll-ms <n>     Wait between queryability checks; default 3000
  --keep-index      Leave the temporary RAG index in place
  --dry-run         Validate input and print the planned run without network calls`);
}

function parseArgs(argv) {
  const out = {
    baseUrl: process.env.RAG_BASE_URL || 'http://localhost:8787',
    key: process.env.RAG_SERVICE_KEY || '',
    input: '',
    topK: 5,
    limit: 5,
    settleMs: 5000,
    maxWaitMs: 60000,
    pollMs: 3000,
    keepIndex: false,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--keep-index') {
      out.keepIndex = true;
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
    else if (arg === '--top-k') out.topK = parsePositiveInteger(value, '--top-k');
    else if (arg === '--limit') out.limit = parsePositiveInteger(value, '--limit');
    else if (arg === '--settle-ms') out.settleMs = parsePositiveInteger(value, '--settle-ms');
    else if (arg === '--max-wait-ms') out.maxWaitMs = parsePositiveInteger(value, '--max-wait-ms');
    else if (arg === '--poll-ms') out.pollMs = parsePositiveInteger(value, '--poll-ms');
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
  return payload;
}

function pickQueryChunks(chunks, limit) {
  const seen = new Set();
  const picked = [];
  for (const chunk of chunks) {
    if (seen.has(chunk.id)) continue;
    seen.add(chunk.id);
    picked.push(chunk);
    if (picked.length >= limit) break;
  }
  return picked;
}

export async function smokeSaasMakerExport(options) {
  const normalized = normalizeInput(options.input);
  const queryChunks = pickQueryChunks(normalized.chunks, Math.max(1, options.limit || 5));
  const topK = Math.max(1, options.topK || 5);
  const smokeId = `smoke-${Date.now()}`;
  const indexName = `${normalized.index.name} ${smokeId}`;
  const externalId = `${normalized.index.external_id || 'saas-maker-export'}-${smokeId}`;

  if (options.dryRun) {
    return {
      dry_run: true,
      chunks: normalized.chunks.length,
      query_vectors: queryChunks.length,
      dimensions: normalized.dimensions,
      cleanup: !options.keepIndex,
    };
  }

  const backfilled = await backfill({
    baseUrl: options.baseUrl,
    key: options.key,
    input: normalized,
    indexName,
    externalId,
    batchSize: 100,
    dryRun: false,
  });

  const indexId = backfilled.index.id;
  const samples = [];
  let queries = [];
  let hits = 0;
  let attempts = 0;
  let waitedMs = 0;

  try {
    const settleMs = Math.max(0, options.settleMs || 0);
    if (settleMs) {
      await sleep(settleMs);
      waitedMs += settleMs;
    }
    const maxWaitMs = Math.max(settleMs, options.maxWaitMs || 60000);
    const pollMs = Math.max(1, options.pollMs || 3000);
    const startedWaiting = Date.now();
    do {
      attempts += 1;
      hits = 0;
      queries = [];
      for (const chunk of queryChunks) {
        const started = performance.now();
        const payload = await requestJson(`${options.baseUrl}/v1/indexes/${indexId}/query-vector`, {
          key: options.key,
          method: 'POST',
          body: { vector: chunk.embedding, top_k: topK },
        });
        const elapsed = performance.now() - started;
        const data = Array.isArray(payload.data) ? payload.data : [];
        const hit = scoreResults(
          { expected_chunk_ids: [chunk.id], expected_document_ids: [], expected_contains: [] },
          data,
        );
        if (hit) hits += 1;
        samples.push(elapsed);
        queries.push({
          chunk_id: chunk.id,
          document_id: chunk.document_id,
          ms: Math.round(elapsed * 100) / 100,
          result_count: data.length,
          hit,
          top_chunk_id: data[0]?.chunk_id ?? null,
          top_score: data[0]?.score ?? null,
        });
      }
      if (hits === queryChunks.length) break;
      waitedMs = settleMs + (Date.now() - startedWaiting);
      if (waitedMs >= maxWaitMs) break;
      const wait = Math.min(pollMs, maxWaitMs - waitedMs);
      await sleep(wait);
      waitedMs += wait;
    } while (waitedMs < maxWaitMs);
  } finally {
    if (!options.keepIndex) {
      await requestJson(`${options.baseUrl}/v1/indexes/${indexId}`, {
        key: options.key,
        method: 'DELETE',
      });
    }
  }

  return {
    dry_run: false,
    index_id: indexId,
    chunks: normalized.chunks.length,
    upserted: backfilled.upserted,
    query_vectors: queryChunks.length,
    latency: summarizeLatencies(samples),
    hit_rate: queryChunks.length ? hits / queryChunks.length : null,
    attempts,
    waited_ms: waitedMs,
    cleaned_up: !options.keepIndex,
    queries,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const input = await readFile(args.input, 'utf8');
    const result = await smokeSaasMakerExport({ ...args, input });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    usage();
    console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
