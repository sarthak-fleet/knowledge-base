#!/usr/bin/env node

import { EXPECTED_DEPLOY_FINGERPRINT } from './deploy-readiness.mjs';

const DEFAULT_BASE_URL = process.env.RAG_BASE_URL || 'https://knowledgebase.sarthakagrawal927.workers.dev';
const DEFAULT_EXPECTED_DEPLOY_FINGERPRINT = process.env.RAG_EXPECTED_DEPLOY_FINGERPRINT || EXPECTED_DEPLOY_FINGERPRINT;
const DEFAULT_QUERY = 'codex cloudflare rag smoke unique retrieval token';
const DEFAULT_DOCUMENT = [
  'Codex Cloudflare RAG smoke document.',
  'This document contains the unique retrieval token:',
  DEFAULT_QUERY,
].join(' ');

function usage() {
  console.error(`Usage:
  node scripts/smoke-rag-crud.mjs [--base-url https://knowledgebase.<subdomain>.workers.dev] [--key <service-key>] [--json] [--require-complete]

Options:
  --base-url <url>     Worker URL. Defaults to RAG_BASE_URL or ${DEFAULT_BASE_URL}.
  --key <service-key>  Service key. Defaults to RAG_SERVICE_KEY.
  --index-name <name>  Temporary index name. Defaults to a timestamped smoke name.
  --include-kb-domain
                      Also smoke the knowledgebase custom-input path by ingesting domain text through /v1/kb/ingest/text and querying /v1/kb/search.
  --kb-domain <name>  Temporary KB domain name when --include-kb-domain is set. Defaults to a timestamped smoke name.
  --embedding-model <id>
                      Optional free-ai embedding model id to verify through /v1/embedding-models and use for the temporary index.
                      Defaults to RAG_SMOKE_EMBEDDING_MODEL.
  --expected-deploy-fingerprint <value>
                      Required /v1/healthz deploy_fingerprint before any mutation.
                      Defaults to RAG_EXPECTED_DEPLOY_FINGERPRINT or ${EXPECTED_DEPLOY_FINGERPRINT}.
  --query <query>      Query/document token to verify. Defaults to a unique smoke token.
  --json               Print machine-readable JSON.
  --require-complete   Exit non-zero unless create, ingest, query, and cleanup pass.

This is an authenticated live smoke. It creates a temporary index, ingests one
document, queries it, and deletes the index in cleanup. With --include-kb-domain
it also creates a temporary KB domain/index via the custom-input text ingest
path, queries it, and deletes the generated domain index. Do not run it without
explicit approval for live Worker mutations and embedding usage.`);
}

function parseArgs(argv) {
  const out = {
    baseUrl: DEFAULT_BASE_URL,
    key: process.env.RAG_SERVICE_KEY || '',
    indexName: `codex-rag-smoke-${Date.now()}`,
    includeKbDomain: false,
    kbDomain: `codex-rag-smoke-domain-${Date.now()}`,
    embeddingModel: process.env.RAG_SMOKE_EMBEDDING_MODEL || '',
    expectedDeployFingerprint: DEFAULT_EXPECTED_DEPLOY_FINGERPRINT,
    query: DEFAULT_QUERY,
    jsonOnly: false,
    requireComplete: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--json') {
      out.jsonOnly = true;
      continue;
    }
    if (arg === '--require-complete') {
      out.requireComplete = true;
      continue;
    }
    if (arg === '--include-kb-domain') {
      out.includeKbDomain = true;
      continue;
    }
    const value = argv[i + 1];
    if (!value) throw new Error(`missing value for ${arg}`);
    i += 1;
    if (arg === '--base-url') out.baseUrl = value;
    else if (arg === '--key') out.key = value;
    else if (arg === '--index-name') out.indexName = value;
    else if (arg === '--kb-domain') {
      out.kbDomain = value;
      out.includeKbDomain = true;
    }
    else if (arg === '--embedding-model') out.embeddingModel = value;
    else if (arg === '--expected-deploy-fingerprint') out.expectedDeployFingerprint = value;
    else if (arg === '--query') out.query = value;
    else throw new Error(`unknown argument: ${arg}`);
  }
  out.baseUrl = out.baseUrl.replace(/\/+$/, '');
  return out;
}

function check(name, ok, detail = {}) {
  return { name, ok, ...detail };
}

async function requestJson(fetchImpl, url, { key, method = 'GET', body } = {}) {
  const headers = {
    ...(key ? { Authorization: `Bearer ${key}` } : {}),
    ...(body ? { 'Content-Type': 'application/json' } : {}),
  };
  const res = await fetchImpl(url, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let payload = {};
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { text };
    }
  }
  return { status: res.status, ok: res.ok, payload };
}

export async function runRagCrudSmoke(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const key = options.key ?? process.env.RAG_SERVICE_KEY ?? '';
  const indexName = options.indexName ?? `codex-rag-smoke-${Date.now()}`;
  const includeKbDomain = options.includeKbDomain === true;
  const kbDomain = options.kbDomain ?? `codex-rag-smoke-domain-${Date.now()}`;
  const embeddingModel = options.embeddingModel ?? process.env.RAG_SMOKE_EMBEDDING_MODEL ?? '';
  const expectedDeployFingerprint = options.expectedDeployFingerprint ?? DEFAULT_EXPECTED_DEPLOY_FINGERPRINT;
  const query = options.query ?? DEFAULT_QUERY;
  const document = options.document ?? DEFAULT_DOCUMENT.replace(DEFAULT_QUERY, query);
  const checks = [];
  let indexId = null;
  let kbIndexId = null;
  let cleanup = null;
  let kbCleanup = null;
  let expectedEmbeddingModel = embeddingModel || null;
  let expectedEmbeddingProvider = null;
  let expectedEmbeddingDimensions = null;

  if (!key) {
    checks.push(check('service-key-present', false, {
      skipped: true,
      reason: 'RAG_SERVICE_KEY or --key is required for authenticated live smoke',
    }));
    return {
      ok: false,
      base_url: baseUrl,
      index_id: null,
      checks,
      cleanup: null,
    };
  }

  try {
    const health = await requestJson(fetchImpl, `${baseUrl}/v1/healthz`, { key });
    const healthDeployFingerprint = typeof health.payload?.deploy_fingerprint === 'string' ? health.payload.deploy_fingerprint : null;
    const healthReady = health.ok
      && health.payload?.ok === true
      && health.payload?.d1 === true
      && health.payload?.d1_schema === true
      && health.payload?.vectorize === true
      && health.payload?.r2 === true;
    checks.push(check('deployed-health', healthReady, {
      status: health.status,
      ok: health.payload?.ok === true,
      d1: health.payload?.d1 === true,
      d1_schema: health.payload?.d1_schema === true,
      d1_schema_check_skipped: health.payload?.d1_schema_check_skipped === true,
      vectorize: health.payload?.vectorize === true,
      r2: health.payload?.r2 === true,
      deploy_fingerprint: healthDeployFingerprint,
      error: typeof health.payload?.error === 'string' ? health.payload.error.slice(0, 200) : undefined,
    }));
    checks.push(check('deployed-worker-fingerprint', healthDeployFingerprint === expectedDeployFingerprint, {
      deploy_fingerprint: healthDeployFingerprint,
      expected_deploy_fingerprint: expectedDeployFingerprint,
    }));
    if (!healthReady) {
      throw new Error('deployed health is not ready for mutating RAG CRUD smoke');
    }
    if (healthDeployFingerprint !== expectedDeployFingerprint) {
      throw new Error(`deployed fingerprint does not match expected ${expectedDeployFingerprint}`);
    }

    if (embeddingModel) {
      const models = await requestJson(fetchImpl, `${baseUrl}/v1/embedding-models`, { key });
      const availableModels = Array.isArray(models.payload?.free_ai_models) ? models.payload.free_ai_models : [];
      const selected = availableModels.find((item) => item?.id === embeddingModel || item?.aliases?.includes?.(embeddingModel)) ?? null;
      const dynamicCatalog = models.payload?.catalog_source === 'free_ai';
      expectedEmbeddingModel = typeof selected?.id === 'string' ? selected.id : embeddingModel;
      expectedEmbeddingProvider = typeof selected?.provider === 'string' ? selected.provider : null;
      expectedEmbeddingDimensions = typeof selected?.dimensions === 'number' ? selected.dimensions : null;
      checks.push(check('embedding-model-catalog', models.ok
        && dynamicCatalog
        && selected?.enabled !== false
        && Boolean(selected)
        && Boolean(selected?.compatible_profile)
        && Boolean(selected?.vectorize_binding)
        && selected?.selectable === true, {
        status: models.status,
        embedding_model: embeddingModel,
        catalog_source: typeof models.payload?.catalog_source === 'string' ? models.payload.catalog_source : null,
        catalog_error: typeof models.payload?.catalog_error === 'string' ? models.payload.catalog_error : null,
        provider: typeof selected?.provider === 'string' ? selected.provider : null,
        dimensions: typeof selected?.dimensions === 'number' ? selected.dimensions : null,
        resolved_embedding_model: expectedEmbeddingModel,
        compatible_profile: typeof selected?.compatible_profile === 'string' ? selected.compatible_profile : null,
        vectorize_binding: typeof selected?.vectorize_binding === 'string' ? selected.vectorize_binding : null,
        selectable: selected?.selectable === true,
      }));
      if (!dynamicCatalog) throw new Error('embedding model catalog is not backed by live free-ai models');
      if (!selected || selected.enabled === false) throw new Error(`embedding model is not enabled in catalog: ${embeddingModel}`);
      if (!selected.compatible_profile || !selected.vectorize_binding || selected.selectable !== true) {
        throw new Error(`embedding model is not compatible with a configured Vectorize binding: ${embeddingModel}`);
      }
    }

    const created = await requestJson(fetchImpl, `${baseUrl}/v1/indexes`, {
      key,
      method: 'POST',
      body: {
        name: indexName,
        ...(embeddingModel ? { embedding_model: embeddingModel } : {}),
      },
    });
    indexId = typeof created.payload?.id === 'string' ? created.payload.id : null;
    const createdEmbeddingModel = typeof created.payload?.embedding_model === 'string' ? created.payload.embedding_model : null;
    const createdEmbeddingProvider = typeof created.payload?.embedding_provider === 'string' ? created.payload.embedding_provider : null;
    const createdDimensions = typeof created.payload?.dimensions === 'number' ? created.payload.dimensions : null;
    const selectedModelPersisted = !embeddingModel
      || (createdEmbeddingModel === expectedEmbeddingModel
        && createdEmbeddingProvider === expectedEmbeddingProvider
        && createdDimensions === expectedEmbeddingDimensions);
    checks.push(check('create-index', created.ok && Boolean(indexId) && selectedModelPersisted, {
      status: created.status,
      index_id: indexId,
      dimensions: createdDimensions,
      requested_embedding_model: embeddingModel || null,
      expected_embedding_model: expectedEmbeddingModel,
      expected_embedding_provider: expectedEmbeddingProvider,
      expected_embedding_dimensions: expectedEmbeddingDimensions,
      embedding_model: createdEmbeddingModel,
      embedding_provider: createdEmbeddingProvider,
    }));
    if (!indexId) throw new Error('create-index did not return an id');
    if (embeddingModel && !selectedModelPersisted) {
      throw new Error(`create-index did not persist selected embedding model ${expectedEmbeddingModel} (${expectedEmbeddingProvider}, ${expectedEmbeddingDimensions}d) for request ${embeddingModel}`);
    }

    const ingested = await requestJson(fetchImpl, `${baseUrl}/v1/indexes/${indexId}/ingest`, {
      key,
      method: 'POST',
      body: {
        documents: [{
          external_id: `${indexName}-doc`,
          content: document,
          metadata: { smoke: true, source: 'smoke-rag-crud' },
        }],
      },
    });
    const chunksCreated = Array.isArray(ingested.payload?.documents)
      ? ingested.payload.documents.reduce((sum, item) => sum + Number(item?.chunks_created ?? 0), 0)
      : 0;
    checks.push(check('ingest-document', ingested.ok && chunksCreated > 0, {
      status: ingested.status,
      chunks_created: chunksCreated,
    }));

    const queried = await requestJson(fetchImpl, `${baseUrl}/v1/indexes/${indexId}/query`, {
      key,
      method: 'POST',
      body: {
        query,
        top_k: 5,
        mode: 'hybrid',
        min_score: 0,
      },
    });
    const results = Array.isArray(queried.payload?.data) ? queried.payload.data : [];
    const matched = results.some((result) => String(result?.chunk_content ?? '').includes(query));
    checks.push(check('query-document', queried.ok && matched, {
      status: queried.status,
      result_count: results.length,
      matched,
    }));

    if (includeKbDomain) {
      const savedDomain = await requestJson(fetchImpl, `${baseUrl}/v1/kb/domains`, {
        key,
        method: 'POST',
        body: {
          name: kbDomain,
          description: 'temporary live smoke domain',
          ...(embeddingModel ? { embedding_model: embeddingModel } : {}),
        },
      });
      checks.push(check('kb-domain-upsert', savedDomain.ok
        && savedDomain.payload?.name === kbDomain
        && (!embeddingModel || (
          savedDomain.payload?.embedding_model === expectedEmbeddingModel
          && savedDomain.payload?.embedding_provider === expectedEmbeddingProvider
        )), {
        status: savedDomain.status,
        domain: savedDomain.payload?.name ?? null,
        requested_embedding_model: embeddingModel || null,
        expected_embedding_model: expectedEmbeddingModel,
        expected_embedding_provider: expectedEmbeddingProvider,
        embedding_model: typeof savedDomain.payload?.embedding_model === 'string' ? savedDomain.payload.embedding_model : null,
        embedding_provider: typeof savedDomain.payload?.embedding_provider === 'string' ? savedDomain.payload.embedding_provider : null,
      }));
      if (!savedDomain.ok) throw new Error(`kb domain upsert failed for ${kbDomain}`);

      const kbIngested = await requestJson(fetchImpl, `${baseUrl}/v1/kb/ingest/text`, {
        key,
        method: 'POST',
        body: {
          domain: kbDomain,
          title: 'live smoke custom input',
          text: document,
          async: false,
          ...(embeddingModel ? { embedding_model: embeddingModel } : {}),
        },
      });
      const chunksIndexed = Number(kbIngested.payload?.chunks_indexed ?? (
        Array.isArray(kbIngested.payload?.files)
          ? kbIngested.payload.files.reduce((sum, item) => sum + Number(item?.chunks_created ?? 0), 0)
          : 0
      ));
      checks.push(check('kb-ingest-text', kbIngested.ok && chunksIndexed > 0, {
        status: kbIngested.status,
        domain: kbIngested.payload?.domain ?? kbDomain,
        chunks_indexed: Number.isFinite(chunksIndexed) ? chunksIndexed : 0,
      }));
      if (!kbIngested.ok || chunksIndexed <= 0) throw new Error(`kb text ingest failed for ${kbDomain}`);

      const kbIndexes = await requestJson(fetchImpl, `${baseUrl}/v1/indexes`, { key });
      const kbIndex = Array.isArray(kbIndexes.payload?.data)
        ? kbIndexes.payload.data.find((item) => item?.external_id === `kb:${kbDomain}`) ?? null
        : null;
      kbIndexId = typeof kbIndex?.id === 'string' ? kbIndex.id : null;
      checks.push(check('kb-domain-index-discovered', kbIndexes.ok && Boolean(kbIndexId), {
        status: kbIndexes.status,
        domain: kbDomain,
        index_id: kbIndexId,
        external_id: kbIndex?.external_id ?? null,
        embedding_model: typeof kbIndex?.embedding_model === 'string' ? kbIndex.embedding_model : null,
        embedding_provider: typeof kbIndex?.embedding_provider === 'string' ? kbIndex.embedding_provider : null,
      }));
      if (!kbIndexId) throw new Error(`kb domain index not found for ${kbDomain}`);

      const kbSearched = await requestJson(fetchImpl, `${baseUrl}/v1/kb/search`, {
        key,
        method: 'POST',
        body: {
          domain: kbDomain,
          query,
          top_k: 5,
          mode: 'hybrid',
        },
      });
      const kbResults = Array.isArray(kbSearched.payload?.data) ? kbSearched.payload.data : [];
      const kbMatched = kbResults.some((result) => String(result?.chunk_content ?? '').includes(query));
      checks.push(check('kb-search-text', kbSearched.ok && kbMatched, {
        status: kbSearched.status,
        domain: kbSearched.payload?.domain ?? kbDomain,
        index_id: kbSearched.payload?.index_id ?? kbIndexId,
        result_count: kbResults.length,
        matched: kbMatched,
      }));
    }
  } catch (error) {
    checks.push(check('rag-crud-error', false, {
      error: String(error instanceof Error ? error.message : error),
    }));
  } finally {
    if (kbIndexId) {
      try {
        const deleted = await requestJson(fetchImpl, `${baseUrl}/v1/indexes/${kbIndexId}`, {
          key,
          method: 'DELETE',
        });
        kbCleanup = {
          ok: deleted.ok,
          status: deleted.status,
          index_id: kbIndexId,
        };
        checks.push(check('cleanup-kb-domain-index', deleted.ok, kbCleanup));
      } catch (error) {
        kbCleanup = {
          ok: false,
          index_id: kbIndexId,
          error: String(error instanceof Error ? error.message : error),
        };
        checks.push(check('cleanup-kb-domain-index', false, kbCleanup));
      }
    }
    if (indexId) {
      try {
        const deleted = await requestJson(fetchImpl, `${baseUrl}/v1/indexes/${indexId}`, {
          key,
          method: 'DELETE',
        });
        cleanup = {
          ok: deleted.ok,
          status: deleted.status,
        };
        checks.push(check('cleanup-index', deleted.ok, cleanup));
      } catch (error) {
        cleanup = {
          ok: false,
          error: String(error instanceof Error ? error.message : error),
        };
        checks.push(check('cleanup-index', false, cleanup));
      }
    }
  }

  return {
    ok: checks.every((item) => item.ok),
    base_url: baseUrl,
    index_id: indexId,
    kb_domain: includeKbDomain ? kbDomain : null,
    kb_index_id: kbIndexId,
    embedding_model: embeddingModel || null,
    expected_deploy_fingerprint: expectedDeployFingerprint,
    checks,
    cleanup,
    kb_cleanup: kbCleanup,
  };
}

function printHuman(report) {
  for (const item of report.checks) {
    const detail = item.status ? ` status=${item.status}` : item.error ? ` error=${item.error}` : '';
    console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name}${detail}`);
  }
  console.log(`\n${report.ok ? 'READY' : 'NOT READY'} rag-crud-smoke base_url=${report.base_url}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = await runRagCrudSmoke(args);
    if (args.jsonOnly) console.log(JSON.stringify(report, null, 2));
    else printHuman(report);
    if (args.requireComplete && !report.ok) process.exitCode = 1;
  } catch (error) {
    usage();
    console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
