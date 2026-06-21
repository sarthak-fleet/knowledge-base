CREATE TABLE IF NOT EXISTS kb_eval_reports (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL DEFAULT 'default',
  domain TEXT,
  index_id TEXT,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  rows TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_kb_eval_reports_scope
  ON kb_eval_reports(project, kind, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_kb_eval_reports_domain
  ON kb_eval_reports(project, domain, created_at DESC);
