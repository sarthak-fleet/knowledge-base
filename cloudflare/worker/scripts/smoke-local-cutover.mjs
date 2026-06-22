#!/usr/bin/env node

import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { EXPECTED_DEPLOY_FINGERPRINT, runDeployedLegacyRouteSmoke } from './deploy-readiness.mjs';

const DEFAULT_STARTUP_TIMEOUT_MS = 45_000;
const DEFAULT_HOST = '127.0.0.1';

function usage() {
  console.error(`Usage:
  node scripts/smoke-local-cutover.mjs [--port 0] [--startup-timeout-ms 45000] [--expected-deploy-fingerprint ${EXPECTED_DEPLOY_FINGERPRINT}] [--json]

Options:
  --port <port>                  Port for wrangler dev. Use 0 for an ephemeral port.
  --startup-timeout-ms <ms>      How long to wait for /v1/healthz before failing.
  --expected-deploy-fingerprint  Required /healthz deploy_fingerprint.
  --json                         Print machine-readable JSON.`);
}

function parseArgs(argv) {
  const out = {
    port: Number(process.env.RAG_LOCAL_SMOKE_PORT || 0),
    startupTimeoutMs: Number(process.env.RAG_LOCAL_SMOKE_STARTUP_TIMEOUT_MS || DEFAULT_STARTUP_TIMEOUT_MS),
    expectedDeployFingerprint: process.env.RAG_EXPECTED_DEPLOY_FINGERPRINT || EXPECTED_DEPLOY_FINGERPRINT,
    jsonOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--json') {
      out.jsonOnly = true;
      continue;
    }
    const value = argv[i + 1];
    if (!value) throw new Error(`missing value for ${arg}`);
    i += 1;
    if (arg === '--port') out.port = Number(value);
    else if (arg === '--startup-timeout-ms') out.startupTimeoutMs = Number(value);
    else if (arg === '--expected-deploy-fingerprint') out.expectedDeployFingerprint = value;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(out.port) || out.port < 0 || out.port > 65535) throw new Error('port must be an integer from 0 to 65535');
  if (!Number.isFinite(out.startupTimeoutMs) || out.startupTimeoutMs <= 0) throw new Error('startup timeout must be positive');
  return out;
}

async function pickPort(requestedPort) {
  if (requestedPort !== 0) return requestedPort;
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, DEFAULT_HOST, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else resolvePort(port);
      });
    });
  });
}

function sleep(ms) {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

async function waitForHealth(baseUrl, timeoutMs, child, logs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited before health was ready: ${logs.slice(-20).join('\n')}`);
    try {
      const response = await fetch(`${baseUrl}/v1/healthz`);
      const payload = await response.json().catch(() => ({}));
      if (response.ok && payload?.ok === true) return payload;
      lastError = `status=${response.status} payload=${JSON.stringify(payload).slice(0, 500)}`;
    } catch (error) {
      lastError = String(error instanceof Error ? error.message : error);
    }
    await sleep(500);
  }
  throw new Error(`timed out waiting for local Worker health: ${lastError}`);
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolveStop) => child.once('exit', resolveStop)),
    sleep(3000).then(() => {
      if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL');
    }),
  ]);
}

export async function runLocalCutoverSmoke({
  port = 0,
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
  expectedDeployFingerprint = EXPECTED_DEPLOY_FINGERPRINT,
} = {}) {
  const selectedPort = await pickPort(port);
  const baseUrl = `http://${DEFAULT_HOST}:${selectedPort}`;
  const logs = [];
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const child = spawn(command, [
    'exec',
    'wrangler',
    'dev',
    '--local',
    '--ip',
    DEFAULT_HOST,
    '--port',
    String(selectedPort),
    '--var',
    'RAG_ALLOW_UNMIGRATED_LOCAL_D1:true',
  ], {
    cwd: process.cwd(),
    env: { ...process.env, NO_COLOR: '1', RAG_ALLOW_UNMIGRATED_LOCAL_D1: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => logs.push(String(chunk).trimEnd()));
  child.stderr.on('data', (chunk) => logs.push(String(chunk).trimEnd()));
  try {
    const health = await waitForHealth(baseUrl, startupTimeoutMs, child, logs);
    const legacyRoutes = await runDeployedLegacyRouteSmoke({ baseUrl, expectedDeployFingerprint });
    return {
      ok: legacyRoutes.ok,
      base_url: baseUrl,
      health,
      legacy_routes: legacyRoutes,
      wrangler_log_tail: logs.slice(-20),
    };
  } finally {
    await stopChild(child);
  }
}

function printHuman(result) {
  console.log(`${result.ok ? 'READY' : 'NOT READY'} local-cutover ${result.base_url}`);
  console.log(`health deploy_fingerprint=${result.health?.deploy_fingerprint ?? 'missing'}`);
  console.log(`legacy-route-smoke checked=${result.legacy_routes.checked} failed=${result.legacy_routes.failed.length}`);
  if (!result.ok) {
    for (const item of result.legacy_routes.failed) {
      console.log(`  ${item.method} ${item.path} expected=${item.expected.join('/')} actual=${item.status ?? item.error ?? 'error'}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await runLocalCutoverSmoke(args);
    if (args.jsonOnly) console.log(JSON.stringify(result, null, 2));
    else printHuman(result);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    usage();
    console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
