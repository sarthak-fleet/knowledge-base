-- 05_projects.sql — introduce `project` as the new top-level namespace.
--
-- The existing `domain` column on every data table now represents "kind within
-- a project" (e.g. project='biotech-ipo', kind='sec_filings'). For backward
-- compatibility, all existing rows land under project='default'.
--
-- Idempotent — every statement is guarded so re-running this migration is safe.
-- (Transaction handling is delegated to the migration runner; no explicit BEGIN/COMMIT.)

-- ─── projects: top-level namespace above kind ──────────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  name        TEXT PRIMARY KEY,
  description TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed the default project so existing single-namespace installs continue to work.
INSERT INTO projects (name, description)
VALUES ('default', 'Default project — auto-created for single-namespace installs')
ON CONFLICT (name) DO NOTHING;

-- ─── project column on every table that has `domain` (now: kind) ───────────
ALTER TABLE domains              ADD COLUMN IF NOT EXISTS project TEXT NOT NULL DEFAULT 'default';
ALTER TABLE schemas              ADD COLUMN IF NOT EXISTS project TEXT NOT NULL DEFAULT 'default';
ALTER TABLE files                ADD COLUMN IF NOT EXISTS project TEXT NOT NULL DEFAULT 'default';
ALTER TABLE entities             ADD COLUMN IF NOT EXISTS project TEXT NOT NULL DEFAULT 'default';
ALTER TABLE entity_mentions      ADD COLUMN IF NOT EXISTS project TEXT NOT NULL DEFAULT 'default';
ALTER TABLE entity_relationships ADD COLUMN IF NOT EXISTS project TEXT NOT NULL DEFAULT 'default';
ALTER TABLE provenance_spans     ADD COLUMN IF NOT EXISTS project TEXT NOT NULL DEFAULT 'default';
ALTER TABLE ingest_jobs          ADD COLUMN IF NOT EXISTS project TEXT NOT NULL DEFAULT 'default';
ALTER TABLE chunks               ADD COLUMN IF NOT EXISTS project TEXT NOT NULL DEFAULT 'default';
ALTER TABLE query_traces         ADD COLUMN IF NOT EXISTS project TEXT NOT NULL DEFAULT 'default';

-- ─── indexes for (project, kind) lookups ───────────────────────────────────
CREATE INDEX IF NOT EXISTS files_project_idx              ON files (project, domain);
CREATE INDEX IF NOT EXISTS entities_project_type_idx      ON entities (project, domain, type);
CREATE INDEX IF NOT EXISTS chunks_project_idx             ON chunks (project, domain);
CREATE INDEX IF NOT EXISTS ingest_jobs_project_status_idx ON ingest_jobs (project, domain, status);
CREATE INDEX IF NOT EXISTS query_traces_project_idx       ON query_traces (project, domain);

-- Note: existing UNIQUE constraints (schemas(domain, name, version),
-- files(domain, content_hash), entities(domain, type, identity_key), etc.) still
-- apply. They effectively scope to (project='default', domain) for legacy rows.
-- For per-project uniqueness, future migrations can drop+recreate those keys to
-- include `project`. Deferred until needed — risks breaking legacy callers.
