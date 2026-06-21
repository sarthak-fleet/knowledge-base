#!/usr/bin/env node

import { readdir, readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

function usage() {
  console.error(`Usage:
  node scripts/migrate-raw-files.mjs --input ./raw-export --domain manuals --base-url http://localhost:8787 --key <service-key>
  node scripts/migrate-raw-files.mjs --manifest raw-manifest.json --base-url http://localhost:8787 --key <service-key>
  node scripts/migrate-raw-files.mjs --object-root ./minio-export/raw --base-url http://localhost:8787 --key <service-key>

Manifest shape:
  {
    "domain": "manuals",
    "files": [
      { "path": "./exports/guide.txt", "domain": "manuals", "filename": "guide.txt", "mime": "text/plain" }
    ]
  }

Options:
  --object-root <dir>  Read plain object-key exports shaped as <domain>/<hash>/<filename>
  --infer-schema       Call /v1/kb/schemas/infer-upload for each uploaded file
  --apply-schema       Apply the last inferred schema per domain after upload
  --queue-ingest       Queue /v1/kb/ingest/run for touched domains after upload
  --run-id <id>        Base run id for queued ingest; defaults to migrate-<timestamp>
  --dry-run            Validate and print the planned migration without network calls

Note:
  --object-root expects an mc mirror/S3 export, not MinIO's disk/erasure layout.
  If you see xl.meta files, mirror the bucket prefix first:
    mc mirror local/kb-bucket/raw ./exports/raw`);
}

function parseArgs(argv) {
  const out = {
    baseUrl: process.env.RAG_BASE_URL || 'http://localhost:8787',
    key: process.env.RAG_SERVICE_KEY || '',
    input: '',
    manifest: '',
    objectRoot: '',
    domain: '',
    inferSchema: false,
    applySchema: false,
    queueIngest: false,
    runId: '',
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--infer-schema') {
      out.inferSchema = true;
      continue;
    }
    if (arg === '--apply-schema') {
      out.applySchema = true;
      out.inferSchema = true;
      continue;
    }
    if (arg === '--queue-ingest') {
      out.queueIngest = true;
      continue;
    }
    if (arg === '--dry-run') {
      out.dryRun = true;
      continue;
    }
    const value = argv[i + 1];
    if (!value) throw new Error(`missing value for ${arg}`);
    i += 1;
    if (arg === '--base-url') out.baseUrl = value;
    else if (arg === '--key') out.key = value;
    else if (arg === '--input') out.input = value;
    else if (arg === '--manifest') out.manifest = value;
    else if (arg === '--object-root') out.objectRoot = value;
    else if (arg === '--domain') out.domain = value;
    else if (arg === '--run-id') out.runId = value;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!out.input && !out.manifest && !out.objectRoot) throw new Error('--input, --manifest, or --object-root is required');
  if (out.input && !out.domain) throw new Error('--domain is required with --input');
  if (!out.key && !out.dryRun) throw new Error('--key or RAG_SERVICE_KEY is required');
  out.baseUrl = out.baseUrl.replace(/\/+$/, '');
  return out;
}

function mimeFromFilename(filename) {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.jsonl') || lower.endsWith('.ndjson')) return 'application/x-ndjson';
  if (lower.endsWith('.csv')) return 'text/csv';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html';
  if (lower.endsWith('.md')) return 'text/markdown';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.txt')) return 'text/plain';
  if (lower.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (lower.endsWith('.xls')) return 'application/vnd.ms-excel';
  return 'application/octet-stream';
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function asObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

async function collectDirectoryFiles(root, domain) {
  const out = [];
  async function visit(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const filename = relative(root, path);
      out.push({
        path,
        domain,
        filename,
        mime: mimeFromFilename(filename),
      });
    }
  }
  const info = await stat(root);
  if (info.isDirectory()) await visit(root);
  else if (info.isFile()) out.push({ path: root, domain, filename: basename(root), mime: mimeFromFilename(root) });
  else throw new Error(`input is not a file or directory: ${root}`);
  return out;
}

async function collectObjectRootFiles(root) {
  const out = [];
  async function visit(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.name === '.minio.sys' || entry.name === 'xl.meta') {
        throw new Error(
          `--object-root points at MinIO disk internals (${relative(root, path) || entry.name}); ` +
            'mirror the bucket prefix first with mc mirror local/kb-bucket/raw ./exports/raw',
        );
      }
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(root, path);
      const parts = rel.split(/[\\/]+/).filter(Boolean);
      if (parts.length < 3) continue;
      const domain = parts[0];
      const filename = parts.slice(2).join('/');
      out.push({
        path,
        domain,
        filename,
        mime: mimeFromFilename(filename),
      });
    }
  }
  const info = await stat(root);
  if (!info.isDirectory()) throw new Error(`object root is not a directory: ${root}`);
  await visit(root);
  return out;
}

function normalizeManifest(raw, baseDir = process.cwd()) {
  const root = asObject(typeof raw === 'string' ? JSON.parse(raw) : raw, 'manifest');
  const defaultDomain = typeof root.domain === 'string' ? root.domain.trim() : '';
  const files = Array.isArray(root.files) ? root.files : [];
  if (files.length === 0) throw new Error('manifest.files must be a non-empty array');
  return files.map((value, i) => {
    const row = asObject(value, `manifest.files[${i}]`);
    const rawPath = String(row.path || '').trim();
    const domain = String(row.domain || defaultDomain).trim();
    const filename = String(row.filename || basename(rawPath)).trim();
    if (!rawPath) throw new Error(`manifest.files[${i}].path is required`);
    if (!domain) throw new Error(`manifest.files[${i}].domain is required`);
    return {
      path: isAbsolute(rawPath) ? rawPath : resolve(baseDir, rawPath),
      domain,
      filename,
      mime: row.mime ? String(row.mime) : mimeFromFilename(filename),
    };
  });
}

export async function normalizeMigrationInput(options) {
  const manifestPath = options.manifest ? resolve(options.manifest) : '';
  const files = options.manifest
    ? normalizeManifest(await readFile(manifestPath, 'utf8'), dirname(manifestPath))
    : options.objectRoot
      ? await collectObjectRootFiles(options.objectRoot)
    : await collectDirectoryFiles(options.input, options.domain);
  const rows = [];
  for (const file of files) {
    const info = await stat(file.path);
    if (!info.isFile()) throw new Error(`not a file: ${file.path}`);
    const bytes = await readFile(file.path);
    rows.push({
      ...file,
      bytes: info.size,
      content_hash: sha256Hex(bytes),
    });
  }
  return rows.sort((a, b) => a.domain.localeCompare(b.domain) || a.filename.localeCompare(b.filename));
}

async function requestJson(url, { key, method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${url} failed ${res.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function uploadFile(baseUrl, key, file, inferSchema) {
  const form = new FormData();
  form.set('domain', file.domain);
  const bytes = await readFile(file.path);
  const hash = sha256Hex(bytes);
  if (file.content_hash && file.content_hash !== hash) {
    throw new Error(`checksum changed while reading ${file.path}: planned ${file.content_hash}, read ${hash}`);
  }
  const blob = new Blob([bytes], { type: file.mime });
  form.set('file', blob, file.filename);
  const res = await fetch(`${baseUrl}${inferSchema ? '/v1/kb/schemas/infer-upload' : '/v1/kb/files/upload'}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`upload ${file.path} failed ${res.status}: ${JSON.stringify(payload)}`);
  return payload;
}

function uploadedContentHash(payload) {
  if (!payload || typeof payload !== 'object') return '';
  if (typeof payload.content_hash === 'string') return payload.content_hash;
  if (typeof payload.contentHash === 'string') return payload.contentHash;
  const file = payload.file;
  if (file && typeof file === 'object' && typeof file.content_hash === 'string') return file.content_hash;
  if (Array.isArray(payload.staged_files) && payload.staged_files[0]?.content_hash) {
    return String(payload.staged_files[0].content_hash);
  }
  return '';
}

export async function migrateRawFiles(options) {
  const files = await normalizeMigrationInput(options);
  const baseUrl = (options.baseUrl || 'http://localhost:8787').replace(/\/+$/, '');
  const domains = [...new Set(files.map((file) => file.domain))];
  if (options.dryRun) {
    return {
      dry_run: true,
      files: files.length,
      bytes: files.reduce((sum, file) => sum + file.bytes, 0),
      domains,
      content_hashes: files.map((file) => ({
        domain: file.domain,
        filename: file.filename,
        bytes: file.bytes,
        sha256: file.content_hash,
      })),
      infer_schema: Boolean(options.inferSchema),
      apply_schema: Boolean(options.applySchema),
      queue_ingest: Boolean(options.queueIngest),
    };
  }
  const uploaded = [];
  const latestSchemaByDomain = new Map();
  const verified = [];
  for (const file of files) {
    const payload = await uploadFile(baseUrl, options.key, file, options.inferSchema);
    const remoteHash = uploadedContentHash(payload);
    if (remoteHash && remoteHash !== file.content_hash) {
      throw new Error(`checksum mismatch for ${file.path}: local ${file.content_hash}, remote ${remoteHash}`);
    }
    verified.push({
      path: file.path,
      domain: file.domain,
      filename: file.filename,
      bytes: file.bytes,
      sha256: file.content_hash,
      matched: remoteHash ? remoteHash === file.content_hash : null,
    });
    uploaded.push({ path: file.path, domain: file.domain, content_hash: file.content_hash, payload });
    if (payload?.spec && file.domain) latestSchemaByDomain.set(file.domain, payload.spec);
  }
  const applied = [];
  if (options.applySchema) {
    for (const [domain, spec] of latestSchemaByDomain) {
      applied.push(await requestJson(`${baseUrl}/v1/kb/schemas`, {
        key: options.key,
        method: 'POST',
        body: { ...spec, domain },
      }));
    }
  }
  const queued = [];
  if (options.queueIngest) {
    const baseRunId = options.runId || `migrate-${Date.now()}`;
    for (const domain of domains) {
      queued.push(await requestJson(`${baseUrl}/v1/kb/ingest/run`, {
        key: options.key,
        method: 'POST',
        body: { domain, async: true, run_id: `${baseRunId}-${domain}` },
      }));
    }
  }
  return {
    dry_run: false,
    uploaded: uploaded.length,
    verified,
    domains,
    applied: applied.length,
    queued: queued.length,
    uploads: uploaded,
    applied_schemas: applied,
    queued_runs: queued,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await migrateRawFiles(args);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    usage();
    console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
