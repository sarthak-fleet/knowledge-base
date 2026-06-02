-- 06_project_uniqueness.sql — make project the real data namespace.
--
-- Migration 05 added project columns but left several legacy unique constraints
-- keyed only by domain/kind. That made a second project able to overwrite or
-- merge rows from the first. Keep domains as the global kind registry required
-- by the original FK shape, but scope user data by (project, domain, ...).

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS project TEXT NOT NULL DEFAULT 'default';
ALTER TABLE entity_mentions ADD COLUMN IF NOT EXISTS domain TEXT NOT NULL DEFAULT '';
ALTER TABLE provenance_spans ADD COLUMN IF NOT EXISTS project TEXT NOT NULL DEFAULT 'default';
ALTER TABLE provenance_spans ADD COLUMN IF NOT EXISTS domain TEXT NOT NULL DEFAULT '';

ALTER TABLE schemas DROP CONSTRAINT IF EXISTS schemas_domain_name_version_key;
ALTER TABLE files DROP CONSTRAINT IF EXISTS files_domain_content_hash_key;
ALTER TABLE entities DROP CONSTRAINT IF EXISTS entities_domain_type_identity_key_key;
ALTER TABLE entity_relationships DROP CONSTRAINT IF EXISTS entity_relationships_domain_rel_type_src_id_dst_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS schemas_project_domain_name_version_uidx
  ON schemas (project, domain, name, version);
CREATE UNIQUE INDEX IF NOT EXISTS files_project_domain_content_hash_uidx
  ON files (project, domain, content_hash);
CREATE UNIQUE INDEX IF NOT EXISTS entities_project_domain_type_identity_key_uidx
  ON entities (project, domain, type, identity_key);
CREATE UNIQUE INDEX IF NOT EXISTS entity_relationships_project_domain_rel_type_src_dst_uidx
  ON entity_relationships (project, domain, rel_type, src_id, dst_id);

CREATE INDEX IF NOT EXISTS sessions_project_domain_idx ON sessions (project, domain);
CREATE INDEX IF NOT EXISTS schemas_project_active_idx ON schemas (project, domain) WHERE is_active;
CREATE INDEX IF NOT EXISTS chunks_project_content_hash_idx ON chunks (project, domain, content_hash);

CREATE UNIQUE INDEX IF NOT EXISTS provenance_spans_idempotency_idx
  ON provenance_spans (
    project,
    domain,
    file_id,
    COALESCE(entity_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(field, ''),
    page_start,
    page_end,
    COALESCE(element_id, ''),
    md5(excerpt)
  );
