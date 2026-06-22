import type { ChunkRecord, DocumentRecord, IndexRecord, JsonRecord } from './types';

export interface CreateIndexInput {
  id: string;
  tenant: string;
  name: string;
  externalId: string | null;
  dimensions: number;
  embeddingModel?: string | null | undefined;
  embeddingProvider?: string | null | undefined;
}

export interface CreateDocumentInput {
  id: string;
  tenant: string;
  indexId: string;
  externalId: string | null;
  content: string;
  metadata: JsonRecord;
}

export interface CreateChunkInput {
  id: string;
  tenant: string;
  indexId: string;
  documentId: string;
  content: string;
  chunkIndex: number;
  metadata: JsonRecord;
}

export interface LexicalChunkRecord extends ChunkRecord {
  lexical_score: number;
}

export interface Repository {
  createIndex(input: CreateIndexInput): Promise<IndexRecord>;
  listIndexes(tenant: string): Promise<IndexRecord[]>;
  getIndex(tenant: string, id: string): Promise<IndexRecord | null>;
  getIndexByExternalId(tenant: string, externalId: string): Promise<IndexRecord | null>;
  deleteIndex(tenant: string, id: string): Promise<void>;
  createDocument(input: CreateDocumentInput): Promise<DocumentRecord>;
  listDocuments(tenant: string, indexId: string, limit: number, offset: number): Promise<DocumentRecord[]>;
  getDocument(tenant: string, id: string): Promise<DocumentRecord | null>;
  deleteDocument(tenant: string, id: string): Promise<void>;
  deleteChunksByIds(tenant: string, ids: string[]): Promise<void>;
  insertChunks(chunks: CreateChunkInput[]): Promise<void>;
  getChunksByIds(tenant: string, ids: string[]): Promise<ChunkRecord[]>;
  listChunksForIndex(tenant: string, indexId: string, limit: number): Promise<ChunkRecord[]>;
  searchLexicalChunks(
    tenant: string,
    indexId: string,
    tokens: string[],
    limit: number,
  ): Promise<LexicalChunkRecord[]>;
  getChunkIdsForDocument(tenant: string, documentId: string): Promise<string[]>;
  getChunkIdsForIndex(tenant: string, indexId: string): Promise<string[]>;
}
