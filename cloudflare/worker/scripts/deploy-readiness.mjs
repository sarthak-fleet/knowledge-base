#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditSiblingRagService } from './audit-sibling-rag-service.mjs';
import { runFullPortGapGate } from './full-port-gaps.mjs';
import { runLegacyParseEval } from './legacy-parse-eval.mjs';
import { runWorkerPreflight } from './preflight.mjs';
import { smokeSaasMakerExport } from './smoke-saas-maker-export.mjs';

const DEFAULT_BASE_URL = 'https://knowledgebase.sarthakagrawal927.workers.dev';
const NVDA_SCANNED_HASH = 'a56062aa2ee3c2eb6e1128e440e4ab683641e2ef4ccfa7e955538676a02c4c39';
const NVDA_SCANNED_FILENAME = 'NVDA_riskfactors_sample_scanned.pdf';
const NVDA_VISION_MODEL_CHAIN = '@cf/meta/llama-3.2-11b-vision-instruct,@cf/meta/llama-4-scout-17b-16e-instruct';
export const EXPECTED_DEPLOY_FINGERPRINT = 'knowledgebase-cloudflare-embedding-models-2026-06-21';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function usage() {
  console.error(`Usage:
  node scripts/deploy-readiness.mjs [--base-url https://knowledgebase.<subdomain>.workers.dev]

Options:
  --key <service-key>       Service key for authenticated checks. Defaults to RAG_SERVICE_KEY.
  --export-input <path>     SaaS Maker export JSON to smoke through ingest-vectors.
  --require-auth            Fail if no service key is available.
  --require-embedding-model <id>
                            Read-only authenticated check that /v1/embedding-models is backed by live free-ai rows and exposes this enabled model.
                            Defaults to RAG_REQUIRED_EMBEDDING_MODEL.
  --require-nvda-ocr        Fail unless the deployed NVDA scanned-PDF OCR eval passes.
  --allow-live-ocr          Allow the live OCR eval to call Workers AI. Can also be set with RAG_ALLOW_LIVE_OCR=1.
  --require-full-port       Fail unless local bindings and the full-port gap gate are complete.
  --expected-deploy-fingerprint <value>
                            Expected /healthz deploy_fingerprint. Defaults to RAG_EXPECTED_DEPLOY_FINGERPRINT or ${EXPECTED_DEPLOY_FINGERPRINT}.
  --json                    Print JSON only.

Default checks do not require secrets:
  - GET /v1/healthz returns ok, D1, required D1 schema, Vectorize, and R2 true
  - GET /v1/indexes without a key is rejected with 401

Full-port checks use Worker-local Node gates:
  - deployed root legacy aliases and deploy fingerprint before live OCR
  - node scripts/preflight.mjs --json
  - node scripts/audit-sibling-rag-service.mjs --json --require-retired
  - node scripts/full-port-gaps.mjs --json --require-complete`);
}

function parseArgs(argv) {
  const out = {
    baseUrl: process.env.RAG_BASE_URL || DEFAULT_BASE_URL,
    key: process.env.RAG_SERVICE_KEY || '',
    exportInput: '',
    requireAuth: false,
    requireEmbeddingModel: process.env.RAG_REQUIRED_EMBEDDING_MODEL || '',
    requireNvdaOcr: false,
    allowLiveOcr: process.env.RAG_ALLOW_LIVE_OCR === '1',
    requireFullPort: false,
    expectedDeployFingerprint: process.env.RAG_EXPECTED_DEPLOY_FINGERPRINT || EXPECTED_DEPLOY_FINGERPRINT,
    jsonOnly: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--require-auth') {
      out.requireAuth = true;
      continue;
    }
    if (arg === '--require-nvda-ocr') {
      out.requireNvdaOcr = true;
      continue;
    }
    if (arg === '--allow-live-ocr') {
      out.allowLiveOcr = true;
      continue;
    }
    if (arg === '--require-full-port') {
      out.requireFullPort = true;
      continue;
    }
    if (arg === '--json') {
      out.jsonOnly = true;
      continue;
    }
    const value = argv[i + 1];
    if (!value) throw new Error(`missing value for ${arg}`);
    i += 1;
    if (arg === '--base-url') out.baseUrl = value;
    else if (arg === '--key') out.key = value;
    else if (arg === '--export-input') out.exportInput = value;
    else if (arg === '--require-embedding-model') out.requireEmbeddingModel = value;
    else if (arg === '--expected-deploy-fingerprint') out.expectedDeployFingerprint = value;
    else throw new Error(`unknown argument: ${arg}`);
  }

  out.baseUrl = out.baseUrl.replace(/\/+$/, '');
  return out;
}

async function requestJson(url, { key, method = 'GET' } = {}) {
  const headers = key ? { Authorization: `Bearer ${key}` } : {};
  const res = await fetch(url, { method, headers });
  const payload = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, payload };
}

async function requestStatus(url, { method = 'GET' } = {}) {
  const res = await fetch(url, { method });
  const contentType = res.headers.get('content-type') ?? '';
  const payload = contentType.includes('application/json') ? await res.json().catch(() => ({})) : {};
  return { status: res.status, ok: res.ok, payload };
}

async function requestText(url, { method = 'GET' } = {}) {
  const res = await fetch(url, { method });
  return {
    status: res.status,
    ok: res.ok,
    content_type: res.headers.get('content-type') ?? '',
    text: await res.text().catch(() => ''),
  };
}

function check(name, ok, detail = {}) {
  return { name, ok, ...detail };
}

function nvdaOcrRemediation(error) {
  const message = String(error ?? '').toLowerCase();
  if (!message) return null;
  if (!message.includes('llama-3.2') && !message.includes('license') && !message.includes('agree')) return null;
  return 'Run pnpm run workers-ai:accept-llama32-vision-license with CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_AUTH_TOKEN, then rerun readiness:full-port.';
}

async function runDefaultNvdaOcrEval({ baseUrl, key }) {
  try {
    const result = await runLegacyParseEval({
      exportPath: '',
      rawRoot: resolve(REPO_ROOT, 'data/minio/kb-bucket'),
      parseRoot: resolve(REPO_ROOT, 'data/minio/kb-bucket'),
      baseUrl,
      key,
      markdownConversion: 'auto',
      visionOcrModel: NVDA_VISION_MODEL_CHAIN,
      directDomain: 'sec',
      directContentHash: NVDA_SCANNED_HASH,
      directFilename: NVDA_SCANNED_FILENAME,
      directMime: 'application/pdf',
      expectedPerCase: 3,
      filenameContains: NVDA_SCANNED_FILENAME,
      includeTextPreview: true,
      requireCases: true,
      minPassRate: 1,
      dryRun: false,
    });
    const summary = result.summary ?? {};
    return {
      ok: typeof summary.pass_rate === 'number' && summary.pass_rate >= 1,
      summary,
    };
  } catch (error) {
    return {
      ok: false,
      error: String(error instanceof Error ? error.message : error),
    };
  }
}

export async function runDeployedLegacyRouteSmoke({ baseUrl, expectedDeployFingerprint = EXPECTED_DEPLOY_FINGERPRINT }) {
  const publicRoutes = [
    { method: 'GET', path: '/healthz', expected: [200] },
    { method: 'GET', path: '/readyz', expected: [200] },
    { method: 'GET', path: '/metrics', expected: [200] },
  ];
  const protectedRoutes = [
    { method: 'GET', path: '/domains', expected: [401] },
    { method: 'POST', path: '/domains', expected: [401] },
    { method: 'POST', path: '/search', expected: [401] },
    { method: 'POST', path: '/agent/search', expected: [401] },
    { method: 'POST', path: '/search/eval', expected: [401] },
    { method: 'POST', path: '/query', expected: [401] },
    { method: 'POST', path: '/query/stream', expected: [401] },
    { method: 'GET', path: '/query/traces', expected: [401] },
  ];

  const checks = [];
  for (const route of [...publicRoutes, ...protectedRoutes]) {
    try {
      const result = await requestStatus(`${baseUrl}${route.path}`, { method: route.method });
      checks.push({
        ...route,
        status: result.status,
        deploy_fingerprint: route.path === '/healthz' && typeof result.payload?.deploy_fingerprint === 'string'
          ? result.payload.deploy_fingerprint
          : null,
        ok: route.expected.includes(result.status),
      });
    } catch (error) {
      checks.push({
        ...route,
        status: null,
        ok: false,
        error: String(error instanceof Error ? error.message : error),
      });
    }
  }
  const deployFingerprint = checks.find((item) => item.path === '/healthz')?.deploy_fingerprint ?? null;
  const fingerprintOk = deployFingerprint === expectedDeployFingerprint;
  const failed = checks.filter((item) => !item.ok);
  const healthStatusAlreadyFailed = failed.some((item) => item.path === '/healthz');
  const failedWithFingerprint = fingerprintOk || healthStatusAlreadyFailed
    ? failed
    : [
      ...failed,
      {
        method: 'GET',
        path: '/healthz',
        expected: [200],
        status: checks.find((item) => item.path === '/healthz')?.status ?? null,
        deploy_fingerprint: deployFingerprint,
        expected_deploy_fingerprint: expectedDeployFingerprint,
        ok: false,
        error: 'unexpected deploy fingerprint',
      },
    ];
  return {
    ok: failedWithFingerprint.length === 0,
    checked: checks.length,
    failed: failedWithFingerprint,
    deploy_fingerprint: deployFingerprint,
    expected_deploy_fingerprint: expectedDeployFingerprint,
    fingerprint_ok: fingerprintOk,
    checks,
  };
}

export async function runDeployedTestingUiSmoke({ baseUrl }) {
  const requiredMarkers = [
    'Knowledgebase Cloudflare',
    'id="embeddingModel"',
    'function applyEmbeddingSelectionForm(form)',
    '/v1/kb/domains',
    '/v1/kb/ingest/text',
    '/v1/kb/search',
  ];
  const routes = ['/', '/ui'];
  const checks = [];
  for (const path of routes) {
    try {
      const result = await requestText(`${baseUrl}${path}`);
      const missing_markers = requiredMarkers.filter((marker) => !result.text.includes(marker));
      checks.push({
        path,
        status: result.status,
        content_type: result.content_type,
        missing_markers,
        ok: result.ok
          && result.status === 200
          && result.content_type.includes('text/html')
          && missing_markers.length === 0,
      });
    } catch (error) {
      checks.push({
        path,
        status: null,
        content_type: '',
        missing_markers: requiredMarkers,
        ok: false,
        error: String(error instanceof Error ? error.message : error),
      });
    }
  }
  const failed = checks.filter((item) => !item.ok);
  return {
    ok: failed.length === 0,
    checked: checks.length,
    failed,
    checks,
  };
}

export async function runDeployReadiness(options) {
  const checks = [];
  const expectedDeployFingerprint = options.expectedDeployFingerprint || EXPECTED_DEPLOY_FINGERPRINT;

  const health = await requestJson(`${options.baseUrl}/v1/healthz`);
  const healthDeployFingerprint = typeof health.payload?.deploy_fingerprint === 'string' ? health.payload.deploy_fingerprint : null;
  checks.push(check('public-health', health.ok
    && health.payload?.ok === true
    && health.payload?.d1 === true
    && health.payload?.d1_schema === true
    && health.payload?.vectorize === true
    && health.payload?.r2 === true, {
    status: health.status,
    payload: health.payload,
    deploy_fingerprint: healthDeployFingerprint,
    d1_schema: typeof health.payload?.d1_schema === 'boolean' ? health.payload.d1_schema : null,
    r2: typeof health.payload?.r2 === 'boolean' ? health.payload.r2 : null,
  }));
  checks.push(check('deployed-worker-fingerprint', healthDeployFingerprint === expectedDeployFingerprint, {
    deploy_fingerprint: healthDeployFingerprint,
    expected_deploy_fingerprint: expectedDeployFingerprint,
  }));

  const protectedProbe = await requestJson(`${options.baseUrl}/v1/indexes`);
  checks.push(check('protected-indexes-require-auth', protectedProbe.status === 401, {
    status: protectedProbe.status,
  }));

  if (!options.key) {
    checks.push(check('authenticated-key-present', !options.requireAuth, {
      skipped: true,
      reason: 'RAG_SERVICE_KEY or --key is required for authenticated checks',
    }));
    if (options.requireEmbeddingModel) {
      checks.push(check('embedding-model-catalog', false, {
        skipped: true,
        reason: 'RAG_SERVICE_KEY or --key is required for the embedding model catalog check',
        embedding_model: options.requireEmbeddingModel,
      }));
    }
  } else {
    const indexes = await requestJson(`${options.baseUrl}/v1/indexes`, { key: options.key });
    checks.push(check('authenticated-index-list', indexes.ok && Array.isArray(indexes.payload?.data), {
      status: indexes.status,
      count: Array.isArray(indexes.payload?.data) ? indexes.payload.data.length : null,
    }));

    if (options.requireEmbeddingModel) {
      const models = await requestJson(`${options.baseUrl}/v1/embedding-models`, { key: options.key });
      const availableModels = Array.isArray(models.payload?.free_ai_models) ? models.payload.free_ai_models : [];
      const selected = availableModels.find((item) =>
        item?.id === options.requireEmbeddingModel || item?.aliases?.includes?.(options.requireEmbeddingModel),
      ) ?? null;
      checks.push(check(
        'embedding-model-catalog',
        models.ok
          && models.payload?.catalog_source === 'free_ai'
          && selected?.enabled !== false
          && Boolean(selected)
          && Boolean(selected?.compatible_profile)
          && Boolean(selected?.vectorize_binding),
        {
          status: models.status,
          embedding_model: options.requireEmbeddingModel,
          catalog_source: typeof models.payload?.catalog_source === 'string' ? models.payload.catalog_source : null,
          catalog_error: typeof models.payload?.catalog_error === 'string' ? models.payload.catalog_error : null,
          provider: typeof selected?.provider === 'string' ? selected.provider : null,
          dimensions: typeof selected?.dimensions === 'number' ? selected.dimensions : null,
          compatible_profile: typeof selected?.compatible_profile === 'string' ? selected.compatible_profile : null,
          vectorize_binding: typeof selected?.vectorize_binding === 'string' ? selected.vectorize_binding : null,
        },
      ));
    }

    if (options.exportInput) {
      const input = await readFile(options.exportInput, 'utf8');
      const smoke = await smokeSaasMakerExport({
        baseUrl: options.baseUrl,
        key: options.key,
        input,
        topK: 5,
        limit: 5,
        settleMs: 5000,
        maxWaitMs: 60000,
        pollMs: 3000,
        keepIndex: false,
        dryRun: false,
      });
      checks.push(check('authenticated-export-smoke', smoke.hit_rate === 1, {
        hit_rate: smoke.hit_rate,
        latency: smoke.latency,
        attempts: smoke.attempts,
        waited_ms: smoke.waited_ms,
      }));
    }
  }

  let deployedCurrentForOcr = !options.requireFullPort;
  if (options.requireFullPort) {
    const legacyRoutes = await (options.legacyRouteRunner ?? runDeployedLegacyRouteSmoke)({
      baseUrl: options.baseUrl,
      expectedDeployFingerprint,
    });
    checks.push(check('deployed-legacy-route-parity', legacyRoutes.ok, {
      checked: legacyRoutes.checked,
      failed: Array.isArray(legacyRoutes.failed) ? legacyRoutes.failed : [],
    }));
    checks.push(check(
      'deployed-worker-fingerprint',
      legacyRoutes.deploy_fingerprint === expectedDeployFingerprint,
      {
        deploy_fingerprint: legacyRoutes.deploy_fingerprint ?? null,
        expected_deploy_fingerprint: expectedDeployFingerprint,
      },
    ));
    deployedCurrentForOcr = legacyRoutes.ok && legacyRoutes.deploy_fingerprint === expectedDeployFingerprint;

    if (deployedCurrentForOcr) {
      const testingUi = await (options.testingUiRunner ?? runDeployedTestingUiSmoke)({ baseUrl: options.baseUrl });
      checks.push(check('deployed-testing-ui', testingUi.ok, {
        checked: testingUi.checked,
        failed: Array.isArray(testingUi.failed) ? testingUi.failed : [],
      }));
    } else {
      checks.push(check('deployed-testing-ui', false, {
        skipped: true,
        reason: 'deployed legacy aliases and deploy fingerprint must pass before checking the hosted testing UI',
      }));
    }
  }

  if (options.requireNvdaOcr) {
    if (!options.key) {
      checks.push(check('nvda-scanned-ocr-live', false, {
        skipped: true,
        reason: 'RAG_SERVICE_KEY or --key is required for the live OCR eval',
      }));
    } else if (!deployedCurrentForOcr) {
      checks.push(check('nvda-scanned-ocr-live', false, {
        skipped: true,
        reason: 'deployed legacy aliases and deploy fingerprint must pass before running the live OCR eval',
      }));
    } else if (!options.allowLiveOcr) {
      checks.push(check('nvda-scanned-ocr-live', false, {
        skipped: true,
        reason: 'set RAG_ALLOW_LIVE_OCR=1 or pass --allow-live-ocr to run the live Workers AI OCR eval',
      }));
    } else {
      const ocr = await (options.nvdaOcrRunner ?? runDefaultNvdaOcrEval)({
        baseUrl: options.baseUrl,
        key: options.key,
      });
      const summary = ocr.summary && typeof ocr.summary === 'object' ? ocr.summary : {};
      checks.push(check('nvda-scanned-ocr-live', ocr.ok, {
        pass_rate: typeof summary.pass_rate === 'number' ? summary.pass_rate : null,
        n: Number.isFinite(summary.n) ? summary.n : null,
        failed: Array.isArray(summary.failed) ? summary.failed : [],
        report_ids: Array.isArray(summary.report_ids) ? summary.report_ids : [],
        error: ocr.error ?? null,
        remediation: nvdaOcrRemediation(ocr.error),
      }));
    }
  }

  if (options.requireFullPort) {
    const preflight = await (options.preflightRunner ?? runWorkerPreflight)();
    checks.push(check('worker-local-preflight', preflight.ok, {
      errors: Number.isFinite(preflight.errors) ? preflight.errors : null,
      warnings: Number.isFinite(preflight.warnings) ? preflight.warnings : null,
      failed_checks: Array.isArray(preflight.checks)
        ? preflight.checks
          .filter((item) => item?.severity === 'error')
          .map((item) => item.name)
          .filter(Boolean)
        : [],
    }));

    const siblingAudit = await (options.siblingAuditRunner ?? auditSiblingRagService)();
    checks.push(check('sibling-rag-service-retired', siblingAudit.ok === true, {
      sibling_exists: siblingAudit.sibling_exists === true,
      sibling_deployable_surfaces: Array.isArray(siblingAudit.sibling_deployable_surfaces)
        ? siblingAudit.sibling_deployable_surfaces
        : [],
      active_external_reference_count: Array.isArray(siblingAudit.active_external_references)
        ? siblingAudit.active_external_references.length
        : null,
      blockers: Array.isArray(siblingAudit.blockers) ? siblingAudit.blockers : [],
    }));

    const fullPort = await (options.fullPortRunner ?? runFullPortGapGate)();
    const payload = fullPort.payload && typeof fullPort.payload === 'object' ? fullPort.payload : {};
    const remaining = Number.isFinite(payload.remaining) ? payload.remaining : null;
    const remainingFeatures = Array.isArray(payload.items)
      ? payload.items.filter((item) => item?.status !== 'done').map((item) => item.feature).filter(Boolean)
      : [];
    checks.push(check('cloudflare-full-port-complete', fullPort.ok && payload.ok === true, {
      exit_code: fullPort.exit_code ?? null,
      remaining,
      remaining_features: remainingFeatures,
      error: fullPort.error ?? null,
    }));
  }

  return {
    ok: checks.every((item) => item.ok),
    base_url: options.baseUrl,
    checks,
  };
}

function printHuman(result) {
  for (const item of result.checks) {
    const status = item.ok ? 'PASS' : 'FAIL';
    const suffix = item.skipped ? ` (${item.reason})` : '';
    console.log(`${status} ${item.name}${suffix}`);
  }
  console.log(`\n${result.ok ? 'READY' : 'NOT READY'} ${result.base_url}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await runDeployReadiness(args);
    if (args.jsonOnly) console.log(JSON.stringify(result, null, 2));
    else printHuman(result);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    usage();
    console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
