#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GAP_MATRIX_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../full-port-gaps.json');

export const FULL_PORT_ITEMS = Object.freeze(JSON.parse(readFileSync(GAP_MATRIX_PATH, 'utf8')));

export function fullPortReport({ items = FULL_PORT_ITEMS } = {}) {
  const matrix = items.map((item) => ({ ...item }));
  const remaining = matrix.filter((item) => item.status !== 'done').length;
  return {
    ok: remaining === 0,
    total: matrix.length,
    remaining,
    items: matrix,
  };
}

export async function runFullPortGapGate({ items = FULL_PORT_ITEMS } = {}) {
  const payload = fullPortReport({ items });
  return {
    ok: payload.ok,
    exit_code: payload.ok ? 0 : 1,
    payload,
  };
}

function printHuman(report) {
  for (const item of report.items) {
    const status = item.status === 'done' ? 'DONE' : item.status.toUpperCase();
    console.log(`${status} ${item.feature}`);
    if (item.status !== 'done') console.log(`  gap: ${item.gap}`);
  }
  console.log(`\nremaining=${report.remaining} of ${report.total}`);
}

function usage() {
  console.error(`Usage:
  node scripts/full-port-gaps.mjs [--json] [--require-complete]

Options:
  --json              Print machine-readable JSON.
  --require-complete  Exit non-zero while any full-port blocker remains.`);
}

function parseArgs(argv) {
  const args = { jsonOnly: false, requireComplete: false };
  for (const arg of argv) {
    if (arg === '--') continue;
    if (arg === '--json') args.jsonOnly = true;
    else if (arg === '--require-complete') args.requireComplete = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = fullPortReport();
    if (args.jsonOnly) console.log(JSON.stringify(report, null, 2));
    else printHuman(report);
    if (args.requireComplete && !report.ok) process.exitCode = 1;
  } catch (error) {
    usage();
    console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
