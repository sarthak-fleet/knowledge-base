-- KB core schema. Re-run is safe.

-- ─── Domains & schemas ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS domains (
  name        TEXT PRIMARY KEY,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS schemas (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  domain      TEXT NOT NULL REFERENCES domains(name) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  version     INTEGER NOT NULL,
  spec        JSONB NOT NULL,        -- full schema YAML deserialized
  is_active   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (domain, name, version)
);
CREATE INDEX IF NOT EXISTS schemas_active_idx ON schemas (domain) WHERE is_active;

-- ─── Files (raw uploads, lifecycle, idempotent by content_hash) ───────────
CREATE TABLE IF NOT EXISTS files (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  domain        TEXT NOT NULL REFERENCES domains(name) ON DELETE CASCADE,
  filename      TEXT NOT NULL,
  mime          TEXT,
  bytes         BIGINT NOT NULL,
  content_hash  TEXT NOT NULL,
  object_key    TEXT NOT NULL,        -- key in object store
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending|parsing|extracting|resolving|indexing|ready|failed
  last_error    TEXT,
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (domain, content_hash)
);
CREATE INDEX IF NOT EXISTS files_status_idx ON files (status);
CREATE INDEX IF NOT EXISTS files_domain_idx ON files (domain);

-- ─── Parse artifacts (cached element JSON, keyed by content_hash) ─────────
CREATE TABLE IF NOT EXISTS parse_artifacts (
  content_hash  TEXT PRIMARY KEY,
  parser        TEXT NOT NULL,         -- 'unstructured:hi_res' | 'unstructured:fast' | 'xlsx' | ...
  parser_version TEXT,
  object_key    TEXT NOT NULL,         -- elements.json blob location
  page_count    INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Entities (canonical) ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS entities (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  domain          TEXT NOT NULL REFERENCES domains(name) ON DELETE CASCADE,
  type            TEXT NOT NULL,        -- entity type name from the schema
  identity_key    TEXT NOT NULL,        -- normalized key from schema-declared identity fields
  display_name    TEXT,
  fields          JSONB NOT NULL DEFAULT '{}'::jsonb,
  parent_id       UUID REFERENCES entities(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (domain, type, identity_key)
);
CREATE INDEX IF NOT EXISTS entities_type_idx ON entities (domain, type);
CREATE INDEX IF NOT EXISTS entities_parent_idx ON entities (parent_id);
CREATE INDEX IF NOT EXISTS entities_display_trgm_idx ON entities USING gin (display_name gin_trgm_ops);

-- One mention = one extraction occurrence in one file.
CREATE TABLE IF NOT EXISTS entity_mentions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entity_id       UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  file_id         UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  schema_id       UUID NOT NULL REFERENCES schemas(id) ON DELETE CASCADE,
  field_values    JSONB NOT NULL DEFAULT '{}'::jsonb,    -- raw extracted values pre-merge
  confidence      DOUBLE PRECISION DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (entity_id, file_id, schema_id)
);
CREATE INDEX IF NOT EXISTS entity_mentions_file_idx ON entity_mentions (file_id);

-- ─── Relationships (cross-references between entities) ────────────────────
CREATE TABLE IF NOT EXISTS entity_relationships (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  domain        TEXT NOT NULL,
  rel_type      TEXT NOT NULL,
  src_id        UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  dst_id        UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  evidence_file UUID REFERENCES files(id) ON DELETE SET NULL,
  evidence_page INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (domain, rel_type, src_id, dst_id)
);
CREATE INDEX IF NOT EXISTS rels_src_idx ON entity_relationships (src_id);
CREATE INDEX IF NOT EXISTS rels_dst_idx ON entity_relationships (dst_id);

-- ─── Provenance spans (file → page → element → excerpt; bbox optional) ─────
CREATE TABLE IF NOT EXISTS provenance_spans (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  file_id       UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  entity_id     UUID REFERENCES entities(id) ON DELETE CASCADE,
  field         TEXT,                  -- which field this span supports
  page_start    INTEGER NOT NULL,
  page_end      INTEGER NOT NULL,
  element_id    TEXT,                  -- Unstructured element id
  excerpt       TEXT NOT NULL,
  bbox          REAL[],                -- [x0,y0,x1,y1] in element coords; null when N/A
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS prov_file_idx ON provenance_spans (file_id);
CREATE INDEX IF NOT EXISTS prov_entity_idx ON provenance_spans (entity_id);

-- ─── Ingest jobs (SKIP LOCKED safe) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS ingest_jobs (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  domain        TEXT NOT NULL,
  file_id       UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  schema_id     UUID REFERENCES schemas(id) ON DELETE SET NULL,
  stage         TEXT NOT NULL DEFAULT 'parse',  -- parse|extract|resolve|index|done
  status        TEXT NOT NULL DEFAULT 'queued', -- queued|running|done|failed
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  locked_by     TEXT,
  locked_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (file_id, schema_id)
);
CREATE INDEX IF NOT EXISTS jobs_ready_idx ON ingest_jobs (status, updated_at) WHERE status = 'queued';

-- ─── Chunk index (vector store metadata mirror for pgvector adapter) ──────
CREATE TABLE IF NOT EXISTS chunks (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  domain        TEXT NOT NULL,
  file_id       UUID NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  entity_id     UUID REFERENCES entities(id) ON DELETE CASCADE,
  parent_chunk  UUID REFERENCES chunks(id) ON DELETE CASCADE,
  page_start    INTEGER NOT NULL,
  page_end      INTEGER NOT NULL,
  text          TEXT NOT NULL,
  embedding     vector(384),
  bbox          REAL[],
  tsv           tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(text, ''))) STORED,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS chunks_tsv_idx ON chunks USING gin (tsv);
CREATE INDEX IF NOT EXISTS chunks_file_idx ON chunks (file_id);
CREATE INDEX IF NOT EXISTS chunks_entity_idx ON chunks (entity_id);
-- HNSW index on embeddings is lazily added once data exists (avoids empty-table churn).

-- ─── Conversation sessions ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sessions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  domain        TEXT NOT NULL,
  history       JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Query traces (what the system did to produce an answer) ──────────────
CREATE TABLE IF NOT EXISTS query_traces (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  domain        TEXT NOT NULL,
  question      TEXT NOT NULL,
  scope         JSONB,
  filters       JSONB,
  retrieved     JSONB NOT NULL DEFAULT '[]'::jsonb,
  answer        TEXT,
  citations     JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence    JSONB,
  latency_ms    INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS query_traces_domain_idx ON query_traces (domain, created_at DESC);
