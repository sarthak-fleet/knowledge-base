#!/usr/bin/env node

import { auditSiblingRagService } from './audit-sibling-rag-service.mjs';
import { EXPECTED_DEPLOY_FINGERPRINT, runDeployedLegacyRouteSmoke, runDeployReadiness } from './deploy-readiness.mjs';
import { runFullPortGapGate } from './full-port-gaps.mjs';
import { runWorkerPreflight } from './preflight.mjs';

const DEFAULT_BASE_URL = 'https://knowledgebase.sarthakagrawal927.workers.dev';

function usage() {
  console.error(`Usage:
  node scripts/sibling-retirement-readiness.mjs [--base-url https://knowledgebase.<subdomain>.workers.dev] [--key <service-key>] [--allow-live-ocr] [--json]

Checks whether it is safe to retire the sibling ../rag-service folder.
This command is read-only and does not delete anything.

Requirements:
  - deployed Worker health/auth checks pass
  - deployed NVDA scanned-PDF OCR eval passes
  - deployed root compatibility aliases and deploy fingerprint pass
  - Worker-local preflight passes
  - no fleet repo actively references the old rag-service
  - full-port gap matrix is complete or only sibling_rag_service_retirement remains`);
}

function parseArgs(argv) {
  const out = {
    baseUrl: process.env.RAG_BASE_URL || DEFAULT_BASE_URL,
    key: process.env.RAG_SERVICE_KEY || '',
    expectedDeployFingerprint: process.env.RAG_EXPECTED_DEPLOY_FINGERPRINT || EXPECTED_DEPLOY_FINGERPRINT,
    allowLiveOcr: process.env.RAG_ALLOW_LIVE_OCR === '1',
    jsonOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--json') {
      out.jsonOnly = true;
      continue;
    }
    if (arg === '--allow-live-ocr') {
      out.allowLiveOcr = true;
      continue;
    }
    const value = argv[i + 1];
    if (!value) throw new Error(`missing value for ${arg}`);
    i += 1;
    if (arg === '--base-url') out.baseUrl = value;
    else if (arg === '--key') out.key = value;
    else if (arg === '--expected-deploy-fingerprint') out.expectedDeployFingerprint = value;
    else throw new Error(`unknown argument: ${arg}`);
  }
  out.baseUrl = out.baseUrl.replace(/\/+$/, '');
  return out;
}

function check(name, ok, detail = {}) {
  return { name, ok, ...detail };
}

function remainingGapFeatures(fullPort) {
  const payload = fullPort.payload && typeof fullPort.payload === 'object' ? fullPort.payload : {};
  if (!Array.isArray(payload.items)) return [];
  return payload.items
    .filter((item) => item?.status !== 'done')
    .map((item) => item.feature)
    .filter(Boolean)
    .sort();
}

export async function runSiblingRetirementReadiness(options) {
  const checks = [];
  const expectedDeployFingerprint = options.expectedDeployFingerprint || EXPECTED_DEPLOY_FINGERPRINT;

  const legacyRoutes = await (options.legacyRouteRunner ?? runDeployedLegacyRouteSmoke)({
    baseUrl: options.baseUrl,
    expectedDeployFingerprint,
  });
  checks.push(check('deployed-legacy-route-parity', legacyRoutes.ok, {
    checked: legacyRoutes.checked,
    failed: Array.isArray(legacyRoutes.failed) ? legacyRoutes.failed : [],
  }));
  checks.push(check('deployed-worker-fingerprint', legacyRoutes.deploy_fingerprint === expectedDeployFingerprint, {
    deploy_fingerprint: legacyRoutes.deploy_fingerprint ?? null,
    expected_deploy_fingerprint: expectedDeployFingerprint,
  }));

  const deployedCurrentForOcr = legacyRoutes.ok && legacyRoutes.deploy_fingerprint === expectedDeployFingerprint;
  const deployed = await (options.deployReadinessRunner ?? runDeployReadiness)({
    baseUrl: options.baseUrl,
    key: options.key,
    exportInput: '',
    requireAuth: true,
    requireNvdaOcr: deployedCurrentForOcr,
    allowLiveOcr: options.allowLiveOcr === true,
    expectedDeployFingerprint,
  });
  const failedDeployedChecks = Array.isArray(deployed.checks)
    ? deployed.checks.filter((item) => !item.ok).map((item) => item.name).filter(Boolean)
    : [];
  if (!deployedCurrentForOcr) failedDeployedChecks.push('nvda-scanned-ocr-live');
  checks.push(check('deployed-auth-and-ocr-ready', deployed.ok && deployedCurrentForOcr, {
    failed_checks: [...new Set(failedDeployedChecks)],
    live_ocr_skipped_until_current_deploy: !deployedCurrentForOcr,
  }));

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
  checks.push(check('no-active-external-rag-service-references', siblingAudit.external_references_ok === true, {
    active_external_reference_count: Array.isArray(siblingAudit.active_external_references)
      ? siblingAudit.active_external_references.length
      : null,
  }));
  checks.push(check('sibling-rag-service-delete-target-known', siblingAudit.sibling_exists === true || siblingAudit.ok === true, {
    sibling_exists: siblingAudit.sibling_exists === true,
    sibling_deployable_surfaces: Array.isArray(siblingAudit.sibling_deployable_surfaces)
      ? siblingAudit.sibling_deployable_surfaces
      : [],
  }));

  const fullPort = await (options.fullPortRunner ?? runFullPortGapGate)();
  const remainingFeatures = remainingGapFeatures(fullPort);
  const onlySiblingGapRemains = remainingFeatures.length === 0
    || (remainingFeatures.length === 1 && remainingFeatures[0] === 'sibling_rag_service_retirement');
  checks.push(check('full-port-gaps-clear-for-sibling-retirement', onlySiblingGapRemains, {
    remaining_features: remainingFeatures,
    exit_code: fullPort.exit_code ?? null,
    error: fullPort.error ?? null,
  }));

  const siblingGapOpen = remainingFeatures.includes('sibling_rag_service_retirement');
  const siblingExists = siblingAudit.sibling_exists === true;
  checks.push(check('sibling-retirement-gap-matches-audit', siblingGapOpen === siblingExists, {
    sibling_exists: siblingExists,
    sibling_gap_open: siblingGapOpen,
    remaining_features: remainingFeatures,
  }));

  return {
    ok: checks.every((item) => item.ok),
    base_url: options.baseUrl,
    checks,
  };
}

function printHuman(result) {
  for (const item of result.checks) {
    const status = item.ok ? 'PASS' : 'FAIL';
    console.log(`${status} ${item.name}`);
  }
  console.log(`\n${result.ok ? 'READY' : 'NOT READY'} sibling-rag-service-retirement ${result.base_url}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await runSiblingRetirementReadiness(args);
    if (args.jsonOnly) console.log(JSON.stringify(result, null, 2));
    else printHuman(result);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    usage();
    console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
