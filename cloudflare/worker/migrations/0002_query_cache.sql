CREATE TABLE IF NOT EXISTS query_cache (
  cache_key TEXT PRIMARY KEY,
  tenant TEXT NOT NULL,
  index_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_query_cache_scope ON query_cache(tenant, index_id);
CREATE INDEX IF NOT EXISTS idx_query_cache_expires ON query_cache(expires_at);
