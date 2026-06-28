#!/usr/bin/env node

import { spawn } from 'node:child_process';

export const LOCAL_PREDEPLOY_STEPS = [
  {
    name: 'worker-check',
    command: ['pnpm', 'run', 'check'],
  },
  {
    name: 'preflight',
    command: ['pnpm', 'run', 'preflight', '--', '--json'],
  },
  {
    name: 'python-runtime-retirement',
    command: ['pnpm', 'run', 'audit:python-runtime-retirement', '--', '--json', '--require-complete'],
  },
  {
    name: 'external-rag-service-references',
    command: ['pnpm', 'run', 'audit:no-external-rag-service-references', '--', '--json'],
  },
  {
    name: 'consumer-rag-integrations',
    command: ['pnpm', 'run', 'audit:consumer-rag-integrations', '--', '--json', '--require-complete'],
  },
  {
    name: 'consumer-public-smoke',
    command: ['pnpm', 'run', 'smoke:consumer-auth', '--', '--json'],
  },
  {
    name: 'typed-client-contract',
    command: ['pnpm', 'run', 'audit:client-contract', '--', '--json', '--require-complete'],
  },
  {
    name: 'consumer-cloudflare-builds',
    command: ['pnpm', 'run', 'build:consumer-cloudflare', '--', '--json'],
  },
  {
    name: 'free-ai-embedding-contract',
    command: ['pnpm', 'run', 'audit:free-ai-embedding-contract', '--', '--json', '--require-complete'],
  },
  {
    name: 'free-ai-local-check',
    command: ['pnpm', '--dir', '../../../free-ai', 'run', 'check'],
  },
  {
    name: 'vectorize-embedding-bindings',
    command: ['pnpm', 'run', 'audit:vectorize-embedding-bindings', '--', '--json'],
  },
  {
    name: 'full-port-gaps',
    command: ['pnpm', 'run', 'gaps:full-port', '--', '--json', '--require-complete'],
  },
  {
    name: 'embedding-release-plan',
    command: ['pnpm', 'run', 'release-plan:embedding-model', '--', '--json'],
  },
  {
    name: 'nvda-scanned-ocr-dry-run',
    command: ['pnpm', 'run', 'eval:parse:nvda-scanned:dry-run'],
  },
  {
    name: 'local-cutover-smoke',
    command: ['pnpm', 'run', 'smoke:local-cutover', '--', '--json'],
  },
  {
    name: 'deploy-dry-run',
    command: ['pnpm', 'run', 'deploy:dry-run'],
  },
];

function usage() {
  console.error(`Usage:
  node scripts/predeploy-local.mjs [--json]

Runs the local predeploy gate for the Cloudflare cutover:
  - pnpm run check
  - pnpm run preflight -- --json
  - pnpm run audit:python-runtime-retirement -- --json --require-complete
  - pnpm run audit:no-external-rag-service-references -- --json
  - pnpm run audit:consumer-rag-integrations -- --json --require-complete
  - pnpm run smoke:consumer-auth -- --json
  - pnpm run audit:client-contract -- --json --require-complete
  - pnpm run build:consumer-cloudflare -- --json
  - pnpm run audit:free-ai-embedding-contract -- --json --require-complete
  - pnpm --dir ../../../free-ai run check
  - pnpm run audit:vectorize-embedding-bindings -- --json
  - pnpm run gaps:full-port -- --json --require-complete
  - pnpm run release-plan:embedding-model -- --json
  - pnpm run eval:parse:nvda-scanned:dry-run
  - pnpm run smoke:local-cutover -- --json
  - pnpm run deploy:dry-run`);
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

function defaultRunCommand(command, { cwd = process.cwd() } = {}) {
  return new Promise((resolve) => {
    const [bin, ...args] = command;
    const child = spawn(process.platform === 'win32' && bin === 'pnpm' ? 'pnpm.cmd' : bin, args, {
      cwd,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let settled = false;
    const stdout = [];
    const stderr = [];
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
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

export async function runLocalPredeployGate({ runCommand = defaultRunCommand, cwd = process.cwd() } = {}) {
  const checks = [];
  for (const step of LOCAL_PREDEPLOY_STEPS) {
    const started = Date.now();
    const result = await runCommand(step.command, { cwd, step: step.name });
    const ok = result.exit_code === 0;
    checks.push({
      name: step.name,
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
    ok: checks.length === LOCAL_PREDEPLOY_STEPS.length && checks.every((item) => item.ok),
    checks,
  };
}

function printHuman(result) {
  for (const item of result.checks) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name} exit=${item.exit_code ?? item.signal ?? 'unknown'} duration_ms=${item.duration_ms}`);
    if (!item.ok) {
      if (item.stdout_tail) console.log(item.stdout_tail);
      if (item.stderr_tail) console.error(item.stderr_tail);
    }
  }
  console.log(`\n${result.ok ? 'READY' : 'NOT READY'} local-predeploy`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await runLocalPredeployGate();
    if (args.jsonOnly) console.log(JSON.stringify(result, null, 2));
    else printHuman(result);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    usage();
    console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
