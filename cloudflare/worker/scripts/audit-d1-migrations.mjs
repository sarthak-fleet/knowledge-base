#!/usr/bin/env node

import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');

const REQUIRED_MIGRATIONS = [
  {
    name: 'index_embedding_model_columns',
    file: '0005_index_embedding_model.sql',
    patterns: [
      /ALTER\s+TABLE\s+indexes\s+ADD\s+COLUMN\s+embedding_model\s+TEXT\b/i,
      /ALTER\s+TABLE\s+indexes\s+ADD\s+COLUMN\s+embedding_provider\s+TEXT\b/i,
    ],
  },
  {
    name: 'kb_domain_embedding_model_columns',
    file: '0006_kb_domain_embedding_model.sql',
    patterns: [
      /ALTER\s+TABLE\s+kb_domains\s+ADD\s+COLUMN\s+embedding_model\s+TEXT\b/i,
      /ALTER\s+TABLE\s+kb_domains\s+ADD\s+COLUMN\s+embedding_provider\s+TEXT\b/i,
    ],
  },
  {
    name: 'embedding_cache_table',
    file: '0007_embedding_cache.sql',
    patterns: [
      /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+embedding_cache\b/i,
      /\bcache_key\s+TEXT\s+PRIMARY\s+KEY\b/i,
      /\btenant\s+TEXT\s+NOT\s+NULL\b/i,
      /\bvector\s+TEXT\s+NOT\s+NULL\b/i,
      /\bexpires_at\s+INTEGER\s+NOT\s+NULL\b/i,
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_embedding_cache_expires\b/i,
    ],
  },
];

function check(name, ok, detail = {}) {
  return { name, ok, ...detail };
}

export async function auditD1Migrations({ migrationsDir = DEFAULT_MIGRATIONS_DIR } = {}) {
  const checks = [];
  let files = [];

  try {
    files = await readdir(migrationsDir);
    checks.push(check('migrations_dir', true, { migrations_dir: migrationsDir, migration_count: files.length }));
  } catch (error) {
    checks.push(check('migrations_dir', false, {
      migrations_dir: migrationsDir,
      error: String(error instanceof Error ? error.message : error),
    }));
    return {
      ok: false,
      migrations_dir: migrationsDir,
      checks,
      blockers: checks.filter((item) => !item.ok),
    };
  }

  for (const migration of REQUIRED_MIGRATIONS) {
    const path = resolve(migrationsDir, migration.file);
    if (!files.includes(migration.file)) {
      checks.push(check(migration.name, false, {
        file: migration.file,
        error: 'required migration file is missing',
      }));
      continue;
    }

    const sql = await readFile(path, 'utf8');
    const missingPatterns = migration.patterns
      .filter((pattern) => !pattern.test(sql))
      .map((pattern) => String(pattern));
    checks.push(check(migration.name, missingPatterns.length === 0, {
      file: migration.file,
      missing_patterns: missingPatterns,
    }));
  }

  const blockers = checks.filter((item) => !item.ok);
  return {
    ok: blockers.length === 0,
    migrations_dir: migrationsDir,
    checks,
    blockers,
  };
}

function usage() {
  console.error(`Usage:
  node scripts/audit-d1-migrations.mjs [--migrations-dir ./migrations] [--json] [--require-complete]

Options:
  --migrations-dir <path>  Migration directory. Defaults to ./migrations.
  --json                   Print machine-readable JSON.
  --require-complete       Exit non-zero when required migration coverage is missing.`);
}

function parseArgs(argv) {
  const args = {
    migrationsDir: DEFAULT_MIGRATIONS_DIR,
    jsonOnly: false,
    requireComplete: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--json') {
      args.jsonOnly = true;
      continue;
    }
    if (arg === '--require-complete') {
      args.requireComplete = true;
      continue;
    }
    if (arg === '--migrations-dir') {
      const value = argv[i + 1];
      if (!value) throw new Error('missing value for --migrations-dir');
      args.migrationsDir = resolve(process.cwd(), value);
      i += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function printHuman(report) {
  for (const item of report.checks) {
    console.log(`${item.ok ? 'OK' : 'FAIL'} ${item.name}${item.file ? ` ${item.file}` : ''}`);
    if (item.error) console.log(`  ${item.error}`);
    if (Array.isArray(item.missing_patterns) && item.missing_patterns.length > 0) {
      for (const pattern of item.missing_patterns) console.log(`  missing ${pattern}`);
    }
  }
  console.log(`\n${report.ok ? 'PASS' : 'FAIL'} d1-migrations blockers=${report.blockers.length}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const report = await auditD1Migrations({ migrationsDir: args.migrationsDir });
    if (args.jsonOnly) console.log(JSON.stringify(report, null, 2));
    else printHuman(report);
    if (args.requireComplete && !report.ok) process.exitCode = 1;
  } catch (error) {
    usage();
    console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
