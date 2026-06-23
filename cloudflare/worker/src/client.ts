export interface KnowledgebaseClientOptions {
  baseUrl: string;
  serviceKey: string;
  fetch?: typeof fetch;
}

export interface KnowledgebaseIngestTextInput {
  domain: string;
  text: string;
  title?: string;
  async?: boolean;
  idempotency_key?: string;
  embedding_model?: string;
  embedding_provider?: string;
  metadata?: Record<string, unknown>;
}

export interface KnowledgebaseQueryInput {
  domain: string;
  question: string;
  top_k?: number;
  mode?: 'auto' | 'semantic' | 'lexical' | 'hybrid';
  session_id?: string;
  answer_mode?: 'extractive' | 'workers_ai';
  answer_model?: string;
}

export interface KnowledgebaseSearchInput {
  domain: string;
  query: string;
  top_k?: number;
  mode?: 'auto' | 'semantic' | 'lexical' | 'hybrid';
}

export interface KnowledgebaseResult {
  document_id: string;
  chunk_id: string;
  chunk_content: string;
  score: number;
  metadata?: Record<string, unknown>;
}

export interface KnowledgebaseAnswer {
  project: string;
  domain: string;
  index_id: string | null;
  route: string;
  ai_used: boolean;
  trace_id: string;
  session_id: string | null;
  answer_mode: string;
  answer_model: string | null;
  question: string;
  answer: string;
  citations: Array<Record<string, unknown>>;
  confidence: Record<string, unknown>;
  data: KnowledgebaseResult[];
}

export class KnowledgebaseClient {
  private readonly baseUrl: string;
  private readonly serviceKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: KnowledgebaseClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.serviceKey = options.serviceKey;
    this.fetchImpl = options.fetch ?? fetch;
  }

  ingestText(input: KnowledgebaseIngestTextInput): Promise<Record<string, unknown>> {
    return this.request('/v1/kb/ingest/text', input);
  }

  search(input: KnowledgebaseSearchInput): Promise<{ data: KnowledgebaseResult[] }> {
    return this.request('/v1/kb/search', input);
  }

  query(input: KnowledgebaseQueryInput): Promise<KnowledgebaseAnswer> {
    return this.request('/v1/kb/query', input);
  }

  private async request<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const payload = await res.json().catch(() => ({})) as { error?: unknown };
    if (!res.ok) {
      const message = typeof payload?.error === 'string' ? payload.error : `Knowledgebase request failed: ${res.status}`;
      throw new Error(message);
    }
    return payload as T;
  }
}
