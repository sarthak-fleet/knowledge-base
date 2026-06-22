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

Runs the non-UI authenticated consumer smoke commands when their session cookies
are available:
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

export async function runConsumerAuthSmokes(options = {}) {
  const fleetRoot = resolve(options.fleetRoot ?? FLEET_ROOT);
  const env = options.env ?? process.env;
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

  return {
    ok: consumers.every((consumer) => consumer.ok),
    authenticated: consumers.every((consumer) => consumer.authenticated),
    consumers,
    blockers: consumers
      .filter((consumer) => !consumer.ok)
      .map((consumer) => `${consumer.consumer}:${consumer.blocker ?? 'smoke_failed'}`),
  };
}

function printHuman(report) {
  console.log(`${report.ok ? 'READY' : 'NOT READY'} consumer authenticated smokes`);
  for (const consumer of report.consumers) {
    const state = consumer.skipped ? 'SKIP' : consumer.ok ? 'PASS' : 'FAIL';
    const detail = consumer.blocker ? ` - ${consumer.blocker}` : '';
    console.log(`  ${state} ${consumer.consumer}${detail}`);
  }
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

export { parseArgs };
