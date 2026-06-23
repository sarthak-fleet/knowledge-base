CREATE TABLE IF NOT EXISTS embedding_cache (
  cache_key TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  model TEXT NOT NULL,
  provider TEXT,
  dimensions INTEGER NOT NULL,
  vector TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_embedding_cache_scope ON embedding_cache(tenant, model, provider, dimensions);
CREATE INDEX IF NOT EXISTS idx_embedding_cache_expires ON embedding_cache(expires_at);
