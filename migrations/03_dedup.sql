-- Chunk-level dedup + multi-source tracking. Idempotent.
--
-- content_hash: sha256 of normalize(text). Lets us short-circuit duplicate
-- chunks across files (boilerplate, repeated paragraphs, etc.) without an
-- embedding lookup.
--
-- also_in_files: every additional file_id whose chunk was deduped to point
-- at THIS canonical chunk. The primary file_id stays in `file_id`; the array
-- captures the rest so retrieval can cite all sources at once.
--
-- canonical_hash (on files): sha256 of normalized canonical text post-parse.
-- Catches the "same 10-K downloaded as PDF vs HTML" case where bytes differ
-- but content is identical.

ALTER TABLE chunks ADD COLUMN IF NOT EXISTS content_hash TEXT;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS also_in_files UUID[] DEFAULT '{}'::uuid[];
CREATE INDEX IF NOT EXISTS chunks_content_hash_idx ON chunks (domain, content_hash);

ALTER TABLE files ADD COLUMN IF NOT EXISTS canonical_hash TEXT;
CREATE INDEX IF NOT EXISTS files_canonical_hash_idx ON files (domain, canonical_hash);
