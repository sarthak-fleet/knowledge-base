-- Full knowledgebase metadata schema for Cloudflare D1.
--
-- The existing Worker tables (`indexes`, `documents`, `chunks`) are the
-- lightweight fleet RAG API surface. These `kb_*` tables mirror the full
-- knowledgebase product state that currently lives in Postgres.

CREATE TABLE IF NOT EXISTS kb_projects (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO kb_projects (name, description)
VALUES ('default', 'Default project');

CREATE TABLE IF NOT EXISTS kb_domains (
  project TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project, name),
  FOREIGN KEY (project) REFERENCES kb_projects(name) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS kb_schemas (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL DEFAULT 'default',
  domain TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  spec TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project, domain) REFERENCES kb_domains(project, name) ON DELETE CASCADE,
  UNIQUE (project, domain, name, version)
);

CREATE INDEX IF NOT EXISTS idx_kb_schemas_active
  ON kb_schemas(project, domain)
  WHERE is_active = 1;

CREATE TABLE IF NOT EXISTS kb_schema_drafts (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL DEFAULT 'default',
  domain TEXT NOT NULL,
  name TEXT NOT NULL,
  spec TEXT NOT NULL,
  source TEXT NOT NULL,
  sample_count INTEGER NOT NULL DEFAULT 0,
  staged_file_ids TEXT NOT NULL DEFAULT '[]',
  errors TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project, domain) REFERENCES kb_domains(project, name) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_kb_schema_drafts_scope_status
  ON kb_schema_drafts(project, domain, status, updated_at);

CREATE TABLE IF NOT EXISTS kb_files (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL DEFAULT 'default',
  domain TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime TEXT,
  bytes INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  canonical_hash TEXT,
  object_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project, domain) REFERENCES kb_domains(project, name) ON DELETE CASCADE,
  UNIQUE (project, domain, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_kb_files_scope_status
  ON kb_files(project, domain, status);

CREATE INDEX IF NOT EXISTS idx_kb_files_canonical_hash
  ON kb_files(project, domain, canonical_hash);

CREATE TABLE IF NOT EXISTS kb_parse_artifacts (
  content_hash TEXT PRIMARY KEY,
  parser TEXT NOT NULL,
  parser_version TEXT,
  object_key TEXT NOT NULL,
  page_count INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS kb_entities (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL DEFAULT 'default',
  domain TEXT NOT NULL,
  type TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  display_name TEXT,
  fields TEXT NOT NULL DEFAULT '{}',
  parent_id TEXT REFERENCES kb_entities(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (project, domain) REFERENCES kb_domains(project, name) ON DELETE CASCADE,
  UNIQUE (project, domain, type, identity_key)
);

CREATE INDEX IF NOT EXISTS idx_kb_entities_scope_type
  ON kb_entities(project, domain, type);

CREATE INDEX IF NOT EXISTS idx_kb_entities_parent
  ON kb_entities(parent_id);

CREATE TABLE IF NOT EXISTS kb_entity_mentions (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL DEFAULT 'default',
  domain TEXT NOT NULL,
  entity_id TEXT NOT NULL REFERENCES kb_entities(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL REFERENCES kb_files(id) ON DELETE CASCADE,
  schema_id TEXT NOT NULL REFERENCES kb_schemas(id) ON DELETE CASCADE,
  field_values TEXT NOT NULL DEFAULT '{}',
  confidence REAL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (entity_id, file_id, schema_id)
);

CREATE INDEX IF NOT EXISTS idx_kb_entity_mentions_file
  ON kb_entity_mentions(file_id);

CREATE TABLE IF NOT EXISTS kb_entity_relationships (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL DEFAULT 'default',
  domain TEXT NOT NULL,
  rel_type TEXT NOT NULL,
  src_id TEXT NOT NULL REFERENCES kb_entities(id) ON DELETE CASCADE,
  dst_id TEXT NOT NULL REFERENCES kb_entities(id) ON DELETE CASCADE,
  evidence_file TEXT REFERENCES kb_files(id) ON DELETE SET NULL,
  evidence_page INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project, domain, rel_type, src_id, dst_id)
);

CREATE INDEX IF NOT EXISTS idx_kb_relationships_src
  ON kb_entity_relationships(src_id);

CREATE INDEX IF NOT EXISTS idx_kb_relationships_dst
  ON kb_entity_relationships(dst_id);

CREATE TABLE IF NOT EXISTS kb_provenance_spans (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL DEFAULT 'default',
  domain TEXT NOT NULL,
  file_id TEXT NOT NULL REFERENCES kb_files(id) ON DELETE CASCADE,
  entity_id TEXT REFERENCES kb_entities(id) ON DELETE CASCADE,
  field TEXT,
  page_start INTEGER NOT NULL,
  page_end INTEGER NOT NULL,
  element_id TEXT,
  excerpt TEXT NOT NULL,
  bbox TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_kb_provenance_file
  ON kb_provenance_spans(file_id);

CREATE INDEX IF NOT EXISTS idx_kb_provenance_entity
  ON kb_provenance_spans(entity_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_kb_provenance_idempotency
  ON kb_provenance_spans(
    project,
    domain,
    file_id,
    COALESCE(entity_id, ''),
    COALESCE(field, ''),
    page_start,
    page_end,
    COALESCE(element_id, ''),
    excerpt
  );

CREATE TABLE IF NOT EXISTS kb_ingest_jobs (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL DEFAULT 'default',
  domain TEXT NOT NULL,
  file_id TEXT NOT NULL REFERENCES kb_files(id) ON DELETE CASCADE,
  schema_id TEXT REFERENCES kb_schemas(id) ON DELETE SET NULL,
  stage TEXT NOT NULL DEFAULT 'parse',
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  queue_message_id TEXT,
  workflow_id TEXT,
  locked_by TEXT,
  locked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (file_id, schema_id)
);

CREATE INDEX IF NOT EXISTS idx_kb_ingest_jobs_ready
  ON kb_ingest_jobs(project, domain, status, updated_at);

CREATE TABLE IF NOT EXISTS kb_chunks (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL DEFAULT 'default',
  domain TEXT NOT NULL,
  file_id TEXT NOT NULL REFERENCES kb_files(id) ON DELETE CASCADE,
  entity_id TEXT REFERENCES kb_entities(id) ON DELETE SET NULL,
  parent_chunk TEXT REFERENCES kb_chunks(id) ON DELETE CASCADE,
  vector_id TEXT,
  page_start INTEGER NOT NULL,
  page_end INTEGER NOT NULL,
  text TEXT NOT NULL,
  content_hash TEXT,
  also_in_files TEXT NOT NULL DEFAULT '[]',
  bbox TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_kb_chunks_scope
  ON kb_chunks(project, domain);

CREATE INDEX IF NOT EXISTS idx_kb_chunks_file
  ON kb_chunks(file_id);

CREATE INDEX IF NOT EXISTS idx_kb_chunks_entity
  ON kb_chunks(entity_id);

CREATE INDEX IF NOT EXISTS idx_kb_chunks_content_hash
  ON kb_chunks(project, domain, content_hash);

CREATE TABLE IF NOT EXISTS kb_sessions (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL DEFAULT 'default',
  domain TEXT NOT NULL,
  history TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_kb_sessions_scope
  ON kb_sessions(project, domain);

CREATE TABLE IF NOT EXISTS kb_query_traces (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL DEFAULT 'default',
  domain TEXT NOT NULL,
  question TEXT NOT NULL,
  scope TEXT,
  filters TEXT,
  retrieved TEXT NOT NULL DEFAULT '[]',
  answer TEXT,
  citations TEXT NOT NULL DEFAULT '[]',
  confidence TEXT,
  latency_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_kb_query_traces_scope
  ON kb_query_traces(project, domain, created_at DESC);
