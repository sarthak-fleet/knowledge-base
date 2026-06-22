import { strToU8, zipSync } from 'fflate';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildLegacyParseEvalCases } from '../scripts/legacy-parse-eval.mjs';
import { TtlCache } from '../src/cache';
import { createApp, createWorker } from '../src/index';
import type {
  CorpusStatusRecord,
  DomainRecord,
  EntityRecord,
  EntityLineageRecord,
  EntityRelationshipRecord,
  EvalReportRecord,
  FileRecord,
  IngestJobRecord,
  InsertEvalReportInput,
  InsertQueryTraceInput,
  KbChunkInput,
  MetadataRepository,
  ParseArtifactRecord,
  ProjectRecord,
  QueryTraceRecord,
  RecordStructuredEntitiesInput,
  RecordStructuredEntitiesResult,
  RegisterFileInput,
  SchemaDraftRecord,
  SchemaRecord,
  SessionRecord,
} from '../src/kb-metadata-repository';
import type {
  CreateChunkInput,
  CreateDocumentInput,
  CreateIndexInput,
  LexicalChunkRecord,
  Repository,
} from '../src/repository';
import type {
  ChunkRecord,
  CitationRecord,
  DocumentRecord,
  Env,
  IndexRecord,
  JsonRecord,
  KbIngestQueueMessage,
  SearchResult,
  VectorizeBinding,
  VectorizeVector,
} from '../src/types';
import type { DomainSchema } from '../src/schema-inference';

function xlsxFixtureBytes(): ArrayBuffer {
  const zip = zipSync({
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>'),
    'xl/workbook.xml': strToU8(
      '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Contracts" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    ),
    'xl/sharedStrings.xml': strToU8(
      '<sst><si><t>contract_id</t></si><si><t>counterparty</t></si><si><t>value</t></si><si><t>c-9</t></si><si><t>Gamma</t></si></sst>',
    ),
    'xl/worksheets/sheet1.xml': strToU8(
      '<worksheet><sheetData><row r="1"><c t="s"><v>0</v></c><c t="s"><v>1</v></c><c t="s"><v>2</v></c></row><row r="2"><c t="s"><v>3</v></c><c t="s"><v>4</v></c><c><v>9000</v></c></row></sheetData></worksheet>',
    ),
  });
  return zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer;
}

function docxFixtureBytes(): ArrayBuffer {
  const zip = zipSync({
    '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>'),
    'word/document.xml': strToU8(
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Cloudflare Worker RAG migration</w:t></w:r></w:p><w:p><w:r><w:t>Runbooks mention durable Vectorize evidence</w:t></w:r></w:p></w:body></w:document>',
    ),
  });
  return zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength) as ArrayBuffer;
}

function pdfTableFixtureBytes(): ArrayBuffer {
  return new TextEncoder().encode([
    '%PDF-1.7',
    '1 0 obj << /Type /Page >> endobj',
    'BT',
    '1 0 0 1 72 720 Tm (Metric) Tj',
    '1 0 0 1 180 720 Tm (Value) Tj',
    '1 0 0 1 72 700 Tm (Revenue) Tj',
    '1 0 0 1 180 700 Tm (1000) Tj',
    'ET',
    '%%EOF',
  ].join('\n')).buffer as ArrayBuffer;
}

class MemoryRepository implements Repository {
  indexes = new Map<string, IndexRecord>();
  documents = new Map<string, DocumentRecord>();
  chunks = new Map<string, ChunkRecord>();
  getIndexCalls = 0;
  getIndexByExternalIdCalls = 0;
  listChunksForIndexCalls = 0;

  async createIndex(input: CreateIndexInput): Promise<IndexRecord> {
    const row: IndexRecord = {
      id: input.id,
      tenant: input.tenant,
      name: input.name,
      external_id: input.externalId,
      dimensions: input.dimensions,
      embedding_model: input.embeddingModel ?? null,
      embedding_provider: input.embeddingProvider ?? null,
      metric: 'cosine',
      created_at: new Date(0).toISOString(),
    };
    this.indexes.set(row.id, row);
    return row;
  }

  async listIndexes(tenant: string): Promise<IndexRecord[]> {
    return [...this.indexes.values()].filter((row) => row.tenant === tenant);
  }

  async getIndex(tenant: string, id: string): Promise<IndexRecord | null> {
    this.getIndexCalls += 1;
    const row = this.indexes.get(id);
    return row?.tenant === tenant ? row : null;
  }

  async getIndexByExternalId(tenant: string, externalId: string): Promise<IndexRecord | null> {
    this.getIndexByExternalIdCalls += 1;
    return [...this.indexes.values()].find(
      (row) => row.tenant === tenant && row.external_id === externalId,
    ) ?? null;
  }

  async deleteIndex(tenant: string, id: string): Promise<void> {
    const row = this.indexes.get(id);
    if (row?.tenant === tenant) this.indexes.delete(id);
  }

  async createDocument(input: CreateDocumentInput): Promise<DocumentRecord> {
    const row: DocumentRecord = {
      id: input.id,
      index_id: input.indexId,
      tenant: input.tenant,
      external_id: input.externalId,
      content: input.content,
      metadata: input.metadata,
      created_at: new Date(0).toISOString(),
    };
    this.documents.set(row.id, row);
    return row;
  }

  async listDocuments(tenant: string, indexId: string): Promise<DocumentRecord[]> {
    return [...this.documents.values()].filter(
      (row) => row.tenant === tenant && row.index_id === indexId,
    );
  }

  async getDocument(tenant: string, id: string): Promise<DocumentRecord | null> {
    const row = this.documents.get(id);
    return row?.tenant === tenant ? row : null;
  }

  async deleteDocument(tenant: string, id: string): Promise<void> {
    const row = this.documents.get(id);
    if (row?.tenant === tenant) this.documents.delete(id);
  }

  async insertChunks(chunks: CreateChunkInput[]): Promise<void> {
    for (const chunk of chunks) {
      this.chunks.set(chunk.id, {
        id: chunk.id,
        document_id: chunk.documentId,
        index_id: chunk.indexId,
        tenant: chunk.tenant,
        content: chunk.content,
        chunk_index: chunk.chunkIndex,
        metadata: chunk.metadata,
        created_at: new Date(0).toISOString(),
      });
    }
  }

  async getChunksByIds(tenant: string, ids: string[]): Promise<ChunkRecord[]> {
    const rows: ChunkRecord[] = [];
    for (const id of ids) {
      const row = this.chunks.get(id);
      if (row && row.tenant === tenant) rows.push(row);
    }
    return rows;
  }

  async listChunksForIndex(tenant: string, indexId: string, limit: number): Promise<ChunkRecord[]> {
    this.listChunksForIndexCalls += 1;
    return [...this.chunks.values()]
      .filter((row) => row.tenant === tenant && row.index_id === indexId)
      .sort((a, b) => a.chunk_index - b.chunk_index)
      .slice(0, limit);
  }

  async searchLexicalChunks(
    tenant: string,
    indexId: string,
    tokens: string[],
    limit: number,
  ): Promise<LexicalChunkRecord[]> {
    return [...this.chunks.values()]
      .filter((row) => row.tenant === tenant && row.index_id === indexId)
      .map((row) => ({
        ...row,
        lexical_score: tokens.filter((token) => row.content.toLowerCase().includes(token)).length,
      }))
      .filter((row) => row.lexical_score > 0)
      .sort((a, b) => b.lexical_score - a.lexical_score || a.chunk_index - b.chunk_index)
      .slice(0, limit);
  }

  async getChunkIdsForDocument(tenant: string, documentId: string): Promise<string[]> {
    return [...this.chunks.values()]
      .filter((row) => row.tenant === tenant && row.document_id === documentId)
      .map((row) => row.id);
  }

  async getChunkIdsForIndex(tenant: string, indexId: string): Promise<string[]> {
    return [...this.chunks.values()]
      .filter((row) => row.tenant === tenant && row.index_id === indexId)
      .map((row) => row.id);
  }
}

class MemoryMetadataRepository implements MetadataRepository {
  projects = new Map<string, ProjectRecord>();
  domains = new Map<string, DomainRecord>();
  entities = new Map<string, EntityRecord>();
  relationships = new Map<string, EntityRelationshipRecord>();
  files = new Map<string, FileRecord>();
  artifacts = new Map<string, ParseArtifactRecord>();
  jobs = new Map<string, IngestJobRecord>();
  evalReports = new Map<string, EvalReportRecord>();
  sessions = new Map<string, SessionRecord>();
  schemas = new Map<string, SchemaRecord>();
  drafts = new Map<string, SchemaDraftRecord>();
  traces = new Map<string, QueryTraceRecord>();
  chunks = new Map<string, KbChunkInput>();

  async upsertProject(name: string, description = ''): Promise<ProjectRecord> {
    const existing = this.projects.get(name);
    const row: ProjectRecord = {
      name,
      description,
      kind_count: [...this.domains.values()].filter((domain) => domain.project === name).length,
      file_count: [...this.files.values()].filter((file) => file.project === name).length,
      created_at: existing?.created_at ?? new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    };
    this.projects.set(name, row);
    return row;
  }

  async listProjects(project?: string): Promise<ProjectRecord[]> {
    const names = new Set<string>([...this.projects.keys()]);
    for (const domain of this.domains.values()) names.add(domain.project);
    for (const file of this.files.values()) names.add(file.project);
    const projects = [...names].filter((name) => !project || name === project);
    return projects.map((name) => ({
      name,
      description: this.projects.get(name)?.description ?? '',
      kind_count: [...this.domains.values()].filter((domain) => domain.project === name).length,
      file_count: [...this.files.values()].filter((file) => file.project === name).length,
      created_at: this.projects.get(name)?.created_at ?? new Date(0).toISOString(),
      updated_at: this.projects.get(name)?.updated_at ?? new Date(0).toISOString(),
    }));
  }

  async upsertDomain(
    project: string,
    name: string,
    description = '',
    embedding: { model?: string | null; provider?: string | null } = {},
  ): Promise<DomainRecord> {
    await this.upsertProject(project);
    const key = `${project}:${name}`;
    const existing = this.domains.get(key);
    const row: DomainRecord = {
      project,
      name,
      description,
      embedding_model: embedding.model?.trim() || existing?.embedding_model || null,
      embedding_provider: embedding.provider?.trim() || existing?.embedding_provider || null,
      created_at: existing?.created_at ?? new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    };
    this.domains.set(key, row);
    return row;
  }

  async listDomains(project: string): Promise<DomainRecord[]> {
    return [...this.domains.values()].filter((row) => row.project === project);
  }

  async insertSchema(
    project: string,
    domain: string,
    name: string,
    spec: DomainSchema,
  ): Promise<SchemaRecord> {
    await this.upsertDomain(project, domain);
    const version = [...this.schemas.values()].filter(
      (schema) => schema.project === project && schema.domain === domain && schema.name === name,
    ).length + 1;
    const row: SchemaRecord = {
      id: `schema-${this.schemas.size + 1}`,
      project,
      domain,
      name,
      version,
      spec: { ...spec, version },
      is_active: 1,
      created_at: new Date(0).toISOString(),
    };
    for (const schema of this.schemas.values()) {
      if (schema.project === project && schema.domain === domain) schema.is_active = 0;
    }
    this.schemas.set(row.id, row);
    return row;
  }

  async listSchemas(project: string): Promise<SchemaRecord[]> {
    return [...this.schemas.values()].filter((row) => row.project === project && row.is_active === 1);
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
    const row: SchemaDraftRecord = {
      id: `draft-${this.drafts.size + 1}`,
      project: input.project,
      domain: input.domain,
      name: input.name,
      spec: input.spec,
      source: input.source,
      sample_count: input.sampleCount,
      staged_file_ids: input.stagedFileIds ?? [],
      errors: input.errors ?? [],
      status: 'pending',
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    };
    this.drafts.set(row.id, row);
    return row;
  }

  async listSchemaDrafts(project: string, domain?: string, status = 'pending'): Promise<SchemaDraftRecord[]> {
    return [...this.drafts.values()].filter((row) =>
      row.project === project
      && (!domain || row.domain === domain)
      && (!status || row.status === status),
    );
  }

  async getSchemaDraft(project: string, id: string): Promise<SchemaDraftRecord | null> {
    const row = this.drafts.get(id);
    return row?.project === project ? row : null;
  }

  async updateSchemaDraftStatus(project: string, id: string, status: string): Promise<SchemaDraftRecord | null> {
    const row = await this.getSchemaDraft(project, id);
    if (!row) return null;
    row.status = status;
    row.updated_at = new Date(0).toISOString();
    return row;
  }

  async registerFile(input: RegisterFileInput): Promise<FileRecord> {
    await this.upsertDomain(input.project, input.domain);
    const key = `${input.project}:${input.domain}:${input.contentHash}`;
    const existing = this.files.get(key);
    const row: FileRecord = {
      id: existing?.id ?? input.id,
      project: input.project,
      domain: input.domain,
      filename: input.filename,
      mime: input.mime,
      bytes: input.bytes,
      content_hash: input.contentHash,
      canonical_hash: input.canonicalHash ?? null,
      object_key: input.objectKey,
      status: existing?.status ?? 'pending',
      last_error: existing?.last_error ?? null,
      uploaded_at: existing?.uploaded_at ?? new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    };
    this.files.set(key, row);
    return row;
  }

  async listFiles(project: string, domain?: string, statuses?: string[]): Promise<FileRecord[]> {
    return [...this.files.values()].filter((row) =>
      row.project === project
      && (!domain || row.domain === domain)
      && (!statuses || statuses.length === 0 || statuses.includes(row.status)),
    );
  }

  async getFile(project: string, id: string): Promise<FileRecord | null> {
    return [...this.files.values()].find((row) => row.project === project && row.id === id) ?? null;
  }

  async setFileStatus(project: string, id: string, status: string, error: string | null = null): Promise<void> {
    const file = await this.getFile(project, id);
    if (!file) return;
    file.status = status;
    file.last_error = error;
  }

  async listKbChunkVectorIds(project: string, fileIds: string[]): Promise<string[]> {
    const selected = new Set(fileIds);
    return [...this.chunks.values()]
      .filter((chunk) => chunk.project === project && selected.has(chunk.fileId))
      .map((chunk) => chunk.vectorId)
      .filter(Boolean);
  }

  async deleteFiles(project: string, fileIds: string[]): Promise<FileRecord[]> {
    const selected = new Set(fileIds);
    const deleted = [...this.files.values()].filter((file) => file.project === project && selected.has(file.id));
    for (const file of deleted) {
      const key = `${file.project}:${file.domain}:${file.content_hash}`;
      this.files.delete(key);
    }
    for (const [id, job] of this.jobs) {
      if (job.project === project && selected.has(job.file_id)) this.jobs.delete(id);
    }
    for (const [id, chunk] of this.chunks) {
      if (chunk.project === project && selected.has(chunk.fileId)) this.chunks.delete(id);
    }
    return deleted;
  }

  async upsertParseArtifact(input: {
    contentHash: string;
    parser: string;
    parserVersion?: string | null;
    objectKey: string;
    pageCount?: number | null;
  }): Promise<ParseArtifactRecord> {
    const row: ParseArtifactRecord = {
      content_hash: input.contentHash,
      parser: input.parser,
      parser_version: input.parserVersion ?? null,
      object_key: input.objectKey,
      page_count: input.pageCount ?? null,
      created_at: this.artifacts.get(input.contentHash)?.created_at ?? new Date(0).toISOString(),
    };
    this.artifacts.set(input.contentHash, row);
    return row;
  }

  async getParseArtifact(contentHash: string): Promise<ParseArtifactRecord | null> {
    return this.artifacts.get(contentHash) ?? null;
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
    const existing = [...this.jobs.values()].find((job) =>
      job.file_id === input.fileId && (job.schema_id ?? null) === (input.schemaId ?? null),
    );
    const row: IngestJobRecord = {
      id: existing?.id ?? `job-${this.jobs.size + 1}`,
      project: input.project,
      domain: input.domain,
      file_id: input.fileId,
      schema_id: input.schemaId ?? null,
      stage: input.stage ?? 'parse',
      status: input.status ?? 'queued',
      attempts: existing?.attempts ?? 0,
      last_error: null,
      queue_message_id: input.queueMessageId ?? null,
      workflow_id: input.workflowId ?? null,
      locked_by: existing?.locked_by ?? null,
      locked_at: existing?.locked_at ?? null,
      created_at: existing?.created_at ?? new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    };
    this.jobs.set(row.id, row);
    return row;
  }

  async updateIngestJob(id: string, input: {
    stage?: string;
    status?: string;
    error?: string | null;
    lockedBy?: string | null;
    incrementAttempts?: boolean;
  }): Promise<void> {
    const row = this.jobs.get(id);
    if (!row) return;
    if (input.stage !== undefined) row.stage = input.stage;
    if (input.status !== undefined) row.status = input.status;
    if (input.error !== undefined) row.last_error = input.error;
    if (input.incrementAttempts) row.attempts += 1;
    if (input.lockedBy !== undefined) {
      row.locked_by = input.lockedBy;
      row.locked_at = new Date(0).toISOString();
    }
    row.updated_at = new Date(0).toISOString();
  }

  async listIngestJobs(project: string, domain?: string, statuses?: string[], limit = 100): Promise<IngestJobRecord[]> {
    return [...this.jobs.values()]
      .filter((row) =>
        row.project === project
        && (!domain || row.domain === domain)
        && (!statuses || statuses.length === 0 || statuses.includes(row.status)),
      )
      .slice(0, limit);
  }

  async getIngestJob(project: string, id: string): Promise<IngestJobRecord | null> {
    const row = this.jobs.get(id);
    return row?.project === project ? row : null;
  }

  async insertKbChunks(chunks: KbChunkInput[]): Promise<void> {
    for (const chunk of chunks) {
      this.chunks.set(chunk.id, chunk);
    }
  }

  async recordStructuredEntities(input: RecordStructuredEntitiesInput): Promise<RecordStructuredEntitiesResult> {
    const entityTypes = input.schema.spec.entities;
    const primaryType = entityTypes[0];
    if (!primaryType) return { entities: 0, mentions: 0, relationships: 0, provenance_spans: 0, chunks_linked: 0 };
    let count = 0;
    const persisted: Array<{ id: string; record: JsonRecord; type: string; identityField: string }> = [];
    for (const item of input.records) {
      for (const entityType of entityTypes) {
        const identityField = entityType.fields.find((field) => field.identity)?.name
          ?? entityType.fields[0]?.name
          ?? 'id';
        const isPrimary = entityType.name === primaryType.name;
        const rawIdentity = item.record[identityField] ?? (isPrimary ? `${input.fileId}:record:${item.recordIndex}` : null);
        if (rawIdentity === null || rawIdentity === undefined || rawIdentity === '') continue;
        const identity = String(rawIdentity);
        const summaryField = entityType.summary_field ?? identityField;
        const fields = isPrimary
          ? item.record
          : entityType.fields.reduce<JsonRecord>((out, field) => {
              if (Object.prototype.hasOwnProperty.call(item.record, field.name)) out[field.name] = item.record[field.name];
              return out;
            }, {});
        const key = `${input.project}:${input.domain}:${entityType.name}:${identity}`;
        const existing = this.entities.get(key);
        const row = {
          id: existing?.id ?? `entity-${this.entities.size + 1}`,
          project: input.project,
          domain: input.domain,
          type: entityType.name,
          identity_key: identity,
          display_name: String(item.record[summaryField] ?? identity),
          fields: Object.keys(fields).length > 0 ? fields : item.record,
          parent_id: null,
          created_at: existing?.created_at ?? new Date(0).toISOString(),
          updated_at: new Date(0).toISOString(),
        };
        this.entities.set(key, row);
        persisted.push({ id: row.id, record: item.record, type: entityType.name, identityField });
        count += 1;
      }
    }
    const schemaRelationships = input.schema.spec.relationships ?? [];
    const byIdentity = new Map<string, string>();
    const targetTypes = new Set<string>(entityTypes.map((entityType) => entityType.name));
    for (const relationship of schemaRelationships) {
      targetTypes.add(relationship.to_type);
    }
    for (const row of this.entities.values()) {
      if (row.project !== input.project || row.domain !== input.domain || !targetTypes.has(row.type)) continue;
      addTestIdentityAlias(byIdentity, row.type, row.identity_key, row.id, primaryType.name);
      if (row.display_name) addTestIdentityAlias(byIdentity, row.type, row.display_name, row.id, primaryType.name);
    }
    let relationships = 0;
    for (const item of persisted) {
      const relationshipFields = new Map<string, string>();
      const outgoingRelationships = schemaRelationships.filter((relationship) => relationship.from_type === item.type);
      if (schemaRelationships.length > 0 && outgoingRelationships.length === 0) continue;
      for (const relationship of outgoingRelationships) {
        const base = relationship.name.toLowerCase();
        const singular = base === 'parent' ? 'parent_id' : `${base}_id`;
        const plural = `${base}_ids`;
        if (Object.prototype.hasOwnProperty.call(item.record, singular)) relationshipFields.set(singular, relationship.name);
        if (Object.prototype.hasOwnProperty.call(item.record, plural)) relationshipFields.set(plural, relationship.name);
      }
      for (const field of Object.keys(item.record)) {
        const lower = field.toLowerCase();
        const relType = lower === 'parent' || lower === 'parent_id'
          ? 'parent'
          : lower.endsWith('_ids') && lower !== item.identityField.toLowerCase()
            ? lower.slice(0, -4)
            : lower.endsWith('_id') && lower !== item.identityField.toLowerCase()
              ? lower.slice(0, -3)
              : null;
        if (relType && !relationshipFields.has(field)) relationshipFields.set(field, relType);
      }
      for (const [field, relType] of relationshipFields.entries()) {
        const targetTypesForRelationship = outgoingRelationships
          .filter((relationship) => relationship.name.toLowerCase() === relType.toLowerCase())
          .map((relationship) => relationship.to_type);
        const rawValues = Array.isArray(item.record[field]) ? item.record[field] : [item.record[field]];
        const values = rawValues
          .map((value) => value === null || value === undefined || value === '' ? null : String(value))
          .filter((value): value is string => Boolean(value));
        for (const value of values) {
          const targetId = targetTypesForRelationship.length > 0
            ? targetTypesForRelationship
                .flatMap((type) => [`${type}:${value}`, `${type}:${canonicalTestIdentity(value)}`])
                .map((key) => byIdentity.get(key))
                .find(Boolean)
            : null;
          const resolvedTargetId = targetId ?? byIdentity.get(value) ?? byIdentity.get(canonicalTestIdentity(value));
          if (!resolvedTargetId || resolvedTargetId === item.id) continue;
          const id = `relationship-${this.relationships.size + 1}`;
          this.relationships.set(id, {
            id,
            project: input.project,
            domain: input.domain,
            rel_type: relType,
            src_id: item.id,
            dst_id: resolvedTargetId,
            evidence_file: input.fileId,
            evidence_page: 1,
            created_at: new Date(0).toISOString(),
          });
          if (relType === 'parent') {
            const entity = [...this.entities.values()].find((row) => row.id === item.id);
            if (entity) entity.parent_id = resolvedTargetId;
          }
          relationships += 1;
        }
      }
    }
    return {
      entities: count,
      mentions: count,
      relationships,
      provenance_spans: input.records.reduce((sum, item) => sum + Object.keys(item.record).length, 0),
      chunks_linked: input.records.reduce((sum, item) => sum + item.chunks.length, 0),
    };
  }

  async listEntities(project: string, domain?: string, type?: string, limit = 100): Promise<EntityRecord[]> {
    return [...this.entities.values()]
      .filter((row) =>
        row.project === project
        && (!domain || row.domain === domain)
        && (!type || row.type === type),
      )
      .slice(0, limit);
  }

  async getEntity(project: string, id: string): Promise<EntityRecord | null> {
    const row = this.entities.get(id);
    return row?.project === project ? row : null;
  }

  async findEntity(project: string, domain: string, type: string, identityKey: string): Promise<EntityRecord | null> {
    return [...this.entities.values()].find((row) =>
      row.project === project
      && row.domain === domain
      && row.type === type
      && row.identity_key === identityKey,
    ) ?? null;
  }

  async getEntityLineage(project: string, id: string): Promise<EntityLineageRecord> {
    const entity = await this.getEntity(project, id);
    const ancestors: EntityLineageRecord['ancestors'] = [];
    let current = entity;
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      ancestors.unshift({
        id: current.id,
        type: current.type,
        display_name: current.display_name,
        depth: ancestors.length,
      });
      seen.add(current.id);
      current = current.parent_id ? await this.getEntity(project, current.parent_id) : null;
    }
    return {
      ancestors: ancestors.map((item, index) => ({ ...item, depth: index })),
      children: [...this.entities.values()]
        .filter((row) => row.project === project && row.parent_id === id)
        .map((row) => ({ id: row.id, type: row.type, display_name: row.display_name })),
      mentions: [],
    };
  }

  async searchEntities(project: string, domain: string, query: string, limit = 20): Promise<EntityRecord[]> {
    const tokens = query.toLowerCase().match(/[a-z0-9][a-z0-9-]{1,}/g) ?? [];
    return [...this.entities.values()]
      .filter((row) => {
        if (row.project !== project || row.domain !== domain) return false;
        const haystack = `${row.identity_key} ${row.display_name ?? ''} ${JSON.stringify(row.fields)}`.toLowerCase();
        return tokens.some((token) => haystack.includes(token));
      })
      .slice(0, limit);
  }

  async listRelationships(
    project: string,
    domain?: string,
    relType?: string,
    entityId?: string,
    limit = 100,
  ): Promise<EntityRelationshipRecord[]> {
    return [...this.relationships.values()]
      .filter((row) =>
        row.project === project
        && (!domain || row.domain === domain)
        && (!relType || row.rel_type === relType)
        && (!entityId || row.src_id === entityId || row.dst_id === entityId),
      )
      .slice(0, limit);
  }

  async backfillEntityRelationships(project: string, schema: SchemaRecord) {
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
    const scoped = [...this.entities.values()].filter((row) => row.project === project && row.domain === schema.domain);
    const byIdentity = new Map<string, string>();
    for (const row of scoped) {
      addTestIdentityAlias(byIdentity, row.type, row.identity_key, row.id, primaryType.name);
      if (row.display_name) addTestIdentityAlias(byIdentity, row.type, row.display_name, row.id, primaryType.name);
    }
    let candidateRelationships = 0;
    let relationshipsInserted = 0;
    let parentLinksUpdated = 0;
    for (const entity of scoped) {
      const entityType = schema.spec.entities.find((item) => item.name === entity.type);
      if (!entityType) continue;
      const identityField = entityType.fields.find((field) => field.identity)?.name
        ?? entityType.fields[0]?.name
        ?? 'id';
      const outgoingRelationships = schema.spec.relationships.filter((relationship) => relationship.from_type === entity.type);
      if (schema.spec.relationships.length > 0 && outgoingRelationships.length === 0) continue;
      const relationshipFields = new Map<string, string>();
      for (const relationship of outgoingRelationships) {
        const base = relationship.name.toLowerCase();
        const singular = base === 'parent' ? 'parent_id' : `${base}_id`;
        const plural = `${base}_ids`;
        if (Object.prototype.hasOwnProperty.call(entity.fields, singular)) relationshipFields.set(singular, relationship.name);
        if (Object.prototype.hasOwnProperty.call(entity.fields, plural)) relationshipFields.set(plural, relationship.name);
      }
      for (const field of Object.keys(entity.fields)) {
        const lower = field.toLowerCase();
        const relType = lower === 'parent' || lower === 'parent_id'
          ? 'parent'
          : lower.endsWith('_ids') && lower !== identityField.toLowerCase()
            ? lower.slice(0, -4)
            : lower.endsWith('_id') && lower !== identityField.toLowerCase()
              ? lower.slice(0, -3)
              : null;
        if (relType && !relationshipFields.has(field)) relationshipFields.set(field, relType);
      }
      for (const [field, relType] of relationshipFields.entries()) {
        const targetTypesForRelationship = outgoingRelationships
          .filter((relationship) => relationship.name.toLowerCase() === relType.toLowerCase())
          .map((relationship) => relationship.to_type);
        const rawValues = Array.isArray(entity.fields[field]) ? entity.fields[field] : [entity.fields[field]];
        const values = rawValues
          .map((value) => value === null || value === undefined || value === '' ? null : String(value))
          .filter((value): value is string => Boolean(value));
        for (const value of values) {
          const targetId = targetTypesForRelationship.length > 0
            ? targetTypesForRelationship
                .flatMap((type) => [`${type}:${value}`, `${type}:${canonicalTestIdentity(value)}`])
                .map((key) => byIdentity.get(key))
                .find(Boolean)
            : null;
          const resolvedTargetId = targetId ?? byIdentity.get(value) ?? byIdentity.get(canonicalTestIdentity(value));
          if (!resolvedTargetId || resolvedTargetId === entity.id) continue;
          candidateRelationships += 1;
          const exists = [...this.relationships.values()].some((row) =>
            row.project === project
            && row.domain === schema.domain
            && row.rel_type === relType
            && row.src_id === entity.id
            && row.dst_id === resolvedTargetId,
          );
          if (!exists) {
            const id = `relationship-${this.relationships.size + 1}`;
            this.relationships.set(id, {
              id,
              project,
              domain: schema.domain,
              rel_type: relType,
              src_id: entity.id,
              dst_id: resolvedTargetId,
              evidence_file: null,
              evidence_page: null,
              created_at: new Date(0).toISOString(),
            });
            relationshipsInserted += 1;
          }
          if (relType === 'parent' && entity.parent_id !== resolvedTargetId) {
            entity.parent_id = resolvedTargetId;
            parentLinksUpdated += 1;
          }
        }
      }
    }
    return {
      project,
      domain: schema.domain,
      scanned_entities: scoped.length,
      candidate_relationships: candidateRelationships,
      relationships_inserted: relationshipsInserted,
      parent_links_updated: parentLinksUpdated,
    };
  }

  async createSession(project: string, domain: string, id = `session-${this.sessions.size + 1}`): Promise<SessionRecord> {
    await this.upsertDomain(project, domain);
    const existing = this.sessions.get(id);
    const row: SessionRecord = existing ?? {
      id,
      project,
      domain,
      history: [],
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    };
    this.sessions.set(id, row);
    return row;
  }

  async listSessions(project: string, domain?: string, limit = 50): Promise<SessionRecord[]> {
    return [...this.sessions.values()]
      .filter((row) => row.project === project && (!domain || row.domain === domain))
      .slice(0, limit);
  }

  async getSession(project: string, id: string): Promise<SessionRecord | null> {
    const row = this.sessions.get(id);
    return row?.project === project ? row : null;
  }

  async appendSessionHistory(project: string, id: string, entries: JsonRecord[]): Promise<SessionRecord> {
    const session = await this.getSession(project, id);
    if (!session) throw new Error('session not found');
    session.history = [...session.history, ...entries].slice(-200);
    session.updated_at = new Date(0).toISOString();
    return session;
  }

  async corpusStatus(project: string): Promise<CorpusStatusRecord[]> {
    const domains = new Set<string>();
    for (const domain of this.domains.values()) {
      if (domain.project === project) domains.add(domain.name);
    }
    for (const file of this.files.values()) {
      if (file.project === project) domains.add(file.domain);
    }
    for (const schema of this.schemas.values()) {
      if (schema.project === project) domains.add(schema.domain);
    }
    return [...domains].sort().map((domain) => {
      const files = [...this.files.values()].filter(
        (file) => file.project === project && file.domain === domain,
      );
      const hasSchema = [...this.schemas.values()].some(
        (schema) => schema.project === project && schema.domain === domain && schema.is_active === 1,
      );
      const readyFiles = files.filter((file) => file.status === 'ready').length;
      const failedFiles = files.filter((file) => file.status === 'failed').length;
      const stagedFiles = files.filter((file) => file.status === 'pending').length;
      return {
        domain,
        has_schema: hasSchema ? 1 : 0,
        draft_count: 0,
        file_count: files.length,
        ready_files: readyFiles,
        failed_files: failedFiles,
        staged_files: stagedFiles,
        active_files: 0,
        active_jobs: 0,
        failed_jobs: 0,
        state: failedFiles > 0 ? 'failed' : stagedFiles > 0 && hasSchema ? 'files_staged' : hasSchema ? 'schema_ready' : 'no_schema',
      };
    });
  }

  async insertQueryTrace(input: InsertQueryTraceInput): Promise<QueryTraceRecord> {
    await this.upsertDomain(input.project, input.domain);
    const row: QueryTraceRecord = {
      id: `trace-${this.traces.size + 1}`,
      project: input.project,
      domain: input.domain,
      question: input.question,
      scope: input.scope ?? null,
      filters: input.filters ?? null,
      retrieved: input.retrieved,
      answer: input.answer ?? null,
      citations: input.citations ?? [],
      confidence: input.confidence ?? null,
      latency_ms: input.latencyMs ?? null,
      created_at: new Date(0).toISOString(),
    };
    this.traces.set(row.id, row);
    return row;
  }

  async listQueryTraces(project: string, domain?: string, limit = 50): Promise<QueryTraceRecord[]> {
    return [...this.traces.values()]
      .filter((row) => row.project === project && (!domain || row.domain === domain))
      .slice(0, limit);
  }

  async getQueryTrace(project: string, id: string): Promise<QueryTraceRecord | null> {
    const row = this.traces.get(id);
    return row?.project === project ? row : null;
  }

  async insertEvalReport(input: InsertEvalReportInput): Promise<EvalReportRecord> {
    const row: EvalReportRecord = {
      id: `eval-${this.evalReports.size + 1}`,
      project: input.project,
      domain: input.domain ?? null,
      index_id: input.indexId ?? null,
      kind: input.kind,
      summary: input.summary,
      rows: input.rows,
      created_at: new Date(0).toISOString(),
    };
    this.evalReports.set(row.id, row);
    return row;
  }

  async listEvalReports(project: string, kind?: string, domain?: string, limit = 50): Promise<EvalReportRecord[]> {
    return [...this.evalReports.values()]
      .filter((row) =>
        row.project === project
        && (!kind || row.kind === kind)
        && (!domain || row.domain === domain),
      )
      .slice(0, limit);
  }

  async getEvalReport(project: string, id: string): Promise<EvalReportRecord | null> {
    const row = this.evalReports.get(id);
    return row?.project === project ? row : null;
  }
}

class FakeVectorize implements VectorizeBinding {
  vectors = new Map<string, VectorizeVector>();
  deleted: string[] = [];
  queries: Array<{ vector: number[]; filter?: JsonRecord; namespace?: string; returnMetadata?: unknown }> = [];

  async upsert(vectors: VectorizeVector[]): Promise<void> {
    for (const vector of vectors) this.vectors.set(vector.id, vector);
  }

  async query(
    vector: number[],
    options: { topK: number; filter?: JsonRecord; namespace?: string; returnMetadata?: unknown },
  ): Promise<{ matches: { id: string; score: number; metadata?: JsonRecord }[] }> {
    this.queries.push({
      vector,
      ...(options.filter ? { filter: options.filter } : {}),
      ...(options.namespace ? { namespace: options.namespace } : {}),
      ...(options.returnMetadata !== undefined ? { returnMetadata: options.returnMetadata } : {}),
    });
    const entries = [...this.vectors.values()].filter((candidate) => {
      if (options.namespace && candidate.namespace !== options.namespace) return false;
      return Object.entries(options.filter ?? {}).every(([key, value]) => {
        return candidate.metadata[key] === value;
      });
    });
    const matches = entries
      .map((candidate) => ({
        id: candidate.id,
        score: candidate.values.reduce((sum, value, i) => sum + value * (vector[i] ?? 0), 0),
        metadata: candidate.metadata,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, options.topK);
    return { matches };
  }

  async deleteByIds(ids: string[]): Promise<void> {
    this.deleted.push(...ids);
    for (const id of ids) this.vectors.delete(id);
  }
}

function canonicalTestIdentity(value: string): string {
  return value.trim().toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '');
}

function addTestIdentityAlias(map: Map<string, string>, type: string, value: string, id: string, defaultType: string): void {
  const values = [value, canonicalTestIdentity(value)].filter(Boolean);
  for (const item of values) {
    map.set(`${type}:${item}`, id);
    if (type === defaultType) map.set(item, id);
  }
}

class FakeQueryCacheD1 {
  rows = new Map<string, { tenant: string; indexId: string; payload: string; expiresAt: number }>();
  selectPayloadCalls = 0;
  insertCalls = 0;
  deleteCalls = 0;

  prepare(sql: string) {
    return {
      bind: (...args: unknown[]) => ({
        first: async () => {
          if (sql.includes('SELECT payload') && sql.includes('query_cache')) {
            this.selectPayloadCalls += 1;
            const [cacheKey, tenant, indexId, now] = args as [string, string, string, number];
            const row = this.rows.get(cacheKey);
            if (!row || row.tenant !== tenant || row.indexId !== indexId || row.expiresAt <= now) return null;
            return { payload: row.payload };
          }
          return { ok: 1 };
        },
        run: async () => {
          if (sql.includes('INSERT OR REPLACE INTO query_cache')) {
            this.insertCalls += 1;
            const [cacheKey, tenant, indexId, payload, expiresAt] = args as [string, string, string, string, number];
            this.rows.set(cacheKey, { tenant, indexId, payload, expiresAt });
          }
          if (sql.includes('DELETE FROM query_cache')) {
            this.deleteCalls += 1;
            const [tenant, indexId] = args as [string, string];
            for (const [key, row] of this.rows.entries()) {
              if (row.tenant === tenant && row.indexId === indexId) this.rows.delete(key);
            }
          }
          return { success: true };
        },
      }),
      first: async () => ({ ok: 1 }),
    };
  }
}

const TEST_BASE_VECTOR_DIMENSIONS = 768;

function vectorFor(text: string): number[] {
  const vector = vectorOf(TEST_BASE_VECTOR_DIMENSIONS);
  vector[0] = text.length;
  vector[1] = text.includes('alpha') ? 1 : 0;
  vector[2] = text.includes('beta') ? 1 : 0;
  return vector;
}

function vectorOf(length: number, seed = 1): number[] {
  return Array.from({ length }, (_, i) => (i === 0 ? seed : 0));
}

class FakeQueue implements Queue<KbIngestQueueMessage> {
  sent: KbIngestQueueMessage[] = [];

  async metrics(): Promise<QueueMetrics> {
    return { backlogCount: this.sent.length, backlogBytes: 0 };
  }

  async send(message: KbIngestQueueMessage): Promise<QueueSendResponse> {
    this.sent.push(message);
    return { metadata: { metrics: { backlogCount: this.sent.length, backlogBytes: 0 } } };
  }

  async sendBatch(messages: Iterable<MessageSendRequest<KbIngestQueueMessage>>): Promise<QueueSendBatchResponse> {
    for (const message of messages) this.sent.push(message.body);
    return { metadata: { metrics: { backlogCount: this.sent.length, backlogBytes: 0 } } };
  }
}

class FakeWorkflow {
  created: Array<WorkflowInstanceCreateOptions<KbIngestQueueMessage>> = [];
  statuses = new Map<string, InstanceStatus['status']>();

  async create(options: WorkflowInstanceCreateOptions<KbIngestQueueMessage> = {}): Promise<WorkflowInstance> {
    this.created.push(options);
    const id = options.id ?? `workflow-${this.created.length}`;
    this.statuses.set(id, 'running');
    return this.instance(id);
  }

  async createBatch(options: WorkflowInstanceCreateOptions<KbIngestQueueMessage>[]): Promise<WorkflowInstance[]> {
    return Promise.all(options.map((option) => this.create(option)));
  }

  async get(id: string): Promise<WorkflowInstance> {
    if (!this.statuses.has(id)) this.statuses.set(id, 'unknown');
    return this.instance(id);
  }

  private instance(id: string): WorkflowInstance {
    return {
      id,
      pause: async () => { this.statuses.set(id, 'paused'); },
      resume: async () => { this.statuses.set(id, 'running'); },
      terminate: async () => { this.statuses.set(id, 'terminated'); },
      restart: async () => { this.statuses.set(id, 'running'); },
      status: async () => ({ status: this.statuses.get(id) ?? 'unknown' }),
      sendEvent: async () => undefined,
    } as WorkflowInstance;
  }
}

class FakeAnalyticsDataset implements AnalyticsEngineDataset {
  points: AnalyticsEngineDataPoint[] = [];

  writeDataPoint(event?: AnalyticsEngineDataPoint): void {
    if (event) this.points.push(event);
  }
}

function makeEnv(vectorize: FakeVectorize, db: D1Database = {
  prepare: () => ({ first: async () => ({ ok: 1 }) }),
} as unknown as D1Database, vectorizeSmall?: FakeVectorize, rawDocs?: R2Bucket, ingestQueue?: Queue<KbIngestQueueMessage>, ingestWorkflow?: Workflow<KbIngestQueueMessage>, analytics?: AnalyticsEngineDataset): Env {
  return {
    RAG_SERVICE_KEYS: JSON.stringify({ 'key-a': 'tenant-a', 'key-b': 'tenant-b' }),
    EMBEDDING_MODEL: '@cf/baai/bge-base-en-v1.5',
    EMBEDDING_MODEL_SMALL: '@cf/baai/bge-small-en-v1.5',
    VECTORIZE: vectorize,
    ...(vectorizeSmall ? { VECTORIZE_SMALL: vectorizeSmall } : {}),
    AI: {
      run: async (model: string, input: { text?: string[]; messages?: Array<{ role: string; content: string }>; contexts?: Array<{ text?: string }> }) => {
        if (Array.isArray(input.text)) {
          return {
            data: input.text.map((text) => model.includes('small') ? vectorFor(`${text} small`) : vectorFor(text)),
          };
        }
        if (Array.isArray(input.contexts)) {
          return {
            response: input.contexts.map((context, i) => ({
              id: i,
              score: context.text?.includes('conceptual answer') ? 0.96 : 0.42,
            })),
          };
        }
        if (Array.isArray(input.messages) && input.messages.some((message) => message.content.includes('using only the cited evidence'))) {
          return {
            response: 'Workers AI synthesized alpha exact wording with citations [1].',
          };
        }
        return {
          response: JSON.stringify({
            status: 'supported',
            score: 0.92,
            rationale: 'The answer is supported by the provided evidence.',
          }),
        };
      },
    } as unknown as Ai,
    DB: db,
    ...(rawDocs ? { RAW_DOCS: rawDocs } : {}),
    ...(ingestQueue ? { INGEST_QUEUE: ingestQueue } : {}),
    ...(ingestWorkflow ? { KB_INGEST_WORKFLOW: ingestWorkflow } : {}),
    ...(analytics ? { RAG_ANALYTICS: analytics } : {}),
  };
}

function configureStaleFreeAiDefault(env: Env): void {
  env.RAG_EMBED_PROVIDER = 'free_ai';
  env.FREE_AI_EMBED_MODEL = 'gemini-embedding-001';
  env.FREE_AI_EMBED_PROVIDER = 'gemini';
  env.FREE_AI_EMBED_DIMENSIONS = '1536';
  env.FREE_AI_API_KEY = 'test-free-ai-key';
  env.FREE_AI = {
    fetch: async (url: string | Request) => {
      const href = typeof url === 'string' ? url : url.url;
      if (href.endsWith('/v1/models')) {
        return Response.json({
          data: [{
            id: 'voyage-3.5-lite',
            type: 'embedding',
            provider: 'voyage_ai',
            dimensions: 1024,
            enabled: true,
          }],
        });
      }
      return new Response('not found', { status: 404 });
    },
  } as unknown as Fetcher;
}

class FakeR2Bucket {
  objects = new Map<string, ArrayBuffer | string | ReadableStream>();
  puts: Array<{
    key: string;
    value: ArrayBuffer | string | ReadableStream;
    options?: R2PutOptions;
  }> = [];
  deletes: string[] = [];

  async put(
    key: string,
    value: ArrayBuffer | string | ReadableStream,
    options?: R2PutOptions,
  ): Promise<R2Object> {
    this.puts.push(options === undefined ? { key, value } : { key, value, options });
    this.objects.set(key, value);
    return { key } as R2Object;
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const value = this.objects.get(key);
    if (value === undefined) return null;
    return {
      key,
      async arrayBuffer() {
        if (typeof value === 'string') return new TextEncoder().encode(value).buffer;
        if (value instanceof ArrayBuffer) return value;
        return await new Response(value).arrayBuffer();
      },
    } as R2ObjectBody;
  }

  async delete(key: string): Promise<void> {
    this.deletes.push(key);
    this.objects.delete(key);
  }
}

describe('knowledgebase RAG Worker app', () => {
  it('rejects requests without a service key', async () => {
    const repo = new MemoryRepository();
    const app = createApp({ makeRepository: () => repo });
    const res = await app.request('/v1/indexes', {}, makeEnv(new FakeVectorize()));

    expect(res.status).toBe(401);
  });

  it('accepts non-disruptive appended service keys', async () => {
    const repo = new MemoryRepository();
    const app = createApp({ makeRepository: () => repo });
    const env = makeEnv(new FakeVectorize());
    env.RAG_SERVICE_KEYS_APPEND = JSON.stringify({ 'key-c': 'tenant-c' });

    const res = await app.request('/v1/indexes', { headers: { Authorization: 'Bearer key-c' } }, env);

    expect(res.status).toBe(200);
    expect((await res.json()) as { data: IndexRecord[] }).toEqual({ data: [] });
  });

  it('accepts isolated proof service keys without replacing consumer keys', async () => {
    const repo = new MemoryRepository();
    const app = createApp({ makeRepository: () => repo });
    const env = makeEnv(new FakeVectorize());
    env.RAG_SERVICE_PROOF_KEYS = JSON.stringify({ 'proof-key': 'starboard' });

    const res = await app.request('/v1/indexes', { headers: { Authorization: 'Bearer proof-key' } }, env);

    expect(res.status).toBe(200);
    expect((await res.json()) as { data: IndexRecord[] }).toEqual({ data: [] });
  });

  it('lists embedding profiles and creates indexes with configured free-ai dimensions', async () => {
    const repo = new MemoryRepository();
    const app = createApp({ makeRepository: () => repo });
    const env = makeEnv(new FakeVectorize());
    env.RAG_EMBED_PROVIDER = 'free_ai';
    env.FREE_AI_EMBED_MODEL = 'gemini-embedding-001';
    env.FREE_AI_EMBED_PROVIDER = 'gemini';
    env.FREE_AI_EMBED_DIMENSIONS = '1536';
    env.FREE_AI_API_KEY = 'test-free-ai-key';
    env.FREE_AI = {
      fetch: async (url: string | Request) => {
        const href = typeof url === 'string' ? url : url.url;
        if (href.endsWith('/v1/models')) {
          return Response.json({
            data: [
              {
                id: 'gemini-embedding-001',
                type: 'embedding',
                provider: 'gemini',
                dimensions: 1536,
                enabled: true,
              },
            ],
          });
        }
        return new Response('not found', { status: 404 });
      },
    } as unknown as Fetcher;

    const models = await app.request('/v1/embedding-models', { headers: { Authorization: 'Bearer key-a' } }, env);
    const created = await app.request('/v1/indexes', {
      method: 'POST',
      headers: { Authorization: 'Bearer key-a' },
      body: JSON.stringify({ name: 'Gemini Index' }),
    }, env);

    expect(models.status).toBe(200);
    expect(await models.json()).toMatchObject({
      provider: 'free_ai',
      catalog_source: 'free_ai',
      profiles: {
        base: {
          model: 'gemini-embedding-001',
          dimensions: 1536,
          vectorize_binding: 'VECTORIZE',
        },
      },
      free_ai_models: expect.arrayContaining([
        expect.objectContaining({
          id: 'gemini-embedding-001',
          provider: 'gemini',
          dimensions: 1536,
          selectable: true,
        }),
      ]),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      name: 'Gemini Index',
      dimensions: 1536,
      embedding_model: 'gemini-embedding-001',
      embedding_provider: 'gemini',
    });
  });

  it('rejects default free-ai index creation when the configured model is not live in free-ai', async () => {
    const repo = new MemoryRepository();
    const app = createApp({ makeRepository: () => repo });
    const env = makeEnv(new FakeVectorize());
    env.RAG_EMBED_PROVIDER = 'free_ai';
    env.FREE_AI_EMBED_MODEL = 'gemini-embedding-001';
    env.FREE_AI_EMBED_PROVIDER = 'gemini';
    env.FREE_AI_EMBED_DIMENSIONS = '1536';
    env.FREE_AI_API_KEY = 'test-free-ai-key';
    env.FREE_AI = {
      fetch: async (url: string | Request) => {
        const href = typeof url === 'string' ? url : url.url;
        if (href.endsWith('/v1/models')) {
          return Response.json({
            data: [
              {
                id: 'voyage-3.5-lite',
                type: 'embedding',
                provider: 'voyage_ai',
                dimensions: 1024,
                enabled: true,
              },
            ],
          });
        }
        return new Response('not found', { status: 404 });
      },
    } as unknown as Fetcher;

    const created = await app.request('/v1/indexes', {
      method: 'POST',
      headers: { Authorization: 'Bearer key-a' },
      body: JSON.stringify({ name: 'Unavailable Default Model' }),
    }, env);

    expect(created.status).toBe(400);
    expect(await created.json()).toMatchObject({
      error: 'configured base embedding model is not available in free-ai: gemini-embedding-001',
    });
  });

  it('auto-creates knowledgebase domain indexes with live free-ai model/provider metadata', async () => {
    const metadata = new MemoryMetadataRepository();
    const ragRepo = new MemoryRepository();
    const rawDocs = new FakeR2Bucket();
    const vectorize = new FakeVectorize();
    const embeddingCalls: Array<{ headers: Record<string, string>; body: { model?: string; dimensions?: number; input?: string[] } }> = [];
    const app = createApp({
      makeRepository: () => ragRepo,
      makeMetadataRepository: () => metadata,
    });
    const env = makeEnv(
      vectorize,
      undefined as unknown as D1Database,
      undefined,
      rawDocs as unknown as R2Bucket,
    );
    env.RAG_EMBED_PROVIDER = 'free_ai';
    env.FREE_AI_EMBED_MODEL = 'gemini-embedding-001';
    env.FREE_AI_EMBED_PROVIDER = 'gemini';
    env.FREE_AI_EMBED_DIMENSIONS = '1536';
    env.FREE_AI_API_KEY = 'test-free-ai-key';
    env.FREE_AI = {
      fetch: async (url: string | Request, init?: RequestInit) => {
        const href = typeof url === 'string' ? url : url.url;
        if (href.endsWith('/v1/models')) {
          return Response.json({
            data: [{
              id: 'gemini-embedding-001',
              type: 'embedding',
              provider: 'gemini',
              dimensions: 1536,
              enabled: true,
            }],
          });
        }
        if (href.endsWith('/v1/embeddings')) {
          const headers = Object.fromEntries(new Headers(init?.headers).entries());
          const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string; dimensions?: number; input?: string[] };
          embeddingCalls.push({ headers, body });
          return Response.json({
            data: (body.input ?? []).map((_, i) => ({ index: i, embedding: vectorOf(1536, i + 1) })),
          });
        }
        return new Response('not found', { status: 404 });
      },
    } as unknown as Fetcher;

    const ingested = await app.request('/v1/kb/ingest/text', {
      method: 'POST',
      headers: { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        domain: 'freeai-notes',
        title: 'free-ai-note',
        text: 'Knowledgebase domain auto-indexing should pin free-ai metadata.',
      }),
    }, env);

    const index = [...ragRepo.indexes.values()].find((row) => row.external_id === 'kb:freeai-notes');
    expect(ingested.status).toBe(201);
    expect(index).toMatchObject({
      dimensions: 1536,
      embedding_model: 'gemini-embedding-001',
      embedding_provider: 'gemini',
    });
    expect(embeddingCalls[0]).toMatchObject({
      headers: {
        'x-gateway-force-model': 'gemini-embedding-001',
        'x-gateway-force-provider': 'gemini',
      },
      body: {
        model: 'gemini-embedding-001',
        dimensions: 1536,
      },
    });
    expect(vectorize.vectors.size).toBeGreaterThan(0);
  });

  it('persists selected free-ai embedding models on knowledgebase domains before custom input ingestion', async () => {
    const metadata = new MemoryMetadataRepository();
    const ragRepo = new MemoryRepository();
    const rawDocs = new FakeR2Bucket();
    const vectorize = new FakeVectorize();
    const embeddingCalls: Array<{ headers: Record<string, string>; body: { model?: string; dimensions?: number; input?: string[] } }> = [];
    const app = createApp({
      makeRepository: () => ragRepo,
      makeMetadataRepository: () => metadata,
    });
    const env = makeEnv(
      vectorize,
      undefined as unknown as D1Database,
      undefined,
      rawDocs as unknown as R2Bucket,
    );
    env.RAG_EMBED_PROVIDER = 'free_ai';
    env.FREE_AI_EMBED_MODEL = 'gemini-embedding-001';
    env.FREE_AI_EMBED_PROVIDER = 'gemini';
    env.FREE_AI_EMBED_DIMENSIONS = '1536';
    env.FREE_AI_API_KEY = 'test-free-ai-key';
    env.FREE_AI = {
      fetch: async (url: string | Request, init?: RequestInit) => {
        const href = typeof url === 'string' ? url : url.url;
        if (href.endsWith('/v1/models')) {
          return Response.json({
            data: [
              {
                id: 'gemini-embedding-001',
                type: 'embedding',
                provider: 'gemini',
                dimensions: 1536,
                enabled: true,
                aliases: ['text-embedding-3-small'],
              },
              {
                id: 'other-gemini-embedding',
                type: 'embedding',
                provider: 'gemini',
                dimensions: 1536,
                enabled: true,
              },
            ],
          });
        }
        if (href.endsWith('/v1/embeddings')) {
          const headers = Object.fromEntries(new Headers(init?.headers).entries());
          const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string; dimensions?: number; input?: string[] };
          embeddingCalls.push({ headers, body });
          return Response.json({
            data: (body.input ?? []).map((_, i) => ({ index: i, embedding: vectorOf(1536, i + 1) })),
          });
        }
        return new Response('not found', { status: 404 });
      },
    } as unknown as Fetcher;

    const savedDomain = await app.request('/v1/kb/domains', {
      method: 'POST',
      headers: { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'selected-domain',
        description: 'custom input with selected embeddings',
        embedding_model: 'text-embedding-3-small',
      }),
    }, env);
    const ingested = await app.request('/v1/kb/ingest/text', {
      method: 'POST',
      headers: { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        domain: 'selected-domain',
        title: 'selected note',
        text: 'Custom input should inherit the domain embedding model.',
      }),
    }, env);

    const domain = await savedDomain.json() as DomainRecord;
    const index = [...ragRepo.indexes.values()].find((row) => row.external_id === 'kb:selected-domain');
    expect(savedDomain.status).toBe(201);
    expect(domain).toMatchObject({
      name: 'selected-domain',
      embedding_model: 'gemini-embedding-001',
      embedding_provider: 'gemini',
    });
    expect(ingested.status).toBe(201);
    expect(index).toMatchObject({
      dimensions: 1536,
      embedding_model: 'gemini-embedding-001',
      embedding_provider: 'gemini',
    });
    expect(embeddingCalls[0]).toMatchObject({
      headers: {
        'x-gateway-force-model': 'gemini-embedding-001',
        'x-gateway-force-provider': 'gemini',
      },
      body: {
        model: 'gemini-embedding-001',
        dimensions: 1536,
      },
    });
  });

  it('persists a same-request selected free-ai model before direct text ingestion', async () => {
    const metadata = new MemoryMetadataRepository();
    const ragRepo = new MemoryRepository();
    const rawDocs = new FakeR2Bucket();
    const vectorize = new FakeVectorize();
    const app = createApp({
      makeRepository: () => ragRepo,
      makeMetadataRepository: () => metadata,
    });
    const env = makeEnv(
      vectorize,
      undefined as unknown as D1Database,
      undefined,
      rawDocs as unknown as R2Bucket,
    );
    env.RAG_EMBED_PROVIDER = 'free_ai';
    env.FREE_AI_EMBED_MODEL = 'gemini-embedding-001';
    env.FREE_AI_EMBED_PROVIDER = 'gemini';
    env.FREE_AI_EMBED_DIMENSIONS = '1536';
    env.FREE_AI_API_KEY = 'test-free-ai-key';
    env.FREE_AI = {
      fetch: async (url: string | Request, init?: RequestInit) => {
        const href = typeof url === 'string' ? url : url.url;
        if (href.endsWith('/v1/models')) {
          return Response.json({
            data: [{
              id: 'gemini-embedding-001',
              type: 'embedding',
              provider: 'gemini',
              dimensions: 1536,
              enabled: true,
              aliases: ['text-embedding-3-small'],
            }, {
              id: 'other-gemini-embedding',
              type: 'embedding',
              provider: 'gemini',
              dimensions: 1536,
              enabled: true,
            }],
          });
        }
        if (href.endsWith('/v1/embeddings')) {
          const body = JSON.parse(String(init?.body ?? '{}')) as { input?: string[] };
          return Response.json({
            data: (body.input ?? []).map((_, i) => ({ index: i, embedding: vectorOf(1536, i + 1) })),
          });
        }
        return new Response('not found', { status: 404 });
      },
    } as unknown as Fetcher;

    const ingested = await app.request('/v1/kb/ingest/text', {
      method: 'POST',
      headers: { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        domain: 'one-shot-selected-domain',
        title: 'selected note',
        text: 'Custom input should be able to choose embeddings in one request.',
        embedding_model: 'text-embedding-3-small',
      }),
    }, env);
    const switched = await app.request('/v1/kb/ingest/text', {
      method: 'POST',
      headers: { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        domain: 'one-shot-selected-domain',
        title: 'switch note',
        text: 'This should not silently switch the existing domain index.',
        embedding_model: 'other-gemini-embedding',
      }),
    }, env);

    const index = [...ragRepo.indexes.values()].find((row) => row.external_id === 'kb:one-shot-selected-domain');
    const domain = (await metadata.listDomains('tenant-a')).find((row) => row.name === 'one-shot-selected-domain');
    expect(ingested.status).toBe(201);
    expect(domain).toMatchObject({
      embedding_model: 'gemini-embedding-001',
      embedding_provider: 'gemini',
    });
    expect(index).toMatchObject({
      embedding_model: 'gemini-embedding-001',
      embedding_provider: 'gemini',
      dimensions: 1536,
    });
    expect(switched.status).toBe(400);
    expect(await switched.json()).toMatchObject({
      error: 'domain index already uses embedding model gemini-embedding-001; delete and recreate the domain index before selecting other-gemini-embedding',
    });
  });

  it('rejects inline knowledgebase ingestion when the configured free-ai default model is not live', async () => {
    const metadata = new MemoryMetadataRepository();
    const ragRepo = new MemoryRepository();
    const rawDocs = new FakeR2Bucket();
    const vectorize = new FakeVectorize();
    const app = createApp({
      makeRepository: () => ragRepo,
      makeMetadataRepository: () => metadata,
    });
    const env = makeEnv(
      vectorize,
      undefined as unknown as D1Database,
      undefined,
      rawDocs as unknown as R2Bucket,
    );
    env.RAG_EMBED_PROVIDER = 'free_ai';
    env.FREE_AI_EMBED_MODEL = 'gemini-embedding-001';
    env.FREE_AI_EMBED_PROVIDER = 'gemini';
    env.FREE_AI_EMBED_DIMENSIONS = '1536';
    env.FREE_AI_API_KEY = 'test-free-ai-key';
    env.FREE_AI = {
      fetch: async (url: string | Request) => {
        const href = typeof url === 'string' ? url : url.url;
        if (href.endsWith('/v1/models')) {
          return Response.json({
            data: [{
              id: 'voyage-3.5-lite',
              type: 'embedding',
              provider: 'voyage_ai',
              dimensions: 1024,
              enabled: true,
            }],
          });
        }
        return new Response('not found', { status: 404 });
      },
    } as unknown as Fetcher;

    const ingested = await app.request('/v1/kb/ingest/text', {
      method: 'POST',
      headers: { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        domain: 'stale-freeai',
        title: 'stale-free-ai',
        text: 'This should not create an index against a stale free-ai catalog.',
      }),
    }, env);

    expect(ingested.status).toBe(400);
    expect(await ingested.json()).toMatchObject({
      error: 'configured base embedding model is not available in free-ai: gemini-embedding-001',
    });
    expect(ragRepo.indexes.size).toBe(0);
    expect(vectorize.vectors.size).toBe(0);
  });

  it('rejects explicit embedding model selection when free-ai is not the embedding provider', async () => {
    const repo = new MemoryRepository();
    const app = createApp({ makeRepository: () => repo });
    const env = makeEnv(new FakeVectorize());
    env.RAG_EMBED_PROVIDER = 'workers_ai';

    const created = await app.request('/v1/indexes', {
      method: 'POST',
      headers: { Authorization: 'Bearer key-a' },
      body: JSON.stringify({ name: 'Ignored Model Index', embedding_model: 'gemini-embedding-001' }),
    }, env);

    expect(created.status).toBe(400);
    expect(await created.json()).toMatchObject({
      error: 'embedding_model selection requires RAG_EMBED_PROVIDER=free_ai',
    });
  });

  it('creates indexes with a selected available free-ai embedding alias and pins canonical ingest calls', async () => {
    const repo = new MemoryRepository();
    const app = createApp({ makeRepository: () => repo });
    const env = makeEnv(new FakeVectorize());
    const embeddingCalls: Array<{ headers: Record<string, string>; body: { model?: string; dimensions?: number; input?: string[] } }> = [];
    env.RAG_EMBED_PROVIDER = 'free_ai';
    env.FREE_AI_EMBED_MODEL = 'gemini-embedding-001';
    env.FREE_AI_EMBED_PROVIDER = 'gemini';
    env.FREE_AI_EMBED_DIMENSIONS = '1536';
    env.FREE_AI_API_KEY = 'test-free-ai-key';
    env.FREE_AI = {
      fetch: async (url: string | Request, init?: RequestInit) => {
        const href = typeof url === 'string' ? url : url.url;
        if (href.endsWith('/v1/models')) {
          return Response.json({
            data: [
              {
                id: 'gemini-embedding-001',
                type: 'embedding',
                provider: 'gemini',
                dimensions: 1536,
                enabled: true,
                supports_dimensions: true,
                aliases: ['text-embedding-3-small'],
              },
            ],
          });
        }
        if (href.endsWith('/v1/embeddings')) {
          const headers = Object.fromEntries(new Headers(init?.headers).entries());
          const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string; dimensions?: number; input?: string[] };
          embeddingCalls.push({ headers, body });
          return Response.json({
            data: (body.input ?? []).map((_, i) => ({ index: i, embedding: vectorOf(1536, i + 1) })),
          });
        }
        return new Response('not found', { status: 404 });
      },
    } as unknown as Fetcher;

    const models = await app.request('/v1/embedding-models', { headers: { Authorization: 'Bearer key-a' } }, env);
    const created = await app.request('/v1/indexes', {
      method: 'POST',
      headers: { Authorization: 'Bearer key-a' },
      body: JSON.stringify({ name: 'Selected Model Index', embedding_model: 'text-embedding-3-small' }),
    }, env);
    const index = await created.json() as IndexRecord;
    const ingested = await app.request(`/v1/indexes/${index.id}/ingest`, {
      method: 'POST',
      headers: { Authorization: 'Bearer key-a' },
      body: JSON.stringify({ documents: [{ content: 'alpha selected embedding content' }] }),
    }, env);

    expect(models.status).toBe(200);
    expect(await models.json()).toMatchObject({
      catalog_source: 'free_ai',
      free_ai_models: [expect.objectContaining({
        id: 'gemini-embedding-001',
        enabled: true,
        dimensions: 1536,
        selectable: true,
      })],
    });
    expect(created.status).toBe(201);
    expect(index).toMatchObject({
      dimensions: 1536,
      embedding_model: 'gemini-embedding-001',
      embedding_provider: 'gemini',
    });
    expect(ingested.status).toBe(201);
    expect(embeddingCalls[0]).toMatchObject({
      headers: {
        'x-gateway-force-model': 'gemini-embedding-001',
        'x-gateway-force-provider': 'gemini',
      },
      body: {
        model: 'gemini-embedding-001',
        dimensions: 1536,
      },
    });
  });

  it('rejects explicit embedding models that are only present in the static fallback catalog', async () => {
    const repo = new MemoryRepository();
    const app = createApp({ makeRepository: () => repo });
    const env = makeEnv(new FakeVectorize());
    env.VECTORIZE_1024 = new FakeVectorize();
    env.RAG_EMBED_PROVIDER = 'free_ai';
    env.FREE_AI_EMBED_MODEL = 'gemini-embedding-001';
    env.FREE_AI_EMBED_PROVIDER = 'gemini';
    env.FREE_AI_EMBED_DIMENSIONS = '1536';
    env.FREE_AI_API_KEY = 'test-free-ai-key';
    env.FREE_AI = {
      fetch: async (url: string | Request) => {
        const href = typeof url === 'string' ? url : url.url;
        if (href.endsWith('/v1/models')) {
          return Response.json({
            data: [
              {
                id: 'gemini-embedding-001',
                type: 'embedding',
                provider: 'gemini',
                dimensions: 1536,
                enabled: true,
              },
            ],
          });
        }
        return new Response('not found', { status: 404 });
      },
    } as unknown as Fetcher;

    const created = await app.request('/v1/indexes', {
      method: 'POST',
      headers: { Authorization: 'Bearer key-a' },
      body: JSON.stringify({ name: 'Static Voyage Index', embedding_model: 'voyage-3.5-lite' }),
    }, env);

    expect(created.status).toBe(400);
    expect(await created.json()).toMatchObject({
      error: 'embedding model is not available in free-ai: voyage-3.5-lite',
    });
  });

  it('exposes free-ai embedding availability but rejects disabled or unbound dimensions', async () => {
    const repo = new MemoryRepository();
    const app = createApp({ makeRepository: () => repo });
    const env = makeEnv(new FakeVectorize());
    env.RAG_EMBED_PROVIDER = 'free_ai';
    env.FREE_AI_EMBED_MODEL = 'gemini-embedding-001';
    env.FREE_AI_EMBED_PROVIDER = 'gemini';
    env.FREE_AI_EMBED_DIMENSIONS = '1536';
    env.FREE_AI_API_KEY = 'test-free-ai-key';
    env.FREE_AI = {
      fetch: async (url: string | Request) => {
        const href = typeof url === 'string' ? url : url.url;
        if (href.endsWith('/v1/models')) {
          return Response.json({
            data: [
              {
                id: 'gemini-embedding-001',
                type: 'embedding',
                provider: 'gemini',
                dimensions: 1536,
                enabled: false,
              },
              {
                id: '@cf/baai/bge-base-en-v1.5',
                type: 'embedding',
                provider: 'workers_ai',
                dimensions: 768,
                enabled: true,
              },
            ],
          });
        }
        return new Response('not found', { status: 404 });
      },
    } as unknown as Fetcher;

    const models = await app.request('/v1/embedding-models', { headers: { Authorization: 'Bearer key-a' } }, env);
    const disabled = await app.request('/v1/indexes', {
      method: 'POST',
      headers: { Authorization: 'Bearer key-a' },
      body: JSON.stringify({ name: 'Disabled Gemini', embedding_model: 'gemini-embedding-001' }),
    }, env);
    const unbound = await app.request('/v1/indexes', {
      method: 'POST',
      headers: { Authorization: 'Bearer key-a' },
      body: JSON.stringify({ name: 'Unbound BGE', embedding_model: '@cf/baai/bge-base-en-v1.5' }),
    }, env);

    expect(models.status).toBe(200);
    expect(await models.json()).toMatchObject({
      free_ai_models: [
        expect.objectContaining({
          id: 'gemini-embedding-001',
          enabled: false,
          compatible_profile: 'base',
          vectorize_binding: 'VECTORIZE',
          selectable: false,
        }),
        expect.objectContaining({
          id: '@cf/baai/bge-base-en-v1.5',
          enabled: true,
          compatible_profile: null,
          vectorize_binding: null,
          selectable: false,
        }),
      ],
    });
    expect(disabled.status).toBe(400);
    expect(await disabled.json()).toMatchObject({ error: 'embedding model is disabled in free-ai: gemini-embedding-001' });
    expect(unbound.status).toBe(400);
    expect(await unbound.json()).toMatchObject({
      error: 'embedding model dimensions 768 do not match a configured Vectorize binding',
    });
  });

  it('routes selected 1024-dimension free-ai models to a matching Vectorize binding', async () => {
    const repo = new MemoryRepository();
    const app = createApp({ makeRepository: () => repo });
    const vectorize = new FakeVectorize();
    const vectorize1024 = new FakeVectorize();
    const env = makeEnv(vectorize);
    env.VECTORIZE_1024 = vectorize1024;
    env.RAG_EMBED_PROVIDER = 'free_ai';
    env.FREE_AI_EMBED_MODEL = 'gemini-embedding-001';
    env.FREE_AI_EMBED_PROVIDER = 'gemini';
    env.FREE_AI_EMBED_DIMENSIONS = '1536';
    env.FREE_AI_API_KEY = 'test-free-ai-key';
    env.FREE_AI = {
      fetch: async (url: string | Request, init?: RequestInit) => {
        const href = typeof url === 'string' ? url : url.url;
        if (href.endsWith('/v1/models')) {
          return Response.json({
            data: [
              {
                id: 'voyage-3.5-lite',
                type: 'embedding',
                provider: 'voyage_ai',
                dimensions: 1024,
                enabled: true,
              },
            ],
          });
        }
        if (href.endsWith('/v1/embeddings')) {
          const body = JSON.parse(String(init?.body ?? '{}')) as { input?: string[] };
          return Response.json({
            data: (body.input ?? []).map((_, i) => ({ index: i, embedding: vectorOf(1024, i + 1) })),
          });
        }
        return new Response('not found', { status: 404 });
      },
    } as unknown as Fetcher;

    const models = await app.request('/v1/embedding-models', { headers: { Authorization: 'Bearer key-a' } }, env);
    const created = await app.request('/v1/indexes', {
      method: 'POST',
      headers: { Authorization: 'Bearer key-a' },
      body: JSON.stringify({ name: 'Voyage Index', embedding_model: 'voyage-3.5-lite' }),
    }, env);
    const index = await created.json() as IndexRecord;
    const ingested = await app.request(`/v1/indexes/${index.id}/ingest`, {
      method: 'POST',
      headers: { Authorization: 'Bearer key-a' },
      body: JSON.stringify({ documents: [{ content: 'alpha voyage embedding content' }] }),
    }, env);
    const queried = await app.request(`/v1/indexes/${index.id}/query`, {
      method: 'POST',
      headers: { Authorization: 'Bearer key-a' },
      body: JSON.stringify({ query: 'alpha', mode: 'semantic' }),
    }, env);

    expect(models.status).toBe(200);
    expect(await models.json()).toMatchObject({
      vectorize_profiles: expect.arrayContaining([
        expect.objectContaining({ key: 'dim_1024', dimensions: 1024, vectorize_binding: 'VECTORIZE_1024' }),
      ]),
      free_ai_models: [
        expect.objectContaining({
          id: 'voyage-3.5-lite',
          compatible_profile: 'dim_1024',
          vectorize_binding: 'VECTORIZE_1024',
          selectable: true,
        }),
      ],
    });
    expect(created.status).toBe(201);
    expect(index).toMatchObject({
      dimensions: 1024,
      embedding_model: 'voyage-3.5-lite',
      embedding_provider: 'voyage_ai',
    });
    expect(ingested.status).toBe(201);
    expect(queried.status).toBe(200);
    expect(vectorize.vectors.size).toBe(0);
    expect(vectorize.queries).toHaveLength(0);
    expect(vectorize1024.vectors.size).toBeGreaterThan(0);
    expect(vectorize1024.queries).toHaveLength(1);
  });

  it('routes selected 384-dimension free-ai models without requiring an explicit small profile', async () => {
    const repo = new MemoryRepository();
    const app = createApp({ makeRepository: () => repo });
    const vectorize = new FakeVectorize();
    const vectorize384 = new FakeVectorize();
    const env = makeEnv(vectorize);
    const embeddingCalls: Array<{ headers: Record<string, string>; body: { model?: string; dimensions?: number; input?: string[] } }> = [];
    env.VECTORIZE_384 = vectorize384;
    env.RAG_EMBED_PROVIDER = 'free_ai';
    env.FREE_AI_EMBED_MODEL = 'gemini-embedding-001';
    env.FREE_AI_EMBED_PROVIDER = 'gemini';
    env.FREE_AI_EMBED_DIMENSIONS = '1536';
    env.FREE_AI_API_KEY = 'test-free-ai-key';
    env.FREE_AI = {
      fetch: async (url: string | Request, init?: RequestInit) => {
        const href = typeof url === 'string' ? url : url.url;
        if (href.endsWith('/v1/models')) {
          return Response.json({
            data: [
              {
                id: '@cf/baai/bge-small-en-v1.5',
                type: 'embedding',
                provider: 'workers_ai',
                dimensions: 384,
                enabled: true,
              },
            ],
          });
        }
        if (href.endsWith('/v1/embeddings')) {
          const headers = Object.fromEntries(new Headers(init?.headers).entries());
          const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string; dimensions?: number; input?: string[] };
          embeddingCalls.push({ headers, body });
          return Response.json({
            data: (body.input ?? []).map((_, i) => ({ index: i, embedding: vectorOf(384, i + 1) })),
          });
        }
        return new Response('not found', { status: 404 });
      },
    } as unknown as Fetcher;

    const models = await app.request('/v1/embedding-models', { headers: { Authorization: 'Bearer key-a' } }, env);
    const created = await app.request('/v1/indexes', {
      method: 'POST',
      headers: { Authorization: 'Bearer key-a' },
      body: JSON.stringify({ name: 'BGE Small Index', embedding_model: '@cf/baai/bge-small-en-v1.5' }),
    }, env);
    const index = await created.json() as IndexRecord;
    const ingested = await app.request(`/v1/indexes/${index.id}/ingest`, {
      method: 'POST',
      headers: { Authorization: 'Bearer key-a' },
      body: JSON.stringify({ documents: [{ content: 'alpha bge small embedding content' }] }),
    }, env);
    const queried = await app.request(`/v1/indexes/${index.id}/query`, {
      method: 'POST',
      headers: { Authorization: 'Bearer key-a' },
      body: JSON.stringify({ query: 'alpha', mode: 'semantic' }),
    }, env);

    expect(models.status).toBe(200);
    expect(await models.json()).toMatchObject({
      vectorize_profiles: expect.arrayContaining([
        expect.objectContaining({ key: 'dim_384', dimensions: 384, vectorize_binding: 'VECTORIZE_384' }),
      ]),
      free_ai_models: [
        expect.objectContaining({
          id: '@cf/baai/bge-small-en-v1.5',
          compatible_profile: 'dim_384',
          vectorize_binding: 'VECTORIZE_384',
          selectable: true,
        }),
      ],
    });
    expect(created.status).toBe(201);
    expect(index).toMatchObject({
      dimensions: 384,
      embedding_model: '@cf/baai/bge-small-en-v1.5',
      embedding_provider: 'workers_ai',
    });
    expect(ingested.status).toBe(201);
    expect(queried.status).toBe(200);
    expect(embeddingCalls[0]).toMatchObject({
      headers: {
        'x-gateway-force-model': '@cf/baai/bge-small-en-v1.5',
        'x-gateway-force-provider': 'workers_ai',
      },
      body: {
        model: '@cf/baai/bge-small-en-v1.5',
        dimensions: 384,
      },
    });
    expect(vectorize.vectors.size).toBe(0);
    expect(vectorize.queries).toHaveLength(0);
    expect(vectorize384.vectors.size).toBeGreaterThan(0);
    expect(vectorize384.queries).toHaveLength(1);
  });

  it('rejects small-profile indexes when the small Vectorize binding is absent', async () => {
    const repo = new MemoryRepository();
    const app = createApp({ makeRepository: () => repo });
    const env = makeEnv(new FakeVectorize());

    const res = await app.request('/v1/indexes', {
      method: 'POST',
      headers: { Authorization: 'Bearer key-a' },
      body: JSON.stringify({ name: 'Small Index', embedding_profile: 'small' }),
    }, env);

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'small embedding profile is not configured' });
  });

  it('uses the index embedding profile for ingest and query defaults', async () => {
    const repo = new MemoryRepository();
    const app = createApp({ makeRepository: () => repo });
    const vectorize = new FakeVectorize();
    const vectorizeSmall = new FakeVectorize();
    const env = makeEnv(vectorize, undefined as unknown as D1Database, vectorizeSmall);

    const created = await app.request('/v1/indexes', {
      method: 'POST',
      headers: { Authorization: 'Bearer key-a' },
      body: JSON.stringify({ name: 'Small Index', embedding_profile: 'small' }),
    }, env);
    const index = await created.json() as IndexRecord;
    const ingested = await app.request(`/v1/indexes/${index.id}/ingest`, {
      method: 'POST',
      headers: { Authorization: 'Bearer key-a' },
      body: JSON.stringify({ documents: [{ content: 'alpha small profile content' }] }),
    }, env);
    const queried = await app.request(`/v1/indexes/${index.id}/query`, {
      method: 'POST',
      headers: { Authorization: 'Bearer key-a' },
      body: JSON.stringify({ query: 'alpha', mode: 'semantic' }),
    }, env);

    expect(created.status).toBe(201);
    expect(index.dimensions).toBe(384);
    expect(ingested.status).toBe(201);
    expect(vectorize.vectors.size).toBe(0);
    expect(vectorizeSmall.vectors.size).toBeGreaterThan(0);
    expect(queried.status).toBe(200);
    expect(vectorize.queries).toHaveLength(0);
    expect(vectorizeSmall.queries).toHaveLength(1);
  });

  it('rejects explicit small semantic queries when the small binding is absent', async () => {
    const repo = new MemoryRepository();
    const app = createApp({ makeRepository: () => repo });
    const env = makeEnv(new FakeVectorize());

    const created = await app.request('/v1/indexes', {
      method: 'POST',
      headers: { Authorization: 'Bearer key-a' },
      body: JSON.stringify({ name: 'Base Index' }),
    }, env);
    const index = await created.json() as IndexRecord;
    const queried = await app.request(`/v1/indexes/${index.id}/query`, {
      method: 'POST',
      headers: { Authorization: 'Bearer key-a' },
      body: JSON.stringify({ query: 'alpha', mode: 'semantic', semantic_model: 'small' }),
    }, env);

    expect(created.status).toBe(201);
    expect(queried.status).toBe(400);
    expect(await queried.json()).toMatchObject({ error: 'small embedding profile is not configured' });
  });

  it('serves public readiness and Prometheus-compatible metrics aliases', async () => {
    const app = createApp();
    const env = makeEnv(
      new FakeVectorize(),
      undefined as unknown as D1Database,
      undefined,
      new FakeR2Bucket() as unknown as R2Bucket,
    );

    const readyz = await app.request('/readyz', {}, env);
    const metrics = await app.request('/metrics', {}, env);
    const readyzBody = (await readyz.json()) as {
      status: string;
      db: { ok: boolean; schema_ok: boolean };
      vector: { ok: boolean };
      object: { ok: boolean };
      worker: { version: string; deploy_fingerprint: string };
    };
    const metricsText = await metrics.text();

    expect(readyz.status).toBe(200);
    expect(readyzBody).toMatchObject({
      status: 'ok',
      db: { ok: true, schema_ok: true },
      vector: { ok: true },
      object: { ok: true },
      worker: {
        version: '0.1.0',
        deploy_fingerprint: 'knowledgebase-a-plus-evidence-2026-06-23',
      },
    });
    expect(metrics.status).toBe(200);
    expect(metrics.headers.get('content-type')).toContain('text/plain');
    expect(metricsText).toContain('kb_worker_ready 1');
    expect(metricsText).toContain('kb_d1_schema_ready 1');
    expect(metricsText).toContain('deploy_fingerprint="knowledgebase-a-plus-evidence-2026-06-23"');
    expect(metricsText).toContain('kb_queries_total');
    expect(metricsText).toContain('kb_ingest_files_total');
  });

  it('marks health degraded when the required D1 schema migration is missing', async () => {
    const app = createApp();
    const db = {
      prepare: (sql: string) => ({
        first: async () => {
          if (sql.includes('embedding_model')) throw new Error('no such column: embedding_model');
          return { ok: 1 };
        },
      }),
    } as unknown as D1Database;
    const env = makeEnv(
      new FakeVectorize(),
      db,
      undefined,
      new FakeR2Bucket() as unknown as R2Bucket,
    );

    const health = await app.request('/v1/healthz', {}, env);
    const readyz = await app.request('/readyz', {}, env);
    const metrics = await app.request('/metrics', {}, env);
    const healthBody = (await health.json()) as { ok: boolean; d1: boolean; d1_schema: boolean; error: string };
    const readyzBody = (await readyz.json()) as { status: string; db: { ok: boolean; schema_ok: boolean; error: string } };
    const metricsText = await metrics.text();

    expect(health.status).toBe(503);
    expect(healthBody).toMatchObject({
      ok: false,
      d1: true,
      d1_schema: false,
    });
    expect(healthBody.error).toContain('embedding_model');
    expect(readyz.status).toBe(503);
    expect(readyzBody).toMatchObject({
      status: 'degraded',
      db: { ok: false, schema_ok: false },
    });
    expect(metricsText).toContain('kb_worker_ready 0');
    expect(metricsText).toContain('kb_d1_schema_ready 0');
  });

  it('allows local cutover smoke to skip the D1 schema check without reporting schema ready', async () => {
    const app = createApp();
    const db = {
      prepare: (sql: string) => ({
        first: async () => {
          if (sql.includes('embedding_model')) throw new Error('no such table: indexes');
          return { ok: 1 };
        },
      }),
    } as unknown as D1Database;
    const env = makeEnv(
      new FakeVectorize(),
      db,
      undefined,
      new FakeR2Bucket() as unknown as R2Bucket,
    );
    env.RAG_ALLOW_UNMIGRATED_LOCAL_D1 = 'true';

    const health = await app.request('/v1/healthz', {}, env);
    const readyz = await app.request('/readyz', {}, env);
    const healthBody = (await health.json()) as { ok: boolean; d1_schema: boolean; d1_schema_check_skipped: boolean };
    const readyzBody = (await readyz.json()) as { status: string; db: { ok: boolean; schema_ok: boolean; schema_check_skipped: boolean } };

    expect(health.status).toBe(200);
    expect(healthBody).toMatchObject({
      ok: true,
      d1_schema: false,
      d1_schema_check_skipped: true,
    });
    expect(readyz.status).toBe(200);
    expect(readyzBody).toMatchObject({
      status: 'ok',
      db: {
        ok: true,
        schema_ok: false,
        schema_check_skipped: true,
      },
    });
  });

  it('allows an explicit deploy fingerprint override in health metadata', async () => {
    const app = createApp();
    const env = makeEnv(
      new FakeVectorize(),
      undefined as unknown as D1Database,
      undefined,
      new FakeR2Bucket() as unknown as R2Bucket,
    );
    env.RAG_DEPLOY_FINGERPRINT = 'build"one\\two';

    const health = await app.request('/v1/healthz', {}, env);
    const metrics = await app.request('/metrics', {}, env);
    const healthBody = (await health.json()) as { deploy_fingerprint: string };
    const metricsText = await metrics.text();

    expect(healthBody.deploy_fingerprint).toBe('build"one\\two');
    expect(metricsText).toContain('deploy_fingerprint="build\\"one\\\\two"');
  });

  it('ingests documents into chunk rows and Vectorize, then hydrates query results', async () => {
    const repo = new MemoryRepository();
    const vectorize = new FakeVectorize();
    const app = createApp({ makeRepository: () => repo });
    const env = makeEnv(
      vectorize,
      undefined as unknown as D1Database,
      undefined,
      new FakeR2Bucket() as unknown as R2Bucket,
    );
    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };

    const created = await app.request(
      '/v1/indexes',
      { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Docs' }) },
      env,
    );
    const index = (await created.json()) as IndexRecord;

    const ingest = await app.request(
      `/v1/indexes/${index.id}/ingest`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          documents: [{ content: 'alpha document\n\nbeta appendix', metadata: { source: 'unit' } }],
          chunking: { size: 18, overlap: 4 },
        }),
      },
      env,
    );

    expect(ingest.status).toBe(201);
    expect(repo.chunks.size).toBeGreaterThan(0);
    expect(vectorize.vectors.size).toBe(repo.chunks.size);

    const query = await app.request(
      `/v1/indexes/${index.id}/query`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ query: 'alpha', top_k: 3 }),
      },
      env,
    );
    const result = (await query.json()) as { data: Array<{ chunk_content: string; metadata: JsonRecord }> };

    expect(query.status).toBe(200);
    expect(result.data.length).toBeGreaterThan(0);
    expect(result.data[0]?.chunk_content).toContain('alpha');
    expect(result.data[0]?.metadata).toMatchObject({ source: 'unit' });
  });

  it('streams query lifecycle events for the knowledgebase answer route', async () => {
    const repo = new MemoryRepository();
    const metadata = new MemoryMetadataRepository();
    const vectorize = new FakeVectorize();
    const app = createApp({
      makeRepository: () => repo,
      makeMetadataRepository: () => metadata,
    });
    const env = makeEnv(
      vectorize,
      undefined as unknown as D1Database,
      undefined,
      new FakeR2Bucket() as unknown as R2Bucket,
    );
    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };

    const created = await app.request(
      '/v1/indexes',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ name: 'Manuals', external_id: 'kb:manuals' }),
      },
      env,
    );
    const index = (await created.json()) as IndexRecord;
    await app.request(
      `/v1/indexes/${index.id}/ingest`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          documents: [{
            content: 'alpha runbook documents Cloudflare RAG streaming parity',
            metadata: { filename: 'alpha.md' },
          }],
        }),
      },
      env,
    );

    const stream = await app.request(
      '/v1/kb/query/stream',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          domain: 'manuals',
          question: 'Where is alpha documented?',
          mode: 'lexical',
          top_k: 1,
        }),
      },
      env,
    );
    const text = await stream.text();

    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    expect(text).toContain('event: started');
    expect(text).toContain('event: stage');
    expect(text).toContain('event: answer');
    expect(text).toContain('"domain":"manuals"');
    expect(text).toContain('Cloudflare RAG streaming parity');
    expect(text).not.toContain('event: error');
  });

  it('serves retired FastAPI route aliases through the Cloudflare Worker', async () => {
    const repo = new MemoryRepository();
    const metadata = new MemoryMetadataRepository();
    const vectorize = new FakeVectorize();
    const app = createApp({
      makeRepository: () => repo,
      makeMetadataRepository: () => metadata,
    });
    const env = makeEnv(
      vectorize,
      undefined as unknown as D1Database,
      undefined,
      new FakeR2Bucket() as unknown as R2Bucket,
    );
    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };

    const health = await app.request('/healthz', {}, env);
    const healthBody = (await health.json()) as { deploy_fingerprint: string };
    const noAuthDomains = await app.request('/domains', {}, env);
    const domain = await app.request(
      '/domains',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ name: 'manuals', description: 'Legacy alias domain' }),
      },
      env,
    );
    const domains = await app.request('/domains', { headers: { Authorization: 'Bearer key-a' } }, env);
    const inferForm = new FormData();
    inferForm.set('domain', 'manuals');
    inferForm.set('files', new File(['id,title\nm-1,Legacy alias file'], 'legacy.csv', { type: 'text/csv' }));
    const inferFromFiles = await app.request(
      '/schemas/infer/files',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer key-a' },
        body: inferForm,
      },
      env,
    );
    const created = await app.request(
      '/v1/indexes',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ name: 'Manuals', external_id: 'kb:manuals' }),
      },
      env,
    );
    const index = (await created.json()) as IndexRecord;
    await app.request(
      `/v1/indexes/${index.id}/ingest`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          documents: [{
            content: 'alpha legacy route compatibility evidence',
            metadata: { filename: 'legacy.md' },
          }],
        }),
      },
      env,
    );

    const search = await app.request(
      '/search',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ domain: 'manuals', query: 'alpha legacy', mode: 'lexical', top_k: 1 }),
      },
      env,
    );
    const agentSearch = await app.request(
      '/agent/search',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ domain: 'manuals', query: 'alpha legacy', mode: 'lexical', top_k: 1 }),
      },
      env,
    );
    const evalSearch = await app.request(
      '/search/eval',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          index_id: index.id,
          mode: 'lexical',
          cases: [{ id: 'q1', query: 'alpha legacy', expected_text: 'legacy route compatibility' }],
        }),
      },
      env,
    );
    const query = await app.request(
      '/query',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ domain: 'manuals', question: 'alpha legacy', mode: 'lexical', top_k: 1 }),
      },
      env,
    );
    const queryBody = (await query.json()) as { trace_id: string; answer: string };
    const stream = await app.request(
      '/query/stream',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ domain: 'manuals', question: 'alpha legacy', mode: 'lexical', top_k: 1 }),
      },
      env,
    );
    const traces = await app.request('/query/traces?domain=manuals', { headers: { Authorization: 'Bearer key-a' } }, env);
    const trace = await app.request(`/query/trace/${queryBody.trace_id}`, { headers: { Authorization: 'Bearer key-a' } }, env);

    expect(health.status).toBe(200);
    expect(healthBody.deploy_fingerprint).toBe('knowledgebase-a-plus-evidence-2026-06-23');
    expect(noAuthDomains.status).toBe(401);
    expect(domain.status).toBe(201);
    expect(await domains.json()).toMatchObject({ data: [expect.objectContaining({ name: 'manuals' })] });
    expect(inferFromFiles.status, await inferFromFiles.clone().text()).toBe(200);
    expect((await inferFromFiles.json()) as { spec: DomainSchema }).toMatchObject({
      spec: expect.objectContaining({ domain: 'manuals' }),
    });
    expect(search.status).toBe(200);
    expect((await search.json()) as { data: SearchResult[] }).toMatchObject({
      data: [expect.objectContaining({ chunk_content: expect.stringContaining('legacy route compatibility') })],
    });
    expect(agentSearch.status).toBe(200);
    expect(evalSearch.status).toBe(200);
    expect((await evalSearch.json()) as { hit_rate: number }).toMatchObject({ hit_rate: 1 });
    expect(query.status).toBe(200);
    expect(queryBody.answer).toContain('legacy route compatibility');
    expect(stream.status).toBe(200);
    expect(await stream.text()).toContain('event: answer');
    expect(traces.status).toBe(200);
    expect(trace.status).toBe(200);
  });

  it('stores full knowledgebase metadata through tenant-scoped D1 repository routes', async () => {
    const metadata = new MemoryMetadataRepository();
    const app = createApp({ makeMetadataRepository: () => metadata });
    const env = makeEnv(new FakeVectorize());
    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };

    const domain = await app.request(
      '/v1/kb/domains',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ name: 'manuals', description: 'Product manuals' }),
      },
      env,
    );
    const file = await app.request(
      '/v1/kb/files',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          domain: 'manuals',
          filename: 'guide.pdf',
          mime: 'application/pdf',
          bytes: 42,
          content_hash: 'sha256-guide',
          object_key: 'raw/manuals/sha256-guide',
        }),
      },
      env,
    );
    const status = await app.request('/v1/kb/status', { headers: auth }, env);

    expect(domain.status).toBe(201);
    expect(file.status).toBe(201);
    expect(await file.json()).toMatchObject({
      project: 'tenant-a',
      domain: 'manuals',
      filename: 'guide.pdf',
      object_key: 'raw/manuals/sha256-guide',
    });
    expect(await status.json()).toMatchObject({
      data: [{ domain: 'manuals', file_count: 1, staged_files: 1, state: 'no_schema' }],
    });
  });

  it('exposes project aliases for the authenticated Cloudflare tenant', async () => {
    const metadata = new MemoryMetadataRepository();
    const app = createApp({ makeMetadataRepository: () => metadata });
    const env = makeEnv(new FakeVectorize());
    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };

    await app.request(
      '/v1/kb/domains',
      { method: 'POST', headers: auth, body: JSON.stringify({ name: 'manuals' }) },
      env,
    );
    const projects = await app.request('/v1/kb/projects', { headers: auth }, env);
    const upsertedProject = await app.request(
      '/v1/kb/projects',
      { method: 'POST', headers: auth, body: JSON.stringify({ name: 'tenant-a', description: 'Tenant A' }) },
      env,
    );
    const status = await app.request('/v1/kb/projects/tenant-a/status', { headers: auth }, env);
    const wrongProject = await app.request('/v1/kb/projects/other/status', { headers: auth }, env);

    expect(projects.status).toBe(200);
    expect(await projects.json()).toMatchObject({
      data: [{ name: 'tenant-a', project: 'tenant-a', domain_count: 1, kind_count: 1 }],
    });
    expect(upsertedProject.status).toBe(201);
    expect(await upsertedProject.json()).toMatchObject({ name: 'tenant-a', project: 'tenant-a', description: 'Tenant A' });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ project: 'tenant-a', data: [{ domain: 'manuals' }] });
    expect(wrongProject.status).toBe(404);
  });

  it('gets, applies, discards, and resolves active schema drafts', async () => {
    const metadata = new MemoryMetadataRepository();
    const app = createApp({ makeMetadataRepository: () => metadata });
    const env = makeEnv(new FakeVectorize());
    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };

    const inferred = await app.request(
      '/v1/kb/schemas/infer',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          domain: 'contracts',
          records: [{ contract_id: 'c-1', counterparty: 'Acme', value: 1000 }],
        }),
      },
      env,
    );
    const inferredBody = (await inferred.json()) as { draft_id: string };
    const draft = await app.request(`/v1/kb/schemas/drafts/${inferredBody.draft_id}`, { headers: auth }, env);
    const applied = await app.request(
      `/v1/kb/schemas/drafts/${inferredBody.draft_id}/apply`,
      { method: 'POST', headers: auth },
      env,
    );
    const active = await app.request('/v1/kb/schemas/contracts/active', { headers: auth }, env);
    const stagedFile = await app.request(
      '/v1/kb/files',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          domain: 'contracts',
          filename: 'contract.txt',
          mime: 'text/plain',
          bytes: 12,
          content_hash: 'sha256-contract',
          object_key: 'raw/contracts/sha256-contract',
        }),
      },
      env,
    );
    const stagedFileBody = (await stagedFile.json()) as FileRecord;
    const reprocess = await app.request(
      '/v1/kb/schemas/contracts/reprocess',
      { method: 'POST', headers: auth, body: JSON.stringify({ file_ids: [stagedFileBody.id] }) },
      env,
    );

    const second = await app.request(
      '/v1/kb/schemas/infer',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          domain: 'contracts',
          records: [{ contract_id: 'c-2', counterparty: 'Beta' }],
        }),
      },
      env,
    );
    const secondBody = (await second.json()) as { draft_id: string };
    const discarded = await app.request(
      `/v1/kb/schemas/drafts/${secondBody.draft_id}/discard`,
      { method: 'POST', headers: auth },
      env,
    );

    expect(draft.status).toBe(200);
    expect(await draft.json()).toMatchObject({ id: inferredBody.draft_id, status: 'pending' });
    expect(applied.status).toBe(200);
    expect(await applied.json()).toMatchObject({
      draft: { id: inferredBody.draft_id, status: 'applied' },
      schema: { domain: 'contracts', is_active: 1 },
    });
    expect(active.status).toBe(200);
    expect(await active.json()).toMatchObject({ domain: 'contracts', is_active: 1 });
    expect(reprocess.status).toBe(200);
    expect(await reprocess.json()).toMatchObject({
      project: 'tenant-a',
      domain: 'contracts',
      enqueued: 1,
      stage: 'parse',
      jobs: [{ file_id: stagedFileBody.id, schema_id: expect.any(String) }],
    });
    expect(discarded.status).toBe(200);
    expect(await discarded.json()).toMatchObject({ id: secondBody.draft_id, status: 'discarded' });
  });

  it('lists, gets, reprocesses, and deletes individual files', async () => {
    const metadata = new MemoryMetadataRepository();
    const ragRepo = new MemoryRepository();
    const rawDocs = new FakeR2Bucket();
    const vectorize = new FakeVectorize();
    const vectorizeSmall = new FakeVectorize();
    const app = createApp({
      makeRepository: () => ragRepo,
      makeMetadataRepository: () => metadata,
    });
    const env = makeEnv(
      vectorize,
      undefined as unknown as D1Database,
      vectorizeSmall,
      rawDocs as unknown as R2Bucket,
    );
    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };
    const fileRes = await app.request(
      '/v1/kb/files',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          domain: 'manuals',
          filename: 'guide.txt',
          mime: 'text/plain',
          bytes: 12,
          content_hash: 'sha256-guide',
          object_key: 'raw/manuals/sha256-guide',
        }),
      },
      env,
    );
    const file = (await fileRes.json()) as FileRecord;
    const rawBytes = new TextEncoder().encode('hello upload');
    rawDocs.objects.set(file.object_key, rawBytes.buffer.slice(
      rawBytes.byteOffset,
      rawBytes.byteOffset + rawBytes.byteLength,
    ) as ArrayBuffer);
    await metadata.upsertParseArtifact({
      contentHash: file.content_hash,
      parser: 'worker-text-structured-v1',
      objectKey: 'parse/manuals/sha256-guide.json',
    });
    metadata.chunks.set('chunk-1', {
      id: 'chunk-1',
      project: file.project,
      domain: file.domain,
      fileId: file.id,
      vectorId: 'vector-1',
      pageStart: 1,
      pageEnd: 1,
      text: 'hello upload',
    });
    await vectorize.upsert([{ id: 'vector-1', values: [1, 0, 0], namespace: 'ns', metadata: {} }]);
    await vectorizeSmall.upsert([{ id: 'vector-1', values: [1, 0, 0], namespace: 'ns', metadata: {} }]);

    const listed = await app.request('/v1/kb/files?domain=manuals', { headers: auth }, env);
    const got = await app.request(`/v1/kb/files/${file.id}`, { headers: auth }, env);
    const reprocess = await app.request(
      `/v1/kb/files/${file.id}/reprocess`,
      { method: 'POST', headers: auth },
      env,
    );
    const reprocessBody = (await reprocess.json()) as { job: IngestJobRecord };
    const job = await app.request(`/v1/kb/ingest/jobs/${reprocessBody.job.id}`, { headers: auth }, env);
    const deleted = await app.request(
      `/v1/kb/files/${file.id}`,
      { method: 'DELETE', headers: auth },
      env,
    );
    const afterDelete = await app.request(`/v1/kb/files/${file.id}`, { headers: auth }, env);

    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({ data: [{ id: file.id, filename: 'guide.txt' }] });
    expect(got.status).toBe(200);
    expect(await got.json()).toMatchObject({ id: file.id, domain: 'manuals' });
    expect(reprocess.status).toBe(200);
    expect(reprocessBody).toMatchObject({
      project: 'tenant-a',
      file_id: file.id,
      job: { file_id: file.id, status: 'queued', stage: 'parse' },
    });
    expect(job.status).toBe(200);
    expect(await job.json()).toMatchObject({ id: reprocessBody.job.id, file_id: file.id });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ affected_files: 1, deleted_vectors: 1 });
    expect(vectorize.deleted).toContain('vector-1');
    expect(vectorizeSmall.deleted).toContain('vector-1');
    expect(rawDocs.deletes).toContain('raw/manuals/sha256-guide');
    expect(rawDocs.deletes).toContain('parse/manuals/sha256-guide.json');
    expect(afterDelete.status).toBe(404);
  });

  it('gets entity detail, lineage, and relationship aliases', async () => {
    const metadata = new MemoryMetadataRepository();
    const app = createApp({ makeMetadataRepository: () => metadata });
    const env = makeEnv(new FakeVectorize());
    const auth = { Authorization: 'Bearer key-a' };
    metadata.entities.set('parent-1', {
      id: 'parent-1',
      project: 'tenant-a',
      domain: 'contracts',
      type: 'Company',
      identity_key: 'acme',
      display_name: 'Acme',
      fields: { company_id: 'acme' },
      parent_id: null,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    });
    metadata.entities.set('child-1', {
      id: 'child-1',
      project: 'tenant-a',
      domain: 'contracts',
      type: 'Contract',
      identity_key: 'c-1',
      display_name: 'Contract C-1',
      fields: { contract_id: 'c-1', counterparty_id: 'acme' },
      parent_id: 'parent-1',
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    });
    metadata.relationships.set('rel-1', {
      id: 'rel-1',
      project: 'tenant-a',
      domain: 'contracts',
      rel_type: 'counterparty',
      src_id: 'child-1',
      dst_id: 'parent-1',
      evidence_file: null,
      evidence_page: null,
      created_at: new Date(0).toISOString(),
    });

    const detail = await app.request('/v1/kb/entities/child-1', { headers: auth }, env);
    const found = await app.request(
      '/v1/kb/entities/find?domain=contracts&type=Contract&identity_key=c-1',
      { headers: auth },
      env,
    );
    const lineage = await app.request('/v1/kb/entities/child-1/lineage', { headers: auth }, env);
    const relationships = await app.request('/v1/kb/entities/child-1/relationships', { headers: auth }, env);

    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ id: 'child-1', parent_id: 'parent-1' });
    expect(found.status).toBe(200);
    expect(await found.json()).toMatchObject({ id: 'child-1', identity_key: 'c-1' });
    expect(lineage.status).toBe(200);
    expect(await lineage.json()).toMatchObject({
      entity: { id: 'child-1' },
      ancestors: [{ id: 'parent-1' }, { id: 'child-1' }],
      children: [],
      mentions: [],
      parent_chain: [{ id: 'parent-1' }],
      relationships: [{ id: 'rel-1', src_name: 'Contract C-1', dst_name: 'Acme' }],
    });
    expect(relationships.status).toBe(200);
    expect(await relationships.json()).toMatchObject({
      entity_id: 'child-1',
      relationships: [{ id: 'rel-1', src_name: 'Contract C-1', dst_name: 'Acme' }],
    });
  });

  it('ingests direct structured records and raw text as Cloudflare-owned inputs', async () => {
    const metadata = new MemoryMetadataRepository();
    const ragRepo = new MemoryRepository();
    const rawDocs = new FakeR2Bucket();
    const vectorize = new FakeVectorize();
    const app = createApp({
      makeRepository: () => ragRepo,
      makeMetadataRepository: () => metadata,
    });
    const env = makeEnv(
      vectorize,
      undefined as unknown as D1Database,
      undefined,
      rawDocs as unknown as R2Bucket,
    );
    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };
    await app.request(
      '/v1/kb/schemas',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          domain: 'contracts',
          name: 'default',
          entities: [{
            name: 'Contract',
            fields: [
              { name: 'contract_id', type: 'string', identity: true },
              { name: 'counterparty', type: 'string' },
              { name: 'value', type: 'number' },
            ],
          }],
          relationships: [],
        }),
      },
      env,
    );

    const recordIngest = await app.request(
      '/v1/kb/ingest/record',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          kind: 'contracts',
          type: 'Contract',
          data: [
            { contract_id: 'c-1', counterparty: 'Acme', value: 1000 },
            { contract_id: 'c-2', counterparty: 'Beta', value: 2500 },
          ],
        }),
      },
      env,
    );
    const recordBody = (await recordIngest.json()) as {
      file_id: string;
      schema_id: string;
      schema_auto_created: boolean;
      entities_upserted: number;
      chunks_indexed: number;
    };
    const entities = await app.request('/v1/kb/entities?domain=contracts&type=Contract', { headers: auth }, env);
    const inferredRecordIngest = await app.request(
      '/v1/kb/ingest/record',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          domain: 'tickets',
          data: [
            { ticket_id: 't-1', title: 'Broken login', severity: 'high' },
            { ticket_id: 't-2', title: 'Slow dashboard', severity: 'medium' },
          ],
        }),
      },
      env,
    );
    const inferredRecordBody = (await inferredRecordIngest.json()) as {
      file_id: string;
      schema_id: string;
      schema_auto_created: boolean;
      type: string;
      entities_upserted: number;
      chunks_indexed: number;
    };
    const inferredSchema = await app.request('/v1/kb/schemas/tickets/active', { headers: auth }, env);
    const inferredEntities = await app.request(
      '/v1/kb/entities?domain=tickets&type=TicketRecord',
      { headers: auth },
      env,
    );
    const explicitRecordIngest = await app.request(
      '/v1/kb/ingest/record',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          domain: 'incidents',
          type: 'Incident',
          data: [
            { incident_id: 'i-1', title: 'Webhook outage', status: 'open' },
            { incident_id: 'i-2', title: 'Backfill lag', status: 'resolved' },
          ],
        }),
      },
      env,
    );
    const explicitRecordBody = (await explicitRecordIngest.json()) as {
      file_id: string;
      schema_id: string;
      schema_auto_created: boolean;
      type: string;
      entities_upserted: number;
      chunks_indexed: number;
    };
    const explicitSchema = await app.request('/v1/kb/schemas/incidents/active', { headers: auth }, env);
    const explicitEntities = await app.request(
      '/v1/kb/entities?domain=incidents&type=Incident',
      { headers: auth },
      env,
    );

    const textIngest = await app.request(
      '/v1/kb/ingest/text',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          kind: 'contracts',
          type: 'Contract',
          title: 'note',
          text: 'Contract c-3 has counterparty Gamma and value 9000.',
        }),
      },
      env,
    );
    const textBody = (await textIngest.json()) as {
      file_id: string;
      ingestion_mode: string;
      files: Array<{ status: string; chunks_created: number }>;
    };
    const noSchemaTextIngest = await app.request(
      '/v1/kb/ingest/text',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          domain: 'notes',
          title: 'unstructured-note',
          text: 'Unstructured text should still index without an active schema.',
        }),
      },
      env,
    );
    const noSchemaTextBody = (await noSchemaTextIngest.json()) as {
      file_id: string;
      ingestion_mode: string;
      files: Array<{ status: string; chunks_created: number }>;
    };
    const asyncTextIngest = await app.request(
      '/v1/kb/ingest/text',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          domain: 'contracts',
          title: 'async-note',
          text: 'Async text ingestion can still stage the parser job.',
          async: true,
        }),
      },
      env,
    );
    const asyncTextBody = (await asyncTextIngest.json()) as {
      file_id: string;
      ingestion_mode: string;
      job_id: string;
    };
    const asyncTextJob = await app.request(`/v1/kb/ingest/jobs/${asyncTextBody.job_id}`, { headers: auth }, env);

    expect(recordIngest.status).toBe(201);
    expect(recordBody).toMatchObject({
      schema_id: expect.any(String),
      schema_auto_created: false,
      entities_upserted: 2,
    });
    expect(recordBody.chunks_indexed).toBeGreaterThan(0);
    expect(vectorize.vectors.size).toBeGreaterThan(0);
    expect(rawDocs.puts.some((put) => put.key.startsWith('raw/contracts/'))).toBe(true);
    expect(rawDocs.puts.some((put) => put.key.startsWith('parse/contracts/'))).toBe(true);
    expect(entities.status).toBe(200);
    expect(await entities.json()).toMatchObject({ entities: [{ identity_key: 'c-1' }, { identity_key: 'c-2' }] });
    expect(inferredRecordIngest.status).toBe(201);
    expect(inferredRecordBody).toMatchObject({
      schema_id: expect.any(String),
      schema_auto_created: true,
      type: 'TicketRecord',
      entities_upserted: 2,
    });
    expect(inferredRecordBody.chunks_indexed).toBeGreaterThan(0);
    expect(inferredSchema.status).toBe(200);
    expect(await inferredSchema.json()).toMatchObject({
      id: inferredRecordBody.schema_id,
      domain: 'tickets',
      spec: {
        entities: [expect.objectContaining({ name: 'TicketRecord' })],
      },
    });
    expect(rawDocs.puts.some((put) => put.key.startsWith('raw/tickets/'))).toBe(true);
    expect(rawDocs.puts.some((put) => put.key.startsWith('parse/tickets/'))).toBe(true);
    expect(inferredEntities.status).toBe(200);
    expect(await inferredEntities.json()).toMatchObject({
      entities: [{ identity_key: 't-1' }, { identity_key: 't-2' }],
    });
    expect(explicitRecordIngest.status).toBe(201);
    expect(explicitRecordBody).toMatchObject({
      schema_id: expect.any(String),
      schema_auto_created: true,
      type: 'Incident',
      entities_upserted: 2,
    });
    expect(explicitRecordBody.chunks_indexed).toBeGreaterThan(0);
    expect(explicitSchema.status).toBe(200);
    expect(await explicitSchema.json()).toMatchObject({
      id: explicitRecordBody.schema_id,
      domain: 'incidents',
      spec: {
        entities: [expect.objectContaining({
          name: 'Incident',
          aliases: expect.arrayContaining(['IncidentRecord']),
        })],
      },
    });
    expect(explicitEntities.status).toBe(200);
    expect(await explicitEntities.json()).toMatchObject({
      entities: [{ identity_key: 'i-1' }, { identity_key: 'i-2' }],
    });
    expect(textIngest.status).toBe(201);
    expect(textBody.file_id).toBeTruthy();
    expect(textBody.ingestion_mode).toBe('inline');
    expect(textBody.files[0]).toMatchObject({ status: 'ready', chunks_created: expect.any(Number) });
    expect(textBody.files[0]?.chunks_created).toBeGreaterThan(0);
    expect(noSchemaTextIngest.status).toBe(201);
    expect(noSchemaTextBody).toMatchObject({
      file_id: expect.any(String),
      ingestion_mode: 'inline',
      files: [expect.objectContaining({ status: 'ready' })],
    });
    expect(noSchemaTextBody.files[0]?.chunks_created).toBeGreaterThan(0);
    expect(asyncTextIngest.status).toBe(201);
    expect(asyncTextBody).toMatchObject({
      file_id: expect.any(String),
      ingestion_mode: 'queued',
      job_id: expect.any(String),
    });
    expect(asyncTextJob.status).toBe(200);
    expect(await asyncTextJob.json()).toMatchObject({
      id: asyncTextBody.job_id,
      file_id: asyncTextBody.file_id,
      status: 'queued',
    });
  });

  it('lists Cloudflare-supported sources and imports URL sources into R2/D1', async () => {
    const metadata = new MemoryMetadataRepository();
    const rawDocs = new FakeR2Bucket();
    const app = createApp({ makeMetadataRepository: () => metadata });
    const env = makeEnv(
      new FakeVectorize(),
      undefined as unknown as D1Database,
      undefined,
      rawDocs as unknown as R2Bucket,
    );
    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };

    const sources = await app.request('/v1/kb/sources', { headers: auth }, env);
    const imported = await app.request(
      '/v1/kb/sources/import',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          domain: 'notes',
          source: 'url',
          config: { urls: ['data:text/plain,Imported%20source%20document'] },
        }),
      },
      env,
    );
    const originalFetch = globalThis.fetch;
    const fetches: Array<{ url: string; userAgent?: string | null }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      fetches.push({
        url,
        userAgent: init?.headers instanceof Headers
          ? init.headers.get('User-Agent')
          : typeof init?.headers === 'object' && init.headers
            ? (init.headers as Record<string, string>)['User-Agent'] ?? null
            : null,
      });
      if (url.startsWith('data:')) return await originalFetch(input, init);
      if (url === 'https://www.sec.gov/files/company_tickers.json') {
        return Response.json({
          0: { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
        });
      }
      if (url === 'https://data.sec.gov/submissions/CIK0000320193.json') {
        return Response.json({
          cik: '0000320193',
          name: 'Apple Inc.',
          filings: {
            recent: {
              accessionNumber: ['0000320193-26-000001', '0000320193-26-000002'],
              filingDate: ['2026-01-31', '2026-02-01'],
              form: ['10-K', '8-K'],
              primaryDocument: ['aapl-20260131.htm', 'aapl-8k.htm'],
            },
          },
        });
      }
      if (url === 'https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/aapl-20260131.htm') {
        return new Response('<html><body>Apple 10-K risk factors</body></html>', {
          headers: { 'content-type': 'text/html' },
        });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    const edgarImported = await app.request(
      '/v1/kb/sources/import',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          domain: 'sec',
          source: 'edgar',
          config: {
            tickers: ['AAPL'],
            forms: ['10-K'],
            days: 0,
            per_ticker_per_form: 1,
            limit_total: 1,
            user_agent: 'knowledgebase-test test@example.com',
          },
        }),
      },
      env,
    );
    globalThis.fetch = originalFetch;
    const unsupported = await app.request(
      '/v1/kb/sources/import',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ domain: 'notes', source: 'rss', config: {} }),
      },
      env,
    );

    expect(sources.status).toBe(200);
    expect(await sources.json()).toMatchObject({ sources: ['upload', 'url', 'edgar'] });
    expect(imported.status).toBe(200);
    expect(await imported.json()).toMatchObject({
      source: 'url',
      file_count: 1,
      enqueued: 1,
      files: [{ domain: 'notes', status: 'pending' }],
    });
    expect(rawDocs.puts.some((put) => put.key.startsWith('raw/notes/'))).toBe(true);
    expect(edgarImported.status).toBe(200);
    expect(await edgarImported.json()).toMatchObject({
      source: 'edgar',
      file_count: 1,
      enqueued: 1,
      files: [{ domain: 'sec', filename: expect.stringContaining('AAPL_10-K_2026-01-31') }],
      errors: [],
    });
    expect(fetches.some((call) => call.url.includes('/submissions/CIK0000320193.json'))).toBe(true);
    expect(fetches.every((call) => call.url.startsWith('data:') || call.userAgent === 'knowledgebase-test test@example.com')).toBe(true);
    expect(rawDocs.puts.some((put) =>
      put.key.startsWith('raw/sec/')
      && put.options?.customMetadata?.source === 'edgar'
      && put.options.customMetadata.form === '10-K'
      && put.options.customMetadata.ticker === 'AAPL'
    )).toBe(true);
    expect(unsupported.status).toBe(400);
    expect(await unsupported.json()).toMatchObject({ supported_sources: ['url', 'edgar'] });
  });

  it('uploads files to R2 and registers them in tenant-scoped metadata', async () => {
    const metadata = new MemoryMetadataRepository();
    const rawDocs = new FakeR2Bucket();
    const app = createApp({ makeMetadataRepository: () => metadata });
    const env = makeEnv(
      new FakeVectorize(),
      undefined as unknown as D1Database,
      undefined,
      rawDocs as unknown as R2Bucket,
    );
    const form = new FormData();
    form.set('domain', 'Manuals');
    form.set('file', new File(['hello upload'], 'guide.txt', { type: 'text/plain' }));

    const res = await app.request(
      '/v1/kb/files/upload',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer key-a' },
        body: form,
      },
      env,
    );
    const body = (await res.json()) as FileRecord;

    expect(res.status).toBe(201);
    expect(rawDocs.puts).toHaveLength(1);
    expect(rawDocs.puts[0]?.key).toMatch(/^raw\/manuals\/[a-f0-9]{64}$/);
    expect(rawDocs.puts[0]?.options?.customMetadata).toMatchObject({
      project: 'tenant-a',
      domain: 'Manuals',
      filename: 'guide.txt',
    });
    expect(body).toMatchObject({
      project: 'tenant-a',
      domain: 'Manuals',
      filename: 'guide.txt',
      mime: 'text/plain',
      bytes: 12,
      object_key: rawDocs.puts[0]?.key,
    });
  });

	  it('infers and applies a schema from arbitrary structured records', async () => {
    const metadata = new MemoryMetadataRepository();
    const app = createApp({ makeMetadataRepository: () => metadata });
    const env = makeEnv(new FakeVectorize());
    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };

    const inferred = await app.request(
      '/v1/kb/schemas/infer',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          domain: 'contracts',
          records: [
            {
              contract_id: 'c-1',
              counterparty: 'Acme',
              value: 1000,
              effective_date: '2026-01-01',
              parent_id: '',
              owner_id: '',
              related_ids: [],
            },
            {
              contract_id: 'c-2',
              counterparty: 'Beta',
              value: 2500,
              effective_date: '2026-02-01',
              parent_id: 'c-1',
              owner_id: 'c-1',
              related_ids: ['c-1'],
            },
          ],
        }),
      },
      env,
    );
    const inferredBody = (await inferred.json()) as { spec: DomainSchema; draft_id: string };
    const applied = await app.request(
      '/v1/kb/schemas',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify(inferredBody.spec),
      },
      env,
    );
    const schemas = await app.request('/v1/kb/schemas', { headers: auth }, env);

    expect(inferred.status).toBe(200);
    expect(inferredBody.draft_id).toBe('draft-1');
    expect(inferredBody.spec.entities[0]?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'contract_id', identity: true }),
        expect.objectContaining({ name: 'value', type: 'integer' }),
        expect.objectContaining({ name: 'effective_date', type: 'date' }),
        ]),
      );
    expect(inferredBody.spec.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'parent', kind: 'parent', from_type: 'ContractRecord', to_type: 'ContractRecord' }),
        expect.objectContaining({ name: 'owner', kind: 'ref', from_type: 'ContractRecord', to_type: 'ContractRecord' }),
        expect.objectContaining({ name: 'related', kind: 'ref', from_type: 'ContractRecord', to_type: 'ContractRecord' }),
      ]),
    );
    expect(applied.status).toBe(201);
	    expect(await schemas.json()).toMatchObject({
	      data: [{ project: 'tenant-a', domain: 'contracts', name: 'inferred', version: 1 }],
	    });
	  });

	  it('infers records from nested arbitrary JSON structures', async () => {
	    const metadata = new MemoryMetadataRepository();
	    const app = createApp({ makeMetadataRepository: () => metadata });
	    const env = makeEnv(new FakeVectorize());
	    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };

	    const inferred = await app.request(
	      '/v1/kb/schemas/infer',
	      {
	        method: 'POST',
	        headers: auth,
	        body: JSON.stringify({
	          domain: 'contracts',
	          input: {
	            source_system: 'crm',
	            exported_at: '2026-06-20',
	            payload: {
	              contracts: [
	                { contract_id: 'c-1', counterparty: 'Acme, Inc.', value: 1000 },
	                { contract_id: 'c-2', counterparty: 'Beta', value: 2500 },
	              ],
	            },
	          },
	        }),
	      },
	      env,
	    );
	    const inferredBody = (await inferred.json()) as { spec: DomainSchema; sample_count: number };

	    expect(inferred.status).toBe(200);
	    expect(inferredBody.sample_count).toBe(2);
	    expect(inferredBody.spec.entities[0]?.fields).toEqual(
	      expect.arrayContaining([
	        expect.objectContaining({ name: 'source_system', type: 'string' }),
	        expect.objectContaining({ name: 'contract_id', identity: true }),
	        expect.objectContaining({ name: 'counterparty', type: 'enum' }),
	        expect.objectContaining({ name: 'value', type: 'integer' }),
	      ]),
	    );
	  });

  it('infers and ingests cross-type entity relationships from prefixed fields', async () => {
    const metadata = new MemoryMetadataRepository();
    const repo = new MemoryRepository();
    const rawDocs = new FakeR2Bucket();
    const vectorize = new FakeVectorize();
    const app = createApp({
      makeMetadataRepository: () => metadata,
      makeRepository: () => repo,
      embed: async (_env, texts) => texts.map(vectorFor),
    });
    const env = makeEnv(
      vectorize,
      undefined as unknown as D1Database,
      undefined,
      rawDocs as unknown as R2Bucket,
    );
    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };

    const inferred = await app.request(
      '/v1/kb/schemas/infer',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          domain: 'orders',
          records: [
            {
              order_id: 'o-1',
              customer_id: 'cu-1',
              customer_name: 'Acme',
              product_id: 'p-1',
              product_name: 'Widget',
              total: 100,
            },
            {
              order_id: 'o-2',
              customer_id: 'cu-2',
              customer_name: 'Beta',
              product_id: 'p-2',
              product_name: 'Gadget',
              total: 200,
            },
          ],
        }),
      },
      env,
    );
    const inferredBody = (await inferred.json()) as { spec: DomainSchema };
    await app.request('/v1/kb/schemas', { method: 'POST', headers: auth, body: JSON.stringify(inferredBody.spec) }, env);

    const form = new FormData();
    form.set('domain', 'orders');
    form.set(
      'file',
      new File([
        'order_id,customer_id,customer_name,product_id,product_name,total\n'
        + 'o-1,cu-1,Acme,p-1,Widget,100\n'
        + 'o-2,cu-2,Beta,p-2,Gadget,200',
      ], 'orders.csv', { type: 'text/csv' }),
    );
    await app.request('/v1/kb/files/upload', { method: 'POST', headers: { Authorization: 'Bearer key-a' }, body: form }, env);
    const run = await app.request(
      '/v1/kb/ingest/run',
      { method: 'POST', headers: auth, body: JSON.stringify({ domain: 'orders', async: false }) },
      env,
    );
    const runBody = (await run.json()) as { files: Array<{ entities: number; relationships: number }> };
    const entities = await app.request('/v1/kb/entities?domain=orders&limit=20', { headers: auth }, env);
    const entitiesBody = (await entities.json()) as { entities: EntityRecord[] };
    const relationships = await app.request('/v1/kb/relationships?domain=orders&limit=20', { headers: auth }, env);
    const relationshipsBody = (await relationships.json()) as { relationships: EntityRelationshipRecord[] };

    expect(inferred.status).toBe(200);
    expect(inferredBody.spec.entities.map((entity) => entity.name)).toEqual([
      'OrderRecord',
      'CustomerRecord',
      'ProductRecord',
    ]);
    expect(inferredBody.spec.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'customer', from_type: 'OrderRecord', to_type: 'CustomerRecord' }),
        expect.objectContaining({ name: 'product', from_type: 'OrderRecord', to_type: 'ProductRecord' }),
      ]),
    );
    expect(run.status).toBe(200);
    expect(runBody.files[0]).toMatchObject({ entities: 6, relationships: 4 });
    expect(entitiesBody.entities.map((entity) => `${entity.type}:${entity.identity_key}`)).toEqual(
      expect.arrayContaining([
        'OrderRecord:o-1',
        'OrderRecord:o-2',
        'CustomerRecord:cu-1',
        'CustomerRecord:cu-2',
        'ProductRecord:p-1',
        'ProductRecord:p-2',
      ]),
    );
    expect(relationshipsBody.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rel_type: 'customer' }),
        expect.objectContaining({ rel_type: 'product' }),
      ]),
    );
  });

  it('backfills historical D1 entity relationships from the active schema', async () => {
    const metadata = new MemoryMetadataRepository();
    const app = createApp({ makeMetadataRepository: () => metadata });
    const env = makeEnv(new FakeVectorize());
    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };
    const schema: DomainSchema = {
      domain: 'contracts',
      name: 'manual',
      version: 1,
      description: 'manual schema',
      vocabulary: {},
      entities: [
        {
          name: 'ContractRecord',
          description: 'Contract',
          fields: [
            { name: 'contract_id', type: 'string', description: 'id', required: true, identity: true, examples: [] },
            { name: 'counterparty', type: 'string', description: 'party', required: false, identity: false, examples: [] },
            { name: 'parent_id', type: 'string', description: 'parent', required: false, identity: false, examples: [] },
          ],
          summary_field: 'counterparty',
          aliases: ['contracts'],
          graph_route: true,
          tabular: true,
        },
      ],
      relationships: [
        {
          name: 'parent',
          kind: 'parent',
          from_type: 'ContractRecord',
          to_type: 'ContractRecord',
          description: 'contract parent',
        },
      ],
    };
    await app.request('/v1/kb/schemas', { method: 'POST', headers: auth, body: JSON.stringify(schema) }, env);
    metadata.entities.set('tenant-a:contracts:ContractRecord:c-1', {
      id: 'entity-parent',
      project: 'tenant-a',
      domain: 'contracts',
      type: 'ContractRecord',
      identity_key: 'c-1',
      display_name: 'Acme, Inc.',
      fields: { contract_id: 'c-1', counterparty: 'Acme, Inc.' },
      parent_id: null,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    });
    metadata.entities.set('tenant-a:contracts:ContractRecord:c-2', {
      id: 'entity-child',
      project: 'tenant-a',
      domain: 'contracts',
      type: 'ContractRecord',
      identity_key: 'c-2',
      display_name: 'Beta',
      fields: { contract_id: 'c-2', counterparty: 'Beta', parent_id: 'acme inc' },
      parent_id: null,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    });

    const backfill = await app.request(
      '/v1/kb/relationships/backfill',
      { method: 'POST', headers: auth, body: JSON.stringify({ domain: 'contracts' }) },
      env,
    );
    const second = await app.request(
      '/v1/kb/relationships/backfill',
      { method: 'POST', headers: auth, body: JSON.stringify({ domain: 'contracts' }) },
      env,
    );
    const relationships = await app.request('/v1/kb/relationships?domain=contracts', { headers: auth }, env);

    expect(backfill.status).toBe(200);
    expect(await backfill.json()).toMatchObject({
      project: 'tenant-a',
      domain: 'contracts',
      backfilled_domains: 1,
      scanned_entities: 2,
      candidate_relationships: 1,
      relationships_inserted: 1,
      parent_links_updated: 1,
    });
    expect(await second.json()).toMatchObject({
      candidate_relationships: 1,
      relationships_inserted: 0,
      parent_links_updated: 0,
    });
    expect((await relationships.json()) as { relationships: EntityRelationshipRecord[] }).toMatchObject({
      relationships: [expect.objectContaining({
        rel_type: 'parent',
        src_id: 'entity-child',
        dst_id: 'entity-parent',
        evidence_file: null,
      })],
    });
    expect(metadata.entities.get('tenant-a:contracts:ContractRecord:c-2')?.parent_id).toBe('entity-parent');
  });

	  it('infers a schema directly from an uploaded structured file', async () => {
    const metadata = new MemoryMetadataRepository();
    const rawDocs = new FakeR2Bucket();
    const app = createApp({ makeMetadataRepository: () => metadata });
    const env = makeEnv(
      new FakeVectorize(),
      undefined as unknown as D1Database,
      undefined,
      rawDocs as unknown as R2Bucket,
    );
    const form = new FormData();
    form.set('domain', 'contracts');
	    form.set(
	      'file',
	      new File(['contract_id,counterparty,value\nc-1,"Acme, Inc.",1000\nc-2,Beta,2500'], 'contracts.csv', {
	        type: 'text/csv',
	      }),
	    );

    const res = await app.request(
      '/v1/kb/schemas/infer-upload',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer key-a' },
        body: form,
      },
      env,
    );
    const body = (await res.json()) as {
      spec: DomainSchema;
      draft_id: string;
      staged_files: FileRecord[];
    };

    expect(res.status).toBe(200);
    expect(rawDocs.puts).toHaveLength(1);
    expect(body.draft_id).toBe('draft-1');
    expect(body.staged_files[0]).toMatchObject({ filename: 'contracts.csv', domain: 'contracts' });
    expect(body.spec.entities[0]?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'contract_id', identity: true }),
        expect.objectContaining({ name: 'counterparty', type: 'enum' }),
        expect.objectContaining({ name: 'value', type: 'integer' }),
      ]),
    );
  });

  it('ingests uploaded structured files into a domain index and searches them', async () => {
    const repo = new MemoryRepository();
	    const metadata = new MemoryMetadataRepository();
	    const rawDocs = new FakeR2Bucket();
	    const vectorize = new FakeVectorize();
	    const analytics = new FakeAnalyticsDataset();
	    const app = createApp({
      makeRepository: () => repo,
      makeMetadataRepository: () => metadata,
    });
    const env = makeEnv(
      vectorize,
	      undefined as unknown as D1Database,
	      undefined,
	      rawDocs as unknown as R2Bucket,
	      undefined,
	      undefined,
	      analytics,
	    );
    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };
    const form = new FormData();
    form.set('domain', 'contracts');
    form.set(
      'file',
      new File(['contract_id,counterparty,value,parent_id,owner_id,related_id\nc-1,Acme,1000,,,\nc-2,Beta,2500,c-1,c-1,c-1'], 'contracts.csv', {
        type: 'text/csv',
      }),
    );
    const inferred = await app.request(
      '/v1/kb/schemas/infer-upload',
      { method: 'POST', headers: { Authorization: 'Bearer key-a' }, body: form },
      env,
    );
    const inferredBody = (await inferred.json()) as { spec: DomainSchema };
    await app.request(
      '/v1/kb/schemas',
      { method: 'POST', headers: auth, body: JSON.stringify(inferredBody.spec) },
      env,
    );

    const ingest = await app.request(
      '/v1/kb/ingest/run',
      { method: 'POST', headers: auth, body: JSON.stringify({ domain: 'contracts' }) },
      env,
    );
    const search = await app.request(
      '/v1/kb/search',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ domain: 'contracts', query: 'Acme contract', mode: 'lexical', top_k: 3 }),
      },
      env,
    );
    const searchBody = (await search.json()) as { data: SearchResult[] };
	    const entities = await app.request('/v1/kb/entities?domain=contracts', { headers: auth }, env);
	    const entitiesBody = (await entities.json()) as { entities: EntityRecord[] };
	    const relationships = await app.request('/v1/kb/relationships?domain=contracts', { headers: auth }, env);
	    const relationshipsBody = (await relationships.json()) as { relationships: EntityRelationshipRecord[] };
	    const entitySearch = await app.request(
      '/v1/kb/entities/search',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ domain: 'contracts', query: 'Acme', limit: 3 }),
      },
      env,
    );
    const entitySearchBody = (await entitySearch.json()) as {
      ai_used: boolean;
      route: string;
      entities: EntityRecord[];
    };
    const structuredAnswer = await app.request(
      '/v1/kb/query',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ domain: 'contracts', question: 'Acme', mode: 'auto', top_k: 3 }),
      },
      env,
    );
    const structuredAnswerBody = (await structuredAnswer.json()) as {
      ai_used: boolean;
      route: string;
      answer: string;
      citations: CitationRecord[];
      confidence: JsonRecord;
      data: SearchResult[];
    };
    const fieldedAnswer = await app.request(
      '/v1/kb/query',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ domain: 'contracts', question: 'counterparty: Acme', mode: 'auto', top_k: 3 }),
      },
      env,
    );
    const fieldedAnswerBody = (await fieldedAnswer.json()) as {
      ai_used: boolean;
      confidence: JsonRecord;
      citations: CitationRecord[];
      data: SearchResult[];
    };
    const queryEval = await app.request(
      '/v1/kb/evals/query',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
	          domain: 'contracts',
	          mode: 'auto',
	          ai_judge: true,
	          cases: [{ id: 'q1', question: 'Acme', expected_text: 'Acme' }],
	        }),
      },
      env,
    );
    const queryEvalBody = (await queryEval.json()) as {
      report_id: string;
      hit_rate: number;
      citation_rate: number;
      avg_faithfulness_score: number | null;
      avg_unsupported_answer_tokens: number;
	      ai_use_rate: number;
	      model_judge_enabled: boolean;
	      model_judged_count: number;
	      avg_model_judge_score: number | null;
	      rows: Array<{
	        route: string;
	        ai_used: boolean;
	        cited: boolean;
	        faithfulness_status: string;
	        faithfulness_score: number | null;
	        model_judged: boolean;
	        model_judge_status: string;
	        model_judge_score: number;
	        answer_token_count: number;
	        unsupported_answer_token_count: number;
	      }>;
    };
	    const evalReports = await app.request('/v1/kb/evals/reports?domain=contracts', { headers: auth }, env);
	    const evalReportsBody = (await evalReports.json()) as { reports: EvalReportRecord[] };
	    const evalSummary = await app.request('/v1/kb/evals/summary?domain=contracts', { headers: auth }, env);
	    const evalSummaryBody = (await evalSummary.json()) as {
	      report_count: number;
	      summaries: JsonRecord[];
	    };
	    const evalReport = await app.request(`/v1/kb/evals/reports/${queryEvalBody.report_id}`, { headers: auth }, env);
    const evalReportBody = (await evalReport.json()) as EvalReportRecord;
    const ingestBody = await ingest.json() as {
      files: Array<{
        job_id: string;
        parse_artifact: ParseArtifactRecord;
      }>;
    };
    const jobs = await app.request('/v1/kb/jobs?domain=contracts', { headers: auth }, env);
    const jobsBody = (await jobs.json()) as { jobs: IngestJobRecord[] };
    const artifactHash = ingestBody.files[0]?.parse_artifact.content_hash ?? '';
    const artifact = await app.request(`/v1/kb/parse-artifacts/${artifactHash}`, { headers: auth }, env);
    const artifactBody = (await artifact.json()) as ParseArtifactRecord;

    expect(ingest.status).toBe(200);
    expect(ingestBody).toMatchObject({
      project: 'tenant-a',
      domain: 'contracts',
      files: [{
        job_id: expect.any(String),
        filename: 'contracts.csv',
        status: 'ready',
        parse_artifact: expect.objectContaining({
          parser: 'worker-text-structured-v1',
          object_key: expect.stringContaining('parse/contracts/'),
        }),
	        documents_created: 2,
	        entities: 2,
	        mentions: 2,
		        relationships: 3,
		        provenance_spans: 12,
		      }],
		    });
    expect(search.status).toBe(200);
    expect(searchBody.data[0]?.chunk_content).toContain('Acme');
    expect(entities.status).toBe(200);
	    expect(entitiesBody.entities).toEqual(
	      expect.arrayContaining([
	        expect.objectContaining({
	          identity_key: 'c-1',
	          display_name: 'c-1',
          fields: expect.objectContaining({ counterparty: 'Acme' }),
	        }),
	      ]),
	    );
		    expect(relationships.status).toBe(200);
		    expect(relationshipsBody.relationships).toHaveLength(3);
		    expect(relationshipsBody.relationships).toEqual(
		      expect.arrayContaining([
		        expect.objectContaining({ rel_type: 'parent', evidence_file: expect.any(String) }),
		        expect.objectContaining({ rel_type: 'owner', evidence_file: expect.any(String) }),
		        expect.objectContaining({ rel_type: 'related', evidence_file: expect.any(String) }),
		      ]),
		    );
	    expect(entitySearch.status).toBe(200);
    expect(entitySearchBody).toMatchObject({
      ai_used: false,
      route: 'd1_entities',
      entities: [expect.objectContaining({ identity_key: 'c-1' })],
    });
    expect(structuredAnswer.status).toBe(200);
    expect(structuredAnswerBody).toMatchObject({
      ai_used: false,
      route: 'd1_entities',
		      confidence: expect.objectContaining({
		        route: 'd1_graph',
		        graph_result_count: 3,
		        verification_checked: true,
	        verification_status: 'supported',
	        citation_coverage: expect.any(Number),
	      }),
      data: expect.arrayContaining([
        expect.objectContaining({ metadata: expect.objectContaining({ identity_key: 'c-1' }) }),
        expect.objectContaining({
          metadata: expect.objectContaining({
            route: 'd1_graph',
            relationship_type: 'parent',
            source_identity_key: 'c-2',
            target_identity_key: 'c-1',
          }),
        }),
      ]),
    });
    expect(structuredAnswerBody.answer).toContain('[1]');
    expect(structuredAnswerBody.citations[0]?.metadata.route).toBe('d1_entities');
    expect(structuredAnswerBody.citations.some((citation) => citation.metadata.route === 'd1_graph')).toBe(true);
    expect(fieldedAnswer.status).toBe(200);
    expect(fieldedAnswerBody).toMatchObject({
      ai_used: false,
	      confidence: expect.objectContaining({
	        structured_filters: [expect.objectContaining({ normalized_field: 'counterparty', value: 'Acme' })],
	        verification_checked: true,
	        verification_status: 'supported',
	      }),
      data: expect.arrayContaining([
        expect.objectContaining({
          metadata: expect.objectContaining({
            route: 'd1_structured_query',
            identity_key: 'c-1',
            structured_filters: [expect.objectContaining({ normalized_field: 'counterparty' })],
          }),
        }),
      ]),
    });
    expect(fieldedAnswerBody.citations[0]?.metadata.route).toBe('d1_structured_query');
    expect(queryEval.status).toBe(200);
    expect(queryEvalBody).toMatchObject({
      report_id: 'eval-1',
      hit_rate: 1,
      citation_rate: 1,
	      ai_use_rate: 0,
	      model_judge_enabled: true,
	      model_judged_count: 1,
	      avg_model_judge_score: 0.92,
	      avg_faithfulness_score: expect.any(Number),
      avg_unsupported_answer_tokens: expect.any(Number),
      rows: [
        expect.objectContaining({
          route: 'd1_entities',
          ai_used: false,
          cited: true,
	          faithfulness_status: expect.stringMatching(/supported|partial|weak/),
	          faithfulness_score: expect.any(Number),
	          model_judged: true,
	          model_judge_status: 'supported',
	          model_judge_score: 0.92,
	          answer_token_count: expect.any(Number),
          unsupported_answer_token_count: expect.any(Number),
        }),
      ],
    });
	    expect(evalReports.status).toBe(200);
	    expect(evalReportsBody.reports[0]).toMatchObject({ id: queryEvalBody.report_id, kind: 'query' });
	    expect(evalSummary.status).toBe(200);
	    expect(evalSummaryBody).toMatchObject({
	      report_count: 1,
	      summaries: [
	        expect.objectContaining({
	          kind: 'query',
	          domain: 'contracts',
	          report_count: 1,
	          avg_hit_rate: 1,
	          avg_citation_rate: 1,
	          avg_faithfulness_score: expect.any(Number),
	          avg_unsupported_answer_tokens: expect.any(Number),
		          avg_ai_use_rate: 0,
		          avg_model_judge_score: 0.92,
		        }),
	      ],
	    });
	    expect(evalReport.status).toBe(200);
	    expect(evalReportBody).toMatchObject({
	      id: queryEvalBody.report_id,
      kind: 'query',
      summary: expect.objectContaining({
        hit_rate: 1,
        citation_rate: 1,
	        avg_faithfulness_score: expect.any(Number),
	        model_judge_enabled: true,
	        avg_model_judge_score: 0.92,
	      }),
	    });
	    expect(analytics.points).toEqual(
	      expect.arrayContaining([
	        expect.objectContaining({
	          blobs: expect.arrayContaining(['query_trace', 'tenant-a', 'contracts']),
	          doubles: expect.arrayContaining([expect.any(Number)]),
	          indexes: ['tenant-a'],
	        }),
	        expect.objectContaining({
	          blobs: expect.arrayContaining(['eval_report', 'tenant-a', 'query', 'contracts', queryEvalBody.report_id]),
	          doubles: expect.arrayContaining([1, 1, 1, 0.92]),
	          indexes: ['tenant-a'],
	        }),
	      ]),
	    );
	    expect(jobs.status).toBe(200);
    expect(jobsBody.jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: ingestBody.files[0]?.job_id, status: 'succeeded', stage: 'indexed' }),
      ]),
    );
    expect(artifact.status).toBe(200);
    expect(artifactBody).toMatchObject({
      content_hash: artifactHash,
      parser: 'worker-text-structured-v1',
    });
    expect(rawDocs.puts.some((put) => put.key.startsWith('parse/contracts/'))).toBe(true);
    expect(repo.indexes.size).toBe(1);
    expect(vectorize.vectors.size).toBeGreaterThan(0);
  });

  it('infers and ingests XLSX uploads into searchable structured rows', async () => {
    const repo = new MemoryRepository();
    const metadata = new MemoryMetadataRepository();
    const rawDocs = new FakeR2Bucket();
    const vectorize = new FakeVectorize();
    const app = createApp({
      makeRepository: () => repo,
      makeMetadataRepository: () => metadata,
    });
    const env = makeEnv(
      vectorize,
      undefined as unknown as D1Database,
      undefined,
      rawDocs as unknown as R2Bucket,
    );
    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };
    const form = new FormData();
    form.set('domain', 'contracts');
    form.set(
      'file',
      new File([xlsxFixtureBytes()], 'contracts.xlsx', {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }),
    );

    const inferred = await app.request(
      '/v1/kb/schemas/infer-upload',
      { method: 'POST', headers: { Authorization: 'Bearer key-a' }, body: form },
      env,
    );
    const inferredBody = (await inferred.json()) as { parser: string; spec: DomainSchema };
    await app.request(
      '/v1/kb/schemas',
      { method: 'POST', headers: auth, body: JSON.stringify(inferredBody.spec) },
      env,
    );
    const ingest = await app.request(
      '/v1/kb/ingest/run',
      { method: 'POST', headers: auth, body: JSON.stringify({ domain: 'contracts' }) },
      env,
    );
    const ingestBody = (await ingest.json()) as {
      files: Array<{ parse_artifact: ParseArtifactRecord; documents_created: number; entities: number }>;
    };
    const search = await app.request(
      '/v1/kb/search',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ domain: 'contracts', query: 'Gamma contract', mode: 'lexical', top_k: 3 }),
      },
      env,
    );
    const searchBody = (await search.json()) as { data: SearchResult[] };

    expect(inferred.status).toBe(200);
    expect(inferredBody.parser).toBe('worker-xlsx-xml-v1');
    expect(ingest.status).toBe(200);
    expect(ingestBody.files[0]).toMatchObject({
      parse_artifact: expect.objectContaining({ parser: 'worker-xlsx-xml-v1' }),
      documents_created: 2,
      entities: 1,
    });
    expect(search.status).toBe(200);
    expect(searchBody.data[0]?.chunk_content).toContain('Gamma');
  });

  it('ingests DOCX uploads into searchable domain chunks', async () => {
    const repo = new MemoryRepository();
    const metadata = new MemoryMetadataRepository();
    const rawDocs = new FakeR2Bucket();
    const vectorize = new FakeVectorize();
    const app = createApp({
      makeRepository: () => repo,
      makeMetadataRepository: () => metadata,
    });
    const env = makeEnv(
      vectorize,
      undefined as unknown as D1Database,
      undefined,
      rawDocs as unknown as R2Bucket,
    );
    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };
    const form = new FormData();
    form.set('domain', 'manuals');
    form.set(
      'file',
      new File([docxFixtureBytes()], 'runbook.docx', {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    );

    const uploaded = await app.request(
      '/v1/kb/files/upload',
      { method: 'POST', headers: { Authorization: 'Bearer key-a' }, body: form },
      env,
    );
    const ingest = await app.request(
      '/v1/kb/ingest/run',
      { method: 'POST', headers: auth, body: JSON.stringify({ domain: 'manuals', async: false }) },
      env,
    );
    const ingestBody = (await ingest.json()) as {
      files: Array<{ parse_artifact: ParseArtifactRecord; documents_created: number }>;
    };
    const search = await app.request(
      '/v1/kb/search',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ domain: 'manuals', query: 'Vectorize evidence', mode: 'lexical', top_k: 3 }),
      },
      env,
    );
    const searchBody = (await search.json()) as { data: SearchResult[] };

    expect(uploaded.status).toBe(201);
    expect(ingest.status).toBe(200);
    expect(ingestBody.files[0]).toMatchObject({
      parse_artifact: expect.objectContaining({ parser: 'worker-docx-xml-v1' }),
      documents_created: 2,
    });
    expect(search.status).toBe(200);
    expect(searchBody.data[0]?.chunk_content).toContain('Vectorize evidence');
  });

  it('ingests digital PDF table layout into searchable artifacts', async () => {
    const repo = new MemoryRepository();
    const metadata = new MemoryMetadataRepository();
    const rawDocs = new FakeR2Bucket();
    const vectorize = new FakeVectorize();
    const app = createApp({
      makeRepository: () => repo,
      makeMetadataRepository: () => metadata,
    });
    const env = makeEnv(
      vectorize,
      undefined as unknown as D1Database,
      undefined,
      rawDocs as unknown as R2Bucket,
    );
    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };
    const form = new FormData();
    form.set('domain', 'filings');
    form.set('file', new File([pdfTableFixtureBytes()], 'metrics.pdf', { type: 'application/pdf' }));

    const uploaded = await app.request(
      '/v1/kb/files/upload',
      { method: 'POST', headers: { Authorization: 'Bearer key-a' }, body: form },
      env,
    );
    const ingest = await app.request(
      '/v1/kb/ingest/run',
      { method: 'POST', headers: auth, body: JSON.stringify({ domain: 'filings', async: false }) },
      env,
    );
    const ingestBody = (await ingest.json()) as {
      files: Array<{ parse_artifact: ParseArtifactRecord; documents_created: number }>;
    };
    const artifact = ingestBody.files[0]?.parse_artifact;
    const artifactObject = artifact ? await rawDocs.get(artifact.object_key) : null;
    const artifactJson = artifactObject
      ? JSON.parse(new TextDecoder().decode(await artifactObject.arrayBuffer())) as {
          parser: string;
          record_count: number;
          documents: Array<{ content: string; metadata: JsonRecord }>;
        }
      : null;
    const search = await app.request(
      '/v1/kb/search',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ domain: 'filings', query: 'Revenue 1000', mode: 'lexical', top_k: 3 }),
      },
      env,
    );
    const searchBody = (await search.json()) as { data: SearchResult[] };

    expect(uploaded.status).toBe(201);
    expect(ingest.status).toBe(200);
    expect(ingestBody.files[0]).toMatchObject({
      parse_artifact: expect.objectContaining({ parser: 'worker-pdf-layout-v2' }),
      documents_created: 2,
    });
    expect(artifactJson).toMatchObject({
      parser: 'worker-pdf-layout-v2',
      record_count: 1,
      documents: expect.arrayContaining([
        expect.objectContaining({
          content: expect.stringContaining('| Revenue | 1000 |'),
          metadata: expect.objectContaining({ parser_table: true }),
        }),
      ]),
    });
    expect(search.status).toBe(200);
    expect(searchBody.data[0]?.chunk_content).toContain('Revenue');
    expect(searchBody.data[0]?.chunk_content).toContain('1000');
  });

  it('manages domain source sets with dry-run and bulk delete cleanup', async () => {
    const repo = new MemoryRepository();
    const metadata = new MemoryMetadataRepository();
    const rawDocs = new FakeR2Bucket();
    const vectorize = new FakeVectorize();
    const vectorizeSmall = new FakeVectorize();
    const app = createApp({
      makeRepository: () => repo,
      makeMetadataRepository: () => metadata,
    });
    const env = makeEnv(
      vectorize,
      undefined as unknown as D1Database,
      vectorizeSmall,
      rawDocs as unknown as R2Bucket,
    );
    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };
    const form = new FormData();
    form.set('domain', 'contracts');
    form.set(
      'file',
      new File(['contract_id,counterparty,value\nc-1,Acme,1000'], 'contracts.csv', {
        type: 'text/csv',
      }),
    );
    const inferred = await app.request(
      '/v1/kb/schemas/infer-upload',
      { method: 'POST', headers: { Authorization: 'Bearer key-a' }, body: form },
      env,
    );
    const inferredBody = (await inferred.json()) as { spec: DomainSchema };
    await app.request(
      '/v1/kb/schemas',
      { method: 'POST', headers: auth, body: JSON.stringify(inferredBody.spec) },
      env,
    );
    await app.request(
      '/v1/kb/ingest/run',
      { method: 'POST', headers: auth, body: JSON.stringify({ domain: 'contracts' }) },
      env,
    );

    const sourceSets = await app.request('/v1/kb/source-sets?domain=contracts', { headers: auth }, env);
    const sourceSetsBody = (await sourceSets.json()) as {
      source_sets: Array<{ id: string; file_count: number; by_status: Record<string, number> }>;
    };
    const dryRun = await app.request(
      '/v1/kb/source-sets/domain:contracts/actions',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ action: 'delete_ready', dry_run: true }),
      },
      env,
    );
    const dryRunBody = (await dryRun.json()) as { dry_run: boolean; affected_files: number };
    const deleted = await app.request(
      '/v1/kb/source-sets/domain:contracts/actions',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ action: 'delete_ready' }),
      },
      env,
    );
    const deletedBody = (await deleted.json()) as { affected_files: number; deleted_vectors: number };
    const emptySourceSets = await app.request('/v1/kb/source-sets?domain=contracts', { headers: auth }, env);
    const emptySourceSetsBody = (await emptySourceSets.json()) as { source_sets: unknown[] };

    expect(sourceSets.status).toBe(200);
    expect(sourceSetsBody.source_sets[0]).toMatchObject({
      id: 'domain:contracts',
      file_count: 1,
      by_status: { ready: 1 },
    });
    expect(dryRun.status).toBe(200);
    expect(dryRunBody).toMatchObject({ dry_run: true, affected_files: 1 });
    expect(deleted.status).toBe(200);
    expect(deletedBody).toMatchObject({ affected_files: 1 });
    expect(deletedBody.deleted_vectors).toBeGreaterThan(0);
    expect(vectorize.deleted.length).toBeGreaterThan(0);
    expect(vectorizeSmall.deleted.length).toBeGreaterThan(0);
    expect(rawDocs.deletes.some((key) => key.startsWith('raw/contracts/'))).toBe(true);
    expect(rawDocs.deletes.some((key) => key.startsWith('parse/contracts/'))).toBe(true);
    expect(emptySourceSetsBody.source_sets).toEqual([]);
  });

	  it('queues ingestion and processes Cloudflare Queue messages', async () => {
    const repo = new MemoryRepository();
    const metadata = new MemoryMetadataRepository();
    const rawDocs = new FakeR2Bucket();
    const vectorize = new FakeVectorize();
    const queue = new FakeQueue();
    const options = {
      makeRepository: () => repo,
      makeMetadataRepository: () => metadata,
    };
    const app = createApp(options);
    const worker = createWorker(options);
    const env = makeEnv(
      vectorize,
      undefined as unknown as D1Database,
      undefined,
      rawDocs as unknown as R2Bucket,
      queue,
    );
    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };
    const form = new FormData();
    form.set('domain', 'contracts');
    form.set(
      'file',
      new File(['contract_id,counterparty,value\nc-1,Acme,1000'], 'contracts.csv', {
        type: 'text/csv',
      }),
    );
    const inferred = await app.request(
      '/v1/kb/schemas/infer-upload',
      { method: 'POST', headers: { Authorization: 'Bearer key-a' }, body: form },
      env,
    );
    const inferredBody = (await inferred.json()) as { spec: DomainSchema };
    await app.request(
      '/v1/kb/schemas',
      { method: 'POST', headers: auth, body: JSON.stringify(inferredBody.spec) },
      env,
    );

	    const queued = await app.request(
	      '/v1/kb/ingest/run',
	      {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({
            domain: 'contracts',
            run_id: 'run-queued-1',
            markdown_conversion: 'off',
            vision_ocr_model: '@cf/test/vision',
          }),
        },
	      env,
	    );
	    const queuedBody = (await queued.json()) as {
	      run_id: string;
	      ingestion_mode: string;
	      queued: boolean;
	      jobs: IngestJobRecord[];
	    };
	    const queuedRun = await app.request(
	      '/v1/kb/ingest/runs/run-queued-1?domain=contracts',
	      { headers: auth },
	      env,
	    );
	    const queuedRunBody = (await queuedRun.json()) as {
	      summary: { state: string; total_jobs: number; active_jobs: number; done: boolean };
	    };
    const acked: string[] = [];
    const retried: string[] = [];
    const message = {
      id: 'msg-1',
      timestamp: new Date(0),
      attempts: 1,
      body: queue.sent[0],
      ack: () => { acked.push('msg-1'); },
      retry: () => { retried.push('msg-1'); },
    } as Message<KbIngestQueueMessage>;
    await worker.queue({
      messages: [message],
      queue: 'knowledgebase-ingest',
      metadata: { metrics: { backlogCount: 1, backlogBytes: 0 } },
      ackAll: () => undefined,
      retryAll: () => undefined,
    } as MessageBatch<KbIngestQueueMessage>, env);
    const completedRun = await app.request(
      '/v1/kb/ingest/runs/run-queued-1?domain=contracts',
      { headers: auth },
      env,
    );
    const completedRunBody = (await completedRun.json()) as {
      summary: { state: string; total_jobs: number; succeeded_jobs: number; done: boolean };
    };
    const jobs = await metadata.listIngestJobs('tenant-a', 'contracts');
    const files = await metadata.listFiles('tenant-a', 'contracts');

	    expect(queued.status).toBe(202);
	    expect(queuedBody.run_id).toBe('run-queued-1');
	    expect(queuedBody.ingestion_mode).toBe('queued');
	    expect(queuedBody.queued).toBe(true);
	    expect(queuedBody.jobs[0]).toMatchObject({ status: 'queued', stage: 'parse', workflow_id: 'run-queued-1' });
	    expect(queuedRun.status).toBe(200);
	    expect(queuedRunBody.summary).toMatchObject({
	      state: 'running',
	      total_jobs: 1,
	      active_jobs: 1,
	      done: false,
	    });
	    expect(queue.sent).toEqual([
	      expect.objectContaining({
	        kind: 'kb_ingest',
	        project: 'tenant-a',
	        domain: 'contracts',
	        run_id: 'run-queued-1',
	        markdown_conversion: 'off',
	        vision_ocr_model: '@cf/test/vision',
	      }),
	    ]);
    expect(acked).toEqual(['msg-1']);
    expect(retried).toEqual([]);
    expect(files[0]).toMatchObject({ status: 'ready' });
	    expect(jobs).toEqual(
	      expect.arrayContaining([
	        expect.objectContaining({ status: 'succeeded', stage: 'indexed', workflow_id: 'run-queued-1' }),
	      ]),
	    );
    expect(completedRun.status).toBe(200);
    expect(completedRunBody.summary).toMatchObject({
      state: 'succeeded',
      total_jobs: 1,
      succeeded_jobs: 1,
      done: true,
    });
	    expect(rawDocs.puts.some((put) => put.key.startsWith('parse/contracts/'))).toBe(true);
	    expect(vectorize.vectors.size).toBeGreaterThan(0);
	  });

  it('rejects queued knowledgebase ingestion before enqueue when the configured free-ai default model is not live', async () => {
    const repo = new MemoryRepository();
    const metadata = new MemoryMetadataRepository();
    const rawDocs = new FakeR2Bucket();
    const vectorize = new FakeVectorize();
    const queue = new FakeQueue();
    const app = createApp({
      makeRepository: () => repo,
      makeMetadataRepository: () => metadata,
    });
    const env = makeEnv(
      vectorize,
      undefined as unknown as D1Database,
      undefined,
      rawDocs as unknown as R2Bucket,
      queue,
    );
    configureStaleFreeAiDefault(env);
    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };
    await metadata.registerFile({
      id: 'file-stale-queued',
      project: 'tenant-a',
      domain: 'queued-stale-freeai',
      filename: 'queued.txt',
      mime: 'text/plain',
      bytes: 20,
      contentHash: 'sha256-stale-queued',
      objectKey: 'raw/queued-stale-freeai/sha256-stale-queued',
    });
    const jobsBeforeRun = await metadata.listIngestJobs('tenant-a', 'queued-stale-freeai');

    const queued = await app.request(
      '/v1/kb/ingest/run',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ domain: 'queued-stale-freeai', run_id: 'run-stale-freeai' }),
      },
      env,
    );

    expect(queued.status).toBe(400);
    expect(await queued.json()).toMatchObject({
      error: 'configured base embedding model is not available in free-ai: gemini-embedding-001',
    });
    expect(queue.sent).toEqual([]);
    expect(await metadata.listIngestJobs('tenant-a', 'queued-stale-freeai')).toEqual(jobsBeforeRun);
    expect(jobsBeforeRun).toEqual([]);
    expect(repo.indexes.size).toBe(0);
    expect(vectorize.vectors.size).toBe(0);
  });

  it('rejects new knowledgebase staging before writes when the configured free-ai default model is not live', async () => {
    const repo = new MemoryRepository();
    const metadata = new MemoryMetadataRepository();
    const rawDocs = new FakeR2Bucket();
    const app = createApp({
      makeRepository: () => repo,
      makeMetadataRepository: () => metadata,
    });
    const env = makeEnv(
      new FakeVectorize(),
      undefined as unknown as D1Database,
      undefined,
      rawDocs as unknown as R2Bucket,
    );
    configureStaleFreeAiDefault(env);
    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };

    const registered = await app.request(
      '/v1/kb/files',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          domain: 'stale-stage',
          filename: 'guide.txt',
          mime: 'text/plain',
          bytes: 12,
          content_hash: 'sha256-stale-stage',
          object_key: 'raw/stale-stage/sha256-stale-stage',
        }),
      },
      env,
    );
    const uploadForm = new FormData();
    uploadForm.set('domain', 'stale-stage');
    uploadForm.set('file', new File(['hello upload'], 'guide.txt', { type: 'text/plain' }));
    const uploaded = await app.request(
      '/v1/kb/files/upload',
      { method: 'POST', headers: { Authorization: 'Bearer key-a' }, body: uploadForm },
      env,
    );
    const inferForm = new FormData();
    inferForm.set('domain', 'stale-stage');
    inferForm.set('file', new File(['id,name\n1,Acme'], 'rows.csv', { type: 'text/csv' }));
    const inferredUpload = await app.request(
      '/v1/kb/schemas/infer-upload',
      { method: 'POST', headers: { Authorization: 'Bearer key-a' }, body: inferForm },
      env,
    );
    const asyncText = await app.request(
      '/v1/kb/ingest/text',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          domain: 'stale-stage',
          title: 'async-note',
          text: 'Async text should not stage when embeddings are stale.',
          async: true,
        }),
      },
      env,
    );
    const autoImport = await app.request(
      '/v1/kb/sources/import',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          domain: 'stale-stage',
          source: 'url',
          config: { urls: ['data:text/plain,hello'] },
        }),
      },
      env,
    );

    for (const response of [registered, uploaded, inferredUpload, asyncText, autoImport]) {
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: 'configured base embedding model is not available in free-ai: gemini-embedding-001',
      });
    }
    expect(rawDocs.puts).toEqual([]);
    expect(await metadata.listFiles('tenant-a', 'stale-stage')).toEqual([]);
    expect(await metadata.listIngestJobs('tenant-a', 'stale-stage')).toEqual([]);
    expect(repo.indexes.size).toBe(0);

    const importOnly = await app.request(
      '/v1/kb/sources/import',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          domain: 'stale-stage',
          source: 'url',
          auto_ingest: false,
          config: { urls: ['data:text/plain,hello'] },
        }),
      },
      env,
    );
    expect(importOnly.status).toBe(200);
    expect(await importOnly.json()).toMatchObject({ file_count: 1, enqueued: 0 });
    expect(rawDocs.puts).toHaveLength(1);
    expect(await metadata.listIngestJobs('tenant-a', 'stale-stage')).toEqual([]);
  });

  it('rejects knowledgebase reprocess and requeue before mutation when free-ai readiness fails', async () => {
    const repo = new MemoryRepository();
    const metadata = new MemoryMetadataRepository();
    const app = createApp({
      makeRepository: () => repo,
      makeMetadataRepository: () => metadata,
    });
    const env = makeEnv(new FakeVectorize());
    configureStaleFreeAiDefault(env);
    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };
    const file = await metadata.registerFile({
      id: 'file-stale-reprocess',
      project: 'tenant-a',
      domain: 'stale-reprocess',
      filename: 'guide.txt',
      mime: 'text/plain',
      bytes: 12,
      contentHash: 'sha256-stale-reprocess',
      objectKey: 'raw/stale-reprocess/sha256-stale-reprocess',
    });
    await metadata.setFileStatus('tenant-a', file.id, 'ready');
    await metadata.insertSchema('tenant-a', 'stale-reprocess', 'default', {
      domain: 'stale-reprocess',
      name: 'default',
      version: 1,
      description: '',
      vocabulary: {},
      entities: [{
        name: 'Guide',
        description: '',
        fields: [],
        summary_field: null,
        aliases: [],
        graph_route: false,
        tabular: false,
      }],
      relationships: [],
    });
    const filesBefore = await metadata.listFiles('tenant-a', 'stale-reprocess');

    const schemaReprocess = await app.request(
      '/v1/kb/schemas/stale-reprocess/reprocess',
      { method: 'POST', headers: auth },
      env,
    );
    const fileReprocess = await app.request(
      `/v1/kb/files/${file.id}/reprocess`,
      { method: 'POST', headers: auth },
      env,
    );
    const sourceRequeue = await app.request(
      '/v1/kb/source-sets/domain:stale-reprocess/actions',
      { method: 'POST', headers: auth, body: JSON.stringify({ action: 'requeue_all' }) },
      env,
    );

    for (const response of [schemaReprocess, fileReprocess, sourceRequeue]) {
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: 'configured base embedding model is not available in free-ai: gemini-embedding-001',
      });
    }
    expect(await metadata.listFiles('tenant-a', 'stale-reprocess')).toEqual(filesBefore);
    expect(await metadata.listIngestJobs('tenant-a', 'stale-reprocess')).toEqual([]);
    expect(repo.indexes.size).toBe(0);
  });

  it('rejects knowledgebase scheduling when an existing stored free-ai index model is no longer live', async () => {
    const repo = new MemoryRepository();
    const metadata = new MemoryMetadataRepository();
    const rawDocs = new FakeR2Bucket();
    const vectorize1024 = new FakeVectorize();
    const app = createApp({
      makeRepository: () => repo,
      makeMetadataRepository: () => metadata,
    });
    const env = makeEnv(
      new FakeVectorize(),
      undefined as unknown as D1Database,
      undefined,
      rawDocs as unknown as R2Bucket,
    );
    env.VECTORIZE_1024 = vectorize1024;
    configureStaleFreeAiDefault(env);
    await repo.createIndex({
      id: 'idx-existing-stale',
      tenant: 'tenant-a',
      name: 'Knowledgebase existing-stale',
      externalId: 'kb:existing-stale',
      dimensions: 1024,
      embeddingModel: 'retired-embedding-model',
      embeddingProvider: 'gemini',
    });
    const form = new FormData();
    form.set('domain', 'existing-stale');
    form.set('file', new File(['existing stale model'], 'guide.txt', { type: 'text/plain' }));

    const uploaded = await app.request(
      '/v1/kb/files/upload',
      { method: 'POST', headers: { Authorization: 'Bearer key-a' }, body: form },
      env,
    );

    expect(uploaded.status).toBe(400);
    expect(await uploaded.json()).toMatchObject({
      error: 'embedding model is not available in free-ai: retired-embedding-model',
    });
    expect(rawDocs.puts).toEqual([]);
    expect(await metadata.listFiles('tenant-a', 'existing-stale')).toEqual([]);
    expect(vectorize1024.vectors.size).toBe(0);
  });

  it('orchestrates queued ingestion through a Cloudflare Workflow binding when configured', async () => {
    const repo = new MemoryRepository();
    const metadata = new MemoryMetadataRepository();
    const rawDocs = new FakeR2Bucket();
    const vectorize = new FakeVectorize();
    const queue = new FakeQueue();
    const workflow = new FakeWorkflow();
    const app = createApp({
      makeRepository: () => repo,
      makeMetadataRepository: () => metadata,
    });
    const env = makeEnv(
      vectorize,
      undefined as unknown as D1Database,
      undefined,
      rawDocs as unknown as R2Bucket,
      queue,
      workflow as unknown as Workflow<KbIngestQueueMessage>,
    );
    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };
    const form = new FormData();
    form.set('domain', 'contracts');
    form.set('file', new File(['contract_id,counterparty\nc-1,Acme'], 'contracts.csv', { type: 'text/csv' }));
    await app.request(
      '/v1/kb/files/upload',
      { method: 'POST', headers: { Authorization: 'Bearer key-a' }, body: form },
      env,
    );

    const queued = await app.request(
      '/v1/kb/ingest/run',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          domain: 'contracts',
          run_id: 'run-workflow-1',
          markdown_conversion: 'always',
          vision_ocr_model: '@cf/test/vision',
        }),
      },
      env,
    );
    const queuedBody = (await queued.json()) as {
      run_id: string;
      ingestion_mode: string;
      orchestration: string;
      workflow: { id: string };
      jobs: IngestJobRecord[];
    };
    const run = await app.request(
      '/v1/kb/ingest/runs/run-workflow-1?domain=contracts',
      { headers: auth },
      env,
    );
    const runBody = (await run.json()) as {
      workflow: { id: string; status: string };
      summary: { state: string; active_jobs: number };
    };

    expect(queued.status).toBe(202);
    expect(queuedBody).toMatchObject({
      run_id: 'run-workflow-1',
      ingestion_mode: 'queued',
      orchestration: 'workflow',
      workflow: { id: 'run-workflow-1' },
    });
    expect(queuedBody.jobs[0]).toMatchObject({
      status: 'queued',
      stage: 'parse',
      queue_message_id: 'cloudflare-workflow',
      workflow_id: 'run-workflow-1',
    });
    expect(workflow.created).toEqual([
      expect.objectContaining({
        id: 'run-workflow-1',
        params: expect.objectContaining({
          kind: 'kb_ingest',
          project: 'tenant-a',
          domain: 'contracts',
          run_id: 'run-workflow-1',
          markdown_conversion: 'always',
          vision_ocr_model: '@cf/test/vision',
        }),
      }),
    ]);
    expect(queue.sent).toHaveLength(0);
    expect(run.status).toBe(200);
    expect(runBody.workflow).toMatchObject({ id: 'run-workflow-1', status: 'running' });
    expect(runBody.summary).toMatchObject({ state: 'running', active_jobs: 1 });
  });

  it('allows explicit inline ingestion override when a Queue binding exists', async () => {
    const repo = new MemoryRepository();
    const metadata = new MemoryMetadataRepository();
    const rawDocs = new FakeR2Bucket();
    const vectorize = new FakeVectorize();
    const queue = new FakeQueue();
    const app = createApp({
      makeRepository: () => repo,
      makeMetadataRepository: () => metadata,
    });
    const env = makeEnv(
      vectorize,
      undefined as unknown as D1Database,
      undefined,
      rawDocs as unknown as R2Bucket,
      queue,
    );
    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };
    const form = new FormData();
    form.set('domain', 'contracts');
    form.set('file', new File(['contract_id,counterparty\nc-1,Acme'], 'contracts.csv', { type: 'text/csv' }));
    await app.request(
      '/v1/kb/files/upload',
      { method: 'POST', headers: { Authorization: 'Bearer key-a' }, body: form },
      env,
    );

    const inline = await app.request(
      '/v1/kb/ingest/run',
      { method: 'POST', headers: auth, body: JSON.stringify({ domain: 'contracts', async: false, run_id: 'run-inline-1' }) },
      env,
    );
    const inlineBody = (await inline.json()) as {
      run_id: string;
      ingestion_mode: string;
      queued: boolean;
      files: Array<{ status: string }>;
    };

    expect(inline.status).toBe(200);
    expect(inlineBody).toMatchObject({
      run_id: 'run-inline-1',
      ingestion_mode: 'inline',
      queued: false,
    });
    expect(inlineBody.files[0]?.status).toBe('ready');
    expect(queue.sent).toHaveLength(0);
    expect(vectorize.vectors.size).toBeGreaterThan(0);
  });

  it('uses per-request parser options for inline image ingestion without Worker env changes', async () => {
    const repo = new MemoryRepository();
    const metadata = new MemoryMetadataRepository();
    const rawDocs = new FakeR2Bucket();
    const vectorize = new FakeVectorize();
    const app = createApp({
      makeRepository: () => repo,
      makeMetadataRepository: () => metadata,
    });
    const env = makeEnv(
      vectorize,
      undefined as unknown as D1Database,
      undefined,
      rawDocs as unknown as R2Bucket,
    );
    const seenVisionModels: string[] = [];
    (env.AI as unknown as {
      run: (model: string, input: { image?: number[]; text?: string[] }) => Promise<unknown>;
      toMarkdown: () => Promise<unknown>;
    }).run = async (model, input) => {
      if (Array.isArray(input.image)) {
        seenVisionModels.push(model);
        return { response: 'Per-request OCR receipt total 100' };
      }
      if (Array.isArray(input.text)) {
        return { data: input.text.map((text) => vectorFor(text)) };
      }
      return { response: '{}' };
    };
    (env.AI as unknown as { toMarkdown: () => Promise<unknown> }).toMarkdown = async () => {
      throw new Error('Markdown Conversion should be disabled by request');
    };
    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };
    const form = new FormData();
    form.set('domain', 'receipts');
    form.set('file', new File(['not really a png'], 'receipt.png', { type: 'image/png' }));
    await app.request(
      '/v1/kb/files/upload',
      { method: 'POST', headers: { Authorization: 'Bearer key-a' }, body: form },
      env,
    );

    const inline = await app.request(
      '/v1/kb/ingest/run',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          domain: 'receipts',
          async: false,
          markdown_conversion: 'off',
          vision_ocr_model: '@cf/test/vision',
        }),
      },
      env,
    );
    const inlineBody = (await inline.json()) as {
      files: Array<{ status: string; parse_artifact: ParseArtifactRecord }>;
    };

    expect(inline.status).toBe(200);
    expect(seenVisionModels).toEqual(['@cf/test/vision']);
    expect(inlineBody.files[0]).toMatchObject({
      status: 'ready',
      parse_artifact: expect.objectContaining({ parser: 'workers-ai-vision-ocr-v1' }),
    });
  });

  it('answers domain questions with citations and persists query traces', async () => {
    const repo = new MemoryRepository();
    const metadata = new MemoryMetadataRepository();
    const rawDocs = new FakeR2Bucket();
    const vectorize = new FakeVectorize();
    const app = createApp({
      makeRepository: () => repo,
      makeMetadataRepository: () => metadata,
    });
    const env = makeEnv(
      vectorize,
      undefined as unknown as D1Database,
      undefined,
      rawDocs as unknown as R2Bucket,
    );
    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };
    const form = new FormData();
    form.set('domain', 'contracts');
    form.set(
      'file',
      new File(['contract_id,counterparty,value\nc-1,Acme,1000\nc-2,Beta,2500'], 'contracts.csv', {
        type: 'text/csv',
      }),
    );
    await app.request(
      '/v1/kb/schemas/infer-upload',
      { method: 'POST', headers: { Authorization: 'Bearer key-a' }, body: form },
      env,
    );
	    await app.request(
	      '/v1/kb/ingest/run',
	      { method: 'POST', headers: auth, body: JSON.stringify({ domain: 'contracts' }) },
	      env,
	    );
	    const createdSession = await app.request(
	      '/v1/kb/sessions',
	      { method: 'POST', headers: auth, body: JSON.stringify({ domain: 'contracts', id: 'session-1' }) },
	      env,
	    );

	    const answer = await app.request(
	      '/v1/kb/query',
	      {
	        method: 'POST',
	        headers: auth,
	        body: JSON.stringify({
	          domain: 'contracts',
	          question: 'Which contract mentions Acme?',
	          mode: 'lexical',
	          session_id: 'session-1',
	        }),
	      },
	      env,
	    );
	    const secondAnswer = await app.request(
	      '/v1/kb/query',
	      {
	        method: 'POST',
	        headers: auth,
	        body: JSON.stringify({
	          domain: 'contracts',
	          question: 'Which contract mentions Beta?',
	          mode: 'lexical',
	          session_id: 'session-1',
	        }),
	      },
	      env,
	    );
	    const createdSessionBody = (await createdSession.json()) as SessionRecord;
	    const answerBody = (await answer.json()) as {
	      trace_id: string;
	      session_id: string | null;
	      answer: string;
	      citations: CitationRecord[];
	      confidence: JsonRecord;
	    };
	    const secondAnswerBody = (await secondAnswer.json()) as { trace_id: string };
	    const traces = await app.request('/v1/kb/query/traces?domain=contracts', { headers: auth }, env);
	    const tracesBody = (await traces.json()) as { traces: QueryTraceRecord[] };
    const trace = await app.request(`/v1/kb/query/trace/${answerBody.trace_id}`, { headers: auth }, env);
    const traceBody = (await trace.json()) as QueryTraceRecord;
    const traceDrilldown = await app.request(
      `/v1/kb/query/trace/${answerBody.trace_id}/drilldown`,
      { headers: auth },
      env,
    );
    const traceDrilldownBody = (await traceDrilldown.json()) as {
      trace_id: string;
      quality: {
        status: string;
        answer_token_count: number;
        citation_count: number;
        citation_coverage: number | null;
        citations: Array<{ chunk_id: string; answer_token_overlap_count: number }>;
      };
    };
    const traceExport = await app.request('/v1/kb/query/traces/export?domain=contracts', { headers: auth }, env);
    const traceExportBody = (await traceExport.json()) as {
      summary: { trace_count: number; citation_count: number };
      traces: QueryTraceRecord[];
	    };
	    const traceCompare = await app.request(
	      '/v1/kb/query/traces/compare',
	      {
	        method: 'POST',
	        headers: auth,
	        body: JSON.stringify({ trace_ids: [answerBody.trace_id, secondAnswerBody.trace_id] }),
	      },
	      env,
	    );
	    const traceCompareBody = (await traceCompare.json()) as {
	      comparison: {
	        baseline_trace_id: string;
	        candidate_trace_id: string;
	        same_question: boolean;
	        retrieved: { baseline_count: number; candidate_count: number };
	      };
	    };
	    const sessions = await app.request('/v1/kb/sessions?domain=contracts', { headers: auth }, env);
	    const sessionsBody = (await sessions.json()) as { sessions: SessionRecord[] };
	    const session = await app.request('/v1/kb/sessions/session-1', { headers: auth }, env);
	    const sessionBody = (await session.json()) as SessionRecord;

	    expect(createdSession.status).toBe(201);
	    expect(createdSessionBody.id).toBe('session-1');
	    expect(answer.status).toBe(200);
	    expect(answerBody.session_id).toBe('session-1');
	    expect(answerBody.answer).toContain('[1]');
	    expect(answerBody.citations[0]).toMatchObject({
	      index: 1,
	      filename: 'contracts.csv',
	    });
    expect(answerBody.citations[0]?.excerpt).toContain('Acme');
    expect(answerBody.citations[0]?.span_terms).toContain('acme');
    expect(answerBody.citations[0]?.metadata.citation_span_strategy).toBe('question_token_sentence');
    expect(answerBody.confidence.result_count).toBeGreaterThan(0);
    expect(answerBody.confidence).toMatchObject({
      verification_checked: true,
      verification_status: 'supported',
      verification_method: 'deterministic_answer_evidence_token_overlap',
      citation_coverage: 1,
    });
		    expect(traces.status).toBe(200);
		    expect(tracesBody.traces[0]?.id).toBe(answerBody.trace_id);
		    expect(trace.status).toBe(200);
		    expect(traceBody.answer).toBe(answerBody.answer);
		    expect(traceBody.citations[0]?.chunk_id).toBe(answerBody.citations[0]?.chunk_id);
    expect(traceBody.confidence).toMatchObject({
      verification_checked: true,
      verification_status: 'supported',
    });
	    expect(traceDrilldown.status).toBe(200);
	    expect(traceDrilldownBody.trace_id).toBe(answerBody.trace_id);
	    expect(['supported', 'partial']).toContain(traceDrilldownBody.quality.status);
	    expect(traceDrilldownBody.quality.answer_token_count).toBeGreaterThan(0);
	    expect(traceDrilldownBody.quality.citation_count).toBeGreaterThan(0);
	    expect(traceDrilldownBody.quality.citation_coverage).toBeGreaterThan(0);
	    expect(traceDrilldownBody.quality.citations[0]?.chunk_id).toBe(answerBody.citations[0]?.chunk_id);
	    expect(traceDrilldownBody.quality.citations[0]?.answer_token_overlap_count).toBeGreaterThan(0);
	    expect(traceExport.status).toBe(200);
	    expect(traceExportBody.summary.trace_count).toBe(2);
	    expect(traceExportBody.summary.citation_count).toBeGreaterThan(0);
	    expect(traceCompare.status).toBe(200);
	    expect(traceCompareBody.comparison).toMatchObject({
	      baseline_trace_id: answerBody.trace_id,
	      candidate_trace_id: secondAnswerBody.trace_id,
	      same_question: false,
	    });
	    expect(traceCompareBody.comparison.retrieved.baseline_count).toBeGreaterThan(0);
	    expect(sessions.status).toBe(200);
	    expect(sessionsBody.sessions[0]?.id).toBe('session-1');
	    expect(session.status).toBe(200);
	    expect(sessionBody.history).toHaveLength(4);
	    expect(sessionBody.history[0]).toMatchObject({ role: 'user', trace_id: answerBody.trace_id });
	    expect(sessionBody.history[1]).toMatchObject({ role: 'assistant', trace_id: answerBody.trace_id });
	  });

  it('can synthesize cited domain answers with Workers AI', async () => {
    const repo = new MemoryRepository();
    const metadata = new MemoryMetadataRepository();
    const vectorize = new FakeVectorize();
    const app = createApp({
      makeRepository: () => repo,
      makeMetadataRepository: () => metadata,
      embed: async (_env, texts) => texts.map(vectorFor),
    });
    const env = makeEnv(vectorize);
    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };

    const created = await app.request(
      '/v1/indexes',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ name: 'Docs Domain', external_id: 'kb:docs' }),
      },
      env,
    );
    const index = (await created.json()) as IndexRecord;
    await app.request(
      `/v1/indexes/${index.id}/ingest-vectors`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          chunks: [
            {
              id: 'doc-alpha-1',
              document_id: 'doc-alpha',
              document_content: 'alpha exact wording is the source answer',
              content: 'alpha exact wording is the source answer',
              embedding: vectorFor('alpha exact wording'),
              chunk_index: 0,
              metadata: { filename: 'alpha.txt' },
            },
          ],
        }),
      },
      env,
    );

    const answer = await app.request(
      '/v1/kb/query',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          domain: 'docs',
          question: 'What has alpha exact wording?',
          mode: 'semantic',
          answer_mode: 'workers_ai',
          answer_model: '@cf/test/synth',
        }),
      },
      env,
    );
    const body = (await answer.json()) as {
      ai_used: boolean;
      answer_mode: string;
      answer_model: string | null;
      answer: string;
      citations: CitationRecord[];
      confidence: JsonRecord;
    };
    const timing = JSON.parse(answer.headers.get('X-RAG-Timing') ?? '{}');

    expect(answer.status).toBe(200);
    expect(body.ai_used).toBe(true);
    expect(body.answer_mode).toBe('workers_ai');
    expect(body.answer_model).toBe('@cf/test/synth');
    expect(body.answer).toContain('Workers AI synthesized alpha exact wording');
    expect(body.answer).toContain('[1]');
    expect(body.citations[0]).toMatchObject({ index: 1, filename: 'alpha.txt' });
    expect(body.confidence).toMatchObject({
      verification_checked: true,
      verification_method: 'deterministic_answer_evidence_token_overlap',
    });
    expect(timing).toMatchObject({
      answer_requested_mode: 'workers_ai',
      answer_mode: 'workers_ai',
      synthesis_model: '@cf/test/synth',
    });
    expect(typeof timing.synthesis_ms).toBe('number');
  });

  it('serves the Cloudflare-hosted testing UI without a service key', async () => {
    const app = createApp();
    const res = await app.request('/', {}, makeEnv(new FakeVectorize()));
	    const html = await res.text();

	    expect(res.status).toBe(200);
	    expect(res.headers.get('content-type')).toContain('text/html');
	    expect(html).toContain('Knowledgebase Cloudflare');
	    expect(html).toContain('/v1/kb/files/upload');
	    expect(html).toContain('<h2>Admin</h2>');
	    expect(html).toContain('id="loadProjects"');
	    expect(html).toContain('id="loadDomains"');
	    expect(html).toContain('id="loadFiles"');
	    expect(html).toContain('id="loadIndexes"');
	    expect(html).toContain('id="loadEmbeddingModelsAdmin"');
	    expect(html).toContain('/v1/kb/projects');
	    expect(html).toContain('/v1/kb/domains');
	    expect(html).toContain('/v1/kb/files?domain=');
	    expect(html).toContain('/v1/indexes');
	    expect(html).toContain('/v1/embedding-models');
	    expect(html).toContain('/v1/kb/entities');
	    expect(html).toContain('/v1/kb/entities/search');
	    expect(html).toContain('/v1/kb/relationships');
	    expect(html).toContain('/v1/kb/relationships/backfill');
	    expect(html).toContain('id="backfillRelationships"');
	    expect(html).toContain('/v1/kb/jobs');
	    expect(html).toContain('/v1/kb/source-sets');
	    expect(html).toContain('/v1/kb/sources/import');
	    expect(html).toContain('/v1/kb/ingest/record');
	    expect(html).toContain('/v1/kb/ingest/text');
	    expect(html).toContain('id="sourceType"');
	    expect(html).toContain('id="sourceUrls"');
	    expect(html).toContain('id="sourceTickers"');
	    expect(html).toContain('id="recordType"');
	    expect(html).toContain('id="recordData"');
	    expect(html).toContain('id="domainText"');
	    expect(html).toContain('function setLastSchema');
	    expect(html).toContain('Import Source');
	    expect(html).toContain('Ingest Records');
	    expect(html).toContain('Ingest Domain Text');
	    expect(html).toContain('Dry Run Source Action');
	    expect(html).toContain('/v1/kb/ingest/runs/');
	    expect(html).toContain('Load Run Progress');
	    expect(html).toContain('Inline Ingest');
	    expect(html).toContain('Queue Ingest');
	    expect(html).toContain('/v1/kb/query');
	    expect(html).toContain('/v1/kb/query/stream');
	    expect(html).toContain('Stream Answer');
	    expect(html).toContain('/v1/kb/sessions');
	    expect(html).toContain('/v1/kb/query/traces/export');
	    expect(html).toContain('/v1/kb/query/traces/compare');
	    expect(html).toContain('/v1/kb/query/trace/');
	    expect(html).toContain('/drilldown');
	    expect(html).toContain('Load Trace Drilldown');
	    expect(html).toContain('id="semanticModel"');
	    expect(html).toContain('function embeddingSelection()');
	    expect(html).toContain('function applyEmbeddingSelectionForm(form)');
	    expect(html).toContain("applyEmbeddingSelectionForm(form);");
	    expect(html).toContain("return embeddingModel ? { embedding_model: embeddingModel } : {};");
	    expect(html).toContain('...embeddingSelection()');
	    expect(html).toContain('if (embeddingModel) payload.embedding_model = embeddingModel;');
	    expect(html).toContain("else payload.embedding_profile = $('embeddingProfile').value;");
	    expect(html).toContain("if (body.catalog_source !== 'free_ai') return;");
	    expect(html).toContain('item && item.selectable === true');
	    expect(html).toContain('id="minScore"');
	    expect(html).toContain('id="scope"');
	    expect(html).toContain('id="queryFilter"');
	    expect(html).toContain('id="rerank"');
	    expect(html).toContain('id="rerankModel"');
	    expect(html).toContain('id="answerMode"');
	    expect(html).toContain('id="answerModel"');
	    expect(html).toContain('id="mmr"');
	    expect(html).toContain('id="queryRewrite"');
	    expect(html).toContain('id="queryDecompose"');
	    expect(html).toContain('/v1/kb/evals/parse');
	    expect(html).toContain('/v1/kb/evals/query');
	    expect(html).toContain('/v1/kb/evals/summary');
	    expect(html).toContain('/v1/kb/evals/reports');
	  });

  it('can ingest and query the small semantic Vectorize index by namespace', async () => {
    const repo = new MemoryRepository();
    const vectorize = new FakeVectorize();
    const vectorizeSmall = new FakeVectorize();
    const app = createApp({ makeRepository: () => repo });
    const env = makeEnv(vectorize, undefined as unknown as D1Database, vectorizeSmall);
    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };

    const created = await app.request(
      '/v1/indexes',
      { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Small Docs' }) },
      env,
    );
    const index = (await created.json()) as IndexRecord;
    await app.request(
      `/v1/indexes/${index.id}/ingest`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ documents: [{ content: 'alpha semantic document' }] }),
      },
      env,
    );

    const query = await app.request(
      `/v1/indexes/${index.id}/query`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ query: 'semantic alpha', top_k: 1, mode: 'semantic', semantic_model: 'small' }),
      },
      env,
    );
    const timing = JSON.parse(query.headers.get('X-RAG-Timing') ?? '{}');

    expect(query.status).toBe(200);
    expect(vectorizeSmall.vectors.size).toBe(repo.chunks.size);
    expect(timing).toMatchObject({ semantic_model: 'small', vectorize_path: 'namespace' });
    expect(vectorizeSmall.queries.at(-1)).toMatchObject({
      namespace: `tenant-a:${index.id}`,
      returnMetadata: 'all',
    });
  });

  it('caches repeated text queries before calling AI or Vectorize again', async () => {
    const repo = new MemoryRepository();
    const vectorize = new FakeVectorize();
    let aiCalls = 0;
    let vectorQueries = 0;
    const originalQuery = vectorize.query.bind(vectorize);
    vectorize.query = async (...args) => {
      vectorQueries += 1;
      return originalQuery(...args);
    };
    const app = createApp({
      makeRepository: () => repo,
      queryCache: new TtlCache({ enabled: true, ttlMs: 60_000, maxEntries: 100 }),
      embeddingCache: new TtlCache({ enabled: true, ttlMs: 60_000, maxEntries: 100 }),
      embed: async (_env, texts) => {
        aiCalls += 1;
        return texts.map(vectorFor);
      },
    });
    const env = makeEnv(vectorize);
    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };

    const created = await app.request(
      '/v1/indexes',
      { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Cached Docs' }) },
      env,
    );
    const index = (await created.json()) as IndexRecord;
    await app.request(
      `/v1/indexes/${index.id}/ingest-vectors`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          chunks: [
            {
              id: 'chunk-cache',
              document_id: 'doc-cache',
              document_content: 'alpha cache document',
              content: 'alpha cache document',
              embedding: vectorFor('alpha'),
              chunk_index: 0,
            },
          ],
        }),
      },
      env,
    );

    const first = await app.request(
      `/v1/indexes/${index.id}/query`,
      { method: 'POST', headers: auth, body: JSON.stringify({ query: 'alpha', top_k: 1, mode: 'semantic' }) },
      env,
    );
    const second = await app.request(
      `/v1/indexes/${index.id}/query`,
      { method: 'POST', headers: auth, body: JSON.stringify({ top_k: 1, query: 'alpha', mode: 'semantic' }) },
      env,
    );

    expect(first.headers.get('X-RAG-Cache')).toBe('miss');
    expect(second.headers.get('X-RAG-Cache')).toBe('hit');
    expect(JSON.parse(first.headers.get('X-RAG-Timing') ?? '{}')).toMatchObject({
      cache: 'miss',
      embedding_cache: 'miss',
      route: 'query',
    });
    expect(JSON.parse(second.headers.get('X-RAG-Timing') ?? '{}')).toMatchObject({
      cache: 'hit',
      route: 'query',
    });
    expect(first.headers.get('Server-Timing')).toContain('rag_total');
    expect(aiCalls).toBe(1);
    expect(vectorQueries).toBe(1);
  });

  it('runs retrieval evals against a populated index', async () => {
    const repo = new MemoryRepository();
    const metadata = new MemoryMetadataRepository();
    const vectorize = new FakeVectorize();
    const app = createApp({
      makeRepository: () => repo,
      makeMetadataRepository: () => metadata,
    });
    const env = makeEnv(vectorize);
    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };

    const created = await app.request(
      '/v1/indexes',
      { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Eval Docs' }) },
      env,
    );
    const index = (await created.json()) as IndexRecord;
    await app.request(
      `/v1/indexes/${index.id}/ingest-vectors`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          chunks: [{
            id: 'chunk-eval',
            document_id: 'doc-eval',
            document_content: 'alpha eval document',
            content: 'alpha eval document',
            embedding: vectorFor('alpha'),
            chunk_index: 0,
          }],
        }),
      },
      env,
    );

    const res = await app.request(
      '/v1/kb/evals/search',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          index_id: index.id,
          mode: 'lexical',
          cases: [{ id: 'q1', query: 'alpha eval', expected_text: 'alpha eval document' }],
        }),
      },
      env,
    );
    const body = await res.json() as { report_id: string };
    const report = await app.request(`/v1/kb/evals/reports/${body.report_id}`, { headers: auth }, env);
    const reportBody = (await report.json()) as EvalReportRecord;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      project: 'tenant-a',
      index_id: index.id,
      n: 1,
      hit_rate: 1,
      mrr: 1,
      rows: [{ id: 'q1', hit: true, rank: 1 }],
    });
    expect(report.status).toBe(200);
    expect(reportBody).toMatchObject({
      id: body.report_id,
      kind: 'search',
      index_id: index.id,
      summary: expect.objectContaining({ hit_rate: 1, mrr: 1 }),
    });
  });

  it('scores query eval document and chunk expectations against retrieved evidence', async () => {
    const repo = new MemoryRepository();
    const metadata = new MemoryMetadataRepository();
    const vectorize = new FakeVectorize();
    const app = createApp({
      makeRepository: () => repo,
      makeMetadataRepository: () => metadata,
      embed: async (_env, texts) => texts.map(vectorFor),
    });
    const env = makeEnv(vectorize);
    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };

    const created = await app.request(
      '/v1/indexes',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ name: 'Eval Domain', external_id: 'kb:eval-docs' }),
      },
      env,
    );
    const index = (await created.json()) as IndexRecord;
    await app.request(
      `/v1/indexes/${index.id}/ingest-vectors`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          chunks: [{
            id: 'chunk-present',
            document_id: 'doc-present',
            document_content: 'alpha query eval document',
            content: 'alpha query eval document',
            embedding: vectorFor('alpha query eval document'),
            chunk_index: 0,
          }],
        }),
      },
      env,
    );

    const res = await app.request(
      '/v1/kb/evals/query',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          domain: 'eval-docs',
          mode: 'semantic',
          cases: [
            { id: 'hit-doc', question: 'alpha query eval', expected_document_ids: ['doc-present'] },
            { id: 'hit-chunk', question: 'alpha query eval', expected_chunk_ids: ['chunk-present'] },
            { id: 'miss-doc', question: 'alpha query eval', expected_document_ids: ['doc-missing'] },
          ],
        }),
      },
      env,
    );
    const body = await res.json() as {
      hit_rate: number;
      rows: Array<{ id: string; hit: boolean; result_count: number }>;
    };

    expect(res.status).toBe(200);
    expect(body.hit_rate).toBe(2 / 3);
    expect(body.rows).toEqual([
      expect.objectContaining({ id: 'hit-doc', hit: true, result_count: 1 }),
      expect.objectContaining({ id: 'hit-chunk', hit: true, result_count: 1 }),
      expect.objectContaining({ id: 'miss-doc', hit: false, result_count: 1 }),
    ]);
  });

  it('runs parse evals and persists Markdown Conversion fallback reports', async () => {
    const metadata = new MemoryMetadataRepository();
    const vectorize = new FakeVectorize();
    const app = createApp({ makeMetadataRepository: () => metadata });
    const env = makeEnv(vectorize);
    (env.AI as unknown as {
      toMarkdown: (file: MarkdownDocument) => Promise<ConversionResponse>;
      run: (model: string, input: { image?: number[] }) => Promise<unknown>;
    }).toMarkdown = async (file) => file.name === 'scan.pdf'
      ? {
        id: 'converted-pdf',
        name: 'scan.pdf',
        mimeType: 'application/pdf',
        format: 'markdown',
        tokens: 12,
        data: 'Markdown fallback supply chain concentration',
      }
      : {
        id: 'converted-1',
        name: 'scan.png',
        mimeType: 'image/png',
        format: 'markdown',
        tokens: 18,
        data: '# Invoice\n\n| Field | Value |\n| --- | --- |\n| Total | 100 |',
      };
    (env.AI as unknown as {
      run: (model: string, input: { image?: number[] }) => Promise<unknown>;
    }).run = async (_model, input) => {
      if (Array.isArray(input.image)) return { response: 'Vision OCR risk factor paragraph' };
      return { response: '{}' };
    };
    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };

    const res = await app.request(
      '/v1/kb/evals/parse',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          domain: 'contracts',
          cases: [{
            id: 'scan',
            filename: 'scan.png',
            mime: 'image/png',
            content_base64: Buffer.from('fake image bytes').toString('base64'),
            expected_text: ['Invoice', 'Total'],
            expected_parser: 'workers-ai-markdown-v1',
            markdown_conversion: 'always',
          }, {
            id: 'vision-pdf',
            filename: 'scan.pdf',
            mime: 'application/pdf',
            content_base64: Buffer.from('%PDF-1.4\n1 0 obj << /Subtype /Image /Filter /DCTDecode /Length 4 >> stream\nxxxx\nendstream\nendobj\n%%EOF').toString('base64'),
            expected_text: ['Vision OCR risk factor paragraph', 'Markdown fallback supply chain'],
            expected_parser: 'workers-ai-vision-markdown-ocr-v1',
            vision_ocr_model: '@cf/test/vision',
          }, {
            id: 'wrapped-text',
            filename: 'wrapped.txt',
            mime: 'text/plain',
            content: 'Alpha\n\nBeta   Gamma\nNVDA Risk Factors Sample\nSupply chain concentration is performed by Taiwan Semiconductor Manufacturing Company',
            expected_text: [
              'Alpha Beta Gamma',
              'NVDA-RiskFactors-Sample',
              'Supply chain concentration Is performed by Talwan Semiconductor Manufacturing Company',
            ],
          }],
        }),
      },
      env,
    );
    const body = await res.json() as {
      report_id: string;
      pass_rate: number;
      parser_counts: Record<string, number>;
      rows: Array<{ ok: boolean; parser: string; record_count: number }>;
    };
    const report = await app.request(`/v1/kb/evals/reports/${body.report_id}`, { headers: auth }, env);
    const reportBody = (await report.json()) as EvalReportRecord;

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      pass_rate: 1,
      parser_counts: {
        'workers-ai-markdown-v1': 1,
        'workers-ai-vision-markdown-ocr-v1': 1,
        'worker-text-structured-v1': 1,
      },
      rows: [
        expect.objectContaining({ ok: true, parser: 'workers-ai-markdown-v1', record_count: 1 }),
        expect.objectContaining({ id: 'vision-pdf', ok: true, parser: 'workers-ai-vision-markdown-ocr-v1' }),
        expect.objectContaining({ id: 'wrapped-text', ok: true, parser: 'worker-text-structured-v1' }),
      ],
    });
    expect(report.status).toBe(200);
    expect(reportBody).toMatchObject({
      id: body.report_id,
      kind: 'parse',
      domain: 'contracts',
      summary: expect.objectContaining({ pass_rate: 1 }),
    });
  });

  it('retries later configured vision OCR models when parse eval expected text is still missing', async () => {
    const metadata = new MemoryMetadataRepository();
    const vectorize = new FakeVectorize();
    const app = createApp({ makeMetadataRepository: () => metadata });
    const env = makeEnv(vectorize);
    const calls: string[] = [];
    (env.AI as unknown as {
      toMarkdown: (file: MarkdownDocument) => Promise<ConversionResponse>;
      run: (model: string, input: unknown) => Promise<unknown>;
    }).toMarkdown = async () => ({
      id: 'converted-pdf',
      name: 'scan.pdf',
      mimeType: 'application/pdf',
      format: 'markdown',
      tokens: 12,
      data: 'Markdown Conversion found only the page title',
    });
    (env.AI as unknown as {
      run: (model: string, input: unknown) => Promise<unknown>;
    }).run = async (model) => {
      calls.push(model);
      if (model.includes('llama-4-scout')) return { response: 'NVDA-RiskFactors-Sample' };
      return { response: 'Customer concentration: a small number of customers accounted for revenue.' };
    };

    const res = await app.request(
      '/v1/kb/evals/parse',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cases: [{
            id: 'vision-chain-pdf',
            filename: 'scan.pdf',
            mime: 'application/pdf',
            content_base64: Buffer.from('%PDF-1.4\n1 0 obj << /Subtype /Image /Filter /DCTDecode /Length 4 >> stream\nxxxx\nendstream\nendobj\n%%EOF').toString('base64'),
            expected_text: ['Customer concentration: a small number of customers accounted for revenue.'],
            expected_parser: 'workers-ai-vision-markdown-ocr-v1',
            vision_ocr_model: '@cf/meta/llama-4-scout-17b-16e-instruct,@cf/meta/llama-3.2-11b-vision-instruct',
          }],
        }),
      },
      env,
    );
    const body = await res.json() as {
      pass_rate: number;
      rows: Array<{
        ok: boolean;
        missing_text: string[];
        vision_ocr_models_tried: string[];
        vision_ocr_retry_reason: string | null;
        text_preview?: string;
      }>;
    };

    expect(res.status).toBe(200);
    expect(calls).toEqual([
      '@cf/meta/llama-4-scout-17b-16e-instruct',
      '@cf/meta/llama-3.2-11b-vision-instruct',
    ]);
    expect(body.pass_rate).toBe(1);
    expect(body.rows[0]).toMatchObject({
      ok: true,
      missing_text: [],
      vision_ocr_models_tried: [
        '@cf/meta/llama-4-scout-17b-16e-instruct',
        '@cf/meta/llama-3.2-11b-vision-instruct',
      ],
      vision_ocr_retry_reason: 'missing_expected_text',
    });
  });

  it('runs the real NVDA scanned-PDF direct parse-eval case through the vision model retry gate when the fixture is present', async () => {
    const fixture = '../../data/minio/kb-bucket/raw/sec/a56062aa2ee3c2eb6e1128e440e4ab683641e2ef4ccfa7e955538676a02c4c39/NVDA_riskfactors_sample_scanned.pdf/xl.meta';
    if (!existsSync(fixture)) return;

    const { cases } = await buildLegacyParseEvalCases({
      rawRoot: '../../data/minio/kb-bucket',
      parseRoot: '../../data/minio/kb-bucket',
      directDomain: 'sec',
      directContentHash: 'a56062aa2ee3c2eb6e1128e440e4ab683641e2ef4ccfa7e955538676a02c4c39',
      directFilename: 'NVDA_riskfactors_sample_scanned.pdf',
      directMime: 'application/pdf',
      expectedPerCase: 3,
      minTextRatio: 0.2,
    });
    const evalCase = cases[0] as Record<string, unknown> | undefined;
    if (!evalCase) return;
    const expectedText = evalCase.expected_text as string[];
    expect(expectedText.length).toBeGreaterThanOrEqual(3);

    const metadata = new MemoryMetadataRepository();
    const vectorize = new FakeVectorize();
    const app = createApp({ makeMetadataRepository: () => metadata });
    const env = makeEnv(vectorize);
    const calls: string[] = [];
    (env.AI as unknown as {
      toMarkdown: (file: MarkdownDocument) => Promise<ConversionResponse>;
      run: (model: string, input: unknown) => Promise<unknown>;
    }).toMarkdown = async () => ({
      id: 'converted-nvda',
      name: 'NVDA_riskfactors_sample_scanned.pdf',
      mimeType: 'application/pdf',
      format: 'markdown',
      tokens: 12,
      data: expectedText[0] ?? 'NVDA-RiskFactors-Sample',
    });
    (env.AI as unknown as {
      run: (model: string, input: unknown) => Promise<unknown>;
    }).run = async (model) => {
      calls.push(model);
      if (model.includes('llama-3.2')) return { response: expectedText[0] ?? '' };
      return { response: expectedText.join('\n') };
    };
    const { domain: _domain, legacy: _legacy, ...casePayload } = evalCase;

    const res = await app.request(
      '/v1/kb/evals/parse',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          domain: 'sec',
          markdown_conversion: 'auto',
          vision_ocr_model: '@cf/meta/llama-3.2-11b-vision-instruct,@cf/meta/llama-4-scout-17b-16e-instruct',
          include_text_preview: true,
          cases: [casePayload],
        }),
      },
      env,
    );
    const body = await res.json() as {
      pass_rate: number;
      rows: Array<{
        ok: boolean;
        parser: string;
        expected_text_count: number;
        matched_text_count: number;
        missing_text: string[];
        vision_ocr_models_tried: string[];
        vision_ocr_retry_reason: string | null;
        text_preview?: string;
      }>;
    };

    expect(res.status).toBe(200);
    expect(calls).toEqual([
      '@cf/meta/llama-3.2-11b-vision-instruct',
      '@cf/meta/llama-4-scout-17b-16e-instruct',
    ]);
    expect(body.pass_rate).toBe(1);
    expect(body.rows[0]).toMatchObject({
      ok: true,
      parser: 'workers-ai-vision-markdown-ocr-v1',
      expected_text_count: expectedText.length,
      matched_text_count: expectedText.length,
      missing_text: [],
      vision_ocr_models_tried: [
        '@cf/meta/llama-3.2-11b-vision-instruct',
        '@cf/meta/llama-4-scout-17b-16e-instruct',
      ],
      vision_ocr_retry_reason: 'missing_expected_text',
    });
    for (const snippet of expectedText) {
      expect(body.rows[0]?.text_preview).toContain(snippet);
    }
  });

  it('uses lexical retrieval for exact non-cache text queries without AI or Vectorize', async () => {
    const repo = new MemoryRepository();
    const vectorize = new FakeVectorize();
    const db = new FakeQueryCacheD1();
    let aiCalls = 0;
    let vectorQueries = 0;
    const originalQuery = vectorize.query.bind(vectorize);
    vectorize.query = async (...args) => {
      vectorQueries += 1;
      return originalQuery(...args);
    };
    const app = createApp({
      makeRepository: () => repo,
      embed: async (_env, texts) => {
        aiCalls += 1;
        return texts.map(vectorFor);
      },
    });
    const env = makeEnv(vectorize, db as unknown as D1Database);
    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };

    const created = await app.request(
      '/v1/indexes',
      { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Lexical Docs' }) },
      env,
    );
    const index = (await created.json()) as IndexRecord;
    await app.request(
      `/v1/indexes/${index.id}/ingest-vectors`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          chunks: [{
            id: 'chunk-lexical',
            document_id: 'doc-lexical',
            document_content: 'billing guardrails are documented here',
            content: 'billing guardrails are documented here',
            embedding: vectorFor('unrelated'),
            chunk_index: 0,
          }],
        }),
      },
      env,
    );

    repo.getIndexCalls = 0;
    db.selectPayloadCalls = 0;
    const query = await app.request(
      `/v1/indexes/${index.id}/query`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ query: 'where are billing guardrails documented?', top_k: 1, mode: 'lexical' }),
      },
      env,
    );
    const result = (await query.json()) as { data: Array<{ chunk_content: string }> };
    const timing = JSON.parse(query.headers.get('X-RAG-Timing') ?? '{}');

    expect(query.status).toBe(200);
    expect(query.headers.get('X-RAG-Cache')).toBe('miss');
    expect(timing).toMatchObject({ retrieval: 'lexical' });
    expect(timing.query_plan).toBeUndefined();
    expect(result.data[0]?.chunk_content).toContain('billing guardrails');
    expect(aiCalls).toBe(0);
    expect(vectorQueries).toBe(0);
    expect(repo.getIndexCalls).toBe(0);
    expect(db.selectPayloadCalls).toBe(0);
  });

  it('rewrites and decomposes lexical queries without AI or Vectorize', async () => {
    const repo = new MemoryRepository();
    const vectorize = new FakeVectorize();
    let aiCalls = 0;
    let vectorQueries = 0;
    const originalQuery = vectorize.query.bind(vectorize);
    vectorize.query = async (...args) => {
      vectorQueries += 1;
      return originalQuery(...args);
    };
    const app = createApp({
      makeRepository: () => repo,
      embed: async (_env, texts) => {
        aiCalls += 1;
        return texts.map(vectorFor);
      },
    });
    const env = makeEnv(vectorize);
    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };

    const created = await app.request(
      '/v1/indexes',
      { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Query Plan Docs' }) },
      env,
    );
    const index = (await created.json()) as IndexRecord;
    await app.request(
      `/v1/indexes/${index.id}/ingest-vectors`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          chunks: [
            {
              id: 'chunk-billing',
              document_id: 'doc-billing',
              document_content: 'billing guardrails are documented here',
              content: 'billing guardrails are documented here',
              embedding: vectorFor('unrelated'),
              chunk_index: 0,
            },
            {
              id: 'chunk-retention',
              document_id: 'doc-retention',
              document_content: 'retention windows are tracked separately',
              content: 'retention windows are tracked separately',
              embedding: vectorFor('unrelated'),
              chunk_index: 1,
            },
          ],
        }),
      },
      env,
    );

    const query = await app.request(
      `/v1/indexes/${index.id}/query`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          query: 'Which docs discuss billing guardrails and retention windows?',
          top_k: 2,
          mode: 'lexical',
          query_rewrite: true,
          query_decompose: true,
        }),
      },
      env,
    );
    const result = (await query.json()) as { data: Array<{ chunk_id: string; metadata: JsonRecord }> };
    const timing = JSON.parse(query.headers.get('X-RAG-Timing') ?? '{}');

    expect(query.status).toBe(200);
    expect(timing).toMatchObject({
      retrieval: 'lexical',
      query_plan: 'rewrite_decompose',
      query_plan_variants: expect.any(Number),
      query_plan_results: 2,
    });
    expect(timing.query_plan_variants).toBeGreaterThanOrEqual(2);
    expect(result.data.map((item) => item.chunk_id)).toEqual(
      expect.arrayContaining(['chunk-billing', 'chunk-retention']),
    );
    expect(result.data[0]?.metadata.query_plan_sources).toEqual(expect.arrayContaining(['original']));
    expect(aiCalls).toBe(0);
    expect(vectorQueries).toBe(0);
  });

  it('uses sparse term weighting for lexical ranking without AI or Vectorize', async () => {
    const repo = new MemoryRepository();
    const vectorize = new FakeVectorize();
    let aiCalls = 0;
    let vectorQueries = 0;
    const originalQuery = vectorize.query.bind(vectorize);
    vectorize.query = async (...args) => {
      vectorQueries += 1;
      return originalQuery(...args);
    };
    const app = createApp({
      makeRepository: () => repo,
      embed: async (_env, texts) => {
        aiCalls += 1;
        return texts.map(vectorFor);
      },
    });
    const env = makeEnv(vectorize);
    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };

    const created = await app.request(
      '/v1/indexes',
      { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Sparse Ranking Docs' }) },
      env,
    );
    const index = (await created.json()) as IndexRecord;
    await app.request(
      `/v1/indexes/${index.id}/ingest-vectors`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          chunks: [
            {
              id: 'chunk-common-a',
              document_id: 'doc-common-a',
              document_content: 'common policy common policy common policy',
              content: 'common policy common policy common policy',
              embedding: vectorFor('unrelated'),
              chunk_index: 0,
            },
            {
              id: 'chunk-common-b',
              document_id: 'doc-common-b',
              document_content: 'common reference material',
              content: 'common reference material',
              embedding: vectorFor('unrelated'),
              chunk_index: 1,
            },
            {
              id: 'chunk-rare',
              document_id: 'doc-rare',
              document_content: 'ultrarare compliance exception',
              content: 'ultrarare compliance exception',
              embedding: vectorFor('unrelated'),
              chunk_index: 2,
            },
          ],
        }),
      },
      env,
    );

    const query = await app.request(
      `/v1/indexes/${index.id}/query`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          query: 'common ultrarare',
          top_k: 1,
          mode: 'lexical',
          rerank: false,
          mmr: false,
        }),
      },
      env,
    );
    const result = (await query.json()) as { data: Array<{ chunk_id: string; metadata: JsonRecord }> };
    const timing = JSON.parse(query.headers.get('X-RAG-Timing') ?? '{}');

    expect(query.status).toBe(200);
    expect(timing).toMatchObject({
      retrieval: 'lexical',
      lexical_scoring: 'bm25_fuzzy_sparse_v3',
      lexical_corpus_chunks: 3,
      lexical_prefilter: 'chunk_cache_full_scan',
    });
    expect(result.data[0]?.chunk_id).toBe('chunk-rare');
    expect(result.data[0]?.metadata).toMatchObject({
      lexical_scoring: 'bm25_fuzzy_sparse_v3',
      lexical_matched_terms: ['ultrarare'],
    });
    expect(aiCalls).toBe(0);
    expect(vectorQueries).toBe(0);
    expect(repo.listChunksForIndexCalls).toBe(1);
  });

  it('handles fuzzy lexical typos without AI or Vectorize', async () => {
    const repo = new MemoryRepository();
    const vectorize = new FakeVectorize();
    let aiCalls = 0;
    let vectorQueries = 0;
    const originalQuery = vectorize.query.bind(vectorize);
    vectorize.query = async (...args) => {
      vectorQueries += 1;
      return originalQuery(...args);
    };
    const app = createApp({
      makeRepository: () => repo,
      embed: async (_env, texts) => {
        aiCalls += 1;
        return texts.map(vectorFor);
      },
    });
    const env = makeEnv(vectorize);
    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };

    const created = await app.request(
      '/v1/indexes',
      { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Fuzzy Lexical Docs' }) },
      env,
    );
    const index = (await created.json()) as IndexRecord;
    await app.request(
      `/v1/indexes/${index.id}/ingest-vectors`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          chunks: [{
            id: 'chunk-guardrails',
            document_id: 'doc-guardrails',
            document_content: 'billing guardrails are documented here',
            content: 'billing guardrails are documented here',
            embedding: vectorFor('unrelated'),
            chunk_index: 0,
          }],
        }),
      },
      env,
    );

    const query = await app.request(
      `/v1/indexes/${index.id}/query`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          query: 'guadrails',
          top_k: 1,
          mode: 'lexical',
          rerank: false,
          mmr: false,
        }),
      },
      env,
    );
    const result = (await query.json()) as { data: Array<{ chunk_id: string; metadata: JsonRecord }> };
    const timing = JSON.parse(query.headers.get('X-RAG-Timing') ?? '{}');

    expect(query.status).toBe(200);
    expect(timing).toMatchObject({
      retrieval: 'lexical',
      lexical_prefilter: 'chunk_cache_full_scan',
      lexical_scoring: 'bm25_fuzzy_sparse_v3',
    });
    expect(result.data[0]?.chunk_id).toBe('chunk-guardrails');
    expect(result.data[0]?.metadata.lexical_matched_terms).toEqual(['guadrails~guardrails']);
    expect(aiCalls).toBe(0);
    expect(vectorQueries).toBe(0);
    expect(repo.listChunksForIndexCalls).toBe(1);
  });

  it('caches knowledgebase domain index lookups across hot searches', async () => {
    const repo = new MemoryRepository();
    const metadata = new MemoryMetadataRepository();
    const rawDocs = new FakeR2Bucket();
    const vectorize = new FakeVectorize();
    const app = createApp({
      makeRepository: () => repo,
      makeMetadataRepository: () => metadata,
      embed: async (_env, texts) => texts.map(vectorFor),
    });
    const env = makeEnv(
      vectorize,
      undefined as unknown as D1Database,
      undefined,
      rawDocs as unknown as R2Bucket,
    );
    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };

    const ingested = await app.request(
      '/v1/kb/ingest/text',
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          domain: 'kb-hot-path',
          title: 'cache-note',
          text: 'Dashboard cache facts should be found quickly.',
          async: false,
        }),
      },
      env,
    );
    expect(ingested.status).toBe(201);

    repo.getIndexByExternalIdCalls = 0;
    repo.listChunksForIndexCalls = 0;
    for (let i = 0; i < 2; i += 1) {
      const searched = await app.request(
        '/v1/kb/search',
        {
          method: 'POST',
          headers: auth,
          body: JSON.stringify({ domain: 'kb-hot-path', query: 'dashboard cache', mode: 'lexical', top_k: 1 }),
        },
        env,
      );
      expect(searched.status).toBe(200);
    }

    expect(repo.getIndexByExternalIdCalls).toBe(0);
    expect(repo.listChunksForIndexCalls).toBe(0);
  });

  it('fuses lexical and semantic results in hybrid mode', async () => {
    const repo = new MemoryRepository();
    const vectorize = new FakeVectorize();
    let aiCalls = 0;
    let vectorQueries = 0;
    const originalQuery = vectorize.query.bind(vectorize);
    vectorize.query = async (...args) => {
      vectorQueries += 1;
      return originalQuery(...args);
    };
    const app = createApp({
      makeRepository: () => repo,
      embed: async (_env, texts) => {
        aiCalls += 1;
        return texts.map(vectorFor);
      },
    });
    const env = makeEnv(vectorize);
    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };

    const created = await app.request(
      '/v1/indexes',
      { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Hybrid Docs' }) },
      env,
    );
    const index = (await created.json()) as IndexRecord;
    await app.request(
      `/v1/indexes/${index.id}/ingest-vectors`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          chunks: [
            {
              id: 'chunk-lexical',
              document_id: 'doc-lexical',
              document_content: 'alpha exact wording lives here',
              content: 'alpha exact wording lives here',
              embedding: vectorFor('zz'),
              chunk_index: 0,
            },
            {
              id: 'chunk-semantic',
              document_id: 'doc-semantic',
              document_content: 'conceptual answer without the token',
              content: 'conceptual answer without the token',
              embedding: vectorFor('alpha question'),
              chunk_index: 0,
            },
          ],
        }),
      },
      env,
    );

    const query = await app.request(
      `/v1/indexes/${index.id}/query`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ query: 'alpha question', top_k: 2, mode: 'hybrid' }),
      },
      env,
    );
    const result = (await query.json()) as { data: Array<{ chunk_id: string; metadata: JsonRecord }> };
    const timing = JSON.parse(query.headers.get('X-RAG-Timing') ?? '{}');

    expect(query.status).toBe(200);
    expect(timing).toMatchObject({
      retrieval: 'hybrid_rrf',
      hybrid_lexical_results: 1,
      hybrid_semantic_results: 2,
      rerank: 'keyword_mmr',
    });
    expect(result.data.map((item) => item.chunk_id)).toEqual(
      expect.arrayContaining(['chunk-lexical', 'chunk-semantic']),
    );
    expect(result.data[0]?.metadata.hybrid_sources).toBeDefined();
    expect(result.data[0]?.metadata.rerank_score).toBeDefined();
    expect(result.data[0]?.metadata.mmr_rank).toBe(1);
    expect(aiCalls).toBe(1);
    expect(vectorQueries).toBe(1);
  });

  it('can rerank hybrid candidates with Workers AI', async () => {
    const repo = new MemoryRepository();
    const vectorize = new FakeVectorize();
    const app = createApp({
      makeRepository: () => repo,
      embed: async (_env, texts) => texts.map(vectorFor),
    });
    const env = makeEnv(vectorize);
    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };

    const created = await app.request(
      '/v1/indexes',
      { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Neural Rerank Docs' }) },
      env,
    );
    const index = (await created.json()) as IndexRecord;
    await app.request(
      `/v1/indexes/${index.id}/ingest-vectors`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          chunks: [
            {
              id: 'chunk-lexical',
              document_id: 'doc-lexical',
              document_content: 'alpha exact wording lives here',
              content: 'alpha exact wording lives here',
              embedding: vectorFor('zz'),
              chunk_index: 0,
            },
            {
              id: 'chunk-semantic',
              document_id: 'doc-semantic',
              document_content: 'conceptual answer without the token',
              content: 'conceptual answer without the token',
              embedding: vectorFor('alpha question'),
              chunk_index: 0,
            },
          ],
        }),
      },
      env,
    );

    const query = await app.request(
      `/v1/indexes/${index.id}/query`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ query: 'alpha question', top_k: 2, mode: 'hybrid', rerank_model: 'workers_ai' }),
      },
      env,
    );
    const result = (await query.json()) as { data: Array<{ chunk_id: string; score: number; metadata: JsonRecord }> };
    const timing = JSON.parse(query.headers.get('X-RAG-Timing') ?? '{}');

    expect(query.status).toBe(200);
    expect(timing).toMatchObject({
      retrieval: 'hybrid_rrf',
      rerank: 'workers_ai_mmr',
      neural_rerank_model: '@cf/baai/bge-reranker-base',
      neural_rerank_candidates: 2,
    });
    expect(result.data[0]?.chunk_id).toBe('chunk-semantic');
    expect(result.data[0]?.score).toBe(0.96);
    expect(result.data[0]?.metadata.neural_rerank_score).toBe(0.96);
    expect(result.data[0]?.metadata.retrieval_score).toBeDefined();
  });

  it('corrects weak semantic retrieval with lexical evidence', async () => {
    const repo = new MemoryRepository();
    const vectorize = new FakeVectorize();
    let aiCalls = 0;
    let vectorQueries = 0;
    const originalQuery = vectorize.query.bind(vectorize);
    vectorize.query = async (...args) => {
      vectorQueries += 1;
      return originalQuery(...args);
    };
    const app = createApp({
      makeRepository: () => repo,
      embed: async (_env, texts) => {
        aiCalls += 1;
        return texts.map(vectorFor);
      },
    });
    const env = makeEnv(vectorize);
    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };

    const created = await app.request(
      '/v1/indexes',
      { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Corrective Docs' }) },
      env,
    );
    const index = (await created.json()) as IndexRecord;
    await app.request(
      `/v1/indexes/${index.id}/ingest-vectors`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          chunks: [{
            id: 'chunk-corrective',
            document_id: 'doc-corrective',
            document_content: 'billing guardrails are documented here',
            content: 'billing guardrails are documented here',
            embedding: vectorFor('unrelated'),
            chunk_index: 0,
          }],
        }),
      },
      env,
    );

    const query = await app.request(
      `/v1/indexes/${index.id}/query`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          query: 'where are billing guardrails documented?',
          top_k: 1,
          mode: 'semantic',
          min_score: 999,
        }),
      },
      env,
    );
    const result = (await query.json()) as { data: Array<{ chunk_content: string; metadata: JsonRecord }> };
    const timing = JSON.parse(query.headers.get('X-RAG-Timing') ?? '{}');

    expect(query.status).toBe(200);
    expect(timing).toMatchObject({
      retrieval: 'corrective_hybrid',
      corrective_reason: 'semantic_empty',
      corrective_lexical_results: 1,
      corrective_semantic_results: 0,
      rerank: 'keyword_mmr',
    });
    expect(result.data[0]?.chunk_content).toContain('billing guardrails');
    expect(result.data[0]?.metadata.hybrid_sources).toEqual(['lexical']);
    expect(aiCalls).toBe(1);
    expect(vectorQueries).toBe(1);
  });

  it('corrects low-score semantic retrieval with lexical evidence', async () => {
    const repo = new MemoryRepository();
    const vectorize = new FakeVectorize();
    const app = createApp({
      makeRepository: () => repo,
      embed: async (_env, texts) => texts.map(vectorFor),
    });
    const env = makeEnv(vectorize);
    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };

    const created = await app.request(
      '/v1/indexes',
      { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Low Score Corrective Docs' }) },
      env,
    );
    const index = (await created.json()) as IndexRecord;
    await app.request(
      `/v1/indexes/${index.id}/ingest-vectors`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          chunks: [
            {
              id: 'chunk-lexical-low-score',
              document_id: 'doc-lexical-low-score',
              document_content: 'dashboard cache is documented here',
              content: 'dashboard cache is documented here',
              embedding: vectorFor('unrelated'),
              chunk_index: 0,
            },
            {
              id: 'chunk-semantic-low-score',
              document_id: 'doc-semantic-low-score',
              document_content: 'unrelated semantic neighbor',
              content: 'unrelated semantic neighbor',
              embedding: vectorFor('semantic'),
              chunk_index: 1,
            },
          ],
        }),
      },
      env,
    );
    vectorize.query = async () => ({
      matches: [{
        id: 'chunk-semantic-low-score',
        score: 0.46,
        metadata: {
          document_id: 'doc-semantic-low-score',
          chunk_content: 'unrelated semantic neighbor',
          chunk_metadata: '{}',
        },
      }],
    });

    const query = await app.request(
      `/v1/indexes/${index.id}/query`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ query: 'what mentions dashboard cache?', top_k: 1, mode: 'semantic' }),
      },
      env,
    );
    const result = (await query.json()) as { data: Array<{ chunk_id: string; chunk_content: string; metadata: JsonRecord }> };
    const timing = JSON.parse(query.headers.get('X-RAG-Timing') ?? '{}');

    expect(query.status).toBe(200);
    expect(timing).toMatchObject({
      retrieval: 'corrective_hybrid',
      corrective_reason: 'semantic_low_score',
      corrective_lexical_results: 1,
      corrective_semantic_results: 1,
    });
    expect(result.data[0]?.chunk_id).toBe('chunk-lexical-low-score');
    expect(result.data[0]?.chunk_content).toContain('dashboard cache');
    expect(result.data[0]?.metadata.hybrid_sources).toEqual(['lexical']);
  });

  it('benchmarks warmed text queries inside the Worker', async () => {
    const repo = new MemoryRepository();
    const vectorize = new FakeVectorize();
    let aiCalls = 0;
    let vectorQueries = 0;
    const originalQuery = vectorize.query.bind(vectorize);
    vectorize.query = async (...args) => {
      vectorQueries += 1;
      return originalQuery(...args);
    };
    const app = createApp({
      makeRepository: () => repo,
      queryCache: new TtlCache({ enabled: true, ttlMs: 60_000, maxEntries: 100 }),
      embeddingCache: new TtlCache({ enabled: true, ttlMs: 60_000, maxEntries: 100 }),
      embed: async (_env, texts) => {
        aiCalls += 1;
        return texts.map(vectorFor);
      },
    });
    const env = makeEnv(vectorize);
    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };

    const created = await app.request(
      '/v1/indexes',
      { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Bench Docs' }) },
      env,
    );
    const index = (await created.json()) as IndexRecord;
    await app.request(
      `/v1/indexes/${index.id}/ingest-vectors`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          chunks: [
            {
              id: 'chunk-bench',
              document_id: 'doc-bench',
              document_content: 'alpha benchmark document',
              content: 'alpha benchmark document',
              embedding: vectorFor('alpha'),
              chunk_index: 0,
            },
          ],
        }),
      },
      env,
    );

    const bench = await app.request(
      `/v1/indexes/${index.id}/benchmark-query`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ queries: ['alpha'], warmup: 1, repeat: 3, top_k: 1, mode: 'semantic' }),
      },
      env,
    );
    const result = (await bench.json()) as {
      cache_hit_rate: number;
      latency: { count: number; p95_ms: number; p99_ms: number };
      measurements: Array<{ cache: string; result_count: number }>;
    };

    expect(bench.status).toBe(200);
    expect(result.latency.count).toBe(3);
    expect(result.latency).toHaveProperty('p99_ms');
    expect(result.cache_hit_rate).toBe(1);
    expect(result.measurements).toHaveLength(3);
    expect(result.measurements.every((row) => row.cache === 'hit' && row.result_count === 1)).toBe(true);
    expect(aiCalls).toBe(1);
    expect(vectorQueries).toBe(1);
  });

  it('uses the shared D1 query cache across app instances', async () => {
    const repo = new MemoryRepository();
    const vectorize = new FakeVectorize();
    const db = new FakeQueryCacheD1();
    let aiCalls = 0;
    let vectorQueries = 0;
    const originalQuery = vectorize.query.bind(vectorize);
    vectorize.query = async (...args) => {
      vectorQueries += 1;
      return originalQuery(...args);
    };
    const embed = async (_env: Env, texts: string[]) => {
      aiCalls += 1;
      return texts.map(vectorFor);
    };
    const env = makeEnv(vectorize, db as unknown as D1Database);
    env.RAG_SHARED_QUERY_CACHE_ENABLED = 'true';
    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };
    const firstApp = createApp({
      makeRepository: () => repo,
      queryCache: new TtlCache({ enabled: true, ttlMs: 60_000, maxEntries: 100 }),
      embeddingCache: new TtlCache({ enabled: true, ttlMs: 60_000, maxEntries: 100 }),
      embed,
    });

    const created = await firstApp.request(
      '/v1/indexes',
      { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Shared Cache Docs' }) },
      env,
    );
    const index = (await created.json()) as IndexRecord;
    await firstApp.request(
      `/v1/indexes/${index.id}/ingest-vectors`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          chunks: [{
            id: 'chunk-shared-cache',
            document_id: 'doc-shared-cache',
            document_content: 'alpha shared cache document',
            content: 'alpha shared cache document',
            embedding: vectorFor('alpha'),
            chunk_index: 0,
          }],
        }),
      },
      env,
    );
    const firstQuery = await firstApp.request(
      `/v1/indexes/${index.id}/query`,
      { method: 'POST', headers: auth, body: JSON.stringify({ query: 'alpha', top_k: 1, mode: 'semantic' }) },
      env,
    );

    const secondApp = createApp({
      makeRepository: () => repo,
      queryCache: new TtlCache({ enabled: true, ttlMs: 60_000, maxEntries: 100 }),
      embeddingCache: new TtlCache({ enabled: true, ttlMs: 60_000, maxEntries: 100 }),
      embed,
    });
    const secondQuery = await secondApp.request(
      `/v1/indexes/${index.id}/query`,
      { method: 'POST', headers: auth, body: JSON.stringify({ query: 'alpha', top_k: 1, mode: 'semantic' }) },
      env,
    );

    expect(firstQuery.headers.get('X-RAG-Cache')).toBe('miss');
    expect(secondQuery.headers.get('X-RAG-Cache')).toBe('hit');
    expect(JSON.parse(secondQuery.headers.get('X-RAG-Timing') ?? '{}')).toMatchObject({
      cache_layer: 'd1',
    });
    expect(aiCalls).toBe(1);
    expect(vectorQueries).toBe(1);
  });

  it('prevents a tenant from querying another tenant index', async () => {
    const repo = new MemoryRepository();
    const vectorize = new FakeVectorize();
    const app = createApp({ makeRepository: () => repo });
    const env = makeEnv(vectorize);

    const created = await app.request(
      '/v1/indexes',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Private' }),
      },
      env,
    );
    const index = (await created.json()) as IndexRecord;

    const query = await app.request(
      `/v1/indexes/${index.id}/query-vector`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer key-b', 'Content-Type': 'application/json' },
        body: JSON.stringify({ vector: vectorOf(index.dimensions) }),
      },
      env,
    );

    expect(query.status).toBe(404);
  });

  it('rejects caller-supplied vectors that do not match the index dimensions', async () => {
    const repo = new MemoryRepository();
    const vectorize = new FakeVectorize();
    const app = createApp({ makeRepository: () => repo });
    const env = makeEnv(vectorize);
    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };

    const created = await app.request(
      '/v1/indexes',
      { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Dimension Guard' }) },
      env,
    );
    const index = (await created.json()) as IndexRecord;

    const ingest = await app.request(
      `/v1/indexes/${index.id}/ingest-vectors`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          chunks: [{
            id: 'bad-dim-chunk',
            document_id: 'bad-dim-doc',
            content: 'bad dimension vector',
            embedding: [1, 0, 0],
          }],
        }),
      },
      env,
    );
    const query = await app.request(
      `/v1/indexes/${index.id}/query-vector`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ vector: [1, 0, 0] }),
      },
      env,
    );

    expect(ingest.status).toBe(400);
    expect(await ingest.json()).toMatchObject({
      error: `embedding dimensions 3 do not match expected dimensions ${index.dimensions}`,
    });
    expect(query.status).toBe(400);
    expect(await query.json()).toMatchObject({
      error: `vector dimensions 3 do not match expected dimensions ${index.dimensions}`,
    });
    expect(vectorize.vectors.size).toBe(0);
    expect(vectorize.queries).toHaveLength(0);
  });

  it('does not let caller filters override server tenant and index scope', async () => {
    const repo = new MemoryRepository();
    const vectorize = new FakeVectorize();
    const app = createApp({ makeRepository: () => repo });
    const env = makeEnv(vectorize);
    const authA = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };
    const authB = { Authorization: 'Bearer key-b', 'Content-Type': 'application/json' };

    const indexA = (await (await app.request(
      '/v1/indexes',
      { method: 'POST', headers: authA, body: JSON.stringify({ name: 'Tenant A' }) },
      env,
    )).json()) as IndexRecord;
    const indexB = (await (await app.request(
      '/v1/indexes',
      { method: 'POST', headers: authB, body: JSON.stringify({ name: 'Tenant B' }) },
      env,
    )).json()) as IndexRecord;

    await app.request(
      `/v1/indexes/${indexA.id}/ingest-vectors`,
      {
        method: 'POST',
        headers: authA,
        body: JSON.stringify({
          chunks: [{
            id: 'chunk-a',
            document_id: 'doc-a',
            document_content: 'tenant a document',
            content: 'tenant a secret',
            embedding: vectorOf(indexA.dimensions, 10),
            chunk_index: 0,
          }],
        }),
      },
      env,
    );
    await app.request(
      `/v1/indexes/${indexB.id}/ingest-vectors`,
      {
        method: 'POST',
        headers: authB,
        body: JSON.stringify({
          chunks: [{
            id: 'chunk-b',
            document_id: 'doc-b',
            document_content: 'tenant b document',
            content: 'tenant b visible',
            embedding: vectorOf(indexB.dimensions),
            chunk_index: 0,
          }],
        }),
      },
      env,
    );

    const query = await app.request(
      `/v1/indexes/${indexB.id}/query-vector`,
      {
        method: 'POST',
        headers: authB,
        body: JSON.stringify({
          vector: vectorOf(indexB.dimensions),
          filter: { tenant: 'tenant-a', index_id: indexA.id },
        }),
      },
      env,
    );
    const result = (await query.json()) as { data: Array<{ chunk_content: string }> };

    expect(query.status).toBe(200);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.chunk_content).toBe('tenant b visible');
    expect(vectorize.queries.at(-1)).toMatchObject({
      namespace: `tenant-b:${indexB.id}`,
      returnMetadata: 'all',
    });
    expect(vectorize.queries.at(-1)?.filter).toBeUndefined();
  });

  it('uses the index existence cache for queries after creating an index', async () => {
    const repo = new MemoryRepository();
    const vectorize = new FakeVectorize();
    const app = createApp({ makeRepository: () => repo });
    const env = makeEnv(vectorize);
    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };

    const created = await app.request(
      '/v1/indexes',
      { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Cached Index' }) },
      env,
    );
    const index = (await created.json()) as IndexRecord;
    await app.request(
      `/v1/indexes/${index.id}/ingest-vectors`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          chunks: [{
            id: 'chunk-index-cache',
            document_id: 'doc-index-cache',
            document_content: 'alpha cache document',
            content: 'alpha cache document',
            embedding: vectorOf(index.dimensions),
            chunk_index: 0,
          }],
        }),
      },
      env,
    );

    repo.getIndexCalls = 0;
    const query = await app.request(
      `/v1/indexes/${index.id}/query-vector`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ vector: vectorOf(index.dimensions), top_k: 1 }),
      },
      env,
    );

    expect(query.status).toBe(200);
    expect(repo.getIndexCalls).toBe(0);
  });

  it('accepts pre-embedded chunks for backfill without calling AI', async () => {
    const repo = new MemoryRepository();
    const vectorize = new FakeVectorize();
    let embedCalls = 0;
    const app = createApp({
      makeRepository: () => repo,
      embed: async () => {
        embedCalls += 1;
        return [];
      },
    });
    const env = makeEnv(vectorize);
    const auth = { Authorization: 'Bearer key-a', 'Content-Type': 'application/json' };

    const created = await app.request(
      '/v1/indexes',
      { method: 'POST', headers: auth, body: JSON.stringify({ name: 'Backfill' }) },
      env,
    );
    const index = (await created.json()) as IndexRecord;

    const backfill = await app.request(
      `/v1/indexes/${index.id}/ingest-vectors`,
      {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({
          chunks: [
            {
              id: 'chunk-1',
              document_id: 'doc-1',
              document_content: 'alpha original document',
              content: 'alpha original',
              embedding: vectorOf(index.dimensions),
              chunk_index: 0,
              metadata: { imported: true },
            },
          ],
        }),
      },
      env,
    );

    expect(backfill.status).toBe(201);
    expect(await backfill.json()).toEqual({ upserted: 1 });
    expect(embedCalls).toBe(0);
    expect(repo.documents.get('doc-1')?.content).toBe('alpha original document');
    expect(repo.chunks.get('chunk-1')?.metadata).toEqual({ imported: true });
    expect(vectorize.vectors.get('chunk-1')?.values).toEqual(vectorOf(index.dimensions));
  });
});
