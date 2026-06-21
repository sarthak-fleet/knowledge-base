#!/usr/bin/env node

import { EXPECTED_DEPLOY_FINGERPRINT, runDeployedLegacyRouteSmoke } from './deploy-readiness.mjs';

const DEFAULT_BASE_URL = process.env.RAG_BASE_URL || 'http://localhost:8787';
const DEFAULT_EXPECTED_DEPLOY_FINGERPRINT = process.env.RAG_EXPECTED_DEPLOY_FINGERPRINT || EXPECTED_DEPLOY_FINGERPRINT;

function usage() {
  console.error(`Usage:
  node scripts/smoke-legacy-routes.mjs [--base-url http://localhost:8787] [--expected-deploy-fingerprint ${EXPECTED_DEPLOY_FINGERPRINT}] [--json] [--require-complete]

Options:
  --base-url <url>      Worker URL to check. Defaults to RAG_BASE_URL or http://localhost:8787.
  --expected-deploy-fingerprint <value>
                        Required /healthz deploy_fingerprint. Defaults to RAG_EXPECTED_DEPLOY_FINGERPRINT or ${EXPECTED_DEPLOY_FINGERPRINT}.
  --json                Print machine-readable JSON.
  --require-complete    Exit non-zero when any legacy alias smoke or deploy fingerprint check fails.`);
}

function parseArgs(argv) {
  const out = {
    baseUrl: DEFAULT_BASE_URL,
    expectedDeployFingerprint: DEFAULT_EXPECTED_DEPLOY_FINGERPRINT,
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
    const value = argv[i + 1];
    if (!value) throw new Error(`missing value for ${arg}`);
    i += 1;
    if (arg === '--base-url') out.baseUrl = value;
    else if (arg === '--expected-deploy-fingerprint') out.expectedDeployFingerprint = value;
    else throw new Error(`unknown argument: ${arg}`);
  }
  out.baseUrl = out.baseUrl.replace(/\/+$/, '');
  return out;
}

function printHuman(report) {
  for (const item of report.checks) {
    const expected = item.expected.join('/');
    const actual = item.status ?? item.error ?? 'error';
    const fingerprint = item.deploy_fingerprint ? ` deploy_fingerprint=${item.deploy_fingerprint}` : '';
    console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.method} ${item.path} expected=${expected} actual=${actual}${fingerprint}`);
  }
  console.log(`${report.fingerprint_ok ? 'PASS' : 'FAIL'} deploy_fingerprint expected=${report.expected_deploy_fingerprint} actual=${report.deploy_fingerprint ?? 'missing'}`);
  console.log(`\n${report.ok ? 'READY' : 'NOT READY'} legacy-route-smoke checked=${report.checked} failed=${report.failed.length}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = await runDeployedLegacyRouteSmoke({
      baseUrl: args.baseUrl,
      expectedDeployFingerprint: args.expectedDeployFingerprint,
    });
    if (args.jsonOnly) console.log(JSON.stringify(report, null, 2));
    else printHuman(report);
    if (args.requireComplete && !report.ok) process.exitCode = 1;
  } catch (error) {
    usage();
    console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
