#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const FLEET_ROOT = resolve(REPO_ROOT, '..');

function usage() {
  console.error(`Usage:
  node scripts/consumer-auth-smokes.mjs [--json] [--require-authenticated]

Runs public consumer smoke checks plus non-UI authenticated consumer smoke
commands when their session cookies are available:
  - Karte public demo chat: /api/chat/atlas-demo/conversations + /api/chat/atlas-demo
  - Starboard public app: /
  - Karte: KARTE_SESSION_COOKIE + scripts/smoke-profile-memory.mjs
  - Starboard: STARBOARD_SESSION_COOKIE + scripts/smoke-knowledgebase.mjs

Without cookies, the command reports explicit skipped evidence instead of
pretending the product session flow was verified.`);
}

function parseArgs(argv) {
  const out = { jsonOnly: false, requireAuthenticated: false };
  for (const arg of argv) {
    if (arg === '--') continue;
    if (arg === '--json') out.jsonOnly = true;
    else if (arg === '--require-authenticated') out.requireAuthenticated = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function run(command, args, { cwd, env }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(String(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
    child.on('close', (code) => {
      resolve({
        exit_code: code,
        stdout: stdout.join('').trim(),
        stderr: stderr.join('').trim(),
      });
    });
  });
}

function consumerConfigs(fleetRoot) {
  return [
    {
      consumer: 'karte',
      repo: resolve(fleetRoot, 'karte'),
      cookieEnv: 'KARTE_SESSION_COOKIE',
      command: ['pnpm', ['smoke:profile-memory']],
    },
    {
      consumer: 'starboard',
      repo: resolve(fleetRoot, 'starboard'),
      cookieEnv: 'STARBOARD_SESSION_COOKIE',
      command: ['pnpm', ['smoke:knowledgebase', '--', '--sync']],
    },
  ];
}

function consumerPublicConfigs(env) {
  return [
    {
      consumer: 'karte',
      baseUrl: env.KARTE_BASE_URL || 'https://karte.cc',
      kind: 'public_demo_chat',
    },
    {
      consumer: 'starboard',
      baseUrl: env.STARBOARD_BASE_URL || 'https://starboard.sarthakagrawal927.workers.dev',
      kind: 'public_app',
    },
  ];
}

async function requestText(fetchImpl, url, init = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const started = Date.now();
    const res = await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
    const text = await res.text().catch(() => '');
    return { res, text, ms: Date.now() - started };
  } finally {
    clearTimeout(timeout);
  }
}

async function requestJson(fetchImpl, url, init = {}, timeoutMs = 10000) {
  const result = await requestText(fetchImpl, url, init, timeoutMs);
  let body = null;
  try {
    body = result.text ? JSON.parse(result.text) : null;
  } catch {
    body = result.text;
  }
  return { ...result, body };
}

async function runKartePublicSmoke(fetchImpl, baseUrl) {
  const root = baseUrl.replace(/\/+$/, '');
  const visitorEmail = `kb-public-smoke-${Date.now()}@example.com`;
  const visitorId = `kb-public-smoke-${Date.now()}`;
  const conversation = await requestJson(fetchImpl, `${root}/api/chat/atlas-demo/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ visitorId, visitorEmail }),
  });
  if (conversation.res.status !== 201 || !conversation.body?.id) {
    return {
      ok: false,
      status: conversation.res.status,
      blocker: 'karte_public_conversation_failed',
      latency_ms: conversation.ms,
    };
  }

  const chat = await requestText(fetchImpl, `${root}/api/chat/atlas-demo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversationId: conversation.body.id,
      visitorEmail,
      query: 'what is this profile about?',
    }),
  }, 15000);
  const ok = chat.res.status === 200 && chat.text.trim().length > 0;
  return {
    ok,
    status: chat.res.status,
    blocker: ok ? null : 'karte_public_chat_failed',
    conversation_latency_ms: conversation.ms,
    latency_ms: chat.ms,
    response_preview: chat.text.slice(0, 160),
  };
}

async function runStarboardPublicSmoke(fetchImpl, baseUrl) {
  const result = await requestText(fetchImpl, `${baseUrl.replace(/\/+$/, '')}/`);
  const ok = result.res.status === 200 && result.text.includes('Starboard');
  return {
    ok,
    status: result.res.status,
    blocker: ok ? null : 'starboard_public_app_failed',
    latency_ms: result.ms,
  };
}

async function runConsumerPublicSmokes(options = {}) {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const consumers = [];
  for (const config of consumerPublicConfigs(env)) {
    try {
      const result = config.kind === 'public_demo_chat'
        ? await runKartePublicSmoke(fetchImpl, config.baseUrl)
        : await runStarboardPublicSmoke(fetchImpl, config.baseUrl);
      consumers.push({
        consumer: config.consumer,
        public: true,
        kind: config.kind,
        base_url: config.baseUrl,
        ...result,
      });
    } catch (error) {
      consumers.push({
        consumer: config.consumer,
        public: true,
        kind: config.kind,
        base_url: config.baseUrl,
        ok: false,
        blocker: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return consumers;
}

export async function runConsumerAuthSmokes(options = {}) {
  const fleetRoot = resolve(options.fleetRoot ?? FLEET_ROOT);
  const env = options.env ?? process.env;
  const publicConsumers = await runConsumerPublicSmokes(options);
  const consumers = [];

  for (const config of consumerConfigs(fleetRoot)) {
    const hasRepo = existsSync(config.repo);
    const cookie = String(env[config.cookieEnv] ?? '').trim();
    if (!hasRepo) {
      consumers.push({
        consumer: config.consumer,
        ok: false,
        authenticated: false,
        skipped: false,
        blocker: 'repo_missing',
        repo: config.repo,
      });
      continue;
    }
    if (!cookie) {
      consumers.push({
        consumer: config.consumer,
        ok: false,
        authenticated: false,
        skipped: true,
        blocker: `${config.cookieEnv}_missing`,
        repo: config.repo,
      });
      continue;
    }
    const [command, args] = config.command;
    const result = await run(command, args, { cwd: config.repo, env });
    consumers.push({
      consumer: config.consumer,
      ok: result.exit_code === 0,
      authenticated: result.exit_code === 0,
      skipped: false,
      exit_code: result.exit_code,
      repo: config.repo,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }

  const publicOk = publicConsumers.every((consumer) => consumer.ok);
  const noHardAuthenticatedBlockers = consumers.every((consumer) => consumer.ok || consumer.skipped === true);
  return {
    ok: publicOk && noHardAuthenticatedBlockers,
    public: publicOk,
    authenticated: consumers.every((consumer) => consumer.authenticated),
    public_consumers: publicConsumers,
    consumers,
    blockers: consumers
      .filter((consumer) => !consumer.ok)
      .map((consumer) => `${consumer.consumer}:${consumer.blocker ?? 'smoke_failed'}`),
    public_blockers: publicConsumers
      .filter((consumer) => !consumer.ok)
      .map((consumer) => `${consumer.consumer}:${consumer.blocker ?? 'public_smoke_failed'}`),
  };
}

function printHuman(report) {
  console.log(`${report.ok ? 'READY' : 'NOT READY'} consumer authenticated smokes`);
  for (const consumer of report.public_consumers ?? []) {
    const state = consumer.ok ? 'PASS' : 'FAIL';
    const detail = consumer.blocker ? ` - ${consumer.blocker}` : '';
    console.log(`  ${state} ${consumer.consumer} public${detail}`);
  }
  for (const consumer of report.consumers) {
    const state = consumer.skipped ? 'SKIP' : consumer.ok ? 'PASS' : 'FAIL';
    const detail = consumer.blocker ? ` - ${consumer.blocker}` : '';
    console.log(`  ${state} ${consumer.consumer}${detail}`);
  }
  if (report.public_blockers?.length > 0) console.log(`public_blockers=${report.public_blockers.join(',')}`);
  if (report.blockers.length > 0) console.log(`blockers=${report.blockers.join(',')}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = await runConsumerAuthSmokes();
    if (args.jsonOnly) console.log(JSON.stringify(report, null, 2));
    else printHuman(report);
    if (args.requireAuthenticated && !report.authenticated) process.exitCode = 1;
  } catch (error) {
    usage();
    console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

export { parseArgs, runConsumerPublicSmokes };
