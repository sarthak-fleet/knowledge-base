#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const TABLE_ORDER = [
  'projects',
  'domains',
  'schemas',
  'schema_drafts',
  'files',
  'parse_artifacts',
  'entities',
  'entity_mentions',
  'entity_relationships',
  'provenance_spans',
  'ingest_jobs',
  'chunks',
  'sessions',
  'query_traces',
];

const TABLE_SPECS = {
  projects: {
    target: 'kb_projects',
    key: ['name'],
    columns: ['name', 'description', 'created_at', 'updated_at'],
    defaults: { description: '', created_at: nowIso, updated_at: nowIso },
  },
  domains: {
    target: 'kb_domains',
    key: ['project', 'name'],
    columns: ['project', 'name', 'description', 'created_at', 'updated_at'],
    defaults: { project: 'default', description: '', created_at: nowIso, updated_at: nowIso },
  },
  schemas: {
    target: 'kb_schemas',
    key: ['id'],
    columns: ['id', 'project', 'domain', 'name', 'version', 'spec', 'is_active', 'created_at'],
    json: ['spec'],
    booleans: ['is_active'],
    defaults: { project: 'default', name: 'default', version: 1, is_active: 0, created_at: nowIso },
  },
  schema_drafts: {
    target: 'kb_schema_drafts',
    key: ['id'],
    columns: [
      'id',
      'project',
      'domain',
      'name',
      'spec',
      'source',
      'sample_count',
      'staged_file_ids',
      'errors',
      'status',
      'created_at',
      'updated_at',
    ],
    json: ['spec', 'staged_file_ids', 'errors'],
    defaults: {
      project: 'default',
      name: 'inferred',
      source: 'manual',
      sample_count: 0,
      staged_file_ids: [],
      errors: [],
      status: 'pending',
      created_at: nowIso,
      updated_at: nowIso,
    },
  },
  files: {
    target: 'kb_files',
    key: ['project', 'domain', 'content_hash'],
    columns: [
      'id',
      'project',
      'domain',
      'filename',
      'mime',
      'bytes',
      'content_hash',
      'canonical_hash',
      'object_key',
      'status',
      'last_error',
      'uploaded_at',
      'updated_at',
    ],
    defaults: { project: 'default', bytes: 0, status: 'pending', uploaded_at: nowIso, updated_at: nowIso },
  },
  parse_artifacts: {
    target: 'kb_parse_artifacts',
    key: ['content_hash'],
    columns: ['content_hash', 'parser', 'parser_version', 'object_key', 'page_count', 'created_at'],
    defaults: { parser_version: null, page_count: null, created_at: nowIso },
  },
  entities: {
    target: 'kb_entities',
    key: ['project', 'domain', 'type', 'identity_key'],
    columns: [
      'id',
      'project',
      'domain',
      'type',
      'identity_key',
      'display_name',
      'fields',
      'parent_id',
      'created_at',
      'updated_at',
    ],
    json: ['fields'],
    defaults: { project: 'default', fields: {}, created_at: nowIso, updated_at: nowIso },
  },
  entity_mentions: {
    target: 'kb_entity_mentions',
    key: ['entity_id', 'file_id', 'schema_id'],
    columns: [
      'id',
      'project',
      'domain',
      'entity_id',
      'file_id',
      'schema_id',
      'field_values',
      'confidence',
      'created_at',
    ],
    json: ['field_values'],
    defaults: { project: 'default', domain: '', field_values: {}, confidence: 0, created_at: nowIso },
  },
  entity_relationships: {
    target: 'kb_entity_relationships',
    key: ['project', 'domain', 'rel_type', 'src_id', 'dst_id'],
    columns: [
      'id',
      'project',
      'domain',
      'rel_type',
      'src_id',
      'dst_id',
      'evidence_file',
      'evidence_page',
      'created_at',
    ],
    defaults: { project: 'default', evidence_file: null, evidence_page: null, created_at: nowIso },
  },
  provenance_spans: {
    target: 'kb_provenance_spans',
    key: ['id'],
    columns: [
      'id',
      'project',
      'domain',
      'file_id',
      'entity_id',
      'field',
      'page_start',
      'page_end',
      'element_id',
      'excerpt',
      'bbox',
      'created_at',
    ],
    json: ['bbox'],
    defaults: {
      project: 'default',
      domain: '',
      entity_id: null,
      field: null,
      element_id: null,
      bbox: null,
      created_at: nowIso,
    },
  },
  ingest_jobs: {
    target: 'kb_ingest_jobs',
    key: ['file_id', 'schema_id'],
    columns: [
      'id',
      'project',
      'domain',
      'file_id',
      'schema_id',
      'stage',
      'status',
      'attempts',
      'last_error',
      'queue_message_id',
      'workflow_id',
      'locked_by',
      'locked_at',
      'created_at',
      'updated_at',
    ],
    defaults: {
      project: 'default',
      schema_id: null,
      stage: 'parse',
      status: 'queued',
      attempts: 0,
      last_error: null,
      queue_message_id: null,
      workflow_id: null,
      locked_by: null,
      locked_at: null,
      created_at: nowIso,
      updated_at: nowIso,
    },
  },
  chunks: {
    target: 'kb_chunks',
    key: ['id'],
    columns: [
      'id',
      'project',
      'domain',
      'file_id',
      'entity_id',
      'parent_chunk',
      'vector_id',
      'page_start',
      'page_end',
      'text',
      'content_hash',
      'also_in_files',
      'bbox',
      'metadata',
      'created_at',
    ],
    json: ['also_in_files', 'bbox', 'metadata'],
    defaults: {
      project: 'default',
      entity_id: null,
      parent_chunk: null,
      vector_id: null,
      page_start: 1,
      page_end: 1,
      content_hash: null,
      also_in_files: [],
      bbox: null,
      metadata: {},
      created_at: nowIso,
    },
  },
  sessions: {
    target: 'kb_sessions',
    key: ['id'],
    columns: ['id', 'project', 'domain', 'history', 'created_at', 'updated_at'],
    json: ['history'],
    defaults: { project: 'default', history: [], created_at: nowIso, updated_at: nowIso },
  },
  query_traces: {
    target: 'kb_query_traces',
    key: ['id'],
    columns: [
      'id',
      'project',
      'domain',
      'question',
      'scope',
      'filters',
      'retrieved',
      'answer',
      'citations',
      'confidence',
      'latency_ms',
      'created_at',
    ],
    json: ['scope', 'filters', 'retrieved', 'citations', 'confidence'],
    defaults: {
      project: 'default',
      scope: null,
      filters: null,
      retrieved: [],
      answer: null,
      citations: [],
      confidence: null,
      latency_ms: null,
      created_at: nowIso,
    },
  },
};

const POSTGRES_EXPORT_SQL = String.raw`
WITH payload AS (
  SELECT jsonb_build_object(
    'projects', COALESCE((
      SELECT jsonb_agg(to_jsonb(t) ORDER BY t.name)
      FROM (
        SELECT name, description, created_at::text AS created_at, updated_at::text AS updated_at
        FROM projects
      ) AS t
    ), '[]'::jsonb),
    'domains', COALESCE((
      SELECT jsonb_agg(to_jsonb(t) ORDER BY t.project, t.name)
      FROM (
        SELECT project, name, description, created_at::text AS created_at, updated_at::text AS updated_at
        FROM domains
      ) AS t
    ), '[]'::jsonb),
    'schemas', COALESCE((
      SELECT jsonb_agg(to_jsonb(t) ORDER BY t.project, t.domain, t.name, t.version)
      FROM (
        SELECT id::text AS id, project, domain, name, version, spec, is_active, created_at::text AS created_at
        FROM schemas
      ) AS t
    ), '[]'::jsonb),
    'schema_drafts', COALESCE((
      SELECT jsonb_agg(to_jsonb(t) ORDER BY t.project, t.domain, t.updated_at)
      FROM (
        SELECT id::text AS id, project, domain, name, spec, source, sample_count,
               ARRAY(SELECT x::text FROM unnest(staged_file_ids) AS x) AS staged_file_ids,
               errors, status, created_at::text AS created_at, updated_at::text AS updated_at
        FROM schema_drafts
      ) AS t
    ), '[]'::jsonb),
    'files', COALESCE((
      SELECT jsonb_agg(to_jsonb(t) ORDER BY t.project, t.domain, t.filename, t.content_hash)
      FROM (
        SELECT id::text AS id, project, domain, filename, mime, bytes, content_hash,
               canonical_hash, object_key, status, last_error,
               uploaded_at::text AS uploaded_at, updated_at::text AS updated_at
        FROM files
      ) AS t
    ), '[]'::jsonb),
    'parse_artifacts', COALESCE((
      SELECT jsonb_agg(to_jsonb(t) ORDER BY t.content_hash)
      FROM (
        SELECT content_hash, parser, parser_version, object_key, page_count, created_at::text AS created_at
        FROM parse_artifacts
      ) AS t
    ), '[]'::jsonb),
    'entities', COALESCE((
      SELECT jsonb_agg(to_jsonb(t) ORDER BY t.project, t.domain, t.type, t.identity_key)
      FROM (
        SELECT id::text AS id, project, domain, type, identity_key, display_name, fields,
               parent_id::text AS parent_id, created_at::text AS created_at, updated_at::text AS updated_at
        FROM entities
      ) AS t
    ), '[]'::jsonb),
    'entity_mentions', COALESCE((
      SELECT jsonb_agg(to_jsonb(t) ORDER BY t.project, t.domain, t.entity_id, t.file_id, t.schema_id)
      FROM (
        SELECT em.id::text AS id,
               COALESCE(NULLIF(em.project, ''), f.project, e.project, s.project, 'default') AS project,
               COALESCE(NULLIF(em.domain, ''), f.domain, e.domain, s.domain, '') AS domain,
               em.entity_id::text AS entity_id,
               em.file_id::text AS file_id, em.schema_id::text AS schema_id,
               em.field_values, em.confidence, em.created_at::text AS created_at
        FROM entity_mentions em
        LEFT JOIN files f ON f.id = em.file_id
        LEFT JOIN entities e ON e.id = em.entity_id
        LEFT JOIN schemas s ON s.id = em.schema_id
      ) AS t
    ), '[]'::jsonb),
    'entity_relationships', COALESCE((
      SELECT jsonb_agg(to_jsonb(t) ORDER BY t.project, t.domain, t.rel_type, t.src_id, t.dst_id)
      FROM (
        SELECT id::text AS id, project, domain, rel_type, src_id::text AS src_id,
               dst_id::text AS dst_id, evidence_file::text AS evidence_file,
               evidence_page, created_at::text AS created_at
        FROM entity_relationships
      ) AS t
    ), '[]'::jsonb),
    'provenance_spans', COALESCE((
      SELECT jsonb_agg(to_jsonb(t) ORDER BY t.project, t.domain, t.file_id, t.id)
      FROM (
        SELECT ps.id::text AS id,
               COALESCE(NULLIF(ps.project, ''), f.project, e.project, 'default') AS project,
               COALESCE(NULLIF(ps.domain, ''), f.domain, e.domain, '') AS domain,
               ps.file_id::text AS file_id,
               ps.entity_id::text AS entity_id, field, page_start, page_end,
               element_id, excerpt, bbox, ps.created_at::text AS created_at
        FROM provenance_spans ps
        LEFT JOIN files f ON f.id = ps.file_id
        LEFT JOIN entities e ON e.id = ps.entity_id
      ) AS t
    ), '[]'::jsonb),
    'ingest_jobs', COALESCE((
      SELECT jsonb_agg(to_jsonb(t) ORDER BY t.project, t.domain, t.file_id, t.schema_id)
      FROM (
        SELECT id::text AS id, project, domain, file_id::text AS file_id,
               schema_id::text AS schema_id, stage, status, attempts, last_error,
               NULL::text AS queue_message_id, NULL::text AS workflow_id, locked_by,
               locked_at::text AS locked_at, created_at::text AS created_at, updated_at::text AS updated_at
        FROM ingest_jobs
      ) AS t
    ), '[]'::jsonb),
    'chunks', COALESCE((
      SELECT jsonb_agg(to_jsonb(t) ORDER BY t.project, t.domain, t.file_id, t.id)
      FROM (
        SELECT id::text AS id, project, domain, file_id::text AS file_id,
               entity_id::text AS entity_id, parent_chunk::text AS parent_chunk,
               id::text AS vector_id, page_start, page_end, text, content_hash,
               ARRAY(SELECT x::text FROM unnest(COALESCE(also_in_files, '{}'::uuid[])) AS x) AS also_in_files,
               bbox, '{}'::jsonb AS metadata, created_at::text AS created_at
        FROM chunks
      ) AS t
    ), '[]'::jsonb),
    'sessions', COALESCE((
      SELECT jsonb_agg(to_jsonb(t) ORDER BY t.project, t.domain, t.updated_at)
      FROM (
        SELECT id::text AS id, project, domain, history,
               created_at::text AS created_at, updated_at::text AS updated_at
        FROM sessions
      ) AS t
    ), '[]'::jsonb),
    'query_traces', COALESCE((
      SELECT jsonb_agg(to_jsonb(t) ORDER BY t.project, t.domain, t.created_at)
      FROM (
        SELECT id::text AS id, project, domain, question, scope, filters,
               retrieved, answer, citations, confidence, latency_ms,
               created_at::text AS created_at
        FROM query_traces
      ) AS t
    ), '[]'::jsonb)
  ) AS doc
)
SELECT jsonb_pretty(doc) FROM payload;
`.trim();

function usage() {
  console.error(`Usage:
  node scripts/migrate-d1-metadata.mjs --input legacy-kb-export.json --out d1-metadata.sql --dry-run
  node scripts/migrate-d1-metadata.mjs --input legacy-kb-export.json --out d1-metadata.sql
  node scripts/migrate-d1-metadata.mjs --print-postgres-export-sql

Input shape:
  {
    "projects": [{ "name": "default" }],
    "domains": [{ "project": "default", "name": "sec" }],
    "schemas": [{ "id": "...", "project": "default", "domain": "sec", "spec": {...} }],
    "...": []
  }

The generated SQL is idempotent and targets the kb_* D1 tables from
migrations/0003_knowledgebase_metadata.sql. Apply it explicitly with:
  node scripts/migrate-d1-metadata.mjs --input legacy-kb-export.json --out d1-metadata.remote.sql --no-transaction
  wrangler d1 execute rag-db --remote --file d1-metadata.remote.sql`);
}

function parseArgs(argv) {
  const out = { input: '', output: '', dryRun: false, stdout: false, printPostgresExportSql: false, noTransaction: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      out.dryRun = true;
      continue;
    }
    if (arg === '--stdout') {
      out.stdout = true;
      continue;
    }
    if (arg === '--print-postgres-export-sql') {
      out.printPostgresExportSql = true;
      continue;
    }
    if (arg === '--no-transaction') {
      out.noTransaction = true;
      continue;
    }
    const value = argv[i + 1];
    if (!value) throw new Error(`missing value for ${arg}`);
    i += 1;
    if (arg === '--input') out.input = value;
    else if (arg === '--out') out.output = value;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (out.printPostgresExportSql) return out;
  if (!out.input) throw new Error('--input is required');
  if (!out.output && !out.dryRun && !out.stdout) throw new Error('--out, --stdout, or --dry-run is required');
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function asArray(value, table) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${table} must be an array`);
  return value;
}

function asObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function normalizeScalar(value) {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return Number(value);
  return value;
}

function stableJson(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => [key, sortJson(nested)]),
  );
}

function normalizeJsonField(value, fallback = null) {
  const normalized = value === undefined ? fallback : value;
  if (normalized === null) return null;
  if (typeof normalized === 'string') {
    try {
      return stableJson(JSON.parse(normalized));
    } catch {
      return normalized;
    }
  }
  return stableJson(normalized);
}

function normalizeBoolean(value) {
  if (value === true) return 1;
  if (value === false) return 0;
  if (value === 1 || value === 0) return value;
  if (typeof value === 'string') {
    const lower = value.toLowerCase();
    if (lower === 'true') return 1;
    if (lower === 'false') return 0;
  }
  return value ? 1 : 0;
}

function normalizeRow(table, row, generatedAt) {
  const spec = TABLE_SPECS[table];
  const source = asObject(row, `${table} row`);
  const out = {};
  for (const column of spec.columns) {
    let value = source[column];
    if (value === undefined && column === 'bytes') value = source.size;
    if (value === undefined && column === 'vector_id') value = source.vector_id ?? source.id;
    if ((value === undefined || value === null) && spec.defaults && Object.hasOwn(spec.defaults, column) && spec.defaults[column] !== null) {
      const fallback = spec.defaults[column];
      value = typeof fallback === 'function' ? (column.endsWith('_at') ? generatedAt : fallback()) : fallback;
    }
    if (spec.booleans?.includes(column)) value = normalizeBoolean(value);
    if (spec.json?.includes(column)) {
      const fallback = spec.defaults && Object.hasOwn(spec.defaults, column) ? spec.defaults[column] : null;
      value = normalizeJsonField(value, fallback);
    } else {
      value = normalizeScalar(value);
    }
    out[column] = value;
  }
  return out;
}

function rowKey(row, columns) {
  return columns.map((column) => String(row[column] ?? '')).join('\u0000');
}

function addSyntheticParents(tables, warnings, generatedAt) {
  const projectNames = new Set(tables.projects.map((row) => row.name));
  if (!projectNames.has('default')) {
    tables.projects.unshift(normalizeRow('projects', { name: 'default', description: 'Default project' }, generatedAt));
    projectNames.add('default');
    warnings.push('added missing default project for D1 foreign-key ordering');
  }
  const domainKeys = new Set(tables.domains.map((row) => `${row.project}:${row.name}`));
  for (const table of ['schemas', 'schema_drafts', 'files', 'entities', 'entity_relationships', 'ingest_jobs', 'chunks', 'sessions', 'query_traces']) {
    for (const row of tables[table]) {
      const project = row.project || 'default';
      const domain = row.domain;
      if (!domain) continue;
      if (!projectNames.has(project)) {
        tables.projects.push(normalizeRow('projects', { name: project }, generatedAt));
        projectNames.add(project);
        warnings.push(`added missing project ${project}`);
      }
      const domainKey = `${project}:${domain}`;
      if (!domainKeys.has(domainKey)) {
        tables.domains.push(normalizeRow('domains', { project, name: domain }, generatedAt));
        domainKeys.add(domainKey);
        warnings.push(`added missing domain ${project}/${domain}`);
      }
    }
  }
}

function dedupeTable(table, rows, warnings) {
  const spec = TABLE_SPECS[table];
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = rowKey(row, spec.key);
    if (seen.has(key)) {
      warnings.push(`deduped duplicate ${table} row for key ${spec.key.join(',')}=${key.replaceAll('\u0000', '/')}`);
      continue;
    }
    seen.add(key);
    out.push(row);
  }
  return out;
}

function fillDerivedReferenceFields(tables) {
  const files = new Map(tables.files.map((row) => [row.id, row]));
  const entities = new Map(tables.entities.map((row) => [row.id, row]));
  const schemas = new Map(tables.schemas.map((row) => [row.id, row]));

  for (const row of tables.entity_mentions) {
    const file = files.get(row.file_id);
    const entity = entities.get(row.entity_id);
    const schema = schemas.get(row.schema_id);
    row.project ||= file?.project || entity?.project || schema?.project || 'default';
    row.domain ||= file?.domain || entity?.domain || schema?.domain || '';
  }

  for (const row of tables.provenance_spans) {
    const file = files.get(row.file_id);
    const entity = entities.get(row.entity_id);
    row.project ||= file?.project || entity?.project || 'default';
    row.domain ||= file?.domain || entity?.domain || '';
  }
}

function sortByParent(rows, idColumn, parentColumn, warnings, table) {
  const byId = new Map(rows.map((row) => [row[idColumn], row]));
  const output = [];
  const visited = new Set();
  const visiting = new Set();

  function visit(row) {
    const id = row[idColumn];
    if (!id || visited.has(id)) return;
    if (visiting.has(id)) {
      warnings.push(`cleared cyclic ${table}.${parentColumn} reference for ${id}`);
      row[parentColumn] = null;
      return;
    }
    visiting.add(id);
    const parentId = row[parentColumn];
    if (parentId) {
      const parent = byId.get(parentId);
      if (parent) visit(parent);
    }
    visiting.delete(id);
    visited.add(id);
    output.push(row);
  }

  for (const row of rows) visit(row);
  return output;
}

function validateRequired(tables, warnings) {
  const requiredByTable = {
    projects: ['name'],
    domains: ['project', 'name'],
    schemas: ['id', 'project', 'domain', 'name', 'version', 'spec'],
    files: ['id', 'project', 'domain', 'filename', 'bytes', 'content_hash', 'object_key'],
    parse_artifacts: ['content_hash', 'parser', 'object_key'],
    entities: ['id', 'project', 'domain', 'type', 'identity_key'],
    entity_mentions: ['id', 'project', 'domain', 'entity_id', 'file_id', 'schema_id'],
    entity_relationships: ['id', 'project', 'domain', 'rel_type', 'src_id', 'dst_id'],
    provenance_spans: ['id', 'project', 'domain', 'file_id', 'page_start', 'page_end', 'excerpt'],
    ingest_jobs: ['id', 'project', 'domain', 'file_id'],
    chunks: ['id', 'project', 'domain', 'file_id', 'page_start', 'page_end', 'text'],
    sessions: ['id', 'project', 'domain'],
    query_traces: ['id', 'project', 'domain', 'question'],
  };
  for (const [table, columns] of Object.entries(requiredByTable)) {
    tables[table] = tables[table].filter((row) => {
      const missing = columns.filter((column) => row[column] === null || row[column] === undefined || row[column] === '');
      if (missing.length > 0) {
        warnings.push(`skipped ${table} row missing ${missing.join(',')}`);
        return false;
      }
      return true;
    });
  }
}

function validateReferences(tables, warnings) {
  const projects = new Set(tables.projects.map((row) => row.name));
  const domains = new Set(tables.domains.map((row) => `${row.project}:${row.name}`));
  const schemas = new Set(tables.schemas.map((row) => row.id));
  const files = new Set(tables.files.map((row) => row.id));
  const entities = new Set(tables.entities.map((row) => row.id));
  const chunks = new Set(tables.chunks.map((row) => row.id));

  for (const row of tables.domains) {
    if (!projects.has(row.project)) warnings.push(`domain ${row.project}/${row.name} references missing project`);
  }
  for (const table of ['schemas', 'schema_drafts', 'files', 'entities', 'entity_relationships', 'ingest_jobs', 'chunks', 'sessions', 'query_traces']) {
    for (const row of tables[table]) {
      if (!domains.has(`${row.project}:${row.domain}`)) warnings.push(`${table} row references missing domain ${row.project}/${row.domain}`);
    }
  }
  for (const row of tables.entity_mentions) {
    if (!entities.has(row.entity_id)) warnings.push(`entity_mentions ${row.id} references missing entity ${row.entity_id}`);
    if (!files.has(row.file_id)) warnings.push(`entity_mentions ${row.id} references missing file ${row.file_id}`);
    if (!schemas.has(row.schema_id)) warnings.push(`entity_mentions ${row.id} references missing schema ${row.schema_id}`);
  }
  for (const row of tables.entity_relationships) {
    if (!entities.has(row.src_id)) warnings.push(`entity_relationships ${row.id} references missing src entity ${row.src_id}`);
    if (!entities.has(row.dst_id)) warnings.push(`entity_relationships ${row.id} references missing dst entity ${row.dst_id}`);
    if (row.evidence_file && !files.has(row.evidence_file)) warnings.push(`entity_relationships ${row.id} references missing evidence file ${row.evidence_file}`);
  }
  for (const row of tables.provenance_spans) {
    if (!files.has(row.file_id)) warnings.push(`provenance_spans ${row.id} references missing file ${row.file_id}`);
    if (row.entity_id && !entities.has(row.entity_id)) warnings.push(`provenance_spans ${row.id} references missing entity ${row.entity_id}`);
  }
  for (const row of tables.ingest_jobs) {
    if (!files.has(row.file_id)) warnings.push(`ingest_jobs ${row.id} references missing file ${row.file_id}`);
    if (row.schema_id && !schemas.has(row.schema_id)) warnings.push(`ingest_jobs ${row.id} references missing schema ${row.schema_id}`);
  }
  for (const row of tables.chunks) {
    if (!files.has(row.file_id)) warnings.push(`chunks ${row.id} references missing file ${row.file_id}`);
    if (row.entity_id && !entities.has(row.entity_id)) warnings.push(`chunks ${row.id} references missing entity ${row.entity_id}`);
    if (row.parent_chunk && !chunks.has(row.parent_chunk)) warnings.push(`chunks ${row.id} references missing parent chunk ${row.parent_chunk}`);
  }
}

export function normalizeLegacyExport(raw, generatedAt = nowIso()) {
  const input = asObject(raw, 'legacy export');
  const warnings = [];
  const tables = Object.fromEntries(TABLE_ORDER.map((table) => [table, []]));
  for (const table of TABLE_ORDER) {
    tables[table] = asArray(input[table], table).map((row) => normalizeRow(table, row, generatedAt));
  }
  fillDerivedReferenceFields(tables);
  addSyntheticParents(tables, warnings, generatedAt);
  for (const table of TABLE_ORDER) {
    tables[table] = dedupeTable(table, tables[table], warnings);
  }
  tables.entities = sortByParent(tables.entities, 'id', 'parent_id', warnings, 'entities');
  tables.chunks = sortByParent(tables.chunks, 'id', 'parent_chunk', warnings, 'chunks');
  validateRequired(tables, warnings);
  validateReferences(tables, warnings);
  return { tables, warnings };
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'NULL';
    return String(value);
  }
  return `'${String(value).replaceAll("'", "''")}'`;
}

function insertSql(table, row) {
  const spec = TABLE_SPECS[table];
  const columns = spec.columns;
  const values = columns.map((column) => sqlLiteral(row[column]));
  const updates = columns
    .filter((column) => !spec.key.includes(column))
    .map((column) => `${column}=excluded.${column}`)
    .join(', ');
  return `INSERT INTO ${spec.target} (${columns.join(', ')}) VALUES (${values.join(', ')}) ON CONFLICT(${spec.key.join(', ')}) DO UPDATE SET ${updates};`;
}

function checksumRows(tables) {
  const payload = {};
  for (const table of TABLE_ORDER) {
    payload[table] = tables[table].map((row) => sortJson(row));
  }
  return createHash('sha256').update(stableJson(payload)).digest('hex');
}

export function buildD1MigrationPlan(raw, generatedAt = nowIso(), options = {}) {
  const { tables, warnings } = normalizeLegacyExport(raw, generatedAt);
  const counts = Object.fromEntries(TABLE_ORDER.map((table) => [table, tables[table].length]));
  const statements = [];
  statements.push('-- Generated by scripts/migrate-d1-metadata.mjs');
  statements.push(`-- normalized_sha256: ${checksumRows(tables)}`);
  if (!options.noTransaction) {
    statements.push('PRAGMA foreign_keys=ON;');
    statements.push('BEGIN TRANSACTION;');
  }
  for (const table of TABLE_ORDER) {
    for (const row of tables[table]) statements.push(insertSql(table, row));
  }
  if (!options.noTransaction) statements.push('COMMIT;');
  const sql = `${statements.join('\n')}\n`;
  return {
    dry_run: true,
    tables: counts,
    rows: Object.values(counts).reduce((sum, count) => sum + count, 0),
    normalized_sha256: checksumRows(tables),
    warnings,
    sql,
  };
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.printPostgresExportSql) {
      process.stdout.write(`${POSTGRES_EXPORT_SQL}\n`);
      return;
    }
    const inputPath = resolve(options.input);
    const raw = JSON.parse(await readFile(inputPath, 'utf8'));
    const plan = buildD1MigrationPlan(raw, nowIso(), { noTransaction: options.noTransaction });
    const summary = {
      dry_run: options.dryRun,
      rows: plan.rows,
      tables: plan.tables,
      normalized_sha256: plan.normalized_sha256,
      warnings: plan.warnings,
      output: options.output || null,
    };
    if (!options.dryRun) {
      if (options.stdout) process.stdout.write(plan.sql);
      if (options.output) await writeFile(resolve(options.output), plan.sql, 'utf8');
      summary.dry_run = false;
    }
    if (!options.stdout || options.dryRun) {
      console.log(JSON.stringify(summary, null, 2));
    }
  } catch (error) {
    usage();
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
