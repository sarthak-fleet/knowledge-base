import type {
  CreateChunkInput,
  CreateDocumentInput,
  CreateIndexInput,
  LexicalChunkRecord,
  Repository,
} from './repository';
import type { ChunkRecord, DocumentRecord, IndexRecord, JsonRecord } from './types';

type StoredDocument = Omit<DocumentRecord, 'metadata'> & { metadata: string };
type StoredChunk = Omit<ChunkRecord, 'metadata'> & { metadata: string };
type StoredLexicalChunk = StoredChunk & { lexical_score: number };

function parseJsonRecord(raw: string | null): JsonRecord {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as JsonRecord)
      : {};
  } catch {
    return {};
  }
}

function rowToDocument(row: StoredDocument): DocumentRecord {
  return { ...row, metadata: parseJsonRecord(row.metadata) };
}

function rowToChunk(row: StoredChunk): ChunkRecord {
  return { ...row, metadata: parseJsonRecord(row.metadata) };
}

function rowToLexicalChunk(row: StoredLexicalChunk): LexicalChunkRecord {
  return { ...rowToChunk(row), lexical_score: row.lexical_score };
}

function escapeLikeToken(token: string): string {
  return token.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

export class D1Repository implements Repository {
  constructor(private readonly db: D1Database) {}

  async createIndex(input: CreateIndexInput): Promise<IndexRecord> {
    await this.db
      .prepare(
        `INSERT INTO indexes (id, tenant, name, external_id, dimensions, metric)
         VALUES (?, ?, ?, ?, 768, 'cosine')`,
      )
      .bind(input.id, input.tenant, input.name, input.externalId)
      .run();
    const created = await this.getIndex(input.tenant, input.id);
    if (!created) throw new Error('failed to create index');
    return created;
  }

  async listIndexes(tenant: string): Promise<IndexRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT id, tenant, name, external_id, dimensions, metric, created_at
           FROM indexes
          WHERE tenant = ?
          ORDER BY created_at DESC`,
      )
      .bind(tenant)
      .all<IndexRecord>();
    return result.results ?? [];
  }

  async getIndex(tenant: string, id: string): Promise<IndexRecord | null> {
    return await this.db
      .prepare(
        `SELECT id, tenant, name, external_id, dimensions, metric, created_at
           FROM indexes
          WHERE tenant = ? AND id = ?`,
      )
      .bind(tenant, id)
      .first<IndexRecord>();
  }

  async getIndexByExternalId(tenant: string, externalId: string): Promise<IndexRecord | null> {
    return await this.db
      .prepare(
        `SELECT id, tenant, name, external_id, dimensions, metric, created_at
           FROM indexes
          WHERE tenant = ? AND external_id = ?
          ORDER BY created_at DESC
          LIMIT 1`,
      )
      .bind(tenant, externalId)
      .first<IndexRecord>();
  }

  async deleteIndex(tenant: string, id: string): Promise<void> {
    await this.db.prepare('DELETE FROM indexes WHERE tenant = ? AND id = ?').bind(tenant, id).run();
  }

  async createDocument(input: CreateDocumentInput): Promise<DocumentRecord> {
    await this.db
      .prepare(
        `INSERT INTO documents (id, index_id, tenant, external_id, content, metadata)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.id,
        input.indexId,
        input.tenant,
        input.externalId,
        input.content,
        JSON.stringify(input.metadata),
      )
      .run();
    const created = await this.getDocument(input.tenant, input.id);
    if (!created) throw new Error('failed to create document');
    return created;
  }

  async listDocuments(
    tenant: string,
    indexId: string,
    limit: number,
    offset: number,
  ): Promise<DocumentRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT id, index_id, tenant, external_id, content, metadata, created_at
           FROM documents
          WHERE tenant = ? AND index_id = ?
          ORDER BY created_at DESC
          LIMIT ? OFFSET ?`,
      )
      .bind(tenant, indexId, limit, offset)
      .all<StoredDocument>();
    return (result.results ?? []).map(rowToDocument);
  }

  async getDocument(tenant: string, id: string): Promise<DocumentRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT id, index_id, tenant, external_id, content, metadata, created_at
           FROM documents
          WHERE tenant = ? AND id = ?`,
      )
      .bind(tenant, id)
      .first<StoredDocument>();
    return row ? rowToDocument(row) : null;
  }

  async deleteDocument(tenant: string, id: string): Promise<void> {
    await this.db.prepare('DELETE FROM documents WHERE tenant = ? AND id = ?').bind(tenant, id).run();
  }

  async insertChunks(chunks: CreateChunkInput[]): Promise<void> {
    if (chunks.length === 0) return;
    const statements = chunks.map((chunk) =>
      this.db
        .prepare(
          `INSERT OR REPLACE INTO chunks
             (id, document_id, index_id, tenant, content, chunk_index, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          chunk.id,
          chunk.documentId,
          chunk.indexId,
          chunk.tenant,
          chunk.content,
          chunk.chunkIndex,
          JSON.stringify(chunk.metadata),
        ),
    );
    await this.db.batch(statements);
  }

  async getChunksByIds(tenant: string, ids: string[]): Promise<ChunkRecord[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const result = await this.db
      .prepare(
        `SELECT id, document_id, index_id, tenant, content, chunk_index, metadata, created_at
           FROM chunks
          WHERE tenant = ? AND id IN (${placeholders})`,
      )
      .bind(tenant, ...ids)
      .all<StoredChunk>();
    return (result.results ?? []).map(rowToChunk);
  }

  async listChunksForIndex(tenant: string, indexId: string, limit: number): Promise<ChunkRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT id, document_id, index_id, tenant, content, chunk_index, metadata, created_at
           FROM chunks
          WHERE tenant = ? AND index_id = ?
          ORDER BY chunk_index ASC
          LIMIT ?`,
      )
      .bind(tenant, indexId, limit)
      .all<StoredChunk>();
    return (result.results ?? []).map(rowToChunk);
  }

  async searchLexicalChunks(
    tenant: string,
    indexId: string,
    tokens: string[],
    limit: number,
  ): Promise<LexicalChunkRecord[]> {
    if (tokens.length === 0) return [];
    const patterns = tokens.map((token) => `%${escapeLikeToken(token)}%`);
    const scoreExpr = tokens.map(() => `CASE WHEN LOWER(content) LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END`).join(' + ');
    const whereExpr = tokens.map(() => `LOWER(content) LIKE ? ESCAPE '\\'`).join(' OR ');
    const result = await this.db
      .prepare(
        `SELECT id, document_id, index_id, tenant, content, chunk_index, metadata, created_at,
                (${scoreExpr}) AS lexical_score
           FROM chunks
          WHERE tenant = ? AND index_id = ? AND (${whereExpr})
          ORDER BY lexical_score DESC, chunk_index ASC
          LIMIT ?`,
      )
      .bind(...patterns, tenant, indexId, ...patterns, limit)
      .all<StoredLexicalChunk>();
    return (result.results ?? []).map(rowToLexicalChunk);
  }

  async getChunkIdsForDocument(tenant: string, documentId: string): Promise<string[]> {
    const result = await this.db
      .prepare('SELECT id FROM chunks WHERE tenant = ? AND document_id = ?')
      .bind(tenant, documentId)
      .all<{ id: string }>();
    return (result.results ?? []).map((row) => row.id);
  }

  async getChunkIdsForIndex(tenant: string, indexId: string): Promise<string[]> {
    const result = await this.db
      .prepare('SELECT id FROM chunks WHERE tenant = ? AND index_id = ?')
      .bind(tenant, indexId)
      .all<{ id: string }>();
    return (result.results ?? []).map((row) => row.id);
  }
}
