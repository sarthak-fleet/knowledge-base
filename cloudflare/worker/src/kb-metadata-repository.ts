import type { CitationRecord, JsonRecord, SearchResult } from './types';
import type { DomainSchema } from './schema-inference';

export interface DomainRecord {
  project: string;
  name: string;
  description: string;
  embedding_model: string | null;
  embedding_provider: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectRecord {
  name: string;
  description: string;
  kind_count: number;
  file_count: number;
  created_at: string;
  updated_at: string;
}

export interface FileRecord {
  id: string;
  project: string;
  domain: string;
  filename: string;
  mime: string | null;
  bytes: number;
  content_hash: string;
  canonical_hash: string | null;
  object_key: string;
  status: string;
  last_error: string | null;
  uploaded_at: string;
  updated_at: string;
}

export interface ParseArtifactRecord {
  content_hash: string;
  parser: string;
  parser_version: string | null;
  object_key: string;
  page_count: number | null;
  created_at: string;
}

export interface IngestJobRecord {
  id: string;
  project: string;
  domain: string;
  file_id: string;
  schema_id: string | null;
  stage: string;
  status: string;
  attempts: number;
  last_error: string | null;
  queue_message_id: string | null;
  workflow_id: string | null;
  locked_by: string | null;
  locked_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CorpusStatusRecord {
  domain: string;
  has_schema: number;
  draft_count: number;
  file_count: number;
  ready_files: number;
  failed_files: number;
  staged_files: number;
  active_files: number;
  active_jobs: number;
  failed_jobs: number;
  state: string;
}

export interface SchemaRecord {
  id: string;
  project: string;
  domain: string;
  name: string;
  version: number;
  spec: DomainSchema;
  is_active: number;
  created_at: string;
}

export interface SchemaDraftRecord {
  id: string;
  project: string;
  domain: string;
  name: string;
  spec: DomainSchema;
  source: string;
  sample_count: number;
  staged_file_ids: string[];
  errors: JsonRecord[];
  status: string;
  created_at: string;
  updated_at: string;
}

export interface RegisterFileInput {
  id: string;
  project: string;
  domain: string;
  filename: string;
  mime: string | null;
  bytes: number;
  contentHash: string;
  canonicalHash?: string | null;
  objectKey: string;
}

export interface KbChunkInput {
  id: string;
  project: string;
  domain: string;
  fileId: string;
  vectorId: string;
  pageStart: number;
  pageEnd: number;
  text: string;
  contentHash?: string | null;
  metadata?: JsonRecord;
}

export interface EntityRecord {
  id: string;
  project: string;
  domain: string;
  type: string;
  identity_key: string;
  display_name: string | null;
  fields: JsonRecord;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface EntityRelationshipRecord {
  id: string;
  project: string;
  domain: string;
  rel_type: string;
  src_id: string;
  dst_id: string;
  src_name?: string | null;
  dst_name?: string | null;
  evidence_file: string | null;
  evidence_page: number | null;
  created_at: string;
}

export interface EntityLineageRecord {
  ancestors: Array<{
    id: string;
    type: string;
    display_name: string | null;
    depth: number;
  }>;
  children: Array<{
    id: string;
    type: string;
    display_name: string | null;
  }>;
  mentions: Array<{
    file_id: string;
    filename: string;
    confidence: number;
    field_values: JsonRecord;
  }>;
}

export interface RecordStructuredEntitiesInput {
  project: string;
  domain: string;
  fileId: string;
  schema: SchemaRecord;
  records: Array<{
    documentId: string;
    recordIndex: number;
    record: JsonRecord;
    chunks: Array<{ id: string; content: string }>;
  }>;
}

export interface RecordStructuredEntitiesResult {
  entities: number;
  mentions: number;
  relationships: number;
  provenance_spans: number;
  chunks_linked: number;
}

export interface BackfillEntityRelationshipsResult {
  project: string;
  domain: string;
  scanned_entities: number;
  candidate_relationships: number;
  relationships_inserted: number;
  parent_links_updated: number;
}

export interface QueryTraceRecord {
  id: string;
  project: string;
  domain: string;
  question: string;
  scope: string | null;
  filters: JsonRecord | null;
  retrieved: SearchResult[];
  answer: string | null;
  citations: CitationRecord[];
  confidence: JsonRecord | null;
  latency_ms: number | null;
  created_at: string;
}

export interface EvalReportRecord {
  id: string;
  project: string;
  domain: string | null;
  index_id: string | null;
  kind: string;
  summary: JsonRecord;
  rows: JsonRecord[];
  created_at: string;
}

export interface SessionRecord {
  id: string;
  project: string;
  domain: string;
  history: JsonRecord[];
  created_at: string;
  updated_at: string;
}

export interface InsertEvalReportInput {
  project: string;
  kind: string;
  summary: JsonRecord;
  rows: JsonRecord[];
  domain?: string | null;
  indexId?: string | null;
}

export interface InsertQueryTraceInput {
  project: string;
  domain: string;
  question: string;
  scope?: string | null;
  filters?: JsonRecord | null;
  retrieved: SearchResult[];
  answer?: string | null;
  citations?: CitationRecord[];
  confidence?: JsonRecord | null;
  latencyMs?: number | null;
}

export interface MetadataRepository {
  upsertProject(name: string, description?: string): Promise<ProjectRecord>;
  listProjects(project?: string): Promise<ProjectRecord[]>;
  upsertDomain(
    project: string,
    name: string,
    description?: string,
    embedding?: { model?: string | null; provider?: string | null },
  ): Promise<DomainRecord>;
  listDomains(project: string): Promise<DomainRecord[]>;
  insertSchema(project: string, domain: string, name: string, spec: DomainSchema): Promise<SchemaRecord>;
  listSchemas(project: string): Promise<SchemaRecord[]>;
  saveSchemaDraft(input: {
    project: string;
    domain: string;
    name: string;
    spec: DomainSchema;
    source: string;
    sampleCount: number;
    stagedFileIds?: string[];
    errors?: JsonRecord[];
  }): Promise<SchemaDraftRecord>;
  listSchemaDrafts(project: string, domain?: string, status?: string): Promise<SchemaDraftRecord[]>;
  getSchemaDraft(project: string, id: string): Promise<SchemaDraftRecord | null>;
  updateSchemaDraftStatus(project: string, id: string, status: string): Promise<SchemaDraftRecord | null>;
  registerFile(input: RegisterFileInput): Promise<FileRecord>;
  listFiles(project: string, domain?: string, statuses?: string[]): Promise<FileRecord[]>;
  getFile(project: string, id: string): Promise<FileRecord | null>;
  setFileStatus(project: string, id: string, status: string, error?: string | null): Promise<void>;
  listKbChunkVectorIds(project: string, fileIds: string[]): Promise<string[]>;
  deleteFiles(project: string, fileIds: string[]): Promise<FileRecord[]>;
  upsertParseArtifact(input: {
    contentHash: string;
    parser: string;
    parserVersion?: string | null;
    objectKey: string;
    pageCount?: number | null;
  }): Promise<ParseArtifactRecord>;
  getParseArtifact(contentHash: string): Promise<ParseArtifactRecord | null>;
  upsertIngestJob(input: {
    project: string;
    domain: string;
    fileId: string;
    schemaId?: string | null;
    stage?: string;
    status?: string;
    queueMessageId?: string | null;
    workflowId?: string | null;
  }): Promise<IngestJobRecord>;
  updateIngestJob(id: string, input: {
    stage?: string;
    status?: string;
    error?: string | null;
    lockedBy?: string | null;
    incrementAttempts?: boolean;
  }): Promise<void>;
  listIngestJobs(project: string, domain?: string, statuses?: string[], limit?: number): Promise<IngestJobRecord[]>;
  getIngestJob(project: string, id: string): Promise<IngestJobRecord | null>;
  insertKbChunks(chunks: KbChunkInput[]): Promise<void>;
  recordStructuredEntities(input: RecordStructuredEntitiesInput): Promise<RecordStructuredEntitiesResult>;
  backfillEntityRelationships(project: string, schema: SchemaRecord): Promise<BackfillEntityRelationshipsResult>;
  listEntities(project: string, domain?: string, type?: string, limit?: number): Promise<EntityRecord[]>;
  getEntity(project: string, id: string): Promise<EntityRecord | null>;
  findEntity(project: string, domain: string, type: string, identityKey: string): Promise<EntityRecord | null>;
  getEntityLineage(project: string, id: string): Promise<EntityLineageRecord>;
  searchEntities(project: string, domain: string, query: string, limit?: number): Promise<EntityRecord[]>;
  listRelationships(project: string, domain?: string, relType?: string, entityId?: string, limit?: number): Promise<EntityRelationshipRecord[]>;
  createSession(project: string, domain: string, id?: string): Promise<SessionRecord>;
  listSessions(project: string, domain?: string, limit?: number): Promise<SessionRecord[]>;
  getSession(project: string, id: string): Promise<SessionRecord | null>;
  appendSessionHistory(project: string, id: string, entries: JsonRecord[]): Promise<SessionRecord>;
  corpusStatus(project: string): Promise<CorpusStatusRecord[]>;
  insertQueryTrace(input: InsertQueryTraceInput): Promise<QueryTraceRecord>;
  listQueryTraces(project: string, domain?: string, limit?: number): Promise<QueryTraceRecord[]>;
  getQueryTrace(project: string, id: string): Promise<QueryTraceRecord | null>;
  insertEvalReport(input: InsertEvalReportInput): Promise<EvalReportRecord>;
  listEvalReports(project: string, kind?: string, domain?: string, limit?: number): Promise<EvalReportRecord[]>;
  getEvalReport(project: string, id: string): Promise<EvalReportRecord | null>;
}

type StoredDomain = DomainRecord;
type StoredFile = FileRecord;
type StoredParseArtifact = ParseArtifactRecord;
type StoredIngestJob = IngestJobRecord;
type StoredSchema = Omit<SchemaRecord, 'spec'> & { spec: string };
type StoredSchemaDraft = Omit<SchemaDraftRecord, 'spec' | 'staged_file_ids' | 'errors'> & {
  spec: string;
  staged_file_ids: string;
  errors: string;
};
type StoredQueryTrace = Omit<QueryTraceRecord, 'filters' | 'retrieved' | 'citations' | 'confidence'> & {
  filters: string | null;
  retrieved: string;
  citations: string;
  confidence: string | null;
};
type StoredEntity = Omit<EntityRecord, 'fields'> & { fields: string };
type StoredRelationship = EntityRelationshipRecord;
type StoredLineageAncestor = {
  id: string;
  type: string;
  display_name: string | null;
  depth: number;
};
type StoredLineageChild = {
  id: string;
  type: string;
  display_name: string | null;
};
type StoredEntityMention = {
  file_id: string;
  filename: string;
  confidence: number;
  field_values: string;
};
type StoredEvalReport = Omit<EvalReportRecord, 'summary' | 'rows'> & {
  summary: string;
  rows: string;
};
type StoredSession = Omit<SessionRecord, 'history'> & { history: string };

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function ensureRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function rowToSchema(row: StoredSchema): SchemaRecord {
  return { ...row, spec: parseJson<DomainSchema>(row.spec, {} as DomainSchema) };
}

function rowToSchemaDraft(row: StoredSchemaDraft): SchemaDraftRecord {
  return {
    ...row,
    spec: parseJson<DomainSchema>(row.spec, {} as DomainSchema),
    staged_file_ids: parseJson<string[]>(row.staged_file_ids, []),
    errors: parseJson<JsonRecord[]>(row.errors, []),
  };
}

function rowToQueryTrace(row: StoredQueryTrace): QueryTraceRecord {
  return {
    ...row,
    filters: row.filters ? parseJson<JsonRecord>(row.filters, {}) : null,
    retrieved: parseJson<SearchResult[]>(row.retrieved, []),
    citations: parseJson<CitationRecord[]>(row.citations, []),
    confidence: row.confidence ? parseJson<JsonRecord>(row.confidence, {}) : null,
  };
}

function rowToEntity(row: StoredEntity): EntityRecord {
  return { ...row, fields: parseJson<JsonRecord>(row.fields, {}) };
}

function rowToRelationship(row: StoredRelationship): EntityRelationshipRecord {
  return row;
}

function rowToEvalReport(row: StoredEvalReport): EvalReportRecord {
  return {
    ...row,
    summary: parseJson<JsonRecord>(row.summary, {}),
    rows: parseJson<JsonRecord[]>(row.rows, []),
  };
}

function rowToSession(row: StoredSession): SessionRecord {
  return { ...row, history: parseJson<JsonRecord[]>(row.history, []) };
}

function primitiveIdentity(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return null;
}

function primitiveIdentities(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(primitiveIdentity).filter((item): item is string => Boolean(item));
  const identity = primitiveIdentity(value);
  return identity ? [identity] : [];
}

function relationshipTypeFromField(
  field: string,
  identityField: string,
  relationships: DomainSchema['relationships'] = [],
): string | null {
  const lower = field.toLowerCase();
  if (lower === identityField.toLowerCase()) return null;
  if (lower === 'parent' || lower === 'parent_id') return 'parent';
  const inferred = lower.endsWith('_ids') && lower.length > 4
    ? lower.slice(0, -4)
    : lower.endsWith('_id') && lower.length > 3
      ? lower.slice(0, -3)
      : null;
  if (!inferred) return null;
  const declared = relationships.find((relationship) => relationship.name.toLowerCase() === inferred);
  return declared?.name ?? inferred;
}

function relationshipTargetTypes(
  relType: string,
  fallbackType: string,
  relationships: DomainSchema['relationships'] = [],
): string[] {
  const targets = relationships
    .filter((relationship) => relationship.name.toLowerCase() === relType.toLowerCase())
    .map((relationship) => relationship.to_type)
    .filter(Boolean);
  return targets.length > 0 ? [...new Set(targets)] : [fallbackType];
}

function entityLookupKey(type: string, identity: string): string {
  return `${type}\0${identity}`;
}

function canonicalIdentity(value: string): string {
  return value.trim().toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '');
}

function addEntityIdentity(
  identities: Map<string, string>,
  type: string,
  identity: string,
  id: string,
  defaultType: string,
): void {
  const values = [identity, canonicalIdentity(identity)].filter(Boolean);
  for (const value of values) {
    identities.set(entityLookupKey(type, value), id);
    if (type === defaultType) identities.set(value, id);
  }
}

function lookupEntityIdentity(
  identities: Map<string, string>,
  targetTypes: string[],
  identity: string,
): string | null {
  const values = [identity, canonicalIdentity(identity)].filter(Boolean);
  for (const value of values) {
    for (const type of targetTypes) {
      const id = identities.get(entityLookupKey(type, value));
      if (id) return id;
    }
    const id = identities.get(value);
    if (id) return id;
  }
  return null;
}

function relationshipFieldName(type: string): string {
  return type === 'parent' ? 'parent_id' : `${type}_id`;
}

function relationshipValues(record: JsonRecord, field: string, relType: string): string[] {
  const values = primitiveIdentities(record[field]);
  if (values.length > 0 || field.endsWith('_ids')) return values;
  const pluralField = `${relType}_ids`;
  return primitiveIdentities(record[pluralField]);
}

function configuredRelationshipTypes(
  record: JsonRecord,
  identityField: string,
  relationships: DomainSchema['relationships'] = [],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const relationship of relationships) {
    const base = relationship.name.toLowerCase();
    const singular = relationshipFieldName(base);
    const plural = `${base}_ids`;
    if (singular === identityField.toLowerCase() || plural === identityField.toLowerCase()) continue;
    if (Object.prototype.hasOwnProperty.call(record, singular)) map.set(singular, relationship.name);
    if (Object.prototype.hasOwnProperty.call(record, plural)) map.set(plural, relationship.name);
  }
  return map;
}

function relationshipFieldsForRecord(
  record: JsonRecord,
  identityField: string,
  relationships: DomainSchema['relationships'] = [],
): Array<{ field: string; type: string }> {
  const configured = configuredRelationshipTypes(record, identityField, relationships);
  const inferred = Object.keys(record)
    .map((field) => ({ field, type: relationshipTypeFromField(field, identityField, relationships) }))
    .filter((item): item is { field: string; type: string } => Boolean(item.type));
  for (const item of inferred) {
    if (!configured.has(item.field)) configured.set(item.field, item.type);
  }
  return [...configured.entries()].map(([field, type]) => ({ field, type }));
}

function identityFieldForEntity(entityType: DomainSchema['entities'][number]): string {
  return entityType.fields.find((field) => field.identity)?.name
    ?? entityType.fields[0]?.name
    ?? 'id';
}

function entityRecordFields(record: JsonRecord, entityType: DomainSchema['entities'][number], includeAll = false): JsonRecord {
  if (includeAll) return record;
  const out: JsonRecord = {};
  for (const field of entityType.fields) {
    if (Object.prototype.hasOwnProperty.call(record, field.name)) out[field.name] = record[field.name];
  }
  return Object.keys(out).length > 0 ? out : record;
}

function relationshipCandidatesForRecord(
  item: { id: string; type: string; record: JsonRecord; identityField: string },
  relationships: DomainSchema['relationships'],
  defaultType: string,
  entitiesByIdentity: Map<string, string>,
): Array<{ relType: string; srcId: string; dstId: string }> {
  const outgoingRelationships = relationships.filter((relationship) => relationship.from_type === item.type);
  if (relationships.length > 0 && outgoingRelationships.length === 0) return [];
  const out: Array<{ relType: string; srcId: string; dstId: string }> = [];
  const seen = new Set<string>();
  for (const relationshipField of relationshipFieldsForRecord(item.record, item.identityField, outgoingRelationships)) {
    const targetTypesForRelationship = relationshipTargetTypes(
      relationshipField.type,
      defaultType,
      outgoingRelationships,
    );
    for (const targetIdentity of relationshipValues(item.record, relationshipField.field, relationshipField.type)) {
      const targetId = lookupEntityIdentity(entitiesByIdentity, targetTypesForRelationship, targetIdentity);
      if (!targetId || targetId === item.id) continue;
      const key = `${relationshipField.type}:${item.id}:${targetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ relType: relationshipField.type, srcId: item.id, dstId: targetId });
    }
  }
  return out;
}

async function persistedIdentityLookup(
  db: D1Database,
  project: string,
  domain: string,
  types: string[],
  defaultType: string,
): Promise<Map<string, string>> {
  const identities = new Map<string, string>();
  for (const type of types) {
    const rows = await db
      .prepare(
        `SELECT id, type, identity_key, display_name
           FROM kb_entities
          WHERE project = ? AND domain = ? AND type = ?
          LIMIT 10000`,
      )
      .bind(project, domain, type)
      .all<{ id: string; type: string; identity_key: string; display_name: string | null }>();
    for (const row of rows.results ?? []) {
      addEntityIdentity(identities, row.type, row.identity_key, row.id, defaultType);
      if (row.display_name) addEntityIdentity(identities, row.type, row.display_name, row.id, defaultType);
    }
  }
  return identities;
}

function excerptForField(name: string, value: unknown): string {
  const rendered = typeof value === 'string' ? value : JSON.stringify(value);
  return `${name}: ${rendered ?? ''}`.replace(/\s+/g, ' ').trim().slice(0, 500);
}

export class D1MetadataRepository implements MetadataRepository {
  constructor(private readonly db: D1Database) {}

  async ensureProject(project: string): Promise<void> {
    await this.db
      .prepare('INSERT OR IGNORE INTO kb_projects (name, description) VALUES (?, ?)')
      .bind(project, project === 'default' ? 'Default project' : '')
      .run();
  }

  async upsertProject(name: string, description = ''): Promise<ProjectRecord> {
    await this.db
      .prepare(
        `INSERT INTO kb_projects (name, description)
         VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET
           description = COALESCE(excluded.description, kb_projects.description),
           updated_at = datetime('now')`,
      )
      .bind(name, description)
      .run();
    const rows = await this.listProjects(name);
    const row = rows[0];
    if (!row) throw new Error('failed to upsert project');
    return row;
  }

  async listProjects(project?: string): Promise<ProjectRecord[]> {
    const clauses = project ? 'WHERE p.name = ?' : '';
    const stmt = this.db.prepare(
      `SELECT p.name, p.description, p.created_at, p.updated_at,
              (SELECT COUNT(DISTINCT d.name)
                 FROM kb_domains d
                WHERE d.project = p.name) AS kind_count,
              (SELECT COUNT(*)
                 FROM kb_files f
                WHERE f.project = p.name) AS file_count
         FROM kb_projects p
        ${clauses}
        ORDER BY p.name`,
    );
    const result = project
      ? await stmt.bind(project).all<ProjectRecord>()
      : await stmt.all<ProjectRecord>();
    return (result.results ?? []).map((row) => ({
      ...row,
      kind_count: numberValue(row.kind_count),
      file_count: numberValue(row.file_count),
    }));
  }

  async upsertDomain(
    project: string,
    name: string,
    description = '',
    embedding: { model?: string | null; provider?: string | null } = {},
  ): Promise<DomainRecord> {
    await this.ensureProject(project);
    const embeddingModel = embedding.model?.trim() || null;
    const embeddingProvider = embedding.provider?.trim() || null;
    await this.db
      .prepare(
        `INSERT INTO kb_domains (project, name, description, embedding_model, embedding_provider)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project, name) DO UPDATE SET
           description = excluded.description,
           embedding_model = COALESCE(excluded.embedding_model, kb_domains.embedding_model),
           embedding_provider = COALESCE(excluded.embedding_provider, kb_domains.embedding_provider),
           updated_at = datetime('now')`,
      )
      .bind(project, name, description, embeddingModel, embeddingProvider)
      .run();
    const row = await this.db
      .prepare(
        `SELECT project, name, description, embedding_model, embedding_provider, created_at, updated_at
           FROM kb_domains
          WHERE project = ? AND name = ?`,
      )
      .bind(project, name)
      .first<StoredDomain>();
    if (!row) throw new Error('failed to upsert domain');
    return row;
  }

  async listDomains(project: string): Promise<DomainRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT project, name, description, embedding_model, embedding_provider, created_at, updated_at
           FROM kb_domains
          WHERE project = ?
          ORDER BY name`,
      )
      .bind(project)
      .all<StoredDomain>();
    return result.results ?? [];
  }

  async insertSchema(
    project: string,
    domain: string,
    name: string,
    spec: DomainSchema,
  ): Promise<SchemaRecord> {
    await this.upsertDomain(project, domain);
    const versionRow = await this.db
      .prepare(
        `SELECT COALESCE(MAX(version), 0) + 1 AS version
           FROM kb_schemas
          WHERE project = ? AND domain = ? AND name = ?`,
      )
      .bind(project, domain, name)
      .first<{ version: number }>();
    const version = Number(versionRow?.version ?? 1);
    const id = crypto.randomUUID();
    const savedSpec = { ...spec, domain, name, version };
    await this.db
      .prepare('UPDATE kb_schemas SET is_active = 0 WHERE project = ? AND domain = ?')
      .bind(project, domain)
      .run();
    await this.db
      .prepare(
        `INSERT INTO kb_schemas (id, project, domain, name, version, spec, is_active)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
      )
      .bind(id, project, domain, name, version, JSON.stringify(savedSpec))
      .run();
    const row = await this.db
      .prepare(
        `SELECT id, project, domain, name, version, spec, is_active, created_at
           FROM kb_schemas
          WHERE id = ?`,
      )
      .bind(id)
      .first<StoredSchema>();
    if (!row) throw new Error('failed to insert schema');
    return rowToSchema(row);
  }

  async listSchemas(project: string): Promise<SchemaRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT id, project, domain, name, version, spec, is_active, created_at
           FROM kb_schemas
          WHERE project = ? AND is_active = 1
          ORDER BY domain, name`,
      )
      .bind(project)
      .all<StoredSchema>();
    return (result.results ?? []).map(rowToSchema);
  }

  async saveSchemaDraft(input: {
    project: string;
    domain: string;
    name: string;
    spec: DomainSchema;
    source: string;
    sampleCount: number;
    stagedFileIds?: string[];
    errors?: JsonRecord[];
  }): Promise<SchemaDraftRecord> {
    await this.upsertDomain(input.project, input.domain);
    const id = crypto.randomUUID();
    await this.db
      .prepare(
        `INSERT INTO kb_schema_drafts (
           id, project, domain, name, spec, source, sample_count,
           staged_file_ids, errors, status
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      )
      .bind(
        id,
        input.project,
        input.domain,
        input.name,
        JSON.stringify(input.spec),
        input.source,
        input.sampleCount,
        JSON.stringify(input.stagedFileIds ?? []),
        JSON.stringify(input.errors ?? []),
      )
      .run();
    const row = await this.db
      .prepare(
        `SELECT id, project, domain, name, spec, source, sample_count,
                staged_file_ids, errors, status, created_at, updated_at
           FROM kb_schema_drafts
          WHERE id = ?`,
      )
      .bind(id)
      .first<StoredSchemaDraft>();
    if (!row) throw new Error('failed to save schema draft');
    return rowToSchemaDraft(row);
  }

  async listSchemaDrafts(project: string, domain?: string, status = 'pending'): Promise<SchemaDraftRecord[]> {
    const clauses = ['project = ?'];
    const values: string[] = [project];
    if (domain) {
      clauses.push('domain = ?');
      values.push(domain);
    }
    if (status) {
      clauses.push('status = ?');
      values.push(status);
    }
    const result = await this.db
      .prepare(
        `SELECT id, project, domain, name, spec, source, sample_count,
                staged_file_ids, errors, status, created_at, updated_at
           FROM kb_schema_drafts
          WHERE ${clauses.join(' AND ')}
          ORDER BY updated_at DESC`,
      )
      .bind(...values)
      .all<StoredSchemaDraft>();
    return (result.results ?? []).map(rowToSchemaDraft);
  }

  async getSchemaDraft(project: string, id: string): Promise<SchemaDraftRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT id, project, domain, name, spec, source, sample_count,
                staged_file_ids, errors, status, created_at, updated_at
           FROM kb_schema_drafts
          WHERE project = ? AND id = ?`,
      )
      .bind(project, id)
      .first<StoredSchemaDraft>();
    return row ? rowToSchemaDraft(row) : null;
  }

  async updateSchemaDraftStatus(project: string, id: string, status: string): Promise<SchemaDraftRecord | null> {
    await this.db
      .prepare(
        `UPDATE kb_schema_drafts
            SET status = ?, updated_at = datetime('now')
          WHERE project = ? AND id = ?`,
      )
      .bind(status, project, id)
      .run();
    return await this.getSchemaDraft(project, id);
  }

  async registerFile(input: RegisterFileInput): Promise<FileRecord> {
    await this.upsertDomain(input.project, input.domain);
    await this.db
      .prepare(
        `INSERT INTO kb_files (
           id, project, domain, filename, mime, bytes, content_hash,
           canonical_hash, object_key
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project, domain, content_hash) DO UPDATE SET
           filename = excluded.filename,
           mime = excluded.mime,
           bytes = excluded.bytes,
           canonical_hash = excluded.canonical_hash,
           object_key = excluded.object_key,
           updated_at = datetime('now')`,
      )
      .bind(
        input.id,
        input.project,
        input.domain,
        input.filename,
        input.mime,
        input.bytes,
        input.contentHash,
        input.canonicalHash ?? null,
        input.objectKey,
      )
      .run();
    const row = await this.db
      .prepare(
        `SELECT id, project, domain, filename, mime, bytes, content_hash,
                canonical_hash, object_key, status, last_error, uploaded_at, updated_at
           FROM kb_files
          WHERE project = ? AND domain = ? AND content_hash = ?`,
      )
      .bind(input.project, input.domain, input.contentHash)
      .first<StoredFile>();
    if (!row) throw new Error('failed to register file');
    return row;
  }

  async listFiles(project: string, domain?: string, statuses?: string[]): Promise<FileRecord[]> {
    const clauses = ['project = ?'];
    const values: string[] = [project];
    if (domain) {
      clauses.push('domain = ?');
      values.push(domain);
    }
    if (statuses && statuses.length > 0) {
      clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`);
      values.push(...statuses);
    }
    const result = await this.db
      .prepare(
        `SELECT id, project, domain, filename, mime, bytes, content_hash,
                canonical_hash, object_key, status, last_error, uploaded_at, updated_at
           FROM kb_files
          WHERE ${clauses.join(' AND ')}
          ORDER BY uploaded_at ASC`,
      )
      .bind(...values)
      .all<StoredFile>();
    return result.results ?? [];
  }

  async getFile(project: string, id: string): Promise<FileRecord | null> {
    return await this.db
      .prepare(
        `SELECT id, project, domain, filename, mime, bytes, content_hash,
                canonical_hash, object_key, status, last_error, uploaded_at, updated_at
           FROM kb_files
          WHERE project = ? AND id = ?`,
      )
      .bind(project, id)
      .first<StoredFile>();
  }

  async setFileStatus(project: string, id: string, status: string, error: string | null = null): Promise<void> {
    await this.db
      .prepare(
        `UPDATE kb_files
            SET status = ?, last_error = ?, updated_at = datetime('now')
          WHERE project = ? AND id = ?`,
      )
      .bind(status, error, project, id)
      .run();
  }

  async listKbChunkVectorIds(project: string, fileIds: string[]): Promise<string[]> {
    const ids = [...new Set(fileIds.filter(Boolean))];
    if (ids.length === 0) return [];
    const result = await this.db
      .prepare(
        `SELECT vector_id
           FROM kb_chunks
          WHERE project = ?
            AND file_id IN (${ids.map(() => '?').join(', ')})
            AND vector_id IS NOT NULL`,
      )
      .bind(project, ...ids)
      .all<{ vector_id: string }>();
    return (result.results ?? []).map((row) => row.vector_id).filter(Boolean);
  }

  async deleteFiles(project: string, fileIds: string[]): Promise<FileRecord[]> {
    const ids = [...new Set(fileIds.filter(Boolean))];
    if (ids.length === 0) return [];
    const existing = (await Promise.all(ids.map((id) => this.getFile(project, id))))
      .filter((file): file is FileRecord => Boolean(file));
    if (existing.length === 0) return [];
    const placeholders = existing.map(() => '?').join(', ');
    const values = [project, ...existing.map((file) => file.id)];
    await this.db.batch([
      this.db.prepare(`DELETE FROM kb_provenance_spans WHERE project = ? AND file_id IN (${placeholders})`).bind(...values),
      this.db.prepare(`DELETE FROM kb_entity_mentions WHERE project = ? AND file_id IN (${placeholders})`).bind(...values),
      this.db.prepare(`DELETE FROM kb_ingest_jobs WHERE project = ? AND file_id IN (${placeholders})`).bind(...values),
      this.db.prepare(`DELETE FROM kb_chunks WHERE project = ? AND file_id IN (${placeholders})`).bind(...values),
      this.db.prepare(`DELETE FROM kb_files WHERE project = ? AND id IN (${placeholders})`).bind(...values),
    ]);
    return existing;
  }

  async upsertParseArtifact(input: {
    contentHash: string;
    parser: string;
    parserVersion?: string | null;
    objectKey: string;
    pageCount?: number | null;
  }): Promise<ParseArtifactRecord> {
    await this.db
      .prepare(
        `INSERT INTO kb_parse_artifacts (
           content_hash, parser, parser_version, object_key, page_count
         )
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(content_hash) DO UPDATE SET
           parser = excluded.parser,
           parser_version = excluded.parser_version,
           object_key = excluded.object_key,
           page_count = excluded.page_count`,
      )
      .bind(
        input.contentHash,
        input.parser,
        input.parserVersion ?? null,
        input.objectKey,
        input.pageCount ?? null,
      )
      .run();
    const row = await this.getParseArtifact(input.contentHash);
    if (!row) throw new Error('failed to upsert parse artifact');
    return row;
  }

  async getParseArtifact(contentHash: string): Promise<ParseArtifactRecord | null> {
    return await this.db
      .prepare(
        `SELECT content_hash, parser, parser_version, object_key, page_count, created_at
           FROM kb_parse_artifacts
          WHERE content_hash = ?`,
      )
      .bind(contentHash)
      .first<StoredParseArtifact>();
  }

  async upsertIngestJob(input: {
    project: string;
    domain: string;
    fileId: string;
    schemaId?: string | null;
    stage?: string;
    status?: string;
    queueMessageId?: string | null;
    workflowId?: string | null;
  }): Promise<IngestJobRecord> {
    await this.upsertDomain(input.project, input.domain);
    const id = crypto.randomUUID();
    await this.db
      .prepare(
        `INSERT INTO kb_ingest_jobs (
           id, project, domain, file_id, schema_id, stage, status,
           queue_message_id, workflow_id
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(file_id, schema_id) DO UPDATE SET
           stage = excluded.stage,
           status = excluded.status,
           queue_message_id = excluded.queue_message_id,
           workflow_id = excluded.workflow_id,
           last_error = NULL,
           updated_at = datetime('now')`,
      )
      .bind(
        id,
        input.project,
        input.domain,
        input.fileId,
        input.schemaId ?? null,
        input.stage ?? 'parse',
        input.status ?? 'queued',
        input.queueMessageId ?? null,
        input.workflowId ?? null,
      )
      .run();
    const rows = await this.listIngestJobs(input.project, input.domain, undefined, 100);
    const row = rows.find((job) =>
      job.file_id === input.fileId && (job.schema_id ?? null) === (input.schemaId ?? null),
    );
    if (!row) throw new Error('failed to upsert ingest job');
    return row;
  }

  async updateIngestJob(id: string, input: {
    stage?: string;
    status?: string;
    error?: string | null;
    lockedBy?: string | null;
    incrementAttempts?: boolean;
  }): Promise<void> {
    const sets = ['updated_at = datetime(\'now\')'];
    const values: Array<string | null | number> = [];
    if (input.incrementAttempts) {
      sets.push('attempts = attempts + 1');
    }
    if (input.stage !== undefined) {
      sets.push('stage = ?');
      values.push(input.stage);
    }
    if (input.status !== undefined) {
      sets.push('status = ?');
      values.push(input.status);
    }
    if (input.error !== undefined) {
      sets.push('last_error = ?');
      values.push(input.error);
    }
    if (input.lockedBy !== undefined) {
      sets.push('locked_by = ?', 'locked_at = datetime(\'now\')');
      values.push(input.lockedBy);
    }
    values.push(id);
    await this.db
      .prepare(`UPDATE kb_ingest_jobs SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...values)
      .run();
  }

  async listIngestJobs(project: string, domain?: string, statuses?: string[], limit = 100): Promise<IngestJobRecord[]> {
    const clauses = ['project = ?'];
    const values: Array<string | number> = [project];
    if (domain) {
      clauses.push('domain = ?');
      values.push(domain);
    }
    if (statuses && statuses.length > 0) {
      clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`);
      values.push(...statuses);
    }
    values.push(Math.min(Math.max(Math.trunc(limit), 1), 500));
    const result = await this.db
      .prepare(
        `SELECT id, project, domain, file_id, schema_id, stage, status,
                attempts, last_error, queue_message_id, workflow_id,
                locked_by, locked_at, created_at, updated_at
           FROM kb_ingest_jobs
          WHERE ${clauses.join(' AND ')}
          ORDER BY updated_at DESC
          LIMIT ?`,
      )
      .bind(...values)
      .all<StoredIngestJob>();
    return result.results ?? [];
  }

  async getIngestJob(project: string, id: string): Promise<IngestJobRecord | null> {
    return await this.db
      .prepare(
        `SELECT id, project, domain, file_id, schema_id, stage, status,
                attempts, last_error, queue_message_id, workflow_id,
                locked_by, locked_at, created_at, updated_at
           FROM kb_ingest_jobs
          WHERE project = ? AND id = ?`,
      )
      .bind(project, id)
      .first<StoredIngestJob>();
  }

  async insertKbChunks(chunks: KbChunkInput[]): Promise<void> {
    if (chunks.length === 0) return;
    await this.db.batch(chunks.map((chunk) =>
      this.db.prepare(
        `INSERT OR REPLACE INTO kb_chunks (
           id, project, domain, file_id, vector_id, page_start, page_end,
           text, content_hash, metadata
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        chunk.id,
        chunk.project,
        chunk.domain,
        chunk.fileId,
        chunk.vectorId,
        chunk.pageStart,
        chunk.pageEnd,
        chunk.text,
        chunk.contentHash ?? null,
        JSON.stringify(chunk.metadata ?? {}),
      ),
    ));
  }

  async recordStructuredEntities(input: RecordStructuredEntitiesInput): Promise<RecordStructuredEntitiesResult> {
    const entityTypes = input.schema.spec.entities;
    const primaryType = entityTypes[0];
    if (!primaryType || input.records.length === 0) {
      return { entities: 0, mentions: 0, relationships: 0, provenance_spans: 0, chunks_linked: 0 };
    }
    const schemaRelationships = input.schema.spec.relationships ?? [];
    let entities = 0;
    let mentions = 0;
    let relationships = 0;
    let provenanceSpans = 0;
    let chunksLinked = 0;
    const persisted: Array<{
      id: string;
      record: JsonRecord;
      type: string;
      entityType: typeof primaryType;
      identityField: string;
    }> = [];

    for (const item of input.records) {
      for (const entityType of entityTypes) {
        const identityField = identityFieldForEntity(entityType);
        const isPrimary = entityType.name === primaryType.name;
        const identity = primitiveIdentity(item.record[identityField])
          ?? (isPrimary ? `${input.fileId}:record:${item.recordIndex}` : null);
        if (!identity) continue;
        const summaryField = entityType.summary_field ?? identityField;
        const displayName = primitiveIdentity(item.record[summaryField]) ?? identity;
        const fields = entityRecordFields(item.record, entityType, isPrimary);
        const entityId = crypto.randomUUID();
        await this.db
          .prepare(
            `INSERT INTO kb_entities (
               id, project, domain, type, identity_key, display_name, fields
             )
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(project, domain, type, identity_key) DO UPDATE SET
               display_name = excluded.display_name,
               fields = excluded.fields,
               updated_at = datetime('now')`,
          )
          .bind(
            entityId,
            input.project,
            input.domain,
            entityType.name,
            identity,
            displayName,
            JSON.stringify(fields),
          )
          .run();
        const row = await this.db
          .prepare(
            `SELECT id
               FROM kb_entities
              WHERE project = ? AND domain = ? AND type = ? AND identity_key = ?`,
          )
          .bind(input.project, input.domain, entityType.name, identity)
          .first<{ id: string }>();
        if (!row?.id) continue;
        persisted.push({ id: row.id, record: item.record, type: entityType.name, entityType, identityField });
        entities += 1;
        await this.db
          .prepare(
            `INSERT INTO kb_entity_mentions (
               id, project, domain, entity_id, file_id, schema_id, field_values, confidence
             )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(entity_id, file_id, schema_id) DO UPDATE SET
               field_values = excluded.field_values,
               confidence = excluded.confidence`,
          )
          .bind(
            crypto.randomUUID(),
            input.project,
            input.domain,
            row.id,
            input.fileId,
            input.schema.id,
            JSON.stringify(fields),
            0.95,
          )
          .run();
        mentions += 1;
        const spanStatements = Object.entries(fields).slice(0, 50).map(([field, value]) =>
          this.db.prepare(
            `INSERT OR IGNORE INTO kb_provenance_spans (
               id, project, domain, file_id, entity_id, field, page_start, page_end, excerpt
             )
             VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?)`,
          ).bind(
            crypto.randomUUID(),
            input.project,
            input.domain,
            input.fileId,
            row.id,
            field,
            excerptForField(field, value),
          ),
        );
        if (spanStatements.length > 0) {
          await this.db.batch(spanStatements);
          provenanceSpans += spanStatements.length;
        }
        if (!isPrimary) continue;
        const chunkStatements = item.chunks.map((chunk) =>
          this.db.prepare(
            `UPDATE kb_chunks
                SET entity_id = ?
              WHERE project = ? AND domain = ? AND file_id = ? AND vector_id = ?`,
          ).bind(row.id, input.project, input.domain, input.fileId, chunk.id),
        );
        if (chunkStatements.length > 0) {
          await this.db.batch(chunkStatements);
          chunksLinked += chunkStatements.length;
        }
      }
    }
    const targetTypes = new Set<string>(entityTypes.map((entityType) => entityType.name));
    for (const relationship of schemaRelationships) {
      targetTypes.add(relationship.to_type);
    }
    const entitiesByIdentity = await persistedIdentityLookup(
      this.db,
      input.project,
      input.domain,
      [...targetTypes],
      primaryType.name,
    );
    for (const item of persisted) {
      const identity = primitiveIdentity(item.record[item.identityField]);
      if (identity) addEntityIdentity(entitiesByIdentity, item.type, identity, item.id, primaryType.name);
      const summaryField = item.entityType.summary_field ?? item.identityField;
      const display = primitiveIdentity(item.record[summaryField]);
      if (display) addEntityIdentity(entitiesByIdentity, item.type, display, item.id, primaryType.name);
    }
    const relationshipKeys = new Set<string>();
    for (const item of persisted) {
      for (const candidate of relationshipCandidatesForRecord(item, schemaRelationships, primaryType.name, entitiesByIdentity)) {
        const edgeKey = `${candidate.relType}:${candidate.srcId}:${candidate.dstId}`;
        if (relationshipKeys.has(edgeKey)) continue;
        relationshipKeys.add(edgeKey);
        await this.db
          .prepare(
            `INSERT OR IGNORE INTO kb_entity_relationships (
               id, project, domain, rel_type, src_id, dst_id, evidence_file, evidence_page
             )
             VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
          )
          .bind(
            crypto.randomUUID(),
            input.project,
            input.domain,
            candidate.relType,
            candidate.srcId,
            candidate.dstId,
            input.fileId,
          )
          .run();
        if (candidate.relType === 'parent') {
          await this.db
            .prepare(
              `UPDATE kb_entities
                  SET parent_id = ?, updated_at = datetime('now')
                WHERE id = ?`,
            )
            .bind(candidate.dstId, candidate.srcId)
            .run();
        }
        relationships += 1;
      }
    }
    return { entities, mentions, relationships, provenance_spans: provenanceSpans, chunks_linked: chunksLinked };
  }

  async backfillEntityRelationships(project: string, schema: SchemaRecord): Promise<BackfillEntityRelationshipsResult> {
    const primaryType = schema.spec.entities[0];
    if (!primaryType) {
      return {
        project,
        domain: schema.domain,
        scanned_entities: 0,
        candidate_relationships: 0,
        relationships_inserted: 0,
        parent_links_updated: 0,
      };
    }
    const entityTypes = schema.spec.entities.map((entityType) => entityType.name);
    const relationshipTypes = schema.spec.relationships ?? [];
    const targetTypes = new Set<string>(entityTypes);
    for (const relationship of relationshipTypes) targetTypes.add(relationship.to_type);
    const rows = await this.db
      .prepare(
        `SELECT id, project, domain, type, identity_key, display_name,
                fields, parent_id, created_at, updated_at
           FROM kb_entities
          WHERE project = ? AND domain = ?`,
      )
      .bind(project, schema.domain)
      .all<StoredEntity>();
    const entities = (rows.results ?? []).map(rowToEntity);
    const entitiesByIdentity = await persistedIdentityLookup(
      this.db,
      project,
      schema.domain,
      [...targetTypes],
      primaryType.name,
    );
    for (const entity of entities) addEntityIdentity(entitiesByIdentity, entity.type, entity.identity_key, entity.id, primaryType.name);
    let candidateRelationships = 0;
    let relationshipsInserted = 0;
    let parentLinksUpdated = 0;
    const relationshipKeys = new Set<string>();
    for (const entity of entities) {
      const entityType = schema.spec.entities.find((item) => item.name === entity.type);
      if (!entityType) continue;
      const identityField = identityFieldForEntity(entityType);
      const candidates = relationshipCandidatesForRecord(
        { id: entity.id, type: entity.type, record: entity.fields, identityField },
        relationshipTypes,
        primaryType.name,
        entitiesByIdentity,
      );
      for (const candidate of candidates) {
        const edgeKey = `${candidate.relType}:${candidate.srcId}:${candidate.dstId}`;
        if (relationshipKeys.has(edgeKey)) continue;
        relationshipKeys.add(edgeKey);
        candidateRelationships += 1;
        const result = await this.db
          .prepare(
            `INSERT OR IGNORE INTO kb_entity_relationships (
               id, project, domain, rel_type, src_id, dst_id, evidence_file, evidence_page
             )
             VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
          )
          .bind(
            crypto.randomUUID(),
            project,
            schema.domain,
            candidate.relType,
            candidate.srcId,
            candidate.dstId,
          )
          .run();
        if ((result.meta?.changes ?? 0) > 0) relationshipsInserted += 1;
        if (candidate.relType === 'parent') {
          const parentUpdate = await this.db
            .prepare(
              `UPDATE kb_entities
                  SET parent_id = ?, updated_at = datetime('now')
                WHERE id = ? AND (parent_id IS NULL OR parent_id != ?)`,
            )
            .bind(candidate.dstId, candidate.srcId, candidate.dstId)
            .run();
          if ((parentUpdate.meta?.changes ?? 0) > 0) parentLinksUpdated += 1;
        }
      }
    }
    return {
      project,
      domain: schema.domain,
      scanned_entities: entities.length,
      candidate_relationships: candidateRelationships,
      relationships_inserted: relationshipsInserted,
      parent_links_updated: parentLinksUpdated,
    };
  }

  async listEntities(project: string, domain?: string, type?: string, limit = 100): Promise<EntityRecord[]> {
    const clauses = ['project = ?'];
    const values: Array<string | number> = [project];
    if (domain) {
      clauses.push('domain = ?');
      values.push(domain);
    }
    if (type) {
      clauses.push('type = ?');
      values.push(type);
    }
    values.push(Math.min(Math.max(Math.trunc(limit), 1), 500));
    const result = await this.db
      .prepare(
        `SELECT id, project, domain, type, identity_key, display_name,
                fields, parent_id, created_at, updated_at
           FROM kb_entities
          WHERE ${clauses.join(' AND ')}
          ORDER BY updated_at DESC
          LIMIT ?`,
      )
      .bind(...values)
      .all<StoredEntity>();
    return (result.results ?? []).map(rowToEntity);
  }

  async getEntity(project: string, id: string): Promise<EntityRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT id, project, domain, type, identity_key, display_name,
                fields, parent_id, created_at, updated_at
           FROM kb_entities
          WHERE project = ? AND id = ?`,
      )
      .bind(project, id)
      .first<StoredEntity>();
    return row ? rowToEntity(row) : null;
  }

  async findEntity(project: string, domain: string, type: string, identityKey: string): Promise<EntityRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT id, project, domain, type, identity_key, display_name,
                fields, parent_id, created_at, updated_at
           FROM kb_entities
          WHERE project = ? AND domain = ? AND type = ? AND identity_key = ?`,
      )
      .bind(project, domain, type, identityKey)
      .first<StoredEntity>();
    return row ? rowToEntity(row) : null;
  }

  async getEntityLineage(project: string, id: string): Promise<EntityLineageRecord> {
    const [ancestorsResult, childrenResult, mentionsResult] = await Promise.all([
      this.db
        .prepare(
          `WITH RECURSIVE anc(id, type, display_name, parent_id, depth) AS (
             SELECT id, type, display_name, parent_id, 0
               FROM kb_entities
              WHERE project = ? AND id = ?
             UNION ALL
             SELECT e.id, e.type, e.display_name, e.parent_id, anc.depth + 1
               FROM kb_entities e
               JOIN anc ON e.id = anc.parent_id
              WHERE e.project = ?
           )
           SELECT id, type, display_name, depth
             FROM anc
            ORDER BY depth DESC`,
        )
        .bind(project, id, project)
        .all<StoredLineageAncestor>(),
      this.db
        .prepare(
          `SELECT id, type, display_name
             FROM kb_entities
            WHERE project = ? AND parent_id = ?
            ORDER BY type, display_name`,
        )
        .bind(project, id)
        .all<StoredLineageChild>(),
      this.db
        .prepare(
          `SELECT m.file_id, f.filename, m.confidence, m.field_values
             FROM kb_entity_mentions m
             JOIN kb_files f ON f.id = m.file_id
            WHERE m.project = ? AND m.entity_id = ?
            ORDER BY m.created_at DESC`,
        )
        .bind(project, id)
        .all<StoredEntityMention>(),
    ]);
    return {
      ancestors: (ancestorsResult.results ?? []).map((row) => ({
        ...row,
        depth: numberValue(row.depth),
      })),
      children: childrenResult.results ?? [],
      mentions: (mentionsResult.results ?? []).map((row) => ({
        file_id: row.file_id,
        filename: row.filename,
        confidence: numberValue(row.confidence),
        field_values: parseJson<JsonRecord>(row.field_values, {}),
      })),
    };
  }

  async searchEntities(project: string, domain: string, query: string, limit = 20): Promise<EntityRecord[]> {
    const tokens = query.toLowerCase().match(/[a-z0-9][a-z0-9-]{1,}/g)?.slice(0, 8) ?? [];
    if (tokens.length === 0) return [];
    const clauses = tokens.map(() =>
      `(lower(identity_key) LIKE ? OR lower(COALESCE(display_name, '')) LIKE ? OR lower(fields) LIKE ?)`,
    );
    const values: Array<string | number> = [project, domain];
    for (const token of tokens) {
      const pattern = `%${token}%`;
      values.push(pattern, pattern, pattern);
    }
    values.push(Math.min(Math.max(Math.trunc(limit), 1), 100));
    const result = await this.db
      .prepare(
        `SELECT id, project, domain, type, identity_key, display_name,
                fields, parent_id, created_at, updated_at
           FROM kb_entities
          WHERE project = ? AND domain = ? AND (${clauses.join(' OR ')})
          ORDER BY updated_at DESC
          LIMIT ?`,
      )
      .bind(...values)
      .all<StoredEntity>();
    return (result.results ?? []).map(rowToEntity);
  }

  async listRelationships(
    project: string,
    domain?: string,
    relType?: string,
    entityId?: string,
    limit = 100,
  ): Promise<EntityRelationshipRecord[]> {
    const clauses = ['project = ?'];
    const values: Array<string | number> = [project];
    if (domain) {
      clauses.push('domain = ?');
      values.push(domain);
    }
    if (relType) {
      clauses.push('rel_type = ?');
      values.push(relType);
    }
    if (entityId) {
      clauses.push('(src_id = ? OR dst_id = ?)');
      values.push(entityId, entityId);
    }
    values.push(Math.min(Math.max(Math.trunc(limit), 1), 500));
    const result = await this.db
      .prepare(
        `SELECT id, project, domain, rel_type, src_id, dst_id,
                evidence_file, evidence_page, created_at
           FROM kb_entity_relationships
          WHERE ${clauses.join(' AND ')}
          ORDER BY created_at DESC
          LIMIT ?`,
      )
      .bind(...values)
      .all<StoredRelationship>();
    return (result.results ?? []).map(rowToRelationship);
  }

  async createSession(project: string, domain: string, id = crypto.randomUUID()): Promise<SessionRecord> {
    await this.upsertDomain(project, domain);
    await this.db
      .prepare(
        `INSERT OR IGNORE INTO kb_sessions (id, project, domain, history)
         VALUES (?, ?, ?, '[]')`,
      )
      .bind(id, project, domain)
      .run();
    const row = await this.getSession(project, id);
    if (!row) throw new Error('failed to create session');
    return row;
  }

  async listSessions(project: string, domain?: string, limit = 50): Promise<SessionRecord[]> {
    const clauses = ['project = ?'];
    const values: Array<string | number> = [project];
    if (domain) {
      clauses.push('domain = ?');
      values.push(domain);
    }
    values.push(Math.min(Math.max(Math.trunc(limit), 1), 100));
    const result = await this.db
      .prepare(
        `SELECT id, project, domain, history, created_at, updated_at
           FROM kb_sessions
          WHERE ${clauses.join(' AND ')}
          ORDER BY updated_at DESC
          LIMIT ?`,
      )
      .bind(...values)
      .all<StoredSession>();
    return (result.results ?? []).map(rowToSession);
  }

  async getSession(project: string, id: string): Promise<SessionRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT id, project, domain, history, created_at, updated_at
           FROM kb_sessions
          WHERE project = ? AND id = ?`,
      )
      .bind(project, id)
      .first<StoredSession>();
    return row ? rowToSession(row) : null;
  }

  async appendSessionHistory(project: string, id: string, entries: JsonRecord[]): Promise<SessionRecord> {
    const session = await this.getSession(project, id);
    if (!session) throw new Error('session not found');
    const history = [...session.history, ...entries].slice(-200);
    await this.db
      .prepare(
        `UPDATE kb_sessions
            SET history = ?, updated_at = datetime('now')
          WHERE project = ? AND id = ?`,
      )
      .bind(JSON.stringify(history), project, id)
      .run();
    const updated = await this.getSession(project, id);
    if (!updated) throw new Error('session not found');
    return updated;
  }

  async corpusStatus(project: string): Promise<CorpusStatusRecord[]> {
    const result = await this.db
      .prepare(
        `WITH kinds AS (
           SELECT domain FROM kb_schemas WHERE project = ?
           UNION
           SELECT domain FROM kb_files WHERE project = ?
           UNION
           SELECT domain FROM kb_ingest_jobs WHERE project = ?
           UNION
           SELECT domain FROM kb_schema_drafts WHERE project = ?
           UNION
           SELECT name AS domain FROM kb_domains WHERE project = ?
         ),
         agg AS (
           SELECT k.domain,
                  EXISTS (
                    SELECT 1 FROM kb_schemas s
                     WHERE s.project = ? AND s.domain = k.domain AND s.is_active = 1
                  ) AS has_schema,
                  (SELECT COUNT(*) FROM kb_schema_drafts d
                    WHERE d.project = ? AND d.domain = k.domain AND d.status = 'pending') AS draft_count,
                  (SELECT COUNT(*) FROM kb_files f
                    WHERE f.project = ? AND f.domain = k.domain) AS file_count,
                  (SELECT COUNT(*) FROM kb_files f
                    WHERE f.project = ? AND f.domain = k.domain AND f.status = 'ready') AS ready_files,
                  (SELECT COUNT(*) FROM kb_files f
                    WHERE f.project = ? AND f.domain = k.domain AND f.status = 'failed') AS failed_files,
                  (SELECT COUNT(*) FROM kb_files f
                    WHERE f.project = ? AND f.domain = k.domain AND f.status = 'pending') AS staged_files,
                  (SELECT COUNT(*) FROM kb_files f
                    WHERE f.project = ? AND f.domain = k.domain
                      AND f.status IN ('parsing', 'extracting', 'resolving', 'indexing')) AS active_files,
                  (SELECT COUNT(*) FROM kb_ingest_jobs j
                    WHERE j.project = ? AND j.domain = k.domain
                      AND j.status IN ('queued', 'running')) AS active_jobs,
                  (SELECT COUNT(*) FROM kb_ingest_jobs j
                    WHERE j.project = ? AND j.domain = k.domain AND j.status = 'failed') AS failed_jobs
             FROM kinds k
         )
         SELECT domain, has_schema, draft_count, file_count, ready_files, failed_files,
                staged_files, active_files, active_jobs, failed_jobs,
                CASE
                  WHEN failed_files > 0 OR failed_jobs > 0 THEN 'failed'
                  WHEN active_files > 0 OR active_jobs > 0 THEN 'ingesting'
                  WHEN ready_files > 0 AND has_schema THEN 'ready'
                  WHEN staged_files > 0 AND has_schema THEN 'files_staged'
                  WHEN draft_count > 0 THEN 'schema_draft'
                  WHEN has_schema THEN 'schema_ready'
                  ELSE 'no_schema'
                END AS state
           FROM agg
          ORDER BY domain`,
      )
      .bind(
        project,
        project,
        project,
        project,
        project,
        project,
        project,
        project,
        project,
        project,
        project,
        project,
        project,
        project,
      )
      .all<CorpusStatusRecord>();
    return result.results ?? [];
  }

  async insertQueryTrace(input: InsertQueryTraceInput): Promise<QueryTraceRecord> {
    await this.upsertDomain(input.project, input.domain);
    const id = crypto.randomUUID();
    await this.db
      .prepare(
        `INSERT INTO kb_query_traces (
           id, project, domain, question, scope, filters, retrieved,
           answer, citations, confidence, latency_ms
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.project,
        input.domain,
        input.question,
        input.scope ?? null,
        input.filters ? JSON.stringify(input.filters) : null,
        JSON.stringify(input.retrieved),
        input.answer ?? null,
        JSON.stringify(input.citations ?? []),
        input.confidence ? JSON.stringify(input.confidence) : null,
        input.latencyMs ?? null,
      )
      .run();
    const row = await this.getQueryTrace(input.project, id);
    if (!row) throw new Error('failed to insert query trace');
    return row;
  }

  async listQueryTraces(project: string, domain?: string, limit = 50): Promise<QueryTraceRecord[]> {
    const cappedLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const where = domain ? 'project = ? AND domain = ?' : 'project = ?';
    const values = domain ? [project, domain, cappedLimit] : [project, cappedLimit];
    const result = await this.db
      .prepare(
        `SELECT id, project, domain, question, scope, filters, retrieved,
                answer, citations, confidence, latency_ms, created_at
           FROM kb_query_traces
          WHERE ${where}
          ORDER BY created_at DESC
          LIMIT ?`,
      )
      .bind(...values)
      .all<StoredQueryTrace>();
    return (result.results ?? []).map(rowToQueryTrace);
  }

  async getQueryTrace(project: string, id: string): Promise<QueryTraceRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT id, project, domain, question, scope, filters, retrieved,
                answer, citations, confidence, latency_ms, created_at
           FROM kb_query_traces
          WHERE project = ? AND id = ?`,
      )
      .bind(project, id)
      .first<StoredQueryTrace>();
    return row ? rowToQueryTrace(row) : null;
  }

  async insertEvalReport(input: InsertEvalReportInput): Promise<EvalReportRecord> {
    await this.ensureProject(input.project);
    const id = crypto.randomUUID();
    await this.db
      .prepare(
        `INSERT INTO kb_eval_reports (
           id, project, domain, index_id, kind, summary, rows
         )
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        input.project,
        input.domain ?? null,
        input.indexId ?? null,
        input.kind,
        JSON.stringify(input.summary),
        JSON.stringify(input.rows),
      )
      .run();
    const row = await this.getEvalReport(input.project, id);
    if (!row) throw new Error('failed to insert eval report');
    return row;
  }

  async listEvalReports(project: string, kind?: string, domain?: string, limit = 50): Promise<EvalReportRecord[]> {
    const clauses = ['project = ?'];
    const values: Array<string | number> = [project];
    if (kind) {
      clauses.push('kind = ?');
      values.push(kind);
    }
    if (domain) {
      clauses.push('domain = ?');
      values.push(domain);
    }
    values.push(Math.min(Math.max(Math.trunc(limit), 1), 100));
    const result = await this.db
      .prepare(
        `SELECT id, project, domain, index_id, kind, summary, rows, created_at
           FROM kb_eval_reports
          WHERE ${clauses.join(' AND ')}
          ORDER BY created_at DESC
          LIMIT ?`,
      )
      .bind(...values)
      .all<StoredEvalReport>();
    return (result.results ?? []).map(rowToEvalReport);
  }

  async getEvalReport(project: string, id: string): Promise<EvalReportRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT id, project, domain, index_id, kind, summary, rows, created_at
           FROM kb_eval_reports
          WHERE project = ? AND id = ?`,
      )
      .bind(project, id)
      .first<StoredEvalReport>();
    return row ? rowToEvalReport(row) : null;
  }
}

export function parseFileRegistrationBody(value: unknown): Omit<RegisterFileInput, 'id' | 'project'> {
  const body = ensureRecord(value);
  const domain = stringValue(body.domain).trim();
  const filename = stringValue(body.filename).trim();
  const contentHash = stringValue(body.content_hash).trim();
  const objectKey = stringValue(body.object_key).trim();
  return {
    domain,
    filename,
    mime: stringValue(body.mime).trim() || null,
    bytes: numberValue(body.bytes),
    contentHash,
    canonicalHash: stringValue(body.canonical_hash).trim() || null,
    objectKey,
  };
}

export function safeObjectKeySegment(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  return normalized.replace(/^-+|-+$/g, '') || 'file';
}
