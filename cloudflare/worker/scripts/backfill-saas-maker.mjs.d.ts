export function normalizeInput(raw: string | unknown): {
  index: { name: string; external_id?: string };
  chunks: Array<{
    id: string;
    document_id: string;
    document_content: string;
    document_external_id?: string;
    content: string;
    embedding: number[];
    chunk_index: number;
    metadata: Record<string, unknown>;
  }>;
  dimensions: number;
};

export function backfill(input: {
  baseUrl: string;
  key: string;
  input: string | unknown;
  indexName: string;
  externalId: string;
  batchSize: number;
  dryRun: boolean;
}): Promise<Record<string, unknown>>;
