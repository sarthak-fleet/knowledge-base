#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const FLEET_ROOT = resolve(REPO_ROOT, '..');

export const CONSUMER_CLOUDFLARE_BUILD_STEPS = [
  {
    name: 'karte-cf-build',
    repo: 'karte',
    cwd: resolve(FLEET_ROOT, 'karte'),
    command: ['pnpm', 'run', 'cf:build'],
  },
  {
    name: 'starboard-build-cf',
    repo: 'starboard',
    cwd: resolve(FLEET_ROOT, 'starboard'),
    command: ['pnpm', 'run', 'build:cf'],
  },
];

function usage() {
  console.error(`Usage:
  node scripts/consumer-cloudflare-builds.mjs [--json]

Builds the checked-out consumer Cloudflare bundles required before approved
consumer deploys:
  - ../../../karte pnpm run cf:build
  - ../../../starboard pnpm run build:cf

This is local build verification only. It does not deploy or mutate live
Cloudflare resources.`);
}

function parseArgs(argv) {
  const out = { jsonOnly: false };
  for (const arg of argv) {
    if (arg === '--') continue;
    if (arg === '--json') out.jsonOnly = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function defaultRunCommand(step) {
  return new Promise((resolveResult) => {
    const [bin, ...args] = step.command;
    const child = spawn(process.platform === 'win32' && bin === 'pnpm' ? 'pnpm.cmd' : bin, args, {
      cwd: step.cwd,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    const stdout = [];
    const stderr = [];
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolveResult(result);
    };
    child.stdout.on('data', (chunk) => stdout.push(String(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
    child.once('error', (error) => {
      finish({
        exit_code: null,
        signal: 'spawn_error',
        stdout: stdout.join('').trim(),
        stderr: [stderr.join('').trim(), error.message].filter(Boolean).join('\n'),
      });
    });
    child.once('exit', (code, signal) => {
      finish({
        exit_code: typeof code === 'number' ? code : null,
        signal: signal ?? null,
        stdout: stdout.join('').trim(),
        stderr: stderr.join('').trim(),
      });
    });
  });
}

export async function runConsumerCloudflareBuilds({
  steps = CONSUMER_CLOUDFLARE_BUILD_STEPS,
  runCommand = defaultRunCommand,
} = {}) {
  const checks = [];
  for (const step of steps) {
    const started = Date.now();
    const result = await runCommand(step);
    const ok = result.exit_code === 0;
    checks.push({
      name: step.name,
      repo: step.repo,
      cwd: relative(FLEET_ROOT, step.cwd),
      ok,
      command: step.command.join(' '),
      exit_code: result.exit_code,
      signal: result.signal ?? null,
      duration_ms: Date.now() - started,
      stdout_tail: result.stdout ? result.stdout.slice(-2000) : '',
      stderr_tail: result.stderr ? result.stderr.slice(-2000) : '',
    });
    if (!ok) break;
  }
  return {
    ok: checks.length === steps.length && checks.every((item) => item.ok),
    checks,
  };
}

function printHuman(report) {
  for (const check of report.checks) {
    console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.name} ${check.command} cwd=${check.cwd} exit=${check.exit_code ?? check.signal ?? 'unknown'} duration_ms=${check.duration_ms}`);
    if (!check.ok) {
      if (check.stdout_tail) console.log(check.stdout_tail);
      if (check.stderr_tail) console.error(check.stderr_tail);
    }
  }
  console.log(`\n${report.ok ? 'READY' : 'NOT READY'} consumer-cloudflare-builds`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = await runConsumerCloudflareBuilds();
    if (args.jsonOnly) console.log(JSON.stringify(report, null, 2));
    else printHuman(report);
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    usage();
    console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
