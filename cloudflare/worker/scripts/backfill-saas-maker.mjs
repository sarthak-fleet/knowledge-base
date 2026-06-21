#!/usr/bin/env node

import { readFile } from 'node:fs/promises';

function usage() {
  console.error(`Usage:
  node scripts/backfill-saas-maker.mjs --input chunks.json --base-url http://localhost:8787 --key <service-key> --index-name "SaaS Maker"

Input JSON shape:
  {
    "index": { "id": "optional-existing-id", "name": "Docs", "external_id": "saas-index-id" },
    "chunks": [
      {
        "id": "chunk-id",
        "document_id": "doc-id",
        "document_content": "full doc text optional",
        "document_external_id": "source-doc-id optional",
        "content": "chunk text",
        "embedding": [0.1, 0.2],
        "chunk_index": 0,
        "metadata": {}
      }
    ]
  }`);
}

function parseArgs(argv) {
  const out = {
    baseUrl: process.env.RAG_BASE_URL || 'http://localhost:8787',
    key: process.env.RAG_SERVICE_KEY || '',
    input: '',
    indexName: '',
    externalId: '',
    batchSize: 100,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
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
    else if (arg === '--index-name') out.indexName = value;
    else if (arg === '--external-id') out.externalId = value;
    else if (arg === '--batch-size') {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed)) throw new Error('--batch-size must be a number');
      out.batchSize = Math.max(1, parsed);
    }
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!out.input) throw new Error('--input is required');
  if (!out.key && !out.dryRun) throw new Error('--key or RAG_SERVICE_KEY is required');
  return out;
}

function asObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function normalizeChunk(value, index) {
  const row = asObject(value, `chunks[${index}]`);
  const id = String(row.id || '').trim();
  const documentId = String(row.document_id || row.documentId || '').trim();
  const content = String(row.content || '').trim();
  if (!id) throw new Error(`chunks[${index}].id is required`);
  if (!documentId) throw new Error(`chunks[${index}].document_id is required`);
  if (!content) throw new Error(`chunks[${index}].content is required`);
  if (!Array.isArray(row.embedding) || row.embedding.length === 0) {
    throw new Error(`chunks[${index}].embedding must be a non-empty array`);
  }
  return {
    id,
    document_id: documentId,
    document_content: String(row.document_content || row.documentContent || content),
    document_external_id:
      row.document_external_id || row.documentExternalId
        ? String(row.document_external_id || row.documentExternalId)
        : undefined,
    content,
    embedding: row.embedding.map((n, i) => {
      const parsed = Number(n);
      if (!Number.isFinite(parsed)) throw new Error(`chunks[${index}].embedding[${i}] is not numeric`);
      return parsed;
    }),
    chunk_index: Number.isInteger(row.chunk_index)
      ? row.chunk_index
      : Number.isInteger(row.chunkIndex)
        ? row.chunkIndex
        : index,
    metadata: asObject(row.metadata || {}, `chunks[${index}].metadata`),
  };
}

export function normalizeInput(raw) {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const root = asObject(parsed, 'input');
  const chunksRaw = root.chunks;
  if (!Array.isArray(chunksRaw) || chunksRaw.length === 0) {
    throw new Error('input.chunks must be a non-empty array');
  }
  const index = asObject(root.index || {}, 'input.index');
  const chunks = chunksRaw.map(normalizeChunk);
  const dimensions = new Set(chunks.map((chunk) => chunk.embedding.length));
  if (dimensions.size !== 1) throw new Error('all chunk embeddings must have the same dimension');
  return {
    index: {
      name: String(index.name || 'SaaS Maker Backfill'),
      external_id: index.external_id || index.externalId ? String(index.external_id || index.externalId) : undefined,
    },
    chunks,
    dimensions: chunks[0].embedding.length,
  };
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
  if (!res.ok) {
    throw new Error(`${method} ${url} failed ${res.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function ensureIndex({ baseUrl, key, name, externalId }) {
  const existing = await requestJson(`${baseUrl}/v1/indexes`, { key });
  const data = Array.isArray(existing.data) ? existing.data : [];
  const found = data.find((idx) => idx.name === name || (externalId && idx.external_id === externalId));
  if (found) return found;
  return await requestJson(`${baseUrl}/v1/indexes`, {
    key,
    method: 'POST',
    body: { name, external_id: externalId || undefined },
  });
}

export async function backfill({ baseUrl, key, input, indexName, externalId, batchSize, dryRun }) {
  const normalized = normalizeInput(input);
  const name = indexName || normalized.index.name;
  const ext = externalId || normalized.index.external_id;
  const size = Math.max(1, Number.isFinite(batchSize) ? batchSize : 100);
  if (dryRun) {
    return {
      dry_run: true,
      index: { name, external_id: ext },
      chunks: normalized.chunks.length,
      dimensions: normalized.dimensions,
      batches: Math.ceil(normalized.chunks.length / size),
    };
  }
  const index = await ensureIndex({ baseUrl, key, name, externalId: ext });
  let upserted = 0;
  for (let start = 0; start < normalized.chunks.length; start += size) {
    const batch = normalized.chunks.slice(start, start + size);
    const result = await requestJson(`${baseUrl}/v1/indexes/${index.id}/ingest-vectors`, {
      key,
      method: 'POST',
      body: { chunks: batch },
    });
    upserted += Number(result.upserted || 0);
  }
  return { dry_run: false, index, chunks: normalized.chunks.length, upserted };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const input = await readFile(args.input, 'utf8');
    const result = await backfill({ ...args, input });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    usage();
    console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
