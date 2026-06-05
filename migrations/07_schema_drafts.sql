-- 07_schema_drafts.sql — durable inferred schemas awaiting user confirmation.

CREATE TABLE IF NOT EXISTS schema_drafts (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project         TEXT NOT NULL DEFAULT 'default' REFERENCES projects(name) ON DELETE CASCADE,
  domain          TEXT NOT NULL REFERENCES domains(name) ON DELETE CASCADE,
  name            TEXT NOT NULL DEFAULT 'inferred',
  spec            JSONB NOT NULL,
  source          TEXT NOT NULL DEFAULT 'manual',
  sample_count    INTEGER NOT NULL DEFAULT 0,
  staged_file_ids UUID[] NOT NULL DEFAULT '{}'::uuid[],
  errors          JSONB NOT NULL DEFAULT '[]'::jsonb,
  status          TEXT NOT NULL DEFAULT 'pending',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS schema_drafts_project_domain_status_idx
  ON schema_drafts (project, domain, status, updated_at DESC);
