CREATE TABLE IF NOT EXISTS indexes (
  id TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  name TEXT NOT NULL,
  external_id TEXT,
  dimensions INTEGER NOT NULL DEFAULT 768,
  metric TEXT NOT NULL DEFAULT 'cosine',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(tenant, name)
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  index_id TEXT NOT NULL REFERENCES indexes(id) ON DELETE CASCADE,
  tenant TEXT NOT NULL,
  external_id TEXT,
  content TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  index_id TEXT NOT NULL,
  tenant TEXT NOT NULL,
  content TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_indexes_tenant ON indexes(tenant);
CREATE INDEX IF NOT EXISTS idx_docs_index ON documents(index_id);
CREATE INDEX IF NOT EXISTS idx_docs_tenant ON documents(tenant);
CREATE INDEX IF NOT EXISTS idx_chunks_index ON chunks(index_id);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_chunks_tenant_index ON chunks(tenant, index_id);
