import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { Hono, type Context } from 'hono';
import { requireServiceKey, type Variables } from './auth';
import { parseCacheOptions, stableStringify, TtlCache } from './cache';
import { chunkText } from './chunk';
import { D1Repository } from './d1-repository';
import { parseUploadBytesWithCloudflare } from './document-parser';
import { embedTexts } from './embeddings';
import { freeAiChatRaw, freeAiEmbed, freeAiSynthEnabled, freeAiSynthModel } from './free-ai';
import {
  D1MetadataRepository,
  parseFileRegistrationBody,
  safeObjectKeySegment,
  type EntityRecord,
  type EntityRelationshipRecord,
  type FileRecord,
  type IngestJobRecord,
  type MetadataRepository,
  type QueryTraceRecord,
} from './kb-metadata-repository';
import type { CreateChunkInput, Repository } from './repository';
import { inferSchema, recordsFromUnknown, type DomainSchema } from './schema-inference';
import { TESTING_UI_HTML } from './testing-ui';
import type { ChunkRecord, CitationRecord, Env, JsonRecord, KbIngestQueueMessage, SearchResult, VectorizeVector } from './types';

const MAX_DOC_SIZE = 1_000_000;
const MAX_TOP_K = 50;
const MAX_LEXICAL_CHUNKS = 5000;
const MAX_BENCHMARK_QUERIES = 20;
const MAX_BENCHMARK_REPEAT = 200;
const MAX_BENCHMARK_WARMUP = 20;
const MAX_EVAL_CASES = 100;
const CORRECTIVE_SEMANTIC_MIN_SCORE = 0.35;
const DEFAULT_BASE_EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';
const DEFAULT_SMALL_EMBEDDING_MODEL = '@cf/baai/bge-small-en-v1.5';
const DEFAULT_RERANKER_MODEL = '@cf/baai/bge-reranker-base';
const DEFAULT_ANSWER_MODEL = '@cf/meta/llama-3.1-8b-instruct';
const WORKER_VERSION = '0.1.0';
const WORKER_DEPLOY_FINGERPRINT = 'knowledgebase-cloudflare-full-port-2026-06-21';
const LEXICAL_SCORING_VERSION = 'bm25_fuzzy_sparse_v2';
const MAX_RERANK_CONTEXT_CHARS = 1200;
const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'for',
  'from',
  'how',
  'the',
  'this',
  'that',
  'what',
  'when',
  'where',
  'which',
  'with',
]);
type AppContext = Context<{ Bindings: Env; Variables: Variables }>;
type QueryPayload = { data: SearchResult[] };
type TimingValue = number | string | boolean;
type RagTiming = Record<string, TimingValue>;
type CacheStatus = 'hit' | 'miss';
type SemanticModel = 'base' | 'small';
type RerankModel = 'keyword' | 'workers_ai';
type AnswerMode = 'extractive' | 'workers_ai';
type QueryPlanVariantKind = 'rewrite' | 'decompose';
type QueryPlanVariant = { query: string; kind: QueryPlanVariantKind };
type QueryPlan = { variants: QueryPlanVariant[] };
type FetchLikeApp = {
  fetch(request: Request, env: Env): Response | Promise<Response>;
};
type QueueCapableApp = ReturnType<typeof createApp> & {
  processIngestQueue(batch: MessageBatch<KbIngestQueueMessage>, env: Env): Promise<void>;
};

export class KbIngestWorkflow extends WorkflowEntrypoint<Env, KbIngestQueueMessage> {
  async run(
    event: Readonly<WorkflowEvent<KbIngestQueueMessage>>,
    step: WorkflowStep,
  ): Promise<JsonRecord> {
    const payload = await step.do('validate ingest payload', async () => {
      const body = event.payload;
      if (!body || body.kind !== 'kb_ingest' || !body.project || !body.domain) {
        throw new Error('invalid knowledgebase ingest payload');
      }
      return {
        kind: 'kb_ingest' as const,
        project: body.project,
        domain: body.domain,
        ...(body.run_id ? { run_id: body.run_id } : {}),
        ...(body.file_ids ? { file_ids: body.file_ids } : {}),
        ...(body.markdown_conversion ? { markdown_conversion: body.markdown_conversion } : {}),
        ...(body.vision_ocr_model ? { vision_ocr_model: body.vision_ocr_model } : {}),
        ...(body.chunking ? { chunking: body.chunking } : {}),
      };
    });

    await step.do('enqueue ingest queue message', {
      retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
      timeout: '1 minute',
    }, async () => {
      if (!this.env.INGEST_QUEUE) throw new Error('INGEST_QUEUE is not configured');
      const response = await this.env.INGEST_QUEUE.send(payload);
      return {
        run_id: payload.run_id ?? null,
        backlog_count: response.metadata.metrics.backlogCount,
        backlog_bytes: response.metadata.metrics.backlogBytes,
      };
    });

    return {
      run_id: payload.run_id ?? null,
      project: payload.project,
      domain: payload.domain,
      queued: true,
    };
  }
}

interface AppOptions {
  makeRepository?: (env: Env) => Repository;
  makeMetadataRepository?: (env: Env) => MetadataRepository;
  embed?: typeof embedTexts;
  queryCache?: TtlCache<QueryPayload>;
  embeddingCache?: TtlCache<number[]>;
  indexCache?: TtlCache<boolean>;
  lexicalChunkCache?: TtlCache<ChunkRecord[]>;
}

interface CreateIndexBody {
  name?: string;
  external_id?: string;
}

interface UpsertDomainBody {
  name?: string;
  description?: string;
}

interface InferSchemaBody {
  domain?: string;
  name?: string;
  records?: JsonRecord[];
  sample_texts?: string[];
  input?: unknown;
  save_draft?: boolean;
}

interface IngestBody {
  documents?: Array<{
    external_id?: string;
    content?: string;
    metadata?: JsonRecord;
  }>;
  chunking?: {
    size?: number;
    overlap?: number;
  };
}

interface QueryBody {
  query?: string;
  vector?: number[];
  top_k?: number;
  filter?: JsonRecord;
  min_score?: number;
  mode?: 'auto' | 'semantic' | 'lexical' | 'hybrid';
  semantic_model?: SemanticModel;
  rerank?: boolean;
  rerank_model?: RerankModel;
  mmr?: boolean;
  query_rewrite?: boolean;
  query_decompose?: boolean;
}

interface BenchmarkQueryBody {
  queries?: string[];
  repeat?: number;
  warmup?: number;
  top_k?: number;
  filter?: JsonRecord;
  min_score?: number;
  mode?: 'auto' | 'semantic' | 'lexical' | 'hybrid';
  semantic_model?: SemanticModel;
  rerank?: boolean;
  rerank_model?: RerankModel;
  mmr?: boolean;
  query_rewrite?: boolean;
  query_decompose?: boolean;
}

interface SearchEvalCase {
  id?: string;
  query?: string;
  expected_text?: string;
  expected_chunk_ids?: string[];
  expected_document_ids?: string[];
}

interface SearchEvalBody {
  index_id?: string;
  cases?: SearchEvalCase[];
  top_k?: number;
  mode?: 'auto' | 'semantic' | 'lexical' | 'hybrid';
  semantic_model?: SemanticModel;
  rerank?: boolean;
  rerank_model?: RerankModel;
  mmr?: boolean;
  query_rewrite?: boolean;
  query_decompose?: boolean;
}

interface QueryEvalCase extends SearchEvalCase {
  question?: string;
  expected_answer_text?: string;
  expected_citation_text?: string;
}

interface QueryEvalBody {
  domain?: string;
  cases?: QueryEvalCase[];
  top_k?: number;
  mode?: 'auto' | 'semantic' | 'lexical' | 'hybrid';
  semantic_model?: SemanticModel;
  ai_judge?: boolean;
  judge_model?: string;
  rerank?: boolean;
  rerank_model?: RerankModel;
  answer_mode?: AnswerMode;
  answer_model?: string;
  mmr?: boolean;
  query_rewrite?: boolean;
  query_decompose?: boolean;
}

interface ParseEvalCase {
  id?: string;
  filename?: string;
  mime?: string;
  content?: string;
  content_base64?: string;
  expected_text?: string | string[];
  expected_parser?: string;
  markdown_conversion?: string;
  vision_ocr_model?: string;
  min_text_length?: number;
}

interface ParseEvalBody {
  domain?: string;
  cases?: ParseEvalCase[];
  markdown_conversion?: string;
  vision_ocr_model?: string;
  include_text_preview?: boolean;
}

interface KbIngestRunBody {
  domain?: string;
  file_ids?: string[];
  async?: boolean;
  run_id?: string;
  markdown_conversion?: string;
  vision_ocr_model?: string;
  chunking?: {
    size?: number;
    overlap?: number;
  };
}

interface KbRecordIngestBody {
  domain?: string;
  kind?: string;
  type?: string;
  data?: unknown;
}

interface KbTextIngestBody {
  domain?: string;
  kind?: string;
  type?: string;
  title?: string;
  text?: string;
  async?: boolean;
  chunking?: KbIngestRunBody['chunking'];
}

interface SourceImportBody {
  domain?: string;
  source?: string;
  config?: {
    urls?: string[];
    timeout_s?: number;
    tickers?: string[];
    ciks?: string[];
    forms?: string[];
    days?: number;
    per_ticker_per_form?: number;
    limit_total?: number;
    user_agent?: string;
  };
  auto_ingest?: boolean;
}

interface EdgarTickerRow {
  cik_str?: number | string;
  ticker?: string;
  title?: string;
}

interface EdgarSubmissionsResponse {
  cik?: string;
  name?: string;
  filings?: {
    recent?: Record<string, unknown[]>;
  };
}

interface EdgarFilingCandidate {
  ticker: string | null;
  cik: string;
  cikNumber: string;
  companyName: string | null;
  accession: string;
  accessionNoDashes: string;
  form: string;
  filingDate: string;
  primaryDocument: string;
  url: string;
  filename: string;
}

interface KbSearchBody {
  domain?: string;
  query?: string;
  top_k?: number;
  mode?: 'auto' | 'semantic' | 'lexical' | 'hybrid';
  semantic_model?: SemanticModel;
  rerank?: boolean;
  rerank_model?: RerankModel;
  mmr?: boolean;
  query_rewrite?: boolean;
  query_decompose?: boolean;
}

interface KbQueryBody extends KbSearchBody {
  question?: string;
  scope?: string;
  session_id?: string;
  answer_mode?: AnswerMode;
  answer_model?: string;
}

interface KbSessionBody {
  domain?: string;
  id?: string;
  entries?: JsonRecord[];
}

interface KbAnswerPayload {
  project: string;
  domain: string;
  index_id: string | null;
  route: string;
  ai_used: boolean;
  trace_id: string;
  session_id: string | null;
  answer_mode: AnswerMode;
  answer_model: string | null;
  question: string;
  answer: string;
  citations: CitationRecord[];
  confidence: JsonRecord;
  data: SearchResult[];
}

interface IngestVectorsBody {
  chunks?: Array<{
    id?: string;
    document_id?: string;
    document_content?: string;
    document_external_id?: string;
    content?: string;
    embedding?: number[];
    chunk_index?: number;
    metadata?: JsonRecord;
  }>;
}

function jsonRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function clampTopK(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value || 5);
  if (!Number.isFinite(parsed)) return 5;
  return Math.min(Math.max(Math.trunc(parsed), 1), MAX_TOP_K);
}

function sortResultsByVectorOrder(ids: string[], rows: ChunkRecord[]): ChunkRecord[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.map((id) => byId.get(id)).filter((row): row is ChunkRecord => Boolean(row));
}

function fuseHybridResults(lexical: QueryPayload | null, semantic: QueryPayload, topK: number): QueryPayload {
  const fused = new Map<string, SearchResult & {
    lexical_rrf?: number;
    semantic_rrf?: number;
    lexical_score?: number;
    semantic_score?: number;
  }>();
  const add = (result: SearchResult, rank: number, source: 'lexical' | 'semantic') => {
    const existing = fused.get(result.chunk_id) ?? {
      ...result,
      score: 0,
      metadata: {
        ...result.metadata,
        hybrid_sources: [],
      },
    };
    const contribution = 1 / (60 + rank + 1);
    existing.score += contribution;
    if (source === 'lexical') {
      existing.lexical_rrf = contribution;
      existing.lexical_score = result.score;
    } else {
      existing.semantic_rrf = contribution;
      existing.semantic_score = result.score;
    }
    const sources = Array.isArray(existing.metadata.hybrid_sources)
      ? existing.metadata.hybrid_sources
      : [];
    existing.metadata = {
      ...existing.metadata,
      hybrid_sources: sources.includes(source) ? sources : [...sources, source],
      ...(existing.lexical_score !== undefined ? { lexical_score: existing.lexical_score } : {}),
      ...(existing.semantic_score !== undefined ? { semantic_score: existing.semantic_score } : {}),
    };
    fused.set(result.chunk_id, existing);
  };
  lexical?.data.forEach((result, rank) => add(result, rank, 'lexical'));
  semantic.data.forEach((result, rank) => add(result, rank, 'semantic'));
  return {
    data: [...fused.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(({ lexical_rrf, semantic_rrf, lexical_score, semantic_score, ...result }) => result),
  };
}

function contentTokens(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []);
}

function sparseTokens(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g)?.filter((token) => !STOP_WORDS.has(token)) ?? [];
}

function stemLexicalToken(token: string): string {
  if (token.length > 5 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 6 && token.endsWith('ing')) return token.slice(0, -3);
  if (token.length > 5 && token.endsWith('ed')) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith('s')) return token.slice(0, -1);
  return token;
}

function lexicalNgrams(token: string): string[] {
  if (token.length < 6) return [];
  const grams: string[] = [];
  for (let i = 0; i <= token.length - 3; i += 1) {
    const gram = token.slice(i, i + 3);
    if (!STOP_WORDS.has(gram)) grams.push(gram);
  }
  return grams;
}

function lexicalPrefilterTokens(queryTokens: string[]): string[] {
  const out = new Set<string>();
  for (const token of queryTokens) {
    out.add(token);
    out.add(stemLexicalToken(token));
    for (const gram of lexicalNgrams(token)) out.add(gram);
  }
  return [...out].filter((token) => token.length >= 3).slice(0, 32);
}

function boundedEditDistance(a: string, b: string, maxDistance: number): number {
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = current[0] ?? 0;
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? maxDistance + 1) + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1);
      const insertion = (current[j - 1] ?? maxDistance + 1) + 1;
      const deletion = (previous[j] ?? maxDistance + 1) + 1;
      const value = Math.min(substitution, insertion, deletion);
      current[j] = value;
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    previous = current;
  }
  return previous[b.length] ?? maxDistance + 1;
}

function lexicalTokenSimilarity(queryToken: string, chunkToken: string): number {
  if (queryToken === chunkToken) return 1;
  const queryStem = stemLexicalToken(queryToken);
  const chunkStem = stemLexicalToken(chunkToken);
  if (queryStem === chunkStem) return 0.92;
  if (
    queryToken.length >= 5
    && chunkToken.length >= 5
    && (queryToken.includes(chunkToken) || chunkToken.includes(queryToken))
  ) return 0.82;
  if (queryToken.length < 5 || chunkToken.length < 5) return 0;
  const maxLength = Math.max(queryToken.length, chunkToken.length);
  const maxDistance = maxLength <= 7 ? 1 : 2;
  const distance = boundedEditDistance(queryToken, chunkToken, maxDistance);
  if (distance > maxDistance) return 0;
  return Math.max(0, 1 - distance / maxLength);
}

function bestLexicalMatch(
  queryToken: string,
  counts: Map<string, number>,
): { token: string; count: number; similarity: number } | null {
  const exact = counts.get(queryToken);
  if (exact) return { token: queryToken, count: exact, similarity: 1 };
  let best: { token: string; count: number; similarity: number } | null = null;
  for (const [token, count] of counts.entries()) {
    const similarity = lexicalTokenSimilarity(queryToken, token);
    if (similarity < 0.72) continue;
    if (!best || similarity > best.similarity || (similarity === best.similarity && count > best.count)) {
      best = { token, count, similarity };
    }
  }
  return best;
}

function sparseLexicalScore(chunks: ChunkRecord[], queryTokens: string[]): Array<{
  chunk: ChunkRecord;
  score: number;
  overlap: number;
  matchedTerms: string[];
}> {
  if (chunks.length === 0 || queryTokens.length === 0) return [];
  const uniqueQueryTokens = Array.from(new Set(queryTokens));
  const chunkTerms = chunks.map((chunk) => {
    const tokens = sparseTokens(chunk.content);
    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    return { chunk, tokens, counts };
  });
  const documentFrequency = new Map<string, number>();
  for (const token of uniqueQueryTokens) {
    documentFrequency.set(token, chunkTerms.filter((entry) => bestLexicalMatch(token, entry.counts)).length);
  }
  const averageLength = Math.max(
    1,
    chunkTerms.reduce((sum, entry) => sum + entry.tokens.length, 0) / chunkTerms.length,
  );
  const k1 = 1.2;
  const b = 0.75;
  return chunkTerms
    .map((entry) => {
      let score = 0;
      const matchedTerms: string[] = [];
      for (const token of uniqueQueryTokens) {
        const match = bestLexicalMatch(token, entry.counts);
        const tf = match?.count ?? 0;
        if (tf <= 0 || !match) continue;
        matchedTerms.push(match.token === token ? token : `${token}~${match.token}`);
        const df = documentFrequency.get(token) ?? 0;
        const idf = Math.log(1 + (chunkTerms.length - df + 0.5) / (df + 0.5));
        const denominator = tf + k1 * (1 - b + b * (entry.tokens.length / averageLength));
        score += idf * ((tf * (k1 + 1)) / denominator) * match.similarity;
      }
      return { chunk: entry.chunk, score, overlap: matchedTerms.length, matchedTerms };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || b.overlap - a.overlap || a.chunk.chunk_index - b.chunk.chunk_index);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }
  return intersection / (a.size + b.size - intersection);
}

function rerankAndDiversifyResults(payload: QueryPayload, query: string, topK: number, useMmr: boolean): QueryPayload {
  if (payload.data.length <= 1) return payload;
  const queryTokens = tokenizeLexicalQuery(query);
  const queryTokenSet = new Set(queryTokens);
  const candidates = payload.data.map((result) => {
    const tokens = contentTokens(result.chunk_content);
    let overlap = 0;
    for (const token of queryTokenSet) {
      if (tokens.has(token)) overlap += 1;
    }
    const rerankScore = result.score + (queryTokens.length ? (overlap / queryTokens.length) * 0.08 : 0);
    return {
      result: {
        ...result,
        score: rerankScore,
        metadata: {
          ...result.metadata,
          rerank_score: rerankScore,
          rerank_overlap: overlap,
        } as JsonRecord,
      },
      tokens,
      score: rerankScore,
    };
  }).sort((a, b) => b.score - a.score);
  if (!useMmr) return { data: candidates.slice(0, topK).map((item) => item.result) };
  const selected: typeof candidates = [];
  const remaining = [...candidates];
  while (remaining.length > 0 && selected.length < topK) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (const [i, candidate] of remaining.entries()) {
      const maxSimilarity = selected.reduce(
        (max, item) => Math.max(max, jaccardSimilarity(candidate.tokens, item.tokens)),
        0,
      );
      const mmrScore = 0.82 * candidate.score - 0.18 * maxSimilarity;
      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIndex = i;
      }
    }
    const [chosen] = remaining.splice(bestIndex, 1);
    if (chosen) {
      chosen.result.metadata = {
        ...chosen.result.metadata,
        mmr_score: bestScore,
        mmr_rank: selected.length + 1,
      };
      selected.push(chosen);
    }
  }
  return { data: selected.map((item) => item.result) };
}

function diversifyRankedResults(results: SearchResult[], topK: number, useMmr: boolean): QueryPayload {
  if (!useMmr) return { data: results.slice(0, topK) };
  const candidates = results.map((result) => ({ result, tokens: contentTokens(result.chunk_content), score: result.score }));
  const selected: typeof candidates = [];
  const remaining = [...candidates];
  while (remaining.length > 0 && selected.length < topK) {
    let bestIndex = 0;
    let bestScore = -Infinity;
    for (const [i, candidate] of remaining.entries()) {
      const maxSimilarity = selected.reduce(
        (max, item) => Math.max(max, jaccardSimilarity(candidate.tokens, item.tokens)),
        0,
      );
      const mmrScore = 0.82 * candidate.score - 0.18 * maxSimilarity;
      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIndex = i;
      }
    }
    const [chosen] = remaining.splice(bestIndex, 1);
    if (chosen) {
      chosen.result.metadata = {
        ...chosen.result.metadata,
        mmr_score: bestScore,
        mmr_rank: selected.length + 1,
      };
      selected.push(chosen);
    }
  }
  return { data: selected.map((item) => item.result) };
}

function rerankModelFromBody(body: QueryBody): RerankModel {
  return body.rerank_model === 'workers_ai' ? 'workers_ai' : 'keyword';
}

function answerModeFromBody(body: KbQueryBody): AnswerMode {
  return body.answer_mode === 'workers_ai' ? 'workers_ai' : 'extractive';
}

function rerankResponseRows(response: unknown): Array<{ id: number; score: number }> {
  const rows = response && typeof response === 'object' ? (response as { response?: unknown }).response : null;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const item = row as { id?: unknown; index?: unknown; score?: unknown };
    const id = typeof item.id === 'number' ? item.id : typeof item.index === 'number' ? item.index : null;
    const score = typeof item.score === 'number' ? item.score : null;
    return id === null || score === null ? [] : [{ id, score }];
  });
}

function buildCacheKey(parts: unknown): string {
  return stableStringify(parts);
}

function vectorNamespace(tenant: string, indexId: string): string {
  return `${tenant}:${indexId}`;
}

function semanticModelFromBody(body: QueryBody): SemanticModel {
  return body.semantic_model === 'small' ? 'small' : 'base';
}

function embeddingModel(env: Env, model: SemanticModel): string {
  if (model === 'small') return env.EMBEDDING_MODEL_SMALL || DEFAULT_SMALL_EMBEDDING_MODEL;
  return env.EMBEDDING_MODEL || DEFAULT_BASE_EMBEDDING_MODEL;
}

function vectorizeBinding(env: Env, model: SemanticModel) {
  return model === 'small' && env.VECTORIZE_SMALL ? env.VECTORIZE_SMALL : env.VECTORIZE;
}

function userVectorFilter(filter: unknown): JsonRecord | undefined {
  const record = { ...jsonRecord(filter) };
  delete record.tenant;
  delete record.index_id;
  return Object.keys(record).length > 0 ? record : undefined;
}

function sharedQueryCacheEnabled(env: Env): boolean {
  return env.RAG_SHARED_QUERY_CACHE_ENABLED === 'true';
}

function vectorMetadata(
  tenant: string,
  indexId: string,
  documentId: string,
  chunkIndex: number,
  content: string,
  metadata: JsonRecord,
): JsonRecord {
  return {
    tenant,
    index_id: indexId,
    document_id: documentId,
    chunk_index: chunkIndex,
    chunk_content: content,
    chunk_metadata: JSON.stringify(metadata),
  };
}

function searchResultFromVectorMetadata(match: { id: string; score: number; metadata?: JsonRecord }): SearchResult | null {
  const metadata = match.metadata ?? {};
  if (typeof metadata.document_id !== 'string' || typeof metadata.chunk_content !== 'string') return null;
  let parsedMetadata: unknown = {};
  if (typeof metadata.chunk_metadata === 'string') {
    try {
      parsedMetadata = JSON.parse(metadata.chunk_metadata) as unknown;
    } catch {
      parsedMetadata = {};
    }
  }
  return {
    document_id: metadata.document_id,
    chunk_id: match.id,
    chunk_content: metadata.chunk_content,
    score: match.score,
    metadata: jsonRecord(parsedMetadata),
  };
}

function tokenizeLexicalQuery(query: string): string[] {
  const tokens = query
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9-]{2,}/g);
  if (!tokens) return [];
  return Array.from(new Set(tokens.filter((token) => !STOP_WORDS.has(token)))).slice(0, 8);
}

function normalizeSemanticQuery(query: string): string {
  return query
    .trim()
    .toLowerCase()
    .replace(/[?!.,;:]+$/g, '')
    .replace(/\s+/g, ' ');
}

function compactQueryVariant(value: string): string {
  return value
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(?:please|show|find|tell me|list|give me|what|which|where|when|who|how|does|do|did|are|is|was|were|the|a|an)\b/gi, ' ')
    .replace(/\b(?:document|documents|docs|file|files|corpus|domain|about|mention|mentions|mentioned|discuss|discusses|documented)\b/gi, ' ')
    .replace(/[^a-zA-Z0-9_\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function variantTokenCount(value: string): number {
  return tokenizeLexicalQuery(value).length;
}

function pushQueryVariant(
  variants: QueryPlanVariant[],
  seen: Set<string>,
  query: string,
  kind: QueryPlanVariantKind,
): void {
  const normalized = normalizeSemanticQuery(query);
  if (!normalized || seen.has(normalized) || variantTokenCount(normalized) === 0) return;
  variants.push({ query: normalized, kind });
  seen.add(normalized);
}

function buildQueryPlan(query: string, body: QueryBody): QueryPlan {
  const variants: QueryPlanVariant[] = [];
  const seen = new Set([normalizeSemanticQuery(query)]);
  if (body.query_rewrite !== false) {
    const rewritten = compactQueryVariant(query);
    if (variantTokenCount(rewritten) >= 2) pushQueryVariant(variants, seen, rewritten, 'rewrite');
  }
  if (body.query_decompose !== false && /\b(?:and|or|versus|vs|compare|compared)\b|[;?]/i.test(query)) {
    const parts = query
      .split(/\b(?:and|or|versus|vs|compare(?:d)?(?:\s+to)?)\b|[;?]/i)
      .map(compactQueryVariant)
      .filter((part) => variantTokenCount(part) > 0);
    for (const part of parts) {
      pushQueryVariant(variants, seen, part, 'decompose');
      if (variants.length >= 4) break;
    }
  }
  return { variants: variants.slice(0, 4) };
}

function fuseQueryPlanResults(
  entries: Array<{ query: string; kind: 'original' | QueryPlanVariantKind; payload: QueryPayload | null }>,
  topK: number,
): QueryPayload {
  const fused = new Map<string, SearchResult & {
    query_plan_sources?: string[];
    query_plan_score?: number;
  }>();
  for (const entry of entries) {
    entry.payload?.data.forEach((result, rank) => {
      const source = entry.kind === 'original' ? 'original' : `${entry.kind}:${entry.query}`;
      const contribution = result.score + 1 / (80 + rank + 1);
      const existing = fused.get(result.chunk_id) ?? {
        ...result,
        score: 0,
        metadata: { ...result.metadata },
        query_plan_sources: [],
        query_plan_score: 0,
      };
      existing.score += contribution;
      existing.query_plan_score = (existing.query_plan_score ?? 0) + contribution;
      const sources = existing.query_plan_sources ?? [];
      existing.query_plan_sources = sources.includes(source) ? sources : [...sources, source];
      existing.metadata = {
        ...existing.metadata,
        query_plan_sources: existing.query_plan_sources,
        query_plan_score: existing.query_plan_score,
      };
      fused.set(result.chunk_id, existing);
    });
  }
  return {
    data: [...fused.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map(({ query_plan_sources, query_plan_score, ...result }) => result),
  };
}

function elapsedMs(started: number): number {
  return Math.round((performance.now() - started) * 100) / 100;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(blob: ArrayBuffer): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', blob));
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function summarizeLatencies(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count: sorted.length,
    min_ms: Math.round((sorted[0] ?? 0) * 100) / 100,
    p50_ms: Math.round(percentile(sorted, 50) * 100) / 100,
    p95_ms: Math.round(percentile(sorted, 95) * 100) / 100,
    p99_ms: Math.round(percentile(sorted, 99) * 100) / 100,
    max_ms: Math.round((sorted.at(-1) ?? 0) * 100) / 100,
    mean_ms: Math.round((sorted.length ? total / sorted.length : 0) * 100) / 100,
  };
}

function evalMatch(result: SearchResult, testCase: SearchEvalCase): boolean {
  if (testCase.expected_chunk_ids?.includes(result.chunk_id)) return true;
  if (testCase.expected_document_ids?.includes(result.document_id)) return true;
  const expectedText = testCase.expected_text?.trim().toLowerCase();
  if (expectedText && result.chunk_content.toLowerCase().includes(expectedText)) return true;
  return false;
}

function parseEvalCaseBytes(testCase: ParseEvalCase): ArrayBuffer {
  function copyBytes(bytes: Uint8Array): ArrayBuffer {
    const out = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(out).set(bytes);
    return out;
  }
  if (typeof testCase.content_base64 === 'string' && testCase.content_base64.trim()) {
    const binary = atob(testCase.content_base64.trim());
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return copyBytes(bytes);
  }
  const bytes = new TextEncoder().encode(testCase.content ?? '');
  return copyBytes(bytes);
}

function expectedTextList(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.map((item) => item.trim()).filter(Boolean);
  return value?.trim() ? [value.trim()] : [];
}

function visionOcrModelChain(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);
}

function normalizeEvalText(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/\s+/g, ' ').trim();
}

function evalTextTokens(value: string): string[] {
  return normalizeEvalText(value).match(/[a-z0-9]{2,}/g) ?? [];
}

function parseEvalItemMatched(parsedText: string, expected: string): boolean {
  if (normalizeEvalText(parsedText).includes(normalizeEvalText(expected))) return true;
  const haystack = new Set(evalTextTokens(parsedText));
  const expectedTokens = [...new Set(evalTextTokens(expected))];
  if (expectedTokens.length < 3) return false;
  const matchedTokens = expectedTokens.filter((token) => haystack.has(token)).length;
  return matchedTokens / expectedTokens.length >= 0.6;
}

function parseEvalMatch(parsedText: string, expected: string[]): { matched: string[]; missing: string[] } {
  const matched = expected.filter((item) => parseEvalItemMatched(parsedText, item));
  return {
    matched,
    missing: expected.filter((item) => !matched.includes(item)),
  };
}

function traceRoute(trace: QueryTraceRecord): string {
  const confidenceRoute = trace.confidence?.route;
  if (typeof confidenceRoute === 'string') return confidenceRoute;
  const filterRoute = trace.filters?.route;
  if (typeof filterRoute === 'string') return filterRoute;
  return 'unknown';
}

function traceChunkIds(trace: QueryTraceRecord): string[] {
  return trace.retrieved.map((result) => result.chunk_id).filter(Boolean);
}

function overlapCount(left: string[], right: string[]): number {
  const rightSet = new Set(right);
  return left.filter((value) => rightSet.has(value)).length;
}

function qualityTokens(text: string | null | undefined): string[] {
  const tokens = (text ?? '')
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9-]{2,}/g);
  if (!tokens) return [];
  return Array.from(new Set(tokens.filter((token) => !STOP_WORDS.has(token))));
}

function roundedRatio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

function answerSupportQuality(
  answer: string | null | undefined,
  citations: CitationRecord[],
  retrieved: SearchResult[],
): JsonRecord {
  const answerTokens = qualityTokens(answer);
  const evidenceText = [
    ...citations.map((citation) => citation.excerpt),
    ...retrieved.map((result) => result.chunk_content),
  ].join('\n');
  const evidenceTokens = new Set(qualityTokens(evidenceText));
  const supportedTokens = answerTokens.filter((token) => evidenceTokens.has(token));
  const unsupportedTokens = answerTokens.filter((token) => !evidenceTokens.has(token));
  const citationRows = citations.map((citation) => {
    const citationTokens = new Set(qualityTokens(citation.excerpt));
    const overlap = answerTokens.filter((token) => citationTokens.has(token));
    return {
      index: citation.index,
      chunk_id: citation.chunk_id,
      document_id: citation.document_id,
      filename: citation.filename,
      page_start: citation.page_start,
      page_end: citation.page_end,
      score: citation.score,
      excerpt_length: citation.excerpt.length,
      answer_token_overlap_count: overlap.length,
      answer_token_overlap_ratio: roundedRatio(overlap.length, answerTokens.length),
      overlapping_answer_tokens: overlap,
      excerpt: citation.excerpt,
    };
  });
  const coverage = roundedRatio(supportedTokens.length, answerTokens.length);
  const status = !answer || answerTokens.length === 0
    ? 'no_answer'
    : citations.length === 0
      ? 'no_citations'
      : (coverage ?? 0) >= 0.65
        ? 'supported'
        : (coverage ?? 0) >= 0.35
          ? 'partial'
          : 'weak';
  return {
    status,
    answer_token_count: answerTokens.length,
    supported_answer_token_count: supportedTokens.length,
    unsupported_answer_token_count: unsupportedTokens.length,
    citation_coverage: coverage,
    citation_count: citations.length,
    retrieved_count: retrieved.length,
    supported_answer_tokens: supportedTokens,
    unsupported_answer_tokens: unsupportedTokens,
    citations: citationRows,
  };
}

function confidenceWithVerification(confidence: JsonRecord, quality: JsonRecord): JsonRecord {
  const coverage = typeof quality.citation_coverage === 'number' ? quality.citation_coverage : null;
  const status = typeof quality.status === 'string' ? quality.status : 'unknown';
  const currentLevel = typeof confidence.level === 'string' ? confidence.level : 'low';
  const verifiedLevel = status === 'supported'
    ? currentLevel
    : status === 'partial'
      ? currentLevel === 'high' ? 'medium' : currentLevel
      : status === 'no_answer' || status === 'no_citations'
        ? 'none'
        : 'low';
  return {
    ...confidence,
    level: verifiedLevel,
    verification_status: status,
    verification_checked: true,
    verification_method: 'deterministic_answer_evidence_token_overlap',
    citation_coverage: coverage,
    supported_answer_token_count: quality.supported_answer_token_count,
    unsupported_answer_token_count: quality.unsupported_answer_token_count,
    unsupported_answer_tokens: quality.unsupported_answer_tokens,
    calibration: `${String(confidence.calibration ?? 'retrieval_score')}_with_deterministic_evidence_verification`,
  };
}

function answerQualityDrilldown(trace: QueryTraceRecord): JsonRecord {
  return {
    route: traceRoute(trace),
    latency_ms: trace.latency_ms,
    ...answerSupportQuality(trace.answer, trace.citations, trace.retrieved),
  };
}

const DEFAULT_EVAL_JUDGE_MODEL = DEFAULT_ANSWER_MODEL;

function aiTextResponse(response: unknown): string {
  if (typeof response === 'string') return response;
  if (!response || typeof response !== 'object') return '';
  const record = response as JsonRecord;
  if (typeof record.response === 'string') return record.response;
  if (typeof record.result === 'string') return record.result;
  if (typeof record.text === 'string') return record.text;
  return JSON.stringify(response);
}

// Embedding provider seam: route through the free-ai gateway when configured,
// otherwise use Cloudflare Workers AI. Matches the embedTexts signature so it
// drops into the createApp `embed` dependency.
function defaultEmbed(env: Env, texts: string[], options: { model?: string } = {}): Promise<number[][]> {
  return env.RAG_EMBED_PROVIDER === 'free_ai'
    ? freeAiEmbed(env, texts, options)
    : embedTexts(env, texts, options);
}

// Chat/synthesis provider seam: free-ai gateway or Workers AI. Both return a
// response shape aiTextResponse() understands.
async function runAiChat(
  env: Env,
  model: string,
  body: {
    messages: Array<{ role: string; content: string }>;
    max_tokens?: number;
    temperature?: number;
    response_format?: unknown;
  },
): Promise<unknown> {
  if (freeAiSynthEnabled(env)) {
    return freeAiChatRaw(env, model, body);
  }
  return env.AI.run(model, body as unknown as JsonRecord);
}

function parseJudgeJson(text: string): JsonRecord | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonRecord : null;
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[0]) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as JsonRecord : null;
    } catch {
      return null;
    }
  }
}

function boundedEvidenceText(citations: CitationRecord[], retrieved: SearchResult[]): string {
  const citationText = citations
    .slice(0, 5)
    .map((citation) => `[${citation.index}] ${citation.excerpt}`)
    .join('\n');
  const retrievedText = retrieved
    .slice(0, 5)
    .map((item, i) => `retrieved-${i + 1}: ${item.chunk_content}`)
    .join('\n');
  return `${citationText}\n${retrievedText}`.trim().slice(0, 6000);
}

function parseAnswerText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return trimmed;
  const parsed = parseJudgeJson(trimmed);
  const answer = parsed?.answer ?? parsed?.response ?? parsed?.text;
  return typeof answer === 'string' ? answer.trim() : trimmed;
}

async function synthesizeAnswerWithAi(input: {
  env: Env;
  question: string;
  citations: CitationRecord[];
  retrieved: SearchResult[];
  model?: string | undefined;
}): Promise<{ answer: string; model: string }> {
  const model = freeAiSynthEnabled(input.env)
    ? freeAiSynthModel(input.env)
    : input.model?.trim() || input.env.RAG_ANSWER_MODEL?.trim() || DEFAULT_ANSWER_MODEL;
  const evidence = boundedEvidenceText(input.citations, input.retrieved);
  const response = await runAiChat(input.env, model, {
    messages: [
      {
        role: 'system',
        content: [
          'You answer questions using only the cited evidence provided by a retrieval system.',
          'Every factual claim must include bracket citations like [1] that match the evidence numbers.',
          'If the evidence is insufficient, say that the answer is not available from the provided domain evidence.',
        ].join(' '),
      },
      {
        role: 'user',
        content: JSON.stringify({
          question: input.question,
          evidence,
          instructions: [
            'Return a concise answer.',
            'Use only citation ids present in the evidence.',
            'Do not mention evidence ids that are not provided.',
          ],
        }),
      },
    ],
    max_tokens: 512,
    temperature: 0.1,
  });
  return { answer: parseAnswerText(aiTextResponse(response)).slice(0, 4000), model };
}

async function answerFromEvidence(input: {
  env: Env;
  question: string;
  citations: CitationRecord[];
  retrieved: SearchResult[];
  extractiveAnswer: string;
  baseConfidence: JsonRecord;
  requestedMode: AnswerMode;
  requestedModel?: string | undefined;
}): Promise<{
  answer: string;
  confidence: JsonRecord;
  answerMode: AnswerMode;
  answerModel: string | null;
  aiUsed: boolean;
  timing: RagTiming;
}> {
  let answer = input.extractiveAnswer;
  let answerMode: AnswerMode = 'extractive';
  let answerModel: string | null = null;
  let aiUsed = false;
  const timing: RagTiming = {
    answer_requested_mode: input.requestedMode,
    answer_mode: 'extractive',
  };
  if (input.requestedMode === 'workers_ai') {
    const synthesisStarted = performance.now();
    try {
      const synthesized = await synthesizeAnswerWithAi({
        env: input.env,
        question: input.question,
        citations: input.citations,
        retrieved: input.retrieved,
        model: input.requestedModel,
      });
      timing.synthesis_ms = elapsedMs(synthesisStarted);
      timing.synthesis_model = synthesized.model;
      if (synthesized.answer && /\[\d+\]/.test(synthesized.answer)) {
        answer = synthesized.answer;
        answerMode = 'workers_ai';
        answerModel = synthesized.model;
        aiUsed = true;
        timing.answer_mode = 'workers_ai';
      } else {
        timing.synthesis_fallback = 'empty_or_uncited_response';
      }
    } catch (error) {
      timing.synthesis_ms = elapsedMs(synthesisStarted);
      timing.synthesis_fallback = error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160);
    }
  }
  return {
    answer,
    confidence: confidenceWithVerification(
      input.baseConfidence,
      answerSupportQuality(answer, input.citations, input.retrieved),
    ),
    answerMode,
    answerModel,
    aiUsed,
    timing,
  };
}

async function judgeAnswerWithAi(input: {
  env: Env;
  question: string;
  expectedText: string;
  answer: string;
  citations: CitationRecord[];
  retrieved: SearchResult[];
  model?: string;
}): Promise<JsonRecord> {
  const model = freeAiSynthEnabled(input.env)
    ? freeAiSynthModel(input.env)
    : input.model?.trim() || DEFAULT_EVAL_JUDGE_MODEL;
  const evidence = boundedEvidenceText(input.citations, input.retrieved);
  const response = await runAiChat(input.env, model, {
    messages: [
      {
        role: 'system',
        content: [
          'You judge retrieval-augmented answers for answer-in-source support.',
          'Return only JSON. Do not reward correct-looking claims unless they are supported by the provided evidence.',
          'Use status "supported", "partial", or "unsupported".',
        ].join(' '),
      },
      {
        role: 'user',
        content: JSON.stringify({
          question: input.question,
          expected_text: input.expectedText || null,
          answer: input.answer,
          evidence,
          rubric: {
            supported: 'The answer directly follows from the cited/retrieved evidence.',
            partial: 'The answer is partly supported but misses or adds material claims.',
            unsupported: 'The answer is absent, contradicted, or materially unsupported by evidence.',
          },
        }),
      },
    ],
    max_tokens: 256,
    response_format: {
      type: 'json_schema',
      json_schema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['supported', 'partial', 'unsupported'] },
          score: { type: 'number' },
          rationale: { type: 'string' },
        },
        required: ['status', 'score', 'rationale'],
      },
    },
  });
  const parsed = parseJudgeJson(aiTextResponse(response));
  const status = typeof parsed?.status === 'string' && ['supported', 'partial', 'unsupported'].includes(parsed.status)
    ? parsed.status
    : 'unsupported';
  const score = typeof parsed?.score === 'number'
    ? Math.min(1, Math.max(0, parsed.score))
    : status === 'supported'
      ? 1
      : status === 'partial'
        ? 0.5
        : 0;
  return {
    model_judged: true,
    model_judge_model: model,
    model_judge_status: status,
    model_judge_score: Math.round(score * 1000) / 1000,
    model_judge_rationale: typeof parsed?.rationale === 'string' ? parsed.rationale.slice(0, 500) : '',
  };
}

function traceExportSummary(traces: QueryTraceRecord[]): JsonRecord {
  const route_counts: Record<string, number> = {};
  let latencyTotal = 0;
  let latencyCount = 0;
  for (const trace of traces) {
    const route = traceRoute(trace);
    route_counts[route] = (route_counts[route] ?? 0) + 1;
    if (typeof trace.latency_ms === 'number') {
      latencyTotal += trace.latency_ms;
      latencyCount += 1;
    }
  }
  return {
    trace_count: traces.length,
    route_counts,
    avg_latency_ms: latencyCount ? Math.round((latencyTotal / latencyCount) * 100) / 100 : null,
    citation_count: traces.reduce((sum, trace) => sum + trace.citations.length, 0),
  };
}

function compareTraces(baseline: QueryTraceRecord, candidate: QueryTraceRecord): JsonRecord {
  const baselineIds = traceChunkIds(baseline);
  const candidateIds = traceChunkIds(candidate);
  const retrievedOverlap = overlapCount(baselineIds, candidateIds);
  const baselineCitationIds = baseline.citations.map((citation) => citation.chunk_id).filter(Boolean);
  const candidateCitationIds = candidate.citations.map((citation) => citation.chunk_id).filter(Boolean);
  const citationOverlap = overlapCount(baselineCitationIds, candidateCitationIds);
  return {
    baseline_trace_id: baseline.id,
    candidate_trace_id: candidate.id,
    same_question: baseline.question === candidate.question,
    same_answer: baseline.answer === candidate.answer,
    route: {
      baseline: traceRoute(baseline),
      candidate: traceRoute(candidate),
      changed: traceRoute(baseline) !== traceRoute(candidate),
    },
    latency_delta_ms:
      typeof baseline.latency_ms === 'number' && typeof candidate.latency_ms === 'number'
        ? candidate.latency_ms - baseline.latency_ms
        : null,
    retrieved: {
      baseline_count: baselineIds.length,
      candidate_count: candidateIds.length,
      overlap_count: retrievedOverlap,
      overlap_ratio: baselineIds.length ? retrievedOverlap / baselineIds.length : null,
      added_chunk_ids: candidateIds.filter((id) => !baselineIds.includes(id)),
      removed_chunk_ids: baselineIds.filter((id) => !candidateIds.includes(id)),
    },
    citations: {
      baseline_count: baselineCitationIds.length,
      candidate_count: candidateCitationIds.length,
      overlap_count: citationOverlap,
      overlap_ratio: baselineCitationIds.length ? citationOverlap / baselineCitationIds.length : null,
    },
    answer_lengths: {
      baseline: baseline.answer?.length ?? 0,
      candidate: candidate.answer?.length ?? 0,
    },
  };
}

function summarizeIngestRun(runId: string, jobs: IngestJobRecord[]): JsonRecord {
  const by_status: Record<string, number> = {};
  const by_stage: Record<string, number> = {};
  for (const job of jobs) {
    by_status[job.status] = (by_status[job.status] ?? 0) + 1;
    by_stage[job.stage] = (by_stage[job.stage] ?? 0) + 1;
  }
  const total = jobs.length;
  const succeeded = by_status.succeeded ?? 0;
  const failed = by_status.failed ?? 0;
  const completed = succeeded + failed;
  const active = total - completed;
  const state = total === 0
    ? 'not_found'
    : active > 0
      ? 'running'
      : failed > 0
        ? 'failed'
        : 'succeeded';
  return {
    run_id: runId,
    state,
    total_jobs: total,
    completed_jobs: completed,
    succeeded_jobs: succeeded,
    failed_jobs: failed,
    active_jobs: active,
    progress: total > 0 ? completed / total : 0,
    by_status,
    by_stage,
    done: total > 0 && active === 0,
  };
}

function sourceSetId(domain: string): string {
  return `domain:${domain}`;
}

function sourceSetDomain(id: string): string | null {
  return id.startsWith('domain:') ? id.slice('domain:'.length).trim() : null;
}

function summarizeSourceSets(files: FileRecord[]): JsonRecord[] {
  const grouped = new Map<string, FileRecord[]>();
  for (const file of files) {
    const rows = grouped.get(file.domain) ?? [];
    rows.push(file);
    grouped.set(file.domain, rows);
  }
  return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([domain, rows]) => {
    const by_status: Record<string, number> = {};
    const by_mime: Record<string, number> = {};
    let bytes = 0;
    for (const file of rows) {
      by_status[file.status] = (by_status[file.status] ?? 0) + 1;
      by_mime[file.mime || 'unknown'] = (by_mime[file.mime || 'unknown'] ?? 0) + 1;
      bytes += file.bytes;
    }
    const failed = by_status.failed ?? 0;
    const pending = by_status.pending ?? 0;
    const indexing = by_status.indexing ?? 0;
    const lastUpdated = rows.map((file) => file.updated_at).sort().at(-1) ?? null;
    return {
      id: sourceSetId(domain),
      domain,
      file_count: rows.length,
      bytes,
      by_status,
      by_mime,
      failed_files: failed,
      pending_files: pending,
      active_files: indexing,
      attention_files: failed + pending + indexing,
      last_updated_at: lastUpdated,
    };
  });
}

function filesForSourceSetAction(files: FileRecord[], action: string): FileRecord[] {
  if (action.endsWith('_failed')) return files.filter((file) => file.status === 'failed');
  if (action.endsWith('_pending')) return files.filter((file) => file.status === 'pending');
  if (action.endsWith('_ready')) return files.filter((file) => file.status === 'ready');
  return files;
}

function numberFromRecord(record: JsonRecord, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function latencyP95(summary: JsonRecord): number | null {
  const latency = jsonRecord(summary.latency);
  const value = latency.p95_ms;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function analyticsNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function analyticsString(value: unknown): string {
  return String(value ?? '').slice(0, 256);
}

function writeAnalyticsPoint(env: Env, point: AnalyticsEngineDataPoint): void {
  if (!env.RAG_ANALYTICS) return;
  try {
    env.RAG_ANALYTICS.writeDataPoint(point);
  } catch (error) {
    console.warn('knowledgebase analytics write failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function writeTraceAnalytics(env: Env, trace: QueryTraceRecord): void {
  const confidence = jsonRecord(trace.confidence);
  writeAnalyticsPoint(env, {
    indexes: [trace.project],
    blobs: [
      'query_trace',
      analyticsString(trace.project),
      analyticsString(trace.domain),
      analyticsString(traceRoute(trace)),
      analyticsString(confidence.verification_status ?? 'unknown'),
    ],
    doubles: [
      analyticsNumber(trace.latency_ms),
      trace.retrieved.length,
      trace.citations.length,
      analyticsNumber(confidence.citation_coverage),
      analyticsNumber(confidence.unsupported_answer_token_count),
    ],
  });
}

function writeEvalReportAnalytics(env: Env, report: { id: string; project: string; domain: string | null; index_id: string | null; kind: string; summary: JsonRecord }): void {
  writeAnalyticsPoint(env, {
    indexes: [report.project],
    blobs: [
      'eval_report',
      analyticsString(report.project),
      analyticsString(report.kind),
      analyticsString(report.domain),
      analyticsString(report.index_id),
      analyticsString(report.id),
      analyticsString(report.summary.model_judge_enabled === true ? 'model_judge' : 'deterministic'),
    ],
    doubles: [
      analyticsNumber(report.summary.n),
      analyticsNumber(report.summary.hit_rate),
      analyticsNumber(report.summary.mrr),
      analyticsNumber(report.summary.citation_rate),
      analyticsNumber(report.summary.faithfulness_rate),
      analyticsNumber(report.summary.avg_faithfulness_score),
      analyticsNumber(report.summary.avg_unsupported_answer_tokens),
      analyticsNumber(report.summary.ai_use_rate),
      analyticsNumber(report.summary.avg_model_judge_score),
      analyticsNumber(latencyP95(report.summary)),
    ],
  });
}

function average(values: Array<number | null>): number | null {
  const filtered = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  if (filtered.length === 0) return null;
  return Math.round((filtered.reduce((sum, value) => sum + value, 0) / filtered.length) * 10_000) / 10_000;
}

function summarizeEvalReports(reports: Array<{ kind: string; domain: string | null; summary: JsonRecord; created_at: string }>) {
  const byGroup = new Map<string, typeof reports>();
  for (const report of reports) {
    const key = `${report.kind}:${report.domain ?? ''}`;
    const bucket = byGroup.get(key) ?? [];
    bucket.push(report);
    byGroup.set(key, bucket);
  }
  return [...byGroup.values()].map((items) => {
    const sorted = [...items].sort((a, b) => b.created_at.localeCompare(a.created_at));
    const latest = sorted[0];
    return {
      kind: latest?.kind ?? null,
      domain: latest?.domain ?? null,
      report_count: items.length,
      latest_created_at: latest?.created_at ?? null,
      avg_hit_rate: average(items.map((item) => numberFromRecord(item.summary, 'hit_rate'))),
      avg_mrr: average(items.map((item) => numberFromRecord(item.summary, 'mrr'))),
      avg_citation_rate: average(items.map((item) => numberFromRecord(item.summary, 'citation_rate'))),
      avg_faithfulness_rate: average(items.map((item) => numberFromRecord(item.summary, 'faithfulness_rate'))),
	      avg_faithfulness_score: average(items.map((item) => numberFromRecord(item.summary, 'avg_faithfulness_score'))),
	      avg_unsupported_answer_tokens: average(items.map((item) => numberFromRecord(item.summary, 'avg_unsupported_answer_tokens'))),
	      avg_ai_use_rate: average(items.map((item) => numberFromRecord(item.summary, 'ai_use_rate'))),
	      avg_model_judge_score: average(items.map((item) => numberFromRecord(item.summary, 'avg_model_judge_score'))),
	      avg_p95_ms: average(items.map((item) => latencyP95(item.summary))),
      latest_summary: latest?.summary ?? null,
    };
  }).sort((a, b) =>
    String(a.kind).localeCompare(String(b.kind)) || String(a.domain ?? '').localeCompare(String(b.domain ?? '')),
  );
}

function oneLineExcerpt(text: string, maxLength = 420): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function numberMetadata(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.trunc(parsed)) : fallback;
}

function stringMetadata(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function sentenceSpans(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  return normalized
    .split(/(?<=[.!?])\s+/)
    .map((span) => span.trim())
    .filter(Boolean);
}

function bestEvidenceSpan(text: string, question: string | undefined, maxLength = 420): {
  excerpt: string;
  terms: string[];
} {
  const spans = sentenceSpans(text);
  const queryTokens = qualityTokens(question);
  if (spans.length === 0) return { excerpt: '', terms: [] };
  if (queryTokens.length === 0) return { excerpt: oneLineExcerpt(spans.join(' '), maxLength), terms: [] };
  const querySet = new Set(queryTokens);
  let best = spans[0] ?? '';
  let bestTerms: string[] = [];
  let bestScore = -1;
  for (const span of spans) {
    const spanTokens = qualityTokens(span);
    const terms = Array.from(new Set(spanTokens.filter((token) => querySet.has(token))));
    const score = terms.length * 10 + Math.min(span.length, maxLength) / maxLength;
    if (score > bestScore) {
      best = span;
      bestTerms = terms;
      bestScore = score;
    }
  }
  if (bestTerms.length === 0) return { excerpt: oneLineExcerpt(spans.join(' '), maxLength), terms: [] };
  return { excerpt: oneLineExcerpt(best, maxLength), terms: bestTerms };
}

function citationsFromResults(results: SearchResult[], question?: string, limit = 5): CitationRecord[] {
  return results.slice(0, limit).map((result, i) => {
    const pageStart = numberMetadata(result.metadata.page_start ?? result.metadata.page, 1);
    const pageEnd = numberMetadata(result.metadata.page_end ?? result.metadata.page, pageStart);
    const span = bestEvidenceSpan(result.chunk_content, question);
    return {
      index: i + 1,
      document_id: result.document_id,
      chunk_id: result.chunk_id,
      file_id: stringMetadata(result.metadata.file_id),
      filename: stringMetadata(result.metadata.filename ?? result.metadata.source),
      page_start: pageStart,
      page_end: Math.max(pageStart, pageEnd),
      excerpt: span.excerpt || oneLineExcerpt(result.chunk_content),
      span_terms: span.terms,
      score: result.score,
      metadata: {
        ...result.metadata,
        citation_span_terms: span.terms,
        citation_span_strategy: question ? 'question_token_sentence' : 'first_excerpt',
      },
    };
  });
}

function answerFromCitations(question: string, citations: CitationRecord[]): string {
  if (citations.length === 0) {
    return `I cannot answer "${question}" from this domain with citations.`;
  }
  const strongest = citations.slice(0, 3).map((citation) => {
    return `${citation.excerpt} [${citation.index}]`;
  });
  return strongest.join(' ');
}

function confidenceFromResults(results: SearchResult[]): JsonRecord {
  const topScore = results[0]?.score ?? 0;
  return {
    level: results.length === 0 ? 'none' : topScore >= 0.75 ? 'high' : topScore >= 0.45 ? 'medium' : 'low',
    top_score: topScore,
    result_count: results.length,
    calibration: 'retrieval_score_not_answer_truth',
  };
}

function weakSemanticReason(payload: QueryPayload): string | null {
  const topScore = payload.data[0]?.score ?? null;
  if (payload.data.length === 0) return 'semantic_empty';
  if (topScore !== null && topScore < CORRECTIVE_SEMANTIC_MIN_SCORE) return 'semantic_low_score';
  return null;
}

function searchResultFromEntity(entity: EntityRecord, score: number, route = 'd1_entities', extraMetadata: JsonRecord = {}): SearchResult {
  const content = JSON.stringify(entity.fields, null, 2);
  return {
    document_id: entity.id,
    chunk_id: entity.id,
    chunk_content: content,
    score,
    metadata: {
      route,
      entity_id: entity.id,
      entity_type: entity.type,
      identity_key: entity.identity_key,
      display_name: entity.display_name,
      fields: entity.fields,
      ...extraMetadata,
    },
  };
}

function normalizeStructuredFieldName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function entityFieldValue(entity: EntityRecord, normalizedField: string): unknown {
  for (const [field, value] of Object.entries(entity.fields)) {
    if (normalizeStructuredFieldName(field) === normalizedField) return value;
  }
  return undefined;
}

function fieldMatches(value: unknown, expected: string): boolean {
  const normalizedExpected = expected.trim().toLowerCase();
  if (!normalizedExpected) return false;
  if (value === null || value === undefined) return false;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).toLowerCase() === normalizedExpected;
  const actual = String(value).trim().toLowerCase();
  return actual === normalizedExpected || actual.includes(normalizedExpected);
}

function parseStructuredFieldFilters(question: string): Array<{ field: string; normalized_field: string; value: string }> {
  const filters: Array<{ field: string; normalized_field: string; value: string }> = [];
  const pattern = /\b([a-zA-Z_][a-zA-Z0-9_ -]{1,40})\s*(?::|=|\bis\b|\bequals\b)\s*["']?([^"',?;\n]+?)["']?(?=\s+(?:and|or)\s+[a-zA-Z_][a-zA-Z0-9_ -]{1,40}\s*(?::|=|\bis\b|\bequals\b)|[?;,\n]|$)/gi;
  for (const match of question.matchAll(pattern)) {
    const field = (match[1] ?? '').trim();
    const value = (match[2] ?? '').trim();
    const normalizedField = normalizeStructuredFieldName(field);
    if (!field || !value || STOP_WORDS.has(field.toLowerCase())) continue;
    filters.push({ field, normalized_field: normalizedField, value });
  }
  return filters;
}

async function structuredFieldQueryResults(
  repo: MetadataRepository,
  tenant: string,
  domain: string,
  question: string,
  limit: number,
): Promise<{ filters: JsonRecord[]; entities: EntityRecord[] }> {
  const filters = parseStructuredFieldFilters(question);
  if (filters.length === 0) return { filters: [], entities: [] };
  const entities = await repo.listEntities(tenant, domain, undefined, 500);
  const matches = entities.filter((entity) =>
    filters.every((filter) => fieldMatches(entityFieldValue(entity, filter.normalized_field), filter.value)),
  ).slice(0, limit);
  if (matches.length === 0) return { filters: [], entities: [] };
  return {
    filters: filters.map((filter) => ({ field: filter.field, normalized_field: filter.normalized_field, value: filter.value })),
    entities: matches,
  };
}

function searchResultFromRelationship(
  relationship: EntityRelationshipRecord,
  entitiesById: Map<string, EntityRecord>,
  score: number,
): SearchResult {
  const source = entitiesById.get(relationship.src_id);
  const target = entitiesById.get(relationship.dst_id);
  const sourceLabel = source?.display_name ?? source?.identity_key ?? relationship.src_id;
  const targetLabel = target?.display_name ?? target?.identity_key ?? relationship.dst_id;
  const content = `${sourceLabel} ${relationship.rel_type} ${targetLabel}`;
  return {
    document_id: relationship.id,
    chunk_id: relationship.id,
    chunk_content: content,
    score,
    metadata: {
      route: 'd1_graph',
      relationship_id: relationship.id,
      relationship_type: relationship.rel_type,
      source_entity_id: relationship.src_id,
      target_entity_id: relationship.dst_id,
      source_identity_key: source?.identity_key ?? null,
      target_identity_key: target?.identity_key ?? null,
      source_display_name: source?.display_name ?? null,
      target_display_name: target?.display_name ?? null,
      evidence_file: relationship.evidence_file,
      evidence_page: relationship.evidence_page,
    },
  };
}

async function graphResultsForEntities(
  repo: MetadataRepository,
  tenant: string,
  domain: string,
  entities: EntityRecord[],
  limit = 8,
): Promise<SearchResult[]> {
  const relationships: EntityRelationshipRecord[] = [];
  for (const entity of entities.slice(0, 5)) {
    relationships.push(...await repo.listRelationships(tenant, domain, undefined, entity.id, limit));
  }
  const unique = new Map<string, EntityRelationshipRecord>();
  for (const relationship of relationships) {
    if (!unique.has(relationship.id)) unique.set(relationship.id, relationship);
  }
  const entityIds = new Set<string>();
  for (const relationship of unique.values()) {
    entityIds.add(relationship.src_id);
    entityIds.add(relationship.dst_id);
  }
  const knownEntities = new Map(entities.map((entity) => [entity.id, entity]));
  if (entityIds.size > knownEntities.size) {
    const allDomainEntities = await repo.listEntities(tenant, domain, undefined, 500);
    for (const entity of allDomainEntities) {
      if (entityIds.has(entity.id)) knownEntities.set(entity.id, entity);
    }
  }
  return [...unique.values()]
    .slice(0, limit)
    .map((relationship, i) => searchResultFromRelationship(relationship, knownEntities, 0.9 / (i + 1)));
}

function answerFromStructuredEntities(question: string, citations: CitationRecord[]): string {
  if (citations.length === 0) {
    return `I cannot answer "${question}" from structured entities in this domain.`;
  }
  const strongest = citations.slice(0, 3).map((citation) => {
    const label = stringMetadata(citation.metadata.display_name)
      ?? stringMetadata(citation.metadata.identity_key)
      ?? citation.document_id;
    return `${label}: ${citation.excerpt} [${citation.index}]`;
  });
  return strongest.join(' ');
}

function kbIndexExternalId(domain: string): string {
  return `kb:${domain}`;
}

function contextWithIndex(c: AppContext, indexId: string): AppContext {
  return {
    ...c,
    req: {
      ...c.req,
      param: (name: string) => name === 'id' ? indexId : c.req.param(name),
    },
  } as AppContext;
}

function recordFromDocumentMetadata(metadata: JsonRecord): JsonRecord | null {
  const record = metadata.record;
  return record && typeof record === 'object' && !Array.isArray(record) ? record as JsonRecord : null;
}

function parseArtifactKey(domain: string, contentHash: string): string {
  return `parse/${safeObjectKeySegment(domain)}/${contentHash}.json`;
}

function virtualInputFilename(prefix: string, title: string, extension: string, contentHash: string): string {
  const safeTitle = safeObjectKeySegment(title || 'untitled') || 'untitled';
  return `${prefix}-${safeTitle}-${contentHash.slice(0, 8)}.${extension}`;
}

function filenameForImportedUrl(rawUrl: string, contentType: string | null): string {
  try {
    const parsed = new URL(rawUrl);
    const pathname = decodeURIComponent(parsed.pathname);
    const last = pathname.split('/').filter(Boolean).pop() || parsed.hostname || 'document';
    if (last.includes('.')) return safeObjectKeySegment(last);
    if (contentType?.includes('html')) return `${safeObjectKeySegment(last)}.html`;
    if (contentType?.includes('pdf')) return `${safeObjectKeySegment(last)}.pdf`;
    if (contentType?.includes('json')) return `${safeObjectKeySegment(last)}.json`;
    return `${safeObjectKeySegment(last)}.txt`;
  } catch {
    return contentType?.includes('html') ? 'document.html' : 'document.txt';
  }
}

function secUserAgent(env: Env, config?: SourceImportBody['config']): string {
  return config?.user_agent?.trim()
    || env.RAG_SEC_USER_AGENT?.trim()
    || 'knowledgebase-rag-service contact@example.invalid';
}

function secHeaders(userAgent: string): HeadersInit {
  return {
    'User-Agent': userAgent,
    Accept: 'application/json,text/html,application/xhtml+xml,text/plain,*/*',
  };
}

function normalizeTicker(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeCik(value: string | number): string {
  return String(value).replace(/\D/g, '').padStart(10, '0').slice(-10);
}

function cikArchiveSegment(cik: string): string {
  return String(Number(cik));
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item ?? '')) : [];
}

function edgarRecentValue(recent: Record<string, unknown[]>, key: string, index: number): string {
  const value = recent[key]?.[index];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function filingWithinDays(filingDate: string, days: number): boolean {
  if (!Number.isFinite(days) || days <= 0) return true;
  const timestamp = Date.parse(`${filingDate}T00:00:00Z`);
  if (!Number.isFinite(timestamp)) return false;
  return timestamp >= Date.now() - days * 24 * 60 * 60 * 1000;
}

async function fetchJson<T>(url: string, userAgent: string): Promise<T> {
  const response = await fetch(url, { headers: secHeaders(userAgent) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return await response.json() as T;
}

async function secTickerLookup(userAgent: string): Promise<Map<string, EdgarTickerRow>> {
  const raw = await fetchJson<Record<string, EdgarTickerRow>>('https://www.sec.gov/files/company_tickers.json', userAgent);
  const out = new Map<string, EdgarTickerRow>();
  for (const row of Object.values(raw)) {
    if (row?.ticker) out.set(normalizeTicker(row.ticker), row);
  }
  return out;
}

async function edgarCandidatesForCompany(input: {
  ticker: string | null;
  cik: string;
  userAgent: string;
  forms: Set<string>;
  days: number;
  perTickerPerForm: number;
  remaining: number;
}): Promise<EdgarFilingCandidate[]> {
  const submissions = await fetchJson<EdgarSubmissionsResponse>(
    `https://data.sec.gov/submissions/CIK${input.cik}.json`,
    input.userAgent,
  );
  const recent = submissions.filings?.recent ?? {};
  const forms = asStringArray(recent.form);
  const seenPerForm = new Map<string, number>();
  const out: EdgarFilingCandidate[] = [];
  for (let i = 0; i < forms.length && out.length < input.remaining; i += 1) {
    const form = forms[i]?.trim();
    if (!form || !input.forms.has(form)) continue;
    if ((seenPerForm.get(form) ?? 0) >= input.perTickerPerForm) continue;
    const filingDate = edgarRecentValue(recent, 'filingDate', i);
    if (!filingWithinDays(filingDate, input.days)) continue;
    const accession = edgarRecentValue(recent, 'accessionNumber', i);
    const primaryDocument = edgarRecentValue(recent, 'primaryDocument', i);
    if (!accession || !primaryDocument) continue;
    const accessionNoDashes = accession.replace(/-/g, '');
    const url = `https://www.sec.gov/Archives/edgar/data/${cikArchiveSegment(input.cik)}/${accessionNoDashes}/${primaryDocument}`;
    out.push({
      ticker: input.ticker,
      cik: input.cik,
      cikNumber: cikArchiveSegment(input.cik),
      companyName: submissions.name ?? null,
      accession,
      accessionNoDashes,
      form,
      filingDate,
      primaryDocument,
      url,
      filename: `${input.ticker ?? input.cik}_${form}_${filingDate}_${accessionNoDashes}_${primaryDocument}`.replace(/[^A-Za-z0-9_.-]+/g, '_'),
    });
    seenPerForm.set(form, (seenPerForm.get(form) ?? 0) + 1);
  }
  return out;
}

function isQueryPayload(value: unknown): value is QueryPayload {
  return Boolean(value && typeof value === 'object' && Array.isArray((value as QueryPayload).data));
}

function withTimingHeaders(
  timing: RagTiming,
  cache: CacheStatus,
  started: number,
): Record<string, string> {
  timing.cache = cache;
  timing.total_ms = elapsedMs(started);
  const serverTiming = Object.entries(timing)
    .filter((entry): entry is [string, number] => entry[0].endsWith('_ms') && typeof entry[1] === 'number')
    .map(([key, value]) => `rag_${key.slice(0, -3)};dur=${value}`)
    .join(', ');
  return {
    'X-RAG-Cache': cache,
    'X-RAG-Timing': JSON.stringify(timing),
    'Server-Timing': serverTiming,
  };
}

type WorkerHealthPayload = {
  ok: boolean;
  d1: boolean;
  vectorize: boolean;
  r2: boolean;
  version: string;
  deploy_fingerprint: string;
  error?: string;
};

function deployFingerprint(env: Env): string {
  return env.RAG_DEPLOY_FINGERPRINT?.trim() || WORKER_DEPLOY_FINGERPRINT;
}

async function workerHealth(env: Env): Promise<WorkerHealthPayload> {
  const fingerprint = deployFingerprint(env);
  try {
    await env.DB.prepare('SELECT 1 AS ok').first();
    return {
      ok: true,
      d1: true,
      vectorize: Boolean(env.VECTORIZE),
      r2: Boolean(env.RAW_DOCS),
      version: WORKER_VERSION,
      deploy_fingerprint: fingerprint,
    };
  } catch (error) {
    return {
      ok: false,
      d1: false,
      vectorize: Boolean(env.VECTORIZE),
      r2: Boolean(env.RAW_DOCS),
      version: WORKER_VERSION,
      deploy_fingerprint: fingerprint,
      error: String(error),
    };
  }
}

function readyzPayload(health: WorkerHealthPayload): JsonRecord {
  return {
    status: health.ok && health.vectorize && health.r2 ? 'ok' : 'degraded',
    db: health.error ? { ok: false, error: health.error.slice(0, 200) } : { ok: health.d1 },
    vector: { ok: health.vectorize, backend: 'vectorize' },
    object: { ok: health.r2, backend: 'r2' },
    worker: { version: health.version, deploy_fingerprint: health.deploy_fingerprint },
  };
}

function prometheusLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function metricsText(health: WorkerHealthPayload): string {
  const lines = [
    '# HELP kb_worker_info Knowledgebase Worker build information.',
    '# TYPE kb_worker_info gauge',
    `kb_worker_info{version="${prometheusLabel(health.version)}",deploy_fingerprint="${prometheusLabel(health.deploy_fingerprint)}"} 1`,
    '# HELP kb_worker_ready Cloudflare Worker dependency readiness.',
    '# TYPE kb_worker_ready gauge',
    `kb_worker_ready ${health.ok && health.vectorize && health.r2 ? 1 : 0}`,
    '# HELP kb_queries_total Total queries served by this Worker isolate.',
    '# TYPE kb_queries_total counter',
    'kb_queries_total 0',
    '# HELP kb_ingest_files_total Total files ingested by this Worker isolate.',
    '# TYPE kb_ingest_files_total counter',
    'kb_ingest_files_total 0',
    '# HELP kb_query_tokens Token usage per query.',
    '# TYPE kb_query_tokens summary',
    'kb_query_tokens_count 0',
    'kb_query_tokens_sum 0',
    '# HELP kb_stage_latency_ms Per-stage latency in ms.',
    '# TYPE kb_stage_latency_ms summary',
    'kb_stage_latency_ms_count{stage="unknown"} 0',
    'kb_stage_latency_ms_sum{stage="unknown"} 0',
  ];
  return `${lines.join('\n')}\n`;
}

function legacyRouteTarget(pathname: string): string | null {
  if (pathname === '/agent/search') return '/v1/kb/search';
  if (pathname === '/search/eval') return '/v1/kb/evals/search';
  if (pathname === '/search') return '/v1/kb/search';
  if (pathname === '/query/stream') return '/v1/kb/query/stream';
  if (pathname === '/query/traces') return '/v1/kb/query/traces';
  if (pathname.startsWith('/query/trace/')) return `/v1/kb${pathname}`;
  if (pathname === '/query') return '/v1/kb/query';
  if (pathname === '/schemas/infer/files') return '/v1/kb/schemas/infer-upload';
  if (pathname === '/ingest/jobs') return '/v1/kb/jobs';
  if (pathname.startsWith('/ingest/jobs/')) return `/v1/kb/ingest/jobs/${pathname.slice('/ingest/jobs/'.length)}`;
  for (const prefix of ['/projects', '/domains', '/schemas', '/files', '/sources', '/entities', '/ingest']) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return `/v1/kb${pathname}`;
  }
  return null;
}

async function forwardLegacyRoute(app: FetchLikeApp, c: AppContext, targetPath: string): Promise<Response> {
  const sourceUrl = new URL(c.req.url);
  sourceUrl.pathname = targetPath;
  const method = c.req.raw.method;
  const init: RequestInit = {
    method,
    headers: new Headers(c.req.raw.headers),
  };
  if (method !== 'GET' && method !== 'HEAD') {
    const body = await c.req.arrayBuffer();
    if (body.byteLength > 0) init.body = body;
  }
  return app.fetch(new Request(sourceUrl.toString(), init), c.env);
}

function sseEvent(event: string, data: unknown): Uint8Array {
  const json = JSON.stringify(data);
  return new TextEncoder().encode(`event: ${event}\ndata: ${json}\n\n`);
}

function timingStages(timing: RagTiming, payload: KbAnswerPayload): JsonRecord[] {
  const stages: JsonRecord[] = [];
  for (const [key, value] of Object.entries(timing)) {
    if (!key.endsWith('_ms') || key === 'total_ms' || typeof value !== 'number') continue;
    stages.push({
      stage: key.slice(0, -3),
      latency_ms: value,
      route: payload.route,
    });
  }
  if (stages.length === 0) {
    stages.push({
      stage: 'answer',
      route: payload.route,
      result_count: payload.data.length,
    });
  }
  return stages;
}

async function deleteVectors(env: Env, ids: string[], model: SemanticModel = 'base'): Promise<void> {
  if (ids.length === 0) return;
  const binding = vectorizeBinding(env, model);
  for (let start = 0; start < ids.length; start += 1000) {
    await binding.deleteByIds(ids.slice(start, start + 1000));
  }
}

export function createApp(options: AppOptions = {}) {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>();
  const makeRepository = options.makeRepository ?? ((env: Env) => new D1Repository(env.DB));
  const makeMetadataRepository = options.makeMetadataRepository ?? ((env: Env) => new D1MetadataRepository(env.DB));
  const embed = options.embed ?? defaultEmbed;
  const queryCache = options.queryCache ?? new TtlCache<QueryPayload>(parseCacheOptions({}));
  const embeddingCache = options.embeddingCache ?? new TtlCache<number[]>(parseCacheOptions({}));
  const indexCache = options.indexCache ?? new TtlCache<boolean>(parseCacheOptions({}));
  const lexicalChunkCache = options.lexicalChunkCache ?? new TtlCache<ChunkRecord[]>(parseCacheOptions({}));

  function rememberIndex(env: Env, tenant: string, indexId: string): void {
    indexCache.configure(parseCacheOptions(env));
    indexCache.set(buildCacheKey({ tenant, indexId }), true);
  }

  async function indexExists(env: Env, repo: Repository, tenant: string, indexId: string): Promise<boolean> {
    indexCache.configure(parseCacheOptions(env));
    const key = buildCacheKey({ tenant, indexId });
    if (indexCache.get(key)) return true;
    const index = await repo.getIndex(tenant, indexId);
    if (!index) return false;
    indexCache.set(key, true);
    return true;
  }

  async function embedOne(
    env: Env,
    tenant: string,
    text: string,
    model: SemanticModel,
    timing?: RagTiming,
  ): Promise<number[]> {
    const started = performance.now();
    embeddingCache.configure(parseCacheOptions(env));
    const modelId = embeddingModel(env, model);
    const key = buildCacheKey({ model: modelId, tenant, text });
    const cached = embeddingCache.get(key);
    if (cached) {
      if (timing) {
        timing.embedding_cache = 'hit';
        timing.embedding_model = model;
        timing.embed_ms = elapsedMs(started);
      }
      return cached;
    }
    const [vector] = await embed(env, [text], { model: modelId });
    if (!vector) throw new Error('Embedding response was empty');
    embeddingCache.set(key, vector);
    if (timing) {
      timing.embedding_cache = 'miss';
      timing.embedding_model = model;
      timing.embed_ms = elapsedMs(started);
    }
    return vector;
  }

  async function rerankWithWorkersAi(
    env: Env,
    payload: QueryPayload,
    query: string,
    body: QueryBody,
    timing: RagTiming,
  ): Promise<QueryPayload> {
    const topK = clampTopK(body.top_k);
    if (payload.data.length <= 1) return payload;
    const started = performance.now();
    const candidates = payload.data.slice(0, Math.min(MAX_TOP_K, Math.max(topK, payload.data.length)));
    try {
      const runAi = env.AI.run as unknown as (model: string, input: Record<string, unknown>) => Promise<unknown>;
      const response = await runAi(DEFAULT_RERANKER_MODEL, {
        query,
        top_k: Math.min(topK, candidates.length),
        contexts: candidates.map((result) => ({
          text: result.chunk_content.slice(0, MAX_RERANK_CONTEXT_CHARS),
        })),
      });
      const rows = rerankResponseRows(response);
      const scored = rows
        .filter((row) => row.id >= 0 && row.id < candidates.length)
        .sort((a, b) => b.score - a.score)
        .flatMap((row, i) => {
          const result = candidates[row.id];
          if (!result) return [];
          return [{
            ...result,
            score: row.score,
            metadata: {
              ...result.metadata,
              retrieval_score: result.score,
              neural_rerank_model: DEFAULT_RERANKER_MODEL,
              neural_rerank_score: row.score,
              neural_rerank_rank: i + 1,
            } as JsonRecord,
          }];
        });
      if (scored.length === 0) throw new Error('Workers AI reranker response was empty');
      timing.rerank = body.mmr === false ? 'workers_ai' : 'workers_ai_mmr';
      timing.neural_rerank_model = DEFAULT_RERANKER_MODEL;
      timing.neural_rerank_candidates = candidates.length;
      timing.neural_rerank_ms = elapsedMs(started);
      return diversifyRankedResults(scored, topK, body.mmr !== false);
    } catch (error) {
      timing.rerank = body.mmr === false ? 'workers_ai_error_keyword' : 'workers_ai_error_keyword_mmr';
      timing.neural_rerank_error = error instanceof Error ? error.message : String(error);
      timing.neural_rerank_ms = elapsedMs(started);
      return rerankAndDiversifyResults(payload, query, topK, body.mmr !== false);
    }
  }

  async function rerankQueryPayload(
    env: Env,
    payload: QueryPayload,
    query: string,
    body: QueryBody,
    timing: RagTiming,
    defaultEnabled: boolean,
  ): Promise<QueryPayload> {
    if (body.rerank === false) {
      if (defaultEnabled || body.rerank_model) timing.rerank = 'off';
      return payload;
    }
    const useWorkersAi = rerankModelFromBody(body) === 'workers_ai';
    if (!defaultEnabled && !useWorkersAi) return payload;
    if (useWorkersAi) return rerankWithWorkersAi(env, payload, query, body, timing);
    timing.rerank = body.mmr === false ? 'keyword' : 'keyword_mmr';
    return rerankAndDiversifyResults(payload, query, clampTopK(body.top_k), body.mmr !== false);
  }

  async function getSharedQueryCache(
    env: Env,
    tenant: string,
    indexId: string,
    cacheKey: string,
    timing?: RagTiming,
  ): Promise<QueryPayload | null> {
    if (!sharedQueryCacheEnabled(env)) return null;
    if (!parseCacheOptions(env).enabled) return null;
    const started = performance.now();
    try {
      const row = await env.DB
        .prepare(
          `SELECT payload
             FROM query_cache
            WHERE cache_key = ? AND tenant = ? AND index_id = ? AND expires_at > ?`,
        )
        .bind(cacheKey, tenant, indexId, Date.now())
        .first<{ payload: string }>();
      if (!row?.payload) return null;
      const parsed = JSON.parse(row.payload) as unknown;
      return isQueryPayload(parsed) ? parsed : null;
    } catch {
      return null;
    } finally {
      if (timing) timing.shared_cache_ms = elapsedMs(started);
    }
  }

  async function setSharedQueryCache(
    env: Env,
    tenant: string,
    indexId: string,
    cacheKey: string,
    payload: QueryPayload,
  ): Promise<void> {
    if (!sharedQueryCacheEnabled(env)) return;
    const cacheOptions = parseCacheOptions(env);
    if (!cacheOptions.enabled) return;
    try {
      await env.DB
        .prepare(
          `INSERT OR REPLACE INTO query_cache (cache_key, tenant, index_id, payload, expires_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(cacheKey, tenant, indexId, JSON.stringify(payload), Date.now() + cacheOptions.ttlMs)
        .run();
    } catch {
      // Query caching is an optimization. A missing migration or transient D1 write failure should not fail search.
    }
  }

  async function clearSharedQueryCache(env: Env, tenant: string, indexId: string): Promise<void> {
    try {
      await env.DB
        .prepare('DELETE FROM query_cache WHERE tenant = ? AND index_id = ?')
        .bind(tenant, indexId)
        .run();
    } catch {
      // Best effort cache invalidation; in-memory cache is cleared separately.
    }
  }

  async function clearKbDomainCaches(env: Env, tenant: string, domain: string): Promise<void> {
    const ragRepo = makeRepository(env);
    const index = await ragRepo.getIndexByExternalId(tenant, kbIndexExternalId(domain));
    queryCache.clear();
    if (index) {
      clearLexicalChunkCache(tenant, index.id);
      await clearSharedQueryCache(env, tenant, index.id);
    }
  }

  async function deleteKbFiles(env: Env, tenant: string, files: FileRecord[]): Promise<{
    deletedFiles: FileRecord[];
    deletedVectors: number;
  }> {
    const metadataRepo = makeMetadataRepository(env);
    const vectorIds = await metadataRepo.listKbChunkVectorIds(tenant, files.map((file) => file.id));
    if (vectorIds.length > 0) {
      await deleteVectors(env, vectorIds);
      if (env.VECTORIZE_SMALL) await deleteVectors(env, vectorIds, 'small');
    }
    if (env.RAW_DOCS) {
      for (const file of files) {
        await env.RAW_DOCS.delete(file.object_key);
        const artifact = await metadataRepo.getParseArtifact(file.content_hash);
        if (artifact) await env.RAW_DOCS.delete(artifact.object_key);
      }
    }
    const deletedFiles = await metadataRepo.deleteFiles(tenant, files.map((file) => file.id));
    for (const domain of new Set(files.map((file) => file.domain))) {
      await clearKbDomainCaches(env, tenant, domain);
    }
    return { deletedFiles, deletedVectors: vectorIds.length };
  }

  async function relationshipsWithEntityNames(
    metadataRepo: MetadataRepository,
    tenant: string,
    relationships: Awaited<ReturnType<MetadataRepository['listRelationships']>>,
  ): Promise<typeof relationships> {
    return await Promise.all(relationships.map(async (relationship) => {
      const [src, dst] = await Promise.all([
        metadataRepo.getEntity(tenant, relationship.src_id),
        metadataRepo.getEntity(tenant, relationship.dst_id),
      ]);
      return {
        ...relationship,
        src_name: src?.display_name ?? src?.identity_key ?? null,
        dst_name: dst?.display_name ?? dst?.identity_key ?? null,
      };
    }));
  }

  function persistSharedQueryCache(
    c: AppContext,
    tenant: string,
    indexId: string,
    cacheKey: string,
    payload: QueryPayload,
  ): Promise<void> | undefined {
    const promise = setSharedQueryCache(c.env, tenant, indexId, cacheKey, payload);
    try {
      c.executionCtx.waitUntil(promise);
      return undefined;
    } catch {
      return promise;
    }
  }

  async function getCachedLexicalChunks(
    env: Env,
    repo: Repository,
    tenant: string,
    indexId: string,
    timing?: RagTiming,
  ): Promise<ChunkRecord[]> {
    const started = performance.now();
    lexicalChunkCache.configure(parseCacheOptions(env));
    const key = buildCacheKey({ tenant, indexId });
    const cached = lexicalChunkCache.get(key);
    if (cached) {
      if (timing) {
        timing.lexical_chunk_cache = 'hit';
        timing.lexical_chunk_load_ms = elapsedMs(started);
      }
      return cached;
    }
    const chunks = await repo.listChunksForIndex(tenant, indexId, MAX_LEXICAL_CHUNKS);
    lexicalChunkCache.set(key, chunks);
    if (timing) {
      timing.lexical_chunk_cache = 'miss';
      timing.lexical_chunk_load_ms = elapsedMs(started);
    }
    return chunks;
  }

  function clearLexicalChunkCache(tenant: string, indexId: string): void {
    lexicalChunkCache.configure(parseCacheOptions({}));
    lexicalChunkCache.set(buildCacheKey({ tenant, indexId }), []);
    lexicalChunkCache.clear();
  }

  async function runTextQuery(c: AppContext, query: string, body: QueryBody): Promise<{
    payload: QueryPayload;
    cache: CacheStatus;
    timing: RagTiming;
  }> {
    const started = performance.now();
    const timing: RagTiming = { route: 'query' };
    const tenant = c.get('tenant');
    const normalizedQuery = normalizeSemanticQuery(query);
    const semanticModel = semanticModelFromBody(body);
    const queryPlan = buildQueryPlan(query, body);
    const cacheKey = buildCacheKey({
      tenant,
      indexId: c.req.param('id'),
      query: normalizedQuery,
      queryPlan: queryPlan.variants,
      topK: clampTopK(body.top_k),
      filter: jsonRecord(body.filter),
      minScore: typeof body.min_score === 'number' ? body.min_score : null,
      mode: body.mode ?? 'auto',
      semanticModel,
      rerank: body.rerank ?? null,
      rerankModel: body.rerank_model ?? null,
      mmr: body.mmr ?? null,
      queryRewrite: body.query_rewrite ?? null,
      queryDecompose: body.query_decompose ?? null,
      lexicalScoring: LEXICAL_SCORING_VERSION,
    });
    const indexId = c.req.param('id');
    if (!indexId) throw new Error('Index not found');
    queryCache.configure(parseCacheOptions(c.env));
    const cached = queryCache.get(cacheKey);
    if (cached) {
      timing.cache_layer = 'memory';
      timing.cache = 'hit';
      timing.total_ms = elapsedMs(started);
      return { payload: cached, cache: 'hit', timing };
    }
    let lexical: QueryPayload | null = null;
    if (body.mode !== 'semantic') {
      const lexicalTopK = body.mode === 'hybrid'
        ? Math.min(MAX_TOP_K, clampTopK(body.top_k) * 2)
        : clampTopK(body.top_k);
      lexical = await queryByLexicalPlan(c, query, { ...body, top_k: lexicalTopK }, queryPlan, timing);
      if (body.mode !== 'hybrid' && lexical && lexical.data.length > 0) {
        const lexicalPayload = await rerankQueryPayload(c.env, lexical, query, body, timing, false);
        queryCache.set(cacheKey, lexicalPayload);
        timing.cache = 'miss';
        timing.total_ms = elapsedMs(started);
        return { payload: lexicalPayload, cache: 'miss', timing };
      }
      if (body.mode === 'lexical') {
        const empty = { data: [] };
        timing.cache = 'miss';
        timing.total_ms = elapsedMs(started);
        return { payload: empty, cache: 'miss', timing };
      }
    }
    const sharedCached = await getSharedQueryCache(c.env, tenant, indexId, cacheKey, timing);
    if (sharedCached) {
      timing.cache_layer = 'd1';
      queryCache.set(cacheKey, sharedCached);
      timing.cache = 'hit';
      timing.total_ms = elapsedMs(started);
      return { payload: sharedCached, cache: 'hit', timing };
    }
    const vector = await embedOne(c.env, tenant, normalizedQuery, semanticModel, timing);
    const widenedTopK = Math.min(MAX_TOP_K, clampTopK(body.top_k) * 2);
    const semanticBody = body.mode === 'hybrid'
      ? { ...body, top_k: widenedTopK }
      : body;
    const semantic = await queryByVector(c, vector, semanticBody, timing);
    const fused = body.mode === 'hybrid'
      ? fuseHybridResults(lexical, semantic, widenedTopK)
      : semantic;
    let payload = await rerankQueryPayload(c.env, fused, query, body, timing, body.mode === 'hybrid');
    if (body.mode === 'hybrid') {
      timing.retrieval = 'hybrid_rrf';
      timing.hybrid_lexical_results = lexical?.data.length ?? 0;
      timing.hybrid_semantic_results = semantic.data.length;
    }
    const correctiveReason = body.mode === 'semantic' ? weakSemanticReason(semantic) : null;
    if (correctiveReason) {
      const correctiveLexical = await queryByLexicalPlan(c, query, { ...body, top_k: widenedTopK }, queryPlan, timing);
      timing.corrective_reason = correctiveReason;
      timing.corrective_lexical_results = correctiveLexical?.data.length ?? 0;
      timing.corrective_semantic_results = semantic.data.length;
      if (correctiveLexical && correctiveLexical.data.length > 0) {
        const correctiveFused = fuseHybridResults(correctiveLexical, semantic, widenedTopK);
        payload = await rerankQueryPayload(c.env, correctiveFused, query, body, timing, true);
        timing.retrieval = 'corrective_hybrid';
      } else {
        timing.retrieval = 'vectorize';
      }
    }
    if (payload.data.length > 0) {
      queryCache.set(cacheKey, payload);
      await persistSharedQueryCache(c, tenant, indexId, cacheKey, payload);
    }
    timing.cache = 'miss';
    timing.total_ms = elapsedMs(started);
    return { payload, cache: 'miss', timing };
  }

  async function ensureKbIndex(repo: Repository, tenant: string, domain: string): Promise<string> {
    const externalId = kbIndexExternalId(domain);
    const existing = await repo.getIndexByExternalId(tenant, externalId);
    if (existing) return existing.id;
    const created = await repo.createIndex({
      id: crypto.randomUUID(),
      tenant,
      name: `Knowledgebase ${domain}`,
      externalId,
    });
    return created.id;
  }

  async function ingestDocumentsToIndex(
    env: Env,
    repo: Repository,
    tenant: string,
    indexId: string,
    documents: Array<{ external_id: string; content: string; metadata: JsonRecord }>,
    chunking?: KbIngestRunBody['chunking'],
  ): Promise<{ document_id: string; chunks: CreateChunkInput[] }[]> {
    const out: { document_id: string; chunks: CreateChunkInput[] }[] = [];
    for (const input of documents) {
      const content = input.content.trim();
      if (!content) continue;
      if (content.length > MAX_DOC_SIZE) throw new Error('document content too large');
      const document = await repo.createDocument({
        id: crypto.randomUUID(),
        tenant,
        indexId,
        externalId: input.external_id,
        content,
        metadata: input.metadata,
      });
      const chunkContents = chunkText(content, chunking);
      const vectors = await embed(env, chunkContents, { model: embeddingModel(env, 'base') });
      const smallVectors = env.VECTORIZE_SMALL
        ? await embed(env, chunkContents, { model: embeddingModel(env, 'small') })
        : [];
      const chunkRows: CreateChunkInput[] = chunkContents.map((chunk, i) => ({
        id: crypto.randomUUID(),
        tenant,
        indexId,
        documentId: document.id,
        content: chunk,
        chunkIndex: i,
        metadata: input.metadata,
      }));
      await repo.insertChunks(chunkRows);
      const vectorRows: VectorizeVector[] = chunkRows.map((chunk, i) => ({
        id: chunk.id,
        values: vectors[i] ?? [],
        namespace: vectorNamespace(tenant, indexId),
        metadata: vectorMetadata(
          tenant,
          indexId,
          document.id,
          chunk.chunkIndex,
          chunk.content,
          chunk.metadata,
        ),
      }));
      if (vectorRows.length > 0) await env.VECTORIZE.upsert(vectorRows);
      if (env.VECTORIZE_SMALL && smallVectors.length > 0) {
        const smallRows: VectorizeVector[] = chunkRows.map((chunk, i) => ({
          id: chunk.id,
          values: smallVectors[i] ?? [],
          namespace: vectorNamespace(tenant, indexId),
          metadata: vectorMetadata(
            tenant,
            indexId,
            document.id,
            chunk.chunkIndex,
            chunk.content,
            chunk.metadata,
          ),
        }));
        await env.VECTORIZE_SMALL.upsert(smallRows);
      }
      out.push({ document_id: document.id, chunks: chunkRows });
    }
    return out;
  }

  app.get('/v1/healthz', async (c) => {
    const health = await workerHealth(c.env);
    return c.json(health, health.ok ? 200 : 503);
  });

  app.get('/healthz', async (c) => {
    const health = await workerHealth(c.env);
    return c.json(health, health.ok ? 200 : 503);
  });

  app.get('/readyz', async (c) => {
    const health = await workerHealth(c.env);
    return c.json(readyzPayload(health), health.ok && health.vectorize && health.r2 ? 200 : 503);
  });

  app.get('/metrics', async (c) => {
    const health = await workerHealth(c.env);
    return c.text(metricsText(health), 200, {
      'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
    });
  });

  app.get('/', (c) => c.html(TESTING_UI_HTML));
  app.get('/ui', (c) => c.html(TESTING_UI_HTML));

  app.all('*', async (c, next) => {
    const target = legacyRouteTarget(new URL(c.req.url).pathname);
    if (!target) return next();
    return forwardLegacyRoute(app, c, target);
  });

  app.use('/v1/*', requireServiceKey);

  app.get('/v1/kb/projects', async (c) => {
    const tenant = c.get('tenant');
    const repo = makeMetadataRepository(c.env);
    const [projects, domains, status] = await Promise.all([
      repo.listProjects(tenant),
      repo.listDomains(tenant),
      repo.corpusStatus(tenant),
    ]);
    const project = projects[0] ?? await repo.upsertProject(tenant);
    return c.json({
      data: [{
        ...project,
        name: tenant,
        project: tenant,
        domain_count: domains.length,
        domains,
        status,
      }],
    });
  });

  app.post('/v1/kb/projects', async (c) => {
    const tenant = c.get('tenant');
    const body = (await c.req.json().catch(() => ({}))) as { name?: string; description?: string };
    const name = body.name?.trim() || tenant;
    if (name !== tenant) {
      return c.json({ error: 'Cloudflare Worker project is bound to the authenticated tenant', project: tenant }, 400);
    }
    const repo = makeMetadataRepository(c.env);
    const project = await repo.upsertProject(tenant, body.description?.trim() ?? '');
    return c.json({ ...project, project: tenant }, 201);
  });

  app.get('/v1/kb/projects/:project/status', async (c) => {
    const tenant = c.get('tenant');
    const project = c.req.param('project').trim();
    if (project && project !== tenant) {
      return c.json({ error: 'project does not match authenticated tenant', project: tenant }, 404);
    }
    const repo = makeMetadataRepository(c.env);
    return c.json({ project: tenant, data: await repo.corpusStatus(tenant) });
  });

  app.post('/v1/indexes', async (c) => {
    const tenant = c.get('tenant');
    const body = (await c.req.json().catch(() => ({}))) as CreateIndexBody;
    const name = body.name?.trim();
    if (!name) return c.json({ error: 'name is required' }, 400);
    const repo = makeRepository(c.env);
    const index = await repo.createIndex({
      id: crypto.randomUUID(),
      tenant,
      name,
      externalId: body.external_id ?? null,
    });
    rememberIndex(c.env, tenant, index.id);
    return c.json(index, 201);
  });

  app.get('/v1/indexes', async (c) => {
    const repo = makeRepository(c.env);
    return c.json({ data: await repo.listIndexes(c.get('tenant')) });
  });

  app.get('/v1/kb/domains', async (c) => {
    const repo = makeMetadataRepository(c.env);
    return c.json({ data: await repo.listDomains(c.get('tenant')) });
  });

  app.post('/v1/kb/domains', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as UpsertDomainBody;
    const name = body.name?.trim();
    if (!name) return c.json({ error: 'name is required' }, 400);
    const repo = makeMetadataRepository(c.env);
    const domain = await repo.upsertDomain(c.get('tenant'), name, body.description?.trim() ?? '');
    return c.json(domain, 201);
  });

  app.get('/v1/kb/schemas', async (c) => {
    const repo = makeMetadataRepository(c.env);
    return c.json({ data: await repo.listSchemas(c.get('tenant')) });
  });

  app.get('/v1/kb/schemas/:domain/active', async (c) => {
    const domain = c.req.param('domain').trim();
    const repo = makeMetadataRepository(c.env);
    const schema = (await repo.listSchemas(c.get('tenant'))).find(
      (row) => row.domain === domain && row.is_active === 1,
    );
    if (!schema) return c.json({ error: 'active schema not found' }, 404);
    return c.json(schema);
  });

  app.post('/v1/kb/schemas/:domain/reprocess', async (c) => {
    const tenant = c.get('tenant');
    const domain = c.req.param('domain').trim();
    const body = (await c.req.json().catch(() => ({}))) as { file_ids?: string[] };
    const repo = makeMetadataRepository(c.env);
    const activeSchema = (await repo.listSchemas(tenant)).find(
      (schema) => schema.domain === domain && schema.is_active === 1,
    );
    if (!activeSchema) return c.json({ error: 'active schema not found' }, 404);
    const selectedIds = new Set((body.file_ids ?? []).filter(Boolean));
    const files = selectedIds.size > 0
      ? (await Promise.all([...selectedIds].map((id) => repo.getFile(tenant, id))))
          .filter((file): file is FileRecord => Boolean(file && file.domain === domain))
      : await repo.listFiles(tenant, domain);
    const jobs = [];
    for (const file of files) {
      await repo.setFileStatus(tenant, file.id, 'pending');
      jobs.push(await repo.upsertIngestJob({
        project: tenant,
        domain,
        fileId: file.id,
        schemaId: activeSchema.id,
        status: 'queued',
        stage: 'parse',
      }));
    }
    return c.json({
      project: tenant,
      domain,
      schema_id: activeSchema.id,
      schema_version: activeSchema.version,
      enqueued: jobs.length,
      stage: 'parse',
      jobs,
    });
  });

  app.post('/v1/kb/schemas', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Partial<DomainSchema>;
    const domain = typeof body.domain === 'string' ? body.domain.trim() : '';
    const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'default';
    if (!domain) return c.json({ error: 'domain is required' }, 400);
    if (!Array.isArray(body.entities) || body.entities.length === 0) {
      return c.json({ error: 'entities array is required' }, 400);
    }
    const spec = {
      domain,
      name,
      version: Number.isFinite(Number(body.version)) ? Number(body.version) : 1,
      description: typeof body.description === 'string' ? body.description : '',
      vocabulary: jsonRecord(body.vocabulary) as Record<string, string>,
      entities: body.entities,
      relationships: Array.isArray(body.relationships) ? body.relationships : [],
    } as DomainSchema;
    const repo = makeMetadataRepository(c.env);
    const schema = await repo.insertSchema(c.get('tenant'), domain, name, spec);
    return c.json(schema, 201);
  });

  app.post('/v1/kb/schemas/infer', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as InferSchemaBody;
    const domain = body.domain?.trim();
    if (!domain) return c.json({ error: 'domain is required' }, 400);
    const records = [
      ...(Array.isArray(body.records) ? body.records : []),
      ...recordsFromUnknown(body.input),
    ];
    const sampleTexts = Array.isArray(body.sample_texts)
      ? body.sample_texts.map((sample) => String(sample || '')).filter(Boolean)
      : [];
    if (records.length === 0 && sampleTexts.length === 0) {
      return c.json({ error: 'records, sample_texts, or input is required' }, 400);
    }
    const inferenceInput = {
      domain,
      records,
      sample_texts: sampleTexts,
      ...(body.name ? { name: body.name } : {}),
    };
    const spec = inferSchema(inferenceInput);
    let draft = null;
    if (body.save_draft !== false) {
      const repo = makeMetadataRepository(c.env);
      draft = await repo.saveSchemaDraft({
        project: c.get('tenant'),
        domain: spec.domain,
        name: spec.name,
        spec,
        source: records.length > 0 ? 'structured_records' : 'sample_text',
        sampleCount: records.length || sampleTexts.length,
      });
    }
    return c.json({
      project: c.get('tenant'),
      domain: spec.domain,
      name: spec.name,
      spec,
      sample_count: records.length || sampleTexts.length,
      draft_id: draft?.id ?? null,
    });
  });

  app.post('/v1/kb/schemas/infer-upload', async (c) => {
    if (!c.env.RAW_DOCS) return c.json({ error: 'RAW_DOCS R2 bucket is not configured' }, 500);
    const body = await c.req.parseBody();
    const domain = typeof body.domain === 'string' ? body.domain.trim() : '';
    const uploaded = body.file instanceof File ? body.file : body.files;
    if (!domain) return c.json({ error: 'domain is required' }, 400);
    if (!(uploaded instanceof File)) return c.json({ error: 'file is required' }, 400);
    if (uploaded.size === 0) return c.json({ error: 'empty file' }, 400);

    const bytes = await uploaded.arrayBuffer();
    const contentHash = await sha256Hex(bytes);
    const objectKey = `raw/${safeObjectKeySegment(domain)}/${contentHash}`;
    await c.env.RAW_DOCS.put(objectKey, bytes, {
      httpMetadata: { contentType: uploaded.type || 'application/octet-stream' },
      customMetadata: {
        filename: uploaded.name || 'file',
        project: c.get('tenant'),
        domain,
        content_hash: contentHash,
      },
    });
    const repo = makeMetadataRepository(c.env);
    const file = await repo.registerFile({
      id: crypto.randomUUID(),
      project: c.get('tenant'),
      domain,
      filename: uploaded.name || 'file',
      mime: uploaded.type || null,
      bytes: uploaded.size,
      contentHash,
      objectKey,
    });
    await repo.upsertIngestJob({
      project: c.get('tenant'),
      domain,
      fileId: file.id,
      status: 'queued',
      stage: 'parse',
    });
    const parsed = await parseUploadBytesWithCloudflare(
      uploaded.name || 'file',
      uploaded.type || null,
      bytes,
      c.env.AI,
      typeof body.markdown_conversion === 'string' ? body.markdown_conversion : c.env.RAG_MARKDOWN_CONVERSION ?? 'auto',
      typeof body.vision_ocr_model === 'string' ? body.vision_ocr_model : c.env.RAG_VISION_OCR_MODEL ?? '',
    );
    if (parsed.documents.length === 0 || !parsed.text) {
      return c.json({ error: 'uploaded file has no parseable text content', file, parser: parsed.parser }, 400);
    }
    const records = parsed.documents
      .map((doc) => recordFromDocumentMetadata(doc.metadata))
      .filter((record): record is JsonRecord => Boolean(record));
    const spec = inferSchema({
      domain,
      records,
      sample_texts: records.length > 0 ? [] : [parsed.text.slice(0, 24_000)],
    });
    const draft = await repo.saveSchemaDraft({
      project: c.get('tenant'),
      domain: spec.domain,
      name: spec.name,
      spec,
      source: parsed.parser,
      sampleCount: records.length || 1,
      stagedFileIds: [file.id],
    });
    return c.json({
      project: c.get('tenant'),
      domain: spec.domain,
      name: spec.name,
      spec,
      sample_count: records.length || 1,
      draft_id: draft.id,
      parser: parsed.parser,
      staged_files: [file],
    });
  });

  app.get('/v1/kb/schemas/drafts', async (c) => {
    const repo = makeMetadataRepository(c.env);
    const domain = c.req.query('domain') || undefined;
    const status = c.req.query('status') || 'pending';
    return c.json({ data: await repo.listSchemaDrafts(c.get('tenant'), domain, status) });
  });

  app.get('/v1/kb/schemas/drafts/:draft_id', async (c) => {
    const repo = makeMetadataRepository(c.env);
    const draft = await repo.getSchemaDraft(c.get('tenant'), c.req.param('draft_id'));
    if (!draft) return c.json({ error: 'schema draft not found' }, 404);
    return c.json(draft);
  });

  app.post('/v1/kb/schemas/drafts/:draft_id/apply', async (c) => {
    const tenant = c.get('tenant');
    const repo = makeMetadataRepository(c.env);
    const draft = await repo.getSchemaDraft(tenant, c.req.param('draft_id'));
    if (!draft) return c.json({ error: 'schema draft not found' }, 404);
    if (draft.status === 'discarded') return c.json({ error: 'schema draft was discarded' }, 409);
    const schema = await repo.insertSchema(tenant, draft.domain, draft.name, draft.spec);
    const updatedDraft = await repo.updateSchemaDraftStatus(tenant, draft.id, 'applied');
    return c.json({ draft: updatedDraft ?? draft, schema });
  });

  app.post('/v1/kb/schemas/drafts/:draft_id/discard', async (c) => {
    const repo = makeMetadataRepository(c.env);
    const draft = await repo.updateSchemaDraftStatus(c.get('tenant'), c.req.param('draft_id'), 'discarded');
    if (!draft) return c.json({ error: 'schema draft not found' }, 404);
    return c.json(draft);
  });

  app.get('/v1/kb/files', async (c) => {
    const repo = makeMetadataRepository(c.env);
    const domain = c.req.query('domain')?.trim() || undefined;
    const statuses = c.req.query('status')?.split(',').map((status) => status.trim()).filter(Boolean);
    return c.json({ data: await repo.listFiles(c.get('tenant'), domain, statuses) });
  });

  app.post('/v1/kb/files', async (c) => {
    const body = parseFileRegistrationBody(await c.req.json().catch(() => ({})));
    if (!body.domain) return c.json({ error: 'domain is required' }, 400);
    if (!body.filename) return c.json({ error: 'filename is required' }, 400);
    if (!body.contentHash) return c.json({ error: 'content_hash is required' }, 400);
    if (!body.objectKey) return c.json({ error: 'object_key is required' }, 400);
    if (!Number.isFinite(body.bytes) || body.bytes < 0) return c.json({ error: 'bytes must be non-negative' }, 400);
    const repo = makeMetadataRepository(c.env);
    const file = await repo.registerFile({
      id: crypto.randomUUID(),
      project: c.get('tenant'),
      ...body,
    });
    await repo.upsertIngestJob({
      project: c.get('tenant'),
      domain: body.domain,
      fileId: file.id,
      status: 'queued',
      stage: 'parse',
    });
    return c.json(file, 201);
  });

  app.get('/v1/kb/files/:file_id', async (c) => {
    const repo = makeMetadataRepository(c.env);
    const file = await repo.getFile(c.get('tenant'), c.req.param('file_id'));
    if (!file) return c.json({ error: 'file not found' }, 404);
    return c.json(file);
  });

  app.post('/v1/kb/files/:file_id/reprocess', async (c) => {
    const tenant = c.get('tenant');
    const repo = makeMetadataRepository(c.env);
    const file = await repo.getFile(tenant, c.req.param('file_id'));
    if (!file) return c.json({ error: 'file not found' }, 404);
    const activeSchema = (await repo.listSchemas(tenant)).find(
      (schema) => schema.domain === file.domain && schema.is_active === 1,
    );
    await repo.setFileStatus(tenant, file.id, 'pending');
    const job = await repo.upsertIngestJob({
      project: tenant,
      domain: file.domain,
      fileId: file.id,
      schemaId: activeSchema?.id ?? null,
      status: 'queued',
      stage: 'parse',
    });
    return c.json({ project: tenant, file_id: file.id, job });
  });

  app.delete('/v1/kb/files/:file_id', async (c) => {
    const tenant = c.get('tenant');
    const repo = makeMetadataRepository(c.env);
    const file = await repo.getFile(tenant, c.req.param('file_id'));
    if (!file) return c.json({ error: 'file not found' }, 404);
    const deleted = await deleteKbFiles(c.env, tenant, [file]);
    return c.json({
      project: tenant,
      affected_files: deleted.deletedFiles.length,
      deleted_files: deleted.deletedFiles,
      deleted_vectors: deleted.deletedVectors,
    });
  });

  app.post('/v1/kb/files/upload', async (c) => {
    if (!c.env.RAW_DOCS) return c.json({ error: 'RAW_DOCS R2 bucket is not configured' }, 500);
    const body = await c.req.parseBody();
    const domain = typeof body.domain === 'string' ? body.domain.trim() : '';
    const uploaded = body.file;
    if (!domain) return c.json({ error: 'domain is required' }, 400);
    if (!(uploaded instanceof File)) return c.json({ error: 'file is required' }, 400);
    if (uploaded.size === 0) return c.json({ error: 'empty file' }, 400);

    const bytes = await uploaded.arrayBuffer();
    const contentHash = await sha256Hex(bytes);
    const safeDomain = safeObjectKeySegment(domain);
    const filename = uploaded.name || 'file';
    const objectKey = `raw/${safeDomain}/${contentHash}`;
    await c.env.RAW_DOCS.put(objectKey, bytes, {
      httpMetadata: { contentType: uploaded.type || 'application/octet-stream' },
      customMetadata: {
        filename,
        project: c.get('tenant'),
        domain,
        content_hash: contentHash,
      },
    });

    const repo = makeMetadataRepository(c.env);
    const file = await repo.registerFile({
      id: crypto.randomUUID(),
      project: c.get('tenant'),
      domain,
      filename,
      mime: uploaded.type || null,
      bytes: uploaded.size,
      contentHash,
      objectKey,
    });
    await repo.upsertIngestJob({
      project: c.get('tenant'),
      domain,
      fileId: file.id,
      status: 'queued',
      stage: 'parse',
    });
    return c.json(file, 201);
  });

  app.get('/v1/kb/status', async (c) => {
    const repo = makeMetadataRepository(c.env);
    return c.json({ data: await repo.corpusStatus(c.get('tenant')) });
  });

  app.get('/v1/kb/jobs', async (c) => {
    const repo = makeMetadataRepository(c.env);
    const domain = c.req.query('domain')?.trim() || undefined;
    const statuses = c.req.query('status')?.split(',').map((status) => status.trim()).filter(Boolean);
    const limit = Number(c.req.query('limit') ?? 100);
    const jobs = await repo.listIngestJobs(c.get('tenant'), domain, statuses, limit);
    return c.json({ project: c.get('tenant'), domain: domain ?? null, jobs });
  });

  app.get('/v1/kb/ingest/jobs/:job_id', async (c) => {
    const repo = makeMetadataRepository(c.env);
    const job = await repo.getIngestJob(c.get('tenant'), c.req.param('job_id'));
    if (!job) return c.json({ error: 'job not found' }, 404);
    return c.json(job);
  });

  app.get('/v1/kb/sources', (c) => c.json({
    sources: ['upload', 'url', 'edgar'],
  }));

  app.post('/v1/kb/sources/import', async (c) => {
    if (!c.env.RAW_DOCS) return c.json({ error: 'RAW_DOCS R2 bucket is not configured' }, 500);
    const body = (await c.req.json().catch(() => ({}))) as SourceImportBody;
    const tenant = c.get('tenant');
    const domain = body.domain?.trim();
    const source = body.source?.trim() || '';
    if (!domain) return c.json({ error: 'domain is required' }, 400);
    if (source !== 'url' && source !== 'edgar') {
      return c.json({
        error: 'unsupported Cloudflare source',
        source,
        supported_sources: ['url', 'edgar'],
        upload_route: '/v1/kb/files/upload',
      }, 400);
    }
    const metadataRepo = makeMetadataRepository(c.env);
    const activeSchema = (await metadataRepo.listSchemas(tenant)).find(
      (schema) => schema.domain === domain && schema.is_active === 1,
    );
    const files: FileRecord[] = [];
    const jobs: IngestJobRecord[] = [];
    const errors: Array<{ url?: string; ticker?: string; cik?: string; error: string }> = [];

    const registerImported = async (input: {
      source: string;
      filename: string;
      mime: string | null;
      bytes: ArrayBuffer;
      metadata: Record<string, string>;
    }) => {
      if (input.bytes.byteLength === 0) throw new Error('empty response');
      if (input.bytes.byteLength > 10_000_000) throw new Error('response exceeds 10 MB source import limit');
      const contentHash = await sha256Hex(input.bytes);
      const objectKey = `raw/${safeObjectKeySegment(domain)}/${contentHash}`;
      await c.env.RAW_DOCS!.put(objectKey, input.bytes, {
        httpMetadata: { contentType: input.mime ?? 'application/octet-stream' },
        customMetadata: {
          filename: input.filename,
          project: tenant,
          domain,
          content_hash: contentHash,
          source: input.source,
          ...input.metadata,
        },
      });
      const file = await metadataRepo.registerFile({
        id: crypto.randomUUID(),
        project: tenant,
        domain,
        filename: input.filename,
        mime: input.mime,
        bytes: input.bytes.byteLength,
        contentHash,
        objectKey,
      });
      files.push(file);
      if (body.auto_ingest !== false) {
        jobs.push(await metadataRepo.upsertIngestJob({
          project: tenant,
          domain,
          fileId: file.id,
          schemaId: activeSchema?.id ?? null,
          status: 'queued',
          stage: 'parse',
        }));
      }
    };

    if (source === 'url') {
      const urls = (body.config?.urls ?? []).map((url) => url.trim()).filter(Boolean).slice(0, 20);
      if (urls.length === 0) return c.json({ error: 'config.urls must contain at least one URL' }, 400);
      for (const url of urls) {
        try {
          const response = await fetch(url, { redirect: 'follow' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const mime = response.headers.get('content-type')?.split(';', 1)[0] || null;
          await registerImported({
            source: 'url',
            filename: filenameForImportedUrl(response.url || url, mime),
            mime,
            bytes: await response.arrayBuffer(),
            metadata: { url: response.url || url },
          });
        } catch (error) {
          errors.push({ url, error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) });
        }
      }
    }

    if (source === 'edgar') {
      const config = body.config ?? {};
      const userAgent = secUserAgent(c.env, config);
      const forms = new Set(
        (config.forms ?? ['10-K', '10-Q', '8-K'])
          .map((form) => form.trim())
          .filter(Boolean),
      );
      if (forms.size === 0) return c.json({ error: 'config.forms must contain at least one form' }, 400);
      const days = Math.min(Math.max(Math.trunc(Number(config.days ?? 540)), 0), 3650);
      const perTickerPerForm = Math.min(Math.max(Math.trunc(Number(config.per_ticker_per_form ?? 2)), 1), 10);
      const limitTotal = Math.min(Math.max(Math.trunc(Number(config.limit_total ?? 12)), 1), 50);
      const tickers = (config.tickers ?? ['NVDA', 'AAPL', 'MSFT']).map(normalizeTicker).filter(Boolean).slice(0, 20);
      const ciks = (config.ciks ?? []).map(normalizeCik).filter(Boolean).slice(0, 20);
      const targets: Array<{ ticker: string | null; cik: string }> = [];
      if (tickers.length > 0) {
        try {
          const lookup = await secTickerLookup(userAgent);
          for (const ticker of tickers) {
            const row = lookup.get(ticker);
            if (!row?.cik_str) {
              errors.push({ ticker, error: 'ticker not found in SEC company_tickers.json' });
              continue;
            }
            targets.push({ ticker, cik: normalizeCik(row.cik_str) });
          }
        } catch (error) {
          errors.push({ error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) });
        }
      }
      for (const cik of ciks) targets.push({ ticker: null, cik });
      const dedupedTargets = [...new Map(targets.map((target) => [`${target.ticker ?? ''}:${target.cik}`, target])).values()];
      if (dedupedTargets.length === 0 && errors.length === 0) return c.json({ error: 'config.tickers or config.ciks must identify at least one company' }, 400);
      const candidates: EdgarFilingCandidate[] = [];
      for (const target of dedupedTargets) {
        if (candidates.length >= limitTotal) break;
        try {
          candidates.push(...await edgarCandidatesForCompany({
            ticker: target.ticker,
            cik: target.cik,
            userAgent,
            forms,
            days,
            perTickerPerForm,
            remaining: limitTotal - candidates.length,
          }));
        } catch (error) {
          errors.push({
            ...(target.ticker ? { ticker: target.ticker } : {}),
            cik: target.cik,
            error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
          });
        }
      }
      for (const filing of candidates.slice(0, limitTotal)) {
        try {
          const response = await fetch(filing.url, { headers: secHeaders(userAgent) });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const mime = response.headers.get('content-type')?.split(';', 1)[0] || 'text/html';
          await registerImported({
            source: 'edgar',
            filename: filing.filename,
            mime,
            bytes: await response.arrayBuffer(),
            metadata: {
              url: filing.url,
              ...(filing.ticker ? { ticker: filing.ticker } : {}),
              cik: filing.cik,
              accession: filing.accession,
              form: filing.form,
              filed_date: filing.filingDate,
              primary_document: filing.primaryDocument,
              ...(filing.companyName ? { company_name: filing.companyName } : {}),
            },
          });
        } catch (error) {
          errors.push({
            url: filing.url,
            ...(filing.ticker ? { ticker: filing.ticker } : {}),
            cik: filing.cik,
            error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
          });
        }
      }
    }
    return c.json({
      project: tenant,
      domain,
      source,
      files,
      file_count: files.length,
      enqueued: jobs.length,
      jobs,
      errors,
    });
  });

  app.get('/v1/kb/source-sets', async (c) => {
    const repo = makeMetadataRepository(c.env);
    const domain = c.req.query('domain')?.trim() || undefined;
    const files = await repo.listFiles(c.get('tenant'), domain);
    return c.json({
      project: c.get('tenant'),
      domain: domain ?? null,
      source_sets: summarizeSourceSets(files),
    });
  });

  app.post('/v1/kb/source-sets/:id/actions', async (c) => {
    const id = c.req.param('id');
    const domain = sourceSetDomain(id);
    if (!domain) return c.json({ error: 'source set id must be domain:<domain>' }, 400);
    const body = (await c.req.json().catch(() => ({}))) as { action?: string; dry_run?: boolean };
    const action = body.action?.trim() || '';
    const allowed = new Set([
      'requeue_all',
      'requeue_failed',
      'requeue_pending',
      'archive_all',
      'archive_failed',
      'archive_ready',
      'delete_all',
      'delete_failed',
      'delete_pending',
      'delete_ready',
    ]);
    if (!allowed.has(action)) return c.json({ error: 'unsupported source-set action' }, 400);
    const tenant = c.get('tenant');
    const metadataRepo = makeMetadataRepository(c.env);
    const files = filesForSourceSetAction(await metadataRepo.listFiles(tenant, domain), action);
    if (body.dry_run) {
      return c.json({
        project: tenant,
        source_set_id: id,
        action,
        dry_run: true,
        affected_files: files.length,
        files,
      });
    }
    if (action.startsWith('requeue_')) {
      const activeSchema = (await metadataRepo.listSchemas(tenant)).find(
        (schema) => schema.domain === domain && schema.is_active === 1,
      );
      const jobs = [];
      for (const file of files) {
        await metadataRepo.setFileStatus(tenant, file.id, 'pending');
        jobs.push(await metadataRepo.upsertIngestJob({
          project: tenant,
          domain,
          fileId: file.id,
          schemaId: activeSchema?.id ?? null,
          status: 'queued',
          stage: 'parse',
        }));
      }
      return c.json({ project: tenant, source_set_id: id, action, affected_files: files.length, jobs });
    }
    if (action.startsWith('archive_')) {
      for (const file of files) {
        await metadataRepo.setFileStatus(tenant, file.id, 'archived');
      }
      return c.json({ project: tenant, source_set_id: id, action, affected_files: files.length });
    }
    const deleted = await deleteKbFiles(c.env, tenant, files);
    return c.json({
      project: tenant,
      source_set_id: id,
      action,
      affected_files: deleted.deletedFiles.length,
      deleted_files: deleted.deletedFiles,
      deleted_vectors: deleted.deletedVectors,
    });
  });

  app.post('/v1/kb/ingest/record', async (c) => {
    if (!c.env.RAW_DOCS) return c.json({ error: 'RAW_DOCS R2 bucket is not configured' }, 500);
    const body = (await c.req.json().catch(() => ({}))) as KbRecordIngestBody;
    const tenant = c.get('tenant');
    const domain = (body.domain ?? body.kind)?.trim();
    const requestedEntityType = body.type?.trim();
    if (!domain) return c.json({ error: 'domain is required' }, 400);
    const records = (Array.isArray(body.data) ? body.data : [body.data])
      .map(jsonRecord)
      .filter((record) => Object.keys(record).length > 0);
    if (records.length === 0) return c.json({ error: 'data must contain at least one record' }, 400);
    const metadataRepo = makeMetadataRepository(c.env);
    let activeSchema = (await metadataRepo.listSchemas(tenant)).find(
      (schema) => schema.domain === domain && schema.is_active === 1,
    );
    let schemaAutoCreated = false;
    if (!activeSchema) {
      const inferred = inferSchema({ domain, records, name: 'auto-direct-record' });
      const inferredPrimary = inferred.entities[0]?.name;
      const spec = requestedEntityType && inferredPrimary
        ? {
            ...inferred,
            entities: inferred.entities.map((entity, index) => (
              index === 0
                ? { ...entity, name: requestedEntityType, aliases: Array.from(new Set([...entity.aliases, inferredPrimary])) }
                : entity
            )),
            relationships: inferred.relationships.map((relationship) => ({
              ...relationship,
              from_type: relationship.from_type === inferredPrimary ? requestedEntityType : relationship.from_type,
              to_type: relationship.to_type === inferredPrimary ? requestedEntityType : relationship.to_type,
            })),
          }
        : inferred;
      activeSchema = await metadataRepo.insertSchema(tenant, domain, spec.name, spec);
      schemaAutoCreated = true;
    }
    const entityType = requestedEntityType || activeSchema.spec.entities[0]?.name;
    if (!entityType) return c.json({ error: 'schema has no entity types' }, 422);
    if (!activeSchema.spec.entities.some((entity) => entity.name === entityType)) {
      return c.json({ error: `schema does not declare entity type '${entityType}'` }, 422);
    }
    const payload = JSON.stringify({ project: tenant, domain, type: entityType, data: records }, null, 2);
    const bytes = new TextEncoder().encode(payload);
    const contentHash = await sha256Hex(bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer);
    const filename = virtualInputFilename('records', entityType.toLowerCase(), 'json', contentHash);
    const objectKey = `raw/${safeObjectKeySegment(domain)}/${contentHash}`;
    await c.env.RAW_DOCS.put(objectKey, bytes, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: {
        filename,
        project: tenant,
        domain,
        content_hash: contentHash,
        source: 'record',
      },
    });
    const file = await metadataRepo.registerFile({
      id: crypto.randomUUID(),
      project: tenant,
      domain,
      filename,
      mime: 'application/json',
      bytes: bytes.byteLength,
      contentHash,
      objectKey,
    });
    await metadataRepo.setFileStatus(tenant, file.id, 'indexing');
    const artifactKey = parseArtifactKey(domain, contentHash);
    const docs = records.map((record, i) => ({
      external_id: `${file.id}:record:${i}`,
      content: stableStringify(record),
      metadata: {
        project: tenant,
        domain,
        file_id: file.id,
        filename,
        record,
        record_index: i,
        entity_type: entityType,
        source: 'record',
      } as JsonRecord,
    }));
    await c.env.RAW_DOCS.put(artifactKey, JSON.stringify({
      parser: 'worker-direct-record-v1',
      parser_version: '1',
      project: tenant,
      domain,
      file_id: file.id,
      filename,
      content_hash: contentHash,
      record_count: records.length,
      document_count: docs.length,
      documents: docs,
    }), {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: {
        project: tenant,
        domain,
        file_id: file.id,
        content_hash: contentHash,
        parser: 'worker-direct-record-v1',
      },
    });
    await metadataRepo.upsertParseArtifact({
      contentHash,
      parser: 'worker-direct-record-v1',
      parserVersion: '1',
      objectKey: artifactKey,
      pageCount: 1,
    });
    const ragRepo = makeRepository(c.env);
    const indexId = await ensureKbIndex(ragRepo, tenant, domain);
    const ingested = await ingestDocumentsToIndex(c.env, ragRepo, tenant, indexId, docs);
    await metadataRepo.insertKbChunks(ingested.flatMap((entry) =>
      entry.chunks.map((chunk) => ({
        id: crypto.randomUUID(),
        project: tenant,
        domain,
        fileId: file.id,
        vectorId: chunk.id,
        pageStart: 0,
        pageEnd: 0,
        text: chunk.content,
        contentHash,
        metadata: chunk.metadata,
      })),
    ));
    const structured = await metadataRepo.recordStructuredEntities({
      project: tenant,
      domain,
      fileId: file.id,
      schema: activeSchema,
      records: records.map((record, i) => ({
        documentId: ingested[i]?.document_id ?? `${file.id}:record:${i}`,
        recordIndex: i,
        record,
        chunks: ingested[i]?.chunks.map((chunk) => ({ id: chunk.id, content: chunk.content })) ?? [],
      })),
    });
    await metadataRepo.setFileStatus(tenant, file.id, 'ready');
    await clearKbDomainCaches(c.env, tenant, domain);
    return c.json({
      project: tenant,
      kind: domain,
      domain,
      type: entityType,
      file_id: file.id,
      schema_id: activeSchema.id,
      schema_auto_created: schemaAutoCreated,
      entities_upserted: structured.entities,
      chunks_indexed: ingested.reduce((sum, entry) => sum + entry.chunks.length, 0),
      structured,
    }, 201);
  });

  app.post('/v1/kb/ingest/text', async (c) => {
    if (!c.env.RAW_DOCS) return c.json({ error: 'RAW_DOCS R2 bucket is not configured' }, 500);
    const body = (await c.req.json().catch(() => ({}))) as KbTextIngestBody;
    const tenant = c.get('tenant');
    const domain = (body.domain ?? body.kind)?.trim();
    const text = body.text?.trim();
    if (!domain) return c.json({ error: 'domain is required' }, 400);
    if (!text) return c.json({ error: 'text must be non-empty' }, 400);
    const metadataRepo = makeMetadataRepository(c.env);
    const activeSchema = (await metadataRepo.listSchemas(tenant)).find(
      (schema) => schema.domain === domain && schema.is_active === 1,
    );
    const bytes = new TextEncoder().encode(text);
    const contentHash = await sha256Hex(bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer);
    const filename = virtualInputFilename('text', body.title?.trim() || 'untitled', 'txt', contentHash);
    const objectKey = `raw/${safeObjectKeySegment(domain)}/${contentHash}`;
    await c.env.RAW_DOCS.put(objectKey, bytes, {
      httpMetadata: { contentType: 'text/plain' },
      customMetadata: {
        filename,
        project: tenant,
        domain,
        content_hash: contentHash,
        ...(body.type ? { entity_type_hint: body.type } : {}),
      },
    });
    const file = await metadataRepo.registerFile({
      id: crypto.randomUUID(),
      project: tenant,
      domain,
      filename,
      mime: 'text/plain',
      bytes: bytes.byteLength,
      contentHash,
      objectKey,
    });
    await metadataRepo.setFileStatus(tenant, file.id, 'pending');
    if (body.async !== true) {
      const ingestBody: KbIngestRunBody = {
        domain,
        file_ids: [file.id],
        async: false,
      };
      if (body.chunking) ingestBody.chunking = body.chunking;
      const ingested = await runKbIngest(c.env, tenant, ingestBody, 'direct-text');
      return c.json({
        ...ingested,
        kind: domain,
        file_id: file.id,
        ingestion_mode: 'inline',
      }, 201);
    }
    const job = await metadataRepo.upsertIngestJob({
      project: tenant,
      domain,
      fileId: file.id,
      schemaId: activeSchema?.id ?? null,
      status: 'queued',
      stage: 'parse',
    });
    return c.json({
      project: tenant,
      kind: domain,
      domain,
      file_id: file.id,
      ingestion_mode: 'queued',
      job_id: job.id,
      job,
    }, 201);
  });

	  app.get('/v1/kb/ingest/runs/:run_id', async (c) => {
	    const repo = makeMetadataRepository(c.env);
	    const runId = c.req.param('run_id').trim();
	    const domain = c.req.query('domain')?.trim() || undefined;
	    const jobs = (await repo.listIngestJobs(c.get('tenant'), domain, undefined, 500))
	      .filter((job) => job.workflow_id === runId);
	    if (jobs.length === 0) return c.json({ error: 'ingest run not found' }, 404);
	    let workflow: JsonRecord | null = null;
	    if (c.env.KB_INGEST_WORKFLOW) {
	      try {
	        const instance = await c.env.KB_INGEST_WORKFLOW.get(runId);
	        const status = await instance.status();
	        workflow = {
	          id: instance.id,
	          status: status.status,
	          ...(status.error ? { error: status.error } : {}),
	        };
	      } catch {
	        workflow = null;
	      }
	    }
	    return c.json({
	      project: c.get('tenant'),
	      domain: domain ?? null,
	      run_id: runId,
	      ...(workflow ? { workflow } : {}),
	      summary: summarizeIngestRun(runId, jobs),
	      jobs,
	    });
	  });

  app.get('/v1/kb/parse-artifacts/:hash', async (c) => {
    const repo = makeMetadataRepository(c.env);
    const artifact = await repo.getParseArtifact(c.req.param('hash'));
    if (!artifact) return c.json({ error: 'parse artifact not found' }, 404);
    return c.json(artifact);
  });

  async function runKbIngest(
    env: Env,
    tenant: string,
    body: KbIngestRunBody,
    lockedBy: string,
  ): Promise<{ project: string; domain: string; run_id: string | null; index_id: string; files: JsonRecord[] }> {
    if (!env.RAW_DOCS) throw new Error('RAW_DOCS R2 bucket is not configured');
    const domain = body.domain?.trim();
    if (!domain) throw new Error('domain is required');
    const repo = makeRepository(env);
    const metadataRepo = makeMetadataRepository(env);
    const runId = body.run_id?.trim() || null;
    const indexId = await ensureKbIndex(repo, tenant, domain);
    const activeSchema = (await metadataRepo.listSchemas(tenant)).find(
      (schema) => schema.domain === domain && schema.is_active === 1,
    );
    const selectedIds = new Set((body.file_ids ?? []).filter(Boolean));
    const files = selectedIds.size > 0
      ? (await Promise.all([...selectedIds].map((id) => metadataRepo.getFile(tenant, id)))).filter((file): file is NonNullable<typeof file> => Boolean(file))
      : await metadataRepo.listFiles(tenant, domain, ['pending']);
    const results = [];
    for (const file of files) {
      const job = await metadataRepo.upsertIngestJob({
        project: tenant,
        domain,
        fileId: file.id,
	        schemaId: activeSchema?.id ?? null,
	        status: 'running',
	        stage: 'parse',
	        workflowId: runId,
	      });
      try {
        await metadataRepo.updateIngestJob(job.id, { status: 'running', stage: 'parse', lockedBy });
        await metadataRepo.setFileStatus(tenant, file.id, 'indexing');
        const object = await env.RAW_DOCS.get(file.object_key);
        if (!object) throw new Error(`R2 object not found: ${file.object_key}`);
        const parsed = await parseUploadBytesWithCloudflare(
          file.filename,
          file.mime,
          await object.arrayBuffer(),
          env.AI,
          body.markdown_conversion ?? env.RAG_MARKDOWN_CONVERSION ?? 'auto',
          body.vision_ocr_model ?? env.RAG_VISION_OCR_MODEL ?? '',
        );
        if (parsed.documents.length === 0 || !parsed.text) throw new Error(`file has no parseable text content via ${parsed.parser}`);
        const docs = parsed.documents.map((doc) => ({
          ...doc,
          metadata: {
            ...doc.metadata,
            project: tenant,
            domain,
            file_id: file.id,
            filename: file.filename,
          },
        }));
        const artifactKey = parseArtifactKey(domain, file.content_hash);
        await env.RAW_DOCS.put(artifactKey, JSON.stringify({
          parser: parsed.parser,
          parser_version: parsed.parser_version,
          project: tenant,
          domain,
          file_id: file.id,
          filename: file.filename,
          content_hash: file.content_hash,
          record_count: parsed.record_count,
          document_count: docs.length,
          text_length: parsed.text.length,
          documents: docs,
        }), {
          httpMetadata: { contentType: 'application/json' },
          customMetadata: {
            project: tenant,
            domain,
            file_id: file.id,
            content_hash: file.content_hash,
            parser: parsed.parser,
          },
        });
        const artifact = await metadataRepo.upsertParseArtifact({
          contentHash: file.content_hash,
          parser: parsed.parser,
          parserVersion: parsed.parser_version,
          objectKey: artifactKey,
          pageCount: parsed.page_count,
        });
        await metadataRepo.updateIngestJob(job.id, { status: 'running', stage: 'index' });
        const ingested = await ingestDocumentsToIndex(env, repo, tenant, indexId, docs, body.chunking);
        await metadataRepo.insertKbChunks(ingested.flatMap((entry) =>
          entry.chunks.map((chunk) => ({
            id: crypto.randomUUID(),
            project: tenant,
            domain,
            fileId: file.id,
            vectorId: chunk.id,
            pageStart: 1,
            pageEnd: 1,
            text: chunk.content,
            metadata: chunk.metadata,
          })),
        ));
        let structured = { entities: 0, mentions: 0, relationships: 0, provenance_spans: 0, chunks_linked: 0 };
        if (activeSchema) {
          await metadataRepo.updateIngestJob(job.id, { status: 'running', stage: 'extract' });
          structured = await metadataRepo.recordStructuredEntities({
            project: tenant,
            domain,
            fileId: file.id,
            schema: activeSchema,
            records: ingested.flatMap((entry, i) => {
              const record = recordFromDocumentMetadata(docs[i]?.metadata ?? {});
              return record ? [{
                documentId: entry.document_id,
                recordIndex: i,
                record,
                chunks: entry.chunks.map((chunk) => ({ id: chunk.id, content: chunk.content })),
              }] : [];
            }),
          });
        }
        await metadataRepo.setFileStatus(tenant, file.id, 'ready');
        await metadataRepo.updateIngestJob(job.id, { status: 'succeeded', stage: 'indexed', lockedBy: null });
        results.push({
          job_id: job.id,
          file_id: file.id,
          filename: file.filename,
          status: 'ready',
          parse_artifact: artifact,
          documents_created: ingested.length,
          chunks_created: ingested.reduce((sum, entry) => sum + entry.chunks.length, 0),
          ...structured,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await metadataRepo.setFileStatus(tenant, file.id, 'failed', message);
	        await metadataRepo.updateIngestJob(job.id, {
	          status: 'failed',
	          error: message,
	          lockedBy: null,
	          incrementAttempts: true,
	        });
        results.push({ job_id: job.id, file_id: file.id, filename: file.filename, status: 'failed', error: message });
      }
    }
    queryCache.clear();
    clearLexicalChunkCache(tenant, indexId);
    await clearSharedQueryCache(env, tenant, indexId);
    return { project: tenant, domain, run_id: runId, index_id: indexId, files: results };
  }

	  app.post('/v1/kb/ingest/run', async (c) => {
	    const body = (await c.req.json().catch(() => ({}))) as KbIngestRunBody;
    const queueIsPrimary = body.async !== false;
	    if (queueIsPrimary && c.env.INGEST_QUEUE) {
		      const domain = body.domain?.trim();
		      if (!domain) return c.json({ error: 'domain is required' }, 400);
		      const runId = body.run_id?.trim() || crypto.randomUUID();
	      const message: KbIngestQueueMessage = {
	        kind: 'kb_ingest',
	        project: c.get('tenant'),
	        domain,
	        run_id: runId,
		      };
      if (body.file_ids !== undefined) message.file_ids = body.file_ids;
      if (body.markdown_conversion !== undefined) message.markdown_conversion = body.markdown_conversion;
      if (body.vision_ocr_model !== undefined) message.vision_ocr_model = body.vision_ocr_model;
      if (body.chunking !== undefined) message.chunking = body.chunking;
      let queueMetrics: { backlog_count: number; backlog_bytes: number } | null = null;
      let workflowInstanceId: string | null = null;
      if (c.env.KB_INGEST_WORKFLOW) {
        const instance = await c.env.KB_INGEST_WORKFLOW.create({
          id: runId,
          params: message,
          retention: {
            successRetention: '1 day',
            errorRetention: '1 week',
          },
        });
        workflowInstanceId = instance.id;
      } else {
        const response = await c.env.INGEST_QUEUE.send(message);
        queueMetrics = {
          backlog_count: response.metadata.metrics.backlogCount,
          backlog_bytes: response.metadata.metrics.backlogBytes,
        };
      }
      const metadataRepo = makeMetadataRepository(c.env);
      const activeSchema = (await metadataRepo.listSchemas(c.get('tenant'))).find(
        (schema) => schema.domain === domain && schema.is_active === 1,
      );
      const files = body.file_ids?.length
        ? (await Promise.all(body.file_ids.map((id) => metadataRepo.getFile(c.get('tenant'), id)))).filter((file): file is NonNullable<typeof file> => Boolean(file))
        : await metadataRepo.listFiles(c.get('tenant'), domain, ['pending']);
      const jobs = [];
      for (const file of files) {
        jobs.push(await metadataRepo.upsertIngestJob({
          project: c.get('tenant'),
          domain,
          fileId: file.id,
		          schemaId: activeSchema?.id ?? null,
		          status: 'queued',
		          stage: 'parse',
		          queueMessageId: workflowInstanceId ? 'cloudflare-workflow' : 'cloudflare-queue',
		          workflowId: runId,
		        }));
	      }
	      return c.json({
		        project: c.get('tenant'),
		        domain,
		        run_id: runId,
		        ingestion_mode: 'queued',
		        orchestration: workflowInstanceId ? 'workflow' : 'queue',
		        queued: true,
		        jobs,
	        ...(workflowInstanceId ? { workflow: { id: workflowInstanceId } } : {}),
	        ...(queueMetrics ? { queue: queueMetrics } : {}),
	      }, 202);
	    }
    if (body.async === true && !c.env.INGEST_QUEUE) return c.json({ error: 'INGEST_QUEUE is not configured' }, 500);
    try {
	      const runBody = {
	        ...body,
	        run_id: body.run_id?.trim() || crypto.randomUUID(),
	      };
      return c.json({
        ...(await runKbIngest(c.env, c.get('tenant'), runBody, 'worker-inline')),
        ingestion_mode: 'inline',
        queued: false,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'RAW_DOCS R2 bucket is not configured') return c.json({ error: message }, 500);
      if (message === 'domain is required') return c.json({ error: message }, 400);
      throw error;
    }
  });

  app.get('/v1/kb/entities', async (c) => {
    const tenant = c.get('tenant');
    const metadataRepo = makeMetadataRepository(c.env);
    const domain = c.req.query('domain')?.trim() || undefined;
    const type = c.req.query('type')?.trim() || undefined;
    const limit = Number(c.req.query('limit') ?? 100);
    const entities = await metadataRepo.listEntities(tenant, domain, type, limit);
    return c.json({ project: tenant, domain: domain ?? null, type: type ?? null, entities });
  });

  app.get('/v1/kb/entities/find', async (c) => {
    const tenant = c.get('tenant');
    const metadataRepo = makeMetadataRepository(c.env);
    const domain = c.req.query('domain')?.trim();
    const type = c.req.query('type')?.trim();
    const identityKey = c.req.query('identity_key')?.trim();
    if (!domain) return c.json({ error: 'domain is required' }, 400);
    if (!type) return c.json({ error: 'type is required' }, 400);
    if (!identityKey) return c.json({ error: 'identity_key is required' }, 400);
    const entity = await metadataRepo.findEntity(tenant, domain, type, identityKey);
    if (!entity) return c.json({ error: 'entity not found' }, 404);
    return c.json(entity);
  });

  app.get('/v1/kb/entities/:entity_id', async (c) => {
    const metadataRepo = makeMetadataRepository(c.env);
    const entity = await metadataRepo.getEntity(c.get('tenant'), c.req.param('entity_id'));
    if (!entity) return c.json({ error: 'entity not found' }, 404);
    return c.json(entity);
  });

  app.get('/v1/kb/entities/:entity_id/lineage', async (c) => {
    const tenant = c.get('tenant');
    const metadataRepo = makeMetadataRepository(c.env);
    const entity = await metadataRepo.getEntity(tenant, c.req.param('entity_id'));
    if (!entity) return c.json({ error: 'entity not found' }, 404);
    const lineage = await metadataRepo.getEntityLineage(tenant, entity.id);
    const relationships = await relationshipsWithEntityNames(
      metadataRepo,
      tenant,
      await metadataRepo.listRelationships(tenant, entity.domain, undefined, entity.id, 100),
    );
    return c.json({
      project: tenant,
      entity,
      ...lineage,
      parent_chain: lineage.ancestors.filter((ancestor) => ancestor.id !== entity.id),
      relationships,
    });
  });

  app.get('/v1/kb/entities/:entity_id/relationships', async (c) => {
    const tenant = c.get('tenant');
    const metadataRepo = makeMetadataRepository(c.env);
    const entity = await metadataRepo.getEntity(tenant, c.req.param('entity_id'));
    if (!entity) return c.json({ error: 'entity not found' }, 404);
    const relationships = await relationshipsWithEntityNames(
      metadataRepo,
      tenant,
      await metadataRepo.listRelationships(tenant, entity.domain, undefined, entity.id, 100),
    );
    return c.json({ project: tenant, entity_id: entity.id, relationships });
  });

  app.post('/v1/kb/entities/search', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { domain?: string; query?: string; limit?: number };
    const domain = body.domain?.trim();
    const query = body.query?.trim();
    if (!domain) return c.json({ error: 'domain is required' }, 400);
    if (!query) return c.json({ error: 'query is required' }, 400);
    const tenant = c.get('tenant');
    const metadataRepo = makeMetadataRepository(c.env);
    const entities = await metadataRepo.searchEntities(tenant, domain, query, body.limit ?? 20);
    return c.json({
      project: tenant,
      domain,
      query,
      route: 'd1_entities',
      ai_used: false,
      entities,
    });
  });

  app.get('/v1/kb/relationships', async (c) => {
    const tenant = c.get('tenant');
    const metadataRepo = makeMetadataRepository(c.env);
    const domain = c.req.query('domain')?.trim() || undefined;
    const relType = c.req.query('type')?.trim() || undefined;
    const entityId = c.req.query('entity_id')?.trim() || undefined;
    const limit = Number(c.req.query('limit') ?? 100);
    const relationships = await relationshipsWithEntityNames(
      metadataRepo,
      tenant,
      await metadataRepo.listRelationships(tenant, domain, relType, entityId, limit),
    );
    return c.json({
      project: tenant,
      domain: domain ?? null,
      type: relType ?? null,
      entity_id: entityId ?? null,
      relationships,
    });
  });

  app.post('/v1/kb/relationships/backfill', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { domain?: string };
    const tenant = c.get('tenant');
    const metadataRepo = makeMetadataRepository(c.env);
    const domain = body.domain?.trim();
    const schemas = (await metadataRepo.listSchemas(tenant))
      .filter((schema) => !domain || schema.domain === domain);
    if (domain && schemas.length === 0) return c.json({ error: 'active schema not found for domain' }, 404);
    const results = [];
    for (const schema of schemas) {
      results.push(await metadataRepo.backfillEntityRelationships(tenant, schema));
    }
    return c.json({
      project: tenant,
      domain: domain ?? null,
      backfilled_domains: results.length,
      scanned_entities: results.reduce((sum, result) => sum + result.scanned_entities, 0),
      candidate_relationships: results.reduce((sum, result) => sum + result.candidate_relationships, 0),
      relationships_inserted: results.reduce((sum, result) => sum + result.relationships_inserted, 0),
      parent_links_updated: results.reduce((sum, result) => sum + result.parent_links_updated, 0),
      results,
    });
  });

  async function runKbAnswer(
    c: AppContext,
    body: KbQueryBody,
    started: number,
  ): Promise<{ payload: KbAnswerPayload; timing: RagTiming; cache: CacheStatus }> {
    const domain = body.domain?.trim();
    const question = (body.question ?? body.query)?.trim();
    if (!domain) throw new Error('domain is required');
    if (!question) throw new Error('question is required');
    const tenant = c.get('tenant');
    const repo = makeRepository(c.env);
    const metadataRepo = makeMetadataRepository(c.env);
    const requestedAnswerMode = answerModeFromBody(body);
    const requestedSessionId = body.session_id?.trim();
    const sessionId: string | null = requestedSessionId || null;
    if (requestedSessionId) {
      const existingSession = await metadataRepo.getSession(tenant, requestedSessionId);
      if (!existingSession) await metadataRepo.createSession(tenant, domain, requestedSessionId);
    }
    const queryBody: QueryBody = {};
    if (body.top_k !== undefined) queryBody.top_k = body.top_k;
    if (body.mode !== undefined) queryBody.mode = body.mode;
    if (body.semantic_model !== undefined) queryBody.semantic_model = body.semantic_model;
    if (body.rerank !== undefined) queryBody.rerank = body.rerank;
    if (body.rerank_model !== undefined) queryBody.rerank_model = body.rerank_model;
    if (body.mmr !== undefined) queryBody.mmr = body.mmr;
    if (body.query_rewrite !== undefined) queryBody.query_rewrite = body.query_rewrite;
    if (body.query_decompose !== undefined) queryBody.query_decompose = body.query_decompose;
    if (body.mode !== 'semantic') {
      const structuredStarted = performance.now();
      const topK = clampTopK(body.top_k ?? 5);
      const fieldQuery = await structuredFieldQueryResults(metadataRepo, tenant, domain, question, topK);
      const structuredEntities = fieldQuery.entities.length > 0
        ? fieldQuery.entities
        : await metadataRepo.searchEntities(tenant, domain, question, topK);
      if (structuredEntities.length > 0) {
        const structuredRoute = fieldQuery.entities.length > 0 ? 'd1_structured_query' : 'd1_entities';
        const entityResults = structuredEntities.map((entity, i) =>
          searchResultFromEntity(entity, 1 / (i + 1), structuredRoute, fieldQuery.filters.length > 0 ? {
            structured_filters: fieldQuery.filters,
          } : {}),
        );
        const graphResults = await graphResultsForEntities(metadataRepo, tenant, domain, structuredEntities);
        const data = [...entityResults, ...graphResults].slice(0, topK + graphResults.length);
        const citations = citationsFromResults(data, question);
        const baseConfidence: JsonRecord = {
          level: 'high',
          route: graphResults.length > 0 ? 'd1_graph' : structuredRoute,
          result_count: data.length,
          entity_result_count: entityResults.length,
          graph_result_count: graphResults.length,
          structured_filters: fieldQuery.filters,
          calibration: fieldQuery.entities.length > 0
            ? 'exact_structured_field_match'
            : graphResults.length > 0
              ? 'exact_structured_entity_match_with_graph_edges'
              : 'exact_structured_entity_match',
        };
        const answerState = await answerFromEvidence({
          env: c.env,
          question,
          citations,
          retrieved: data,
          extractiveAnswer: answerFromStructuredEntities(question, citations),
          baseConfidence,
          requestedMode: requestedAnswerMode,
          requestedModel: body.answer_model,
        });
        const timing: RagTiming = {
          route: 'query',
          structured_route: graphResults.length > 0 ? 'd1_graph' : structuredRoute,
          structured_ms: elapsedMs(structuredStarted),
          ...answerState.timing,
          verification: 'deterministic',
          verification_status: String(answerState.confidence.verification_status ?? 'unknown'),
          cache: 'miss',
        };
	        const trace = await metadataRepo.insertQueryTrace({
	          project: tenant,
	          domain,
          question,
          scope: body.scope ?? null,
          filters: { route: graphResults.length > 0 ? 'd1_graph' : structuredRoute, structured_filters: fieldQuery.filters },
          retrieved: data,
          answer: answerState.answer,
          citations,
	          confidence: answerState.confidence,
	          latencyMs: elapsedMs(started),
	        });
	        writeTraceAnalytics(c.env, trace);
        if (sessionId) {
          await metadataRepo.appendSessionHistory(tenant, sessionId, [
            { role: 'user', content: question, trace_id: trace.id, created_at: new Date().toISOString() },
            { role: 'assistant', content: answerState.answer, trace_id: trace.id, citations, route: 'd1_entities', answer_mode: answerState.answerMode, created_at: new Date().toISOString() },
          ]);
        }
        return {
          payload: {
            project: tenant,
            domain,
            index_id: null,
            route: 'd1_entities',
            ai_used: answerState.aiUsed,
            trace_id: trace.id,
            session_id: sessionId,
            answer_mode: answerState.answerMode,
            answer_model: answerState.answerModel,
            question,
            answer: answerState.answer,
            citations,
            confidence: answerState.confidence,
            data,
          },
          timing,
          cache: 'miss',
        };
      }
    }
    const index = await repo.getIndexByExternalId(tenant, kbIndexExternalId(domain));
    if (!index) throw new Error('domain index not found');
    const result = await runTextQuery(contextWithIndex(c, index.id), question, queryBody);
    const citations = citationsFromResults(result.payload.data, question);
    const answerState = await answerFromEvidence({
      env: c.env,
      question,
      citations,
      retrieved: result.payload.data,
      extractiveAnswer: answerFromCitations(question, citations),
      baseConfidence: confidenceFromResults(result.payload.data),
      requestedMode: requestedAnswerMode,
      requestedModel: body.answer_model,
    });
    const route = result.timing.retrieval === 'lexical'
      ? 'd1_lexical'
      : result.timing.retrieval === 'hybrid_rrf'
        ? 'hybrid_rrf'
        : 'vectorize';
    result.timing.verification = 'deterministic';
    Object.assign(result.timing, answerState.timing);
    result.timing.verification_status = String(answerState.confidence.verification_status ?? 'unknown');
	    const trace = await metadataRepo.insertQueryTrace({
	      project: tenant,
      domain,
      question,
      scope: body.scope ?? null,
      filters: queryBody.filter ?? null,
      retrieved: result.payload.data,
      answer: answerState.answer,
      citations,
	      confidence: answerState.confidence,
	      latencyMs: elapsedMs(started),
	    });
	    writeTraceAnalytics(c.env, trace);
    if (sessionId) {
      await metadataRepo.appendSessionHistory(tenant, sessionId, [
        { role: 'user', content: question, trace_id: trace.id, created_at: new Date().toISOString() },
        { role: 'assistant', content: answerState.answer, trace_id: trace.id, citations, route, answer_mode: answerState.answerMode, created_at: new Date().toISOString() },
      ]);
    }
    return {
      payload: {
        project: tenant,
        domain,
        index_id: index.id,
        route,
        ai_used: answerState.aiUsed || (route !== 'd1_lexical' && result.cache !== 'hit'),
        trace_id: trace.id,
        session_id: sessionId,
        answer_mode: answerState.answerMode,
        answer_model: answerState.answerModel,
        question,
        answer: answerState.answer,
        citations,
        confidence: answerState.confidence,
        data: result.payload.data,
      },
      timing: result.timing,
      cache: result.cache,
    };
  }

  app.post('/v1/kb/search', async (c) => {
    const started = performance.now();
    const body = (await c.req.json().catch(() => ({}))) as KbSearchBody;
    const domain = body.domain?.trim();
    const query = body.query?.trim();
    if (!domain) return c.json({ error: 'domain is required' }, 400);
    if (!query) return c.json({ error: 'query is required' }, 400);
    const tenant = c.get('tenant');
    const repo = makeRepository(c.env);
    const index = await repo.getIndexByExternalId(tenant, kbIndexExternalId(domain));
    if (!index) return c.json({ error: 'domain index not found' }, 404);
    const queryBody: QueryBody = {};
    if (body.top_k !== undefined) queryBody.top_k = body.top_k;
    if (body.mode !== undefined) queryBody.mode = body.mode;
    if (body.semantic_model !== undefined) queryBody.semantic_model = body.semantic_model;
    if (body.rerank !== undefined) queryBody.rerank = body.rerank;
    if (body.rerank_model !== undefined) queryBody.rerank_model = body.rerank_model;
    if (body.mmr !== undefined) queryBody.mmr = body.mmr;
    if (body.query_rewrite !== undefined) queryBody.query_rewrite = body.query_rewrite;
    if (body.query_decompose !== undefined) queryBody.query_decompose = body.query_decompose;
    const result = await runTextQuery(contextWithIndex(c, index.id), query, queryBody);
    return c.json({
      project: tenant,
      domain,
      index_id: index.id,
      ...result.payload,
    }, 200, withTimingHeaders(result.timing, result.cache, started));
  });

  app.post('/v1/kb/query', async (c) => {
    const started = performance.now();
    const body = (await c.req.json().catch(() => ({}))) as KbQueryBody;
    const domain = body.domain?.trim();
    const question = (body.question ?? body.query)?.trim();
    if (!domain) return c.json({ error: 'domain is required' }, 400);
    if (!question) return c.json({ error: 'question is required' }, 400);
    try {
      const result = await runKbAnswer(c, body, started);
      return c.json(result.payload, 200, withTimingHeaders(result.timing, result.cache, started));
    } catch (error) {
      if (error instanceof Error && error.message === 'domain index not found') {
        return c.json({ error: 'domain index not found' }, 404);
      }
      throw error;
    }
  });

  app.post('/v1/kb/query/stream', async (c) => {
    const started = performance.now();
    const body = (await c.req.json().catch(() => ({}))) as KbQueryBody;
    const domain = body.domain?.trim();
    const question = (body.question ?? body.query)?.trim();
    if (!domain) return c.json({ error: 'domain is required' }, 400);
    if (!question) return c.json({ error: 'question is required' }, 400);

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(sseEvent('started', {
          project: c.get('tenant'),
          domain,
          question,
        }));
        try {
          const result = await runKbAnswer(c, body, started);
          withTimingHeaders(result.timing, result.cache, started);
          for (const stage of timingStages(result.timing, result.payload)) {
            controller.enqueue(sseEvent('stage', stage));
          }
          controller.enqueue(sseEvent('answer', result.payload));
        } catch (error) {
          controller.enqueue(sseEvent('error', {
            detail: error instanceof Error ? error.message : String(error),
          }));
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  });

  app.post('/v1/kb/sessions', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as KbSessionBody;
    const domain = body.domain?.trim();
    if (!domain) return c.json({ error: 'domain is required' }, 400);
    const id = body.id?.trim() || undefined;
    const metadataRepo = makeMetadataRepository(c.env);
    const session = await metadataRepo.createSession(c.get('tenant'), domain, id);
    return c.json(session, 201);
  });

  app.get('/v1/kb/sessions', async (c) => {
    const domain = c.req.query('domain')?.trim() || undefined;
    const limit = Number(c.req.query('limit') ?? 50);
    const metadataRepo = makeMetadataRepository(c.env);
    const sessions = await metadataRepo.listSessions(c.get('tenant'), domain, limit);
    return c.json({ project: c.get('tenant'), domain: domain ?? null, sessions });
  });

  app.get('/v1/kb/sessions/:id', async (c) => {
    const metadataRepo = makeMetadataRepository(c.env);
    const session = await metadataRepo.getSession(c.get('tenant'), c.req.param('id'));
    if (!session) return c.json({ error: 'session not found' }, 404);
    return c.json(session);
  });

  app.post('/v1/kb/sessions/:id/messages', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as KbSessionBody;
    const entries = Array.isArray(body.entries) ? body.entries.filter((entry) => entry && typeof entry === 'object') : [];
    if (entries.length === 0) return c.json({ error: 'entries array is required' }, 400);
    const metadataRepo = makeMetadataRepository(c.env);
    try {
      const session = await metadataRepo.appendSessionHistory(c.get('tenant'), c.req.param('id'), entries);
      return c.json(session);
    } catch (error) {
      if (error instanceof Error && error.message === 'session not found') {
        return c.json({ error: 'session not found' }, 404);
      }
      throw error;
    }
  });

  app.get('/v1/kb/query/traces', async (c) => {
    const tenant = c.get('tenant');
    const domain = c.req.query('domain')?.trim() || undefined;
    const limit = clampTopK(c.req.query('limit') ?? 20);
    const metadataRepo = makeMetadataRepository(c.env);
    const traces = await metadataRepo.listQueryTraces(tenant, domain, limit);
    return c.json({ project: tenant, domain: domain ?? null, traces });
  });

  app.get('/v1/kb/query/traces/export', async (c) => {
    const tenant = c.get('tenant');
    const domain = c.req.query('domain')?.trim() || undefined;
    const limit = clampTopK(c.req.query('limit') ?? 50);
    const metadataRepo = makeMetadataRepository(c.env);
    const traces = await metadataRepo.listQueryTraces(tenant, domain, limit);
    return c.json({
      project: tenant,
      domain: domain ?? null,
      exported_at: new Date().toISOString(),
      summary: traceExportSummary(traces),
      traces,
    });
  });

  app.post('/v1/kb/query/traces/compare', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      trace_ids?: string[];
      baseline_trace_id?: string;
      candidate_trace_id?: string;
    };
    const traceIds = Array.isArray(body.trace_ids)
      ? body.trace_ids.map((id) => String(id).trim()).filter(Boolean)
      : [body.baseline_trace_id, body.candidate_trace_id].map((id) => String(id ?? '').trim()).filter(Boolean);
    if (traceIds.length !== 2) return c.json({ error: 'exactly two trace ids are required' }, 400);
    const [baselineId, candidateId] = traceIds as [string, string];
    const tenant = c.get('tenant');
    const metadataRepo = makeMetadataRepository(c.env);
    const baseline = await metadataRepo.getQueryTrace(tenant, baselineId);
    const candidate = await metadataRepo.getQueryTrace(tenant, candidateId);
    if (!baseline || !candidate) return c.json({ error: 'trace not found' }, 404);
    return c.json({
      project: tenant,
      comparison: compareTraces(baseline, candidate),
      traces: [baseline, candidate],
    });
  });

  app.get('/v1/kb/query/trace/:id/drilldown', async (c) => {
    const tenant = c.get('tenant');
    const metadataRepo = makeMetadataRepository(c.env);
    const trace = await metadataRepo.getQueryTrace(tenant, c.req.param('id'));
    if (!trace) return c.json({ error: 'trace not found' }, 404);
    return c.json({
      project: tenant,
      trace_id: trace.id,
      quality: answerQualityDrilldown(trace),
      trace,
    });
  });

  app.get('/v1/kb/query/trace/:id', async (c) => {
    const tenant = c.get('tenant');
    const metadataRepo = makeMetadataRepository(c.env);
    const trace = await metadataRepo.getQueryTrace(tenant, c.req.param('id'));
    if (!trace) return c.json({ error: 'trace not found' }, 404);
    return c.json(trace);
  });

  app.delete('/v1/indexes/:id', async (c) => {
    const tenant = c.get('tenant');
    const indexId = c.req.param('id');
    const repo = makeRepository(c.env);
    const index = await repo.getIndex(tenant, indexId);
    if (!index) return c.json({ error: 'Not found' }, 404);
    const chunkIds = await repo.getChunkIdsForIndex(tenant, indexId);
    await deleteVectors(c.env, chunkIds);
    if (c.env.VECTORIZE_SMALL) await deleteVectors(c.env, chunkIds, 'small');
    await repo.deleteIndex(tenant, indexId);
    queryCache.clear();
    indexCache.clear();
    clearLexicalChunkCache(tenant, indexId);
    await clearSharedQueryCache(c.env, tenant, indexId);
    return c.json({ ok: true });
  });

  app.post('/v1/indexes/:id/ingest', async (c) => {
    const tenant = c.get('tenant');
    const indexId = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as IngestBody;
    const documents = body.documents ?? [];
    if (!Array.isArray(documents) || documents.length === 0) {
      return c.json({ error: 'documents array is required' }, 400);
    }
    const repo = makeRepository(c.env);
    const index = await repo.getIndex(tenant, indexId);
    if (!index) return c.json({ error: 'Index not found' }, 404);

    const out: Array<{ document_id: string; chunks_created: number }> = [];
    for (const input of documents) {
      const content = input.content?.trim();
      if (!content) return c.json({ error: 'document content is required' }, 400);
      if (content.length > MAX_DOC_SIZE) return c.json({ error: 'document content too large' }, 413);

      const document = await repo.createDocument({
        id: crypto.randomUUID(),
        tenant,
        indexId,
        externalId: input.external_id ?? null,
        content,
        metadata: jsonRecord(input.metadata),
      });
      const chunkContents = chunkText(content, body.chunking);
      const vectors = await embed(c.env, chunkContents, { model: embeddingModel(c.env, 'base') });
      const smallVectors = c.env.VECTORIZE_SMALL
        ? await embed(c.env, chunkContents, { model: embeddingModel(c.env, 'small') })
        : [];
      const chunkRows: CreateChunkInput[] = chunkContents.map((chunk, i) => ({
        id: crypto.randomUUID(),
        tenant,
        indexId,
        documentId: document.id,
        content: chunk,
        chunkIndex: i,
        metadata: jsonRecord(input.metadata),
      }));
      await repo.insertChunks(chunkRows);
      const vectorRows: VectorizeVector[] = chunkRows.map((chunk, i) => ({
        id: chunk.id,
        values: vectors[i] ?? [],
        namespace: vectorNamespace(tenant, indexId),
        metadata: vectorMetadata(
          tenant,
          indexId,
          document.id,
          chunk.chunkIndex,
          chunk.content,
          chunk.metadata,
        ),
      }));
      if (vectorRows.length > 0) await c.env.VECTORIZE.upsert(vectorRows);
      if (c.env.VECTORIZE_SMALL && smallVectors.length > 0) {
        const smallRows: VectorizeVector[] = chunkRows.map((chunk, i) => ({
          id: chunk.id,
          values: smallVectors[i] ?? [],
          namespace: vectorNamespace(tenant, indexId),
          metadata: vectorMetadata(
            tenant,
            indexId,
            document.id,
            chunk.chunkIndex,
            chunk.content,
            chunk.metadata,
          ),
        }));
        await c.env.VECTORIZE_SMALL.upsert(smallRows);
      }
      queryCache.clear();
      clearLexicalChunkCache(tenant, indexId);
      await clearSharedQueryCache(c.env, tenant, indexId);
      out.push({ document_id: document.id, chunks_created: chunkRows.length });
    }
    return c.json({ documents: out }, 201);
  });

  app.get('/v1/indexes/:id/documents', async (c) => {
    const tenant = c.get('tenant');
    const indexId = c.req.param('id');
    const repo = makeRepository(c.env);
    const index = await repo.getIndex(tenant, indexId);
    if (!index) return c.json({ error: 'Index not found' }, 404);
    const page = Math.max(Number(c.req.query('page') ?? 1), 1);
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50), 1), 100);
    const data = await repo.listDocuments(tenant, indexId, limit, (page - 1) * limit);
    return c.json({ data, page, limit });
  });

  app.post('/v1/indexes/:id/ingest-vectors', async (c) => {
    const tenant = c.get('tenant');
    const indexId = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as IngestVectorsBody;
    const chunks = body.chunks ?? [];
    if (!Array.isArray(chunks) || chunks.length === 0) {
      return c.json({ error: 'chunks array is required' }, 400);
    }
    const repo = makeRepository(c.env);
    const index = await repo.getIndex(tenant, indexId);
    if (!index) return c.json({ error: 'Index not found' }, 404);

    const docsToCreate = new Map<string, { content: string; externalId: string | null }>();
    const chunkRows: CreateChunkInput[] = [];
    const vectorRows: VectorizeVector[] = [];
    for (const input of chunks) {
      if (!input.id?.trim()) return c.json({ error: 'chunk id is required' }, 400);
      if (!input.document_id?.trim()) return c.json({ error: 'document_id is required' }, 400);
      if (!input.content?.trim()) return c.json({ error: 'chunk content is required' }, 400);
      if (!Array.isArray(input.embedding) || input.embedding.length === 0) {
        return c.json({ error: 'embedding is required' }, 400);
      }
      const chunkId = input.id;
      const documentId = input.document_id;
      const content = input.content;
      const embedding = input.embedding;
      const chunkIndex = Number.isInteger(input.chunk_index) ? (input.chunk_index as number) : chunkRows.length;
      const existingDoc = await repo.getDocument(tenant, documentId);
      if (!existingDoc && !docsToCreate.has(documentId)) {
        docsToCreate.set(documentId, {
          content: input.document_content ?? content,
          externalId: input.document_external_id ?? null,
        });
      }
      const metadata = jsonRecord(input.metadata);
      chunkRows.push({
        id: chunkId,
        tenant,
        indexId,
        documentId,
        content,
        chunkIndex,
        metadata,
      });
      vectorRows.push({
        id: chunkId,
        values: embedding,
        namespace: vectorNamespace(tenant, indexId),
        metadata: vectorMetadata(
          tenant,
          indexId,
          documentId,
          chunkIndex,
          content,
          metadata,
        ),
      });
    }

    for (const [documentId, doc] of docsToCreate) {
      await repo.createDocument({
        id: documentId,
        tenant,
        indexId,
        externalId: doc.externalId,
        content: doc.content,
        metadata: {},
      });
    }
    await repo.insertChunks(chunkRows);
    await c.env.VECTORIZE.upsert(vectorRows);
    queryCache.clear();
    clearLexicalChunkCache(tenant, indexId);
    await clearSharedQueryCache(c.env, tenant, indexId);
    return c.json({ upserted: vectorRows.length }, 201);
  });

  app.delete('/v1/documents/:id', async (c) => {
    const tenant = c.get('tenant');
    const docId = c.req.param('id');
    const repo = makeRepository(c.env);
    const doc = await repo.getDocument(tenant, docId);
    if (!doc) return c.json({ error: 'Not found' }, 404);
    const chunkIds = await repo.getChunkIdsForDocument(tenant, docId);
    await deleteVectors(c.env, chunkIds);
    if (c.env.VECTORIZE_SMALL) await deleteVectors(c.env, chunkIds, 'small');
    await repo.deleteDocument(tenant, docId);
    queryCache.clear();
    indexCache.clear();
    clearLexicalChunkCache(tenant, doc.index_id);
    await clearSharedQueryCache(c.env, tenant, doc.index_id);
    return c.json({ ok: true });
  });

  async function queryByVector(
    c: AppContext,
    vector: number[],
    body: QueryBody,
    timing?: RagTiming,
  ): Promise<QueryPayload> {
    const tenant = c.get('tenant');
    const indexId = c.req.param('id');
    if (!indexId) throw new Error('Index not found');
    const repo = makeRepository(c.env);
    const topK = clampTopK(body.top_k);
    const semanticModel = semanticModelFromBody(body);
    const binding = vectorizeBinding(c.env, semanticModel);
    const filter = userVectorFilter(body.filter);
    const vectorizeStarted = performance.now();
    let query = await binding.query(vector, {
      topK,
      ...(filter ? { filter } : {}),
      namespace: vectorNamespace(tenant, indexId),
      returnMetadata: 'all',
      returnValues: false,
    });
    let vectorizePath = 'namespace';
    if (query.matches.length === 0 && semanticModel === 'base') {
      query = await binding.query(vector, {
        topK,
        filter: { ...jsonRecord(body.filter), tenant, index_id: indexId },
        returnMetadata: 'all',
        returnValues: false,
      });
      vectorizePath = 'metadata_filter_fallback';
    }
    if (timing) timing.vectorize_ms = elapsedMs(vectorizeStarted);
    if (timing) {
      timing.vectorize_path = vectorizePath;
      timing.semantic_model = semanticModel;
    }
    const minScore = typeof body.min_score === 'number' ? body.min_score : -Infinity;
    const matches = query.matches.filter((match) => match.score >= minScore);
    if (matches.length === 0) {
      const indexStarted = performance.now();
      if (!(await indexExists(c.env, repo, tenant, indexId))) throw new Error('Index not found');
      if (timing) timing.index_ms = elapsedMs(indexStarted);
      return { data: [] };
    }
    const metadataResults = matches.map(searchResultFromVectorMetadata);
    if (metadataResults.every(Boolean)) {
      if (timing) timing.hydrate_ms = 0;
      return { data: metadataResults.filter((result): result is SearchResult => Boolean(result)) };
    }
    const hydrateStarted = performance.now();
    const chunkIds = matches.map((match) => match.id);
    const chunks = sortResultsByVectorOrder(chunkIds, await repo.getChunksByIds(tenant, chunkIds));
    const scoreById = new Map(matches.map((match) => [match.id, match.score]));
    const data: SearchResult[] = chunks.map((chunk) => ({
      document_id: chunk.document_id,
      chunk_id: chunk.id,
      chunk_content: chunk.content,
      score: scoreById.get(chunk.id) ?? 0,
      metadata: chunk.metadata,
    }));
    if (timing) timing.hydrate_ms = elapsedMs(hydrateStarted);
    return { data };
  }

  async function queryByLexical(
    c: AppContext,
    query: string,
    body: QueryBody,
    timing?: RagTiming,
  ): Promise<QueryPayload | null> {
    const tokens = tokenizeLexicalQuery(query);
    if (tokens.length === 0) return null;
    const started = performance.now();
    const tenant = c.get('tenant');
    const indexId = c.req.param('id');
    if (!indexId) throw new Error('Index not found');
    const topK = clampTopK(body.top_k);
    const repo = makeRepository(c.env);
    const candidateLimit = Math.min(MAX_LEXICAL_CHUNKS, Math.max(topK * 50, 500));
    const prefilterTokens = lexicalPrefilterTokens(tokens);
    const prefilterStarted = performance.now();
    const candidateChunks = await repo.searchLexicalChunks(tenant, indexId, prefilterTokens, candidateLimit);
    if (candidateChunks.length === 0) {
      const indexStarted = performance.now();
      if (!(await indexExists(c.env, repo, tenant, indexId))) throw new Error('Index not found');
      if (timing) timing.index_ms = elapsedMs(indexStarted);
    }
    const ranked = sparseLexicalScore(candidateChunks, tokens).slice(0, topK);
    if (timing) {
      timing.lexical_ms = elapsedMs(started);
      timing.lexical_prefilter_ms = elapsedMs(prefilterStarted);
      timing.lexical_prefilter = 'd1_like_fuzzy_candidates';
      timing.lexical_tokens = tokens.length;
      timing.lexical_prefilter_tokens = prefilterTokens.length;
      timing.lexical_scoring = LEXICAL_SCORING_VERSION;
      timing.lexical_corpus_chunks = candidateChunks.length;
      timing.lexical_candidate_limit = candidateLimit;
      timing.retrieval = ranked.length > 0 ? 'lexical' : 'semantic_fallback';
    }
    return {
      data: ranked.map((entry) => ({
        document_id: entry.chunk.document_id,
        chunk_id: entry.chunk.id,
        chunk_content: entry.chunk.content,
        score: entry.score,
        metadata: {
          ...entry.chunk.metadata,
          lexical_score: entry.score,
          lexical_overlap: entry.overlap,
          lexical_scoring: LEXICAL_SCORING_VERSION,
          lexical_matched_terms: entry.matchedTerms,
        },
      })),
    };
  }

  async function queryByLexicalPlan(
    c: AppContext,
    query: string,
    body: QueryBody,
    plan: QueryPlan,
    timing?: RagTiming,
  ): Promise<QueryPayload | null> {
    const started = performance.now();
    const primary = await queryByLexical(c, query, body, timing);
    if (plan.variants.length === 0) return primary;
    const entries: Array<{ query: string; kind: 'original' | QueryPlanVariantKind; payload: QueryPayload | null }> = [
      { query: normalizeSemanticQuery(query), kind: 'original', payload: primary },
    ];
    for (const variant of plan.variants) {
      entries.push({
        query: variant.query,
        kind: variant.kind,
        payload: await queryByLexical(c, variant.query, body),
      });
    }
    const fused = fuseQueryPlanResults(entries, clampTopK(body.top_k));
    if (timing) {
      timing.query_plan = 'rewrite_decompose';
      timing.query_plan_ms = elapsedMs(started);
      timing.query_plan_variants = plan.variants.length;
      timing.query_plan_original_results = primary?.data.length ?? 0;
      timing.query_plan_results = fused.data.length;
      if (fused.data.length > 0) timing.retrieval = 'lexical';
    }
    return fused;
  }

  app.post('/v1/indexes/:id/query', async (c) => {
    const started = performance.now();
    const body = (await c.req.json().catch(() => ({}))) as QueryBody;
    const query = body.query?.trim();
    if (!query) return c.json({ error: 'query is required' }, 400);
    try {
      const result = await runTextQuery(c, query, body);
      return c.json(result.payload, 200, withTimingHeaders(result.timing, result.cache, started));
    } catch (error) {
      if (error instanceof Error && error.message === 'Index not found') {
        return c.json({ error: 'Index not found' }, 404);
      }
      throw error;
    }
  });

  app.post('/v1/indexes/:id/benchmark-query', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as BenchmarkQueryBody;
    const queries = (Array.isArray(body.queries) ? body.queries : [])
      .map((query) => String(query || '').trim())
      .filter(Boolean)
      .slice(0, MAX_BENCHMARK_QUERIES);
    if (queries.length === 0) return c.json({ error: 'queries array is required' }, 400);
    const repeat = Math.min(Math.max(Math.trunc(Number(body.repeat ?? 10)), 1), MAX_BENCHMARK_REPEAT);
    const warmup = Math.min(Math.max(Math.trunc(Number(body.warmup ?? 1)), 0), MAX_BENCHMARK_WARMUP);
    const queryBody: QueryBody = {};
    if (body.top_k !== undefined) queryBody.top_k = body.top_k;
    if (body.filter !== undefined) queryBody.filter = body.filter;
    if (body.min_score !== undefined) queryBody.min_score = body.min_score;
    if (body.mode !== undefined) queryBody.mode = body.mode;
    if (body.semantic_model !== undefined) queryBody.semantic_model = body.semantic_model;
    if (body.rerank !== undefined) queryBody.rerank = body.rerank;
    if (body.rerank_model !== undefined) queryBody.rerank_model = body.rerank_model;
    if (body.mmr !== undefined) queryBody.mmr = body.mmr;
    if (body.query_rewrite !== undefined) queryBody.query_rewrite = body.query_rewrite;
    if (body.query_decompose !== undefined) queryBody.query_decompose = body.query_decompose;
    try {
      for (let pass = 0; pass < warmup; pass += 1) {
        for (const query of queries) {
          await runTextQuery(c, query, queryBody);
        }
      }

      const samples: number[] = [];
      const serverSamples: number[] = [];
      const measured: Array<{
        query: string;
        pass: number;
        ms: number;
        server_ms: number | null;
        cache: 'hit' | 'miss';
        result_count: number;
        top_score: number | null;
      }> = [];
      let cacheHits = 0;
      for (let pass = 0; pass < repeat; pass += 1) {
        for (const query of queries) {
          const started = performance.now();
          const result = await runTextQuery(c, query, queryBody);
          const elapsed = elapsedMs(started);
          const serverMs = typeof result.timing.total_ms === 'number' ? result.timing.total_ms : null;
          samples.push(elapsed);
          if (serverMs !== null) serverSamples.push(serverMs);
          if (result.cache === 'hit') cacheHits += 1;
          measured.push({
            query,
            pass,
            ms: elapsed,
            server_ms: serverMs,
            cache: result.cache,
            result_count: result.payload.data.length,
            top_score: result.payload.data[0]?.score ?? null,
          });
        }
      }
      return c.json({
        index_id: c.req.param('id'),
        queries: queries.length,
        repeat,
        warmup,
        samples: samples.length,
        latency: summarizeLatencies(samples),
        server_latency: summarizeLatencies(serverSamples),
        cache_hits: cacheHits,
        cache_hit_rate: samples.length ? cacheHits / samples.length : 0,
        measurements: measured,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'Index not found') {
        return c.json({ error: 'Index not found' }, 404);
      }
      throw error;
    }
  });

  app.post('/v1/kb/evals/search', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as SearchEvalBody;
    const indexId = body.index_id?.trim();
    if (!indexId) return c.json({ error: 'index_id is required' }, 400);
    const cases = (Array.isArray(body.cases) ? body.cases : [])
      .filter((testCase) => testCase.query?.trim())
      .slice(0, MAX_EVAL_CASES);
    if (cases.length === 0) return c.json({ error: 'cases array is required' }, 400);
    const queryBody: QueryBody = {};
    if (body.top_k !== undefined) queryBody.top_k = body.top_k;
    if (body.mode !== undefined) queryBody.mode = body.mode;
    if (body.semantic_model !== undefined) queryBody.semantic_model = body.semantic_model;
    if (body.rerank !== undefined) queryBody.rerank = body.rerank;
    if (body.rerank_model !== undefined) queryBody.rerank_model = body.rerank_model;
    if (body.mmr !== undefined) queryBody.mmr = body.mmr;
    if (body.query_rewrite !== undefined) queryBody.query_rewrite = body.query_rewrite;
    if (body.query_decompose !== undefined) queryBody.query_decompose = body.query_decompose;
    const rows = [];
    const latencies = [];
    let hits = 0;
    let reciprocalRankTotal = 0;
    for (const [i, testCase] of cases.entries()) {
      const started = performance.now();
      const result = await runTextQuery(contextWithIndex(c, indexId), testCase.query ?? '', queryBody);
      const elapsed = elapsedMs(started);
      latencies.push(elapsed);
      const rank = result.payload.data.findIndex((item) => evalMatch(item, testCase));
      const hit = rank >= 0;
      if (hit) {
        hits += 1;
        reciprocalRankTotal += 1 / (rank + 1);
      }
      rows.push({
        id: testCase.id ?? `case-${i + 1}`,
        query: testCase.query,
        hit,
        rank: hit ? rank + 1 : null,
        result_count: result.payload.data.length,
        top_score: result.payload.data[0]?.score ?? null,
        latency_ms: elapsed,
        cache: result.cache,
      });
    }
    const summary: JsonRecord = {
      project: c.get('tenant'),
      index_id: indexId,
      n: cases.length,
      hit_rate: hits / cases.length,
      mrr: reciprocalRankTotal / cases.length,
      latency: summarizeLatencies(latencies),
    };
    const metadataRepo = makeMetadataRepository(c.env);
	    const report = await metadataRepo.insertEvalReport({
	      project: c.get('tenant'),
	      kind: 'search',
	      indexId,
	      summary,
	      rows,
	    });
	    writeEvalReportAnalytics(c.env, report);
	    return c.json({
      ...summary,
      report_id: report.id,
      rows,
    });
  });

  app.post('/v1/kb/evals/parse', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as ParseEvalBody;
    const domain = body.domain?.trim() || null;
    const cases = (Array.isArray(body.cases) ? body.cases : [])
      .filter((testCase) => (testCase.content_base64?.trim() || testCase.content !== undefined) && (testCase.filename?.trim()))
      .slice(0, MAX_EVAL_CASES);
    if (cases.length === 0) return c.json({ error: 'cases array is required' }, 400);
    const rows = [];
    const latencies = [];
    let passed = 0;
    const parserCounts: Record<string, number> = {};
    for (const [i, testCase] of cases.entries()) {
      const started = performance.now();
      const filename = testCase.filename?.trim() || `case-${i + 1}.txt`;
      const mime = testCase.mime?.trim() || null;
      const bytes = parseEvalCaseBytes(testCase);
      const markdownMode = testCase.markdown_conversion ?? body.markdown_conversion ?? c.env.RAG_MARKDOWN_CONVERSION ?? 'auto';
      const expected = expectedTextList(testCase.expected_text);
      const requestedVisionModel = testCase.vision_ocr_model ?? body.vision_ocr_model ?? c.env.RAG_VISION_OCR_MODEL ?? '';
      const visionModels = visionOcrModelChain(requestedVisionModel);
      const firstVisionModel = visionModels.length > 1 ? visionModels[0] ?? '' : requestedVisionModel;
      let parsed = await parseUploadBytesWithCloudflare(
        filename,
        mime,
        bytes,
        c.env.AI,
        markdownMode,
        firstVisionModel,
      );
      let textMatch = parseEvalMatch(parsed.text, expected);
      let parserMatched = testCase.expected_parser ? parsed.parser === testCase.expected_parser : true;
      let lengthMatched = testCase.min_text_length === undefined || parsed.text.length >= testCase.min_text_length;
      let ok = textMatch.missing.length === 0 && parserMatched && lengthMatched && parsed.text.length > 0;
      const triedVisionModels = firstVisionModel ? [firstVisionModel] : [];
      let retryReason: string | null = null;
      if (!ok && textMatch.missing.length > 0 && visionModels.length > 1) {
        const retryVisionModel = visionModels.slice(1).join(',');
        triedVisionModels.push(...visionModels.slice(1));
        retryReason = 'missing_expected_text';
        const retryParsed = await parseUploadBytesWithCloudflare(
          filename,
          mime,
          bytes,
          c.env.AI,
          markdownMode,
          retryVisionModel,
        );
        const retryTextMatch = parseEvalMatch(retryParsed.text, expected);
        const retryParserMatched = testCase.expected_parser ? retryParsed.parser === testCase.expected_parser : true;
        const retryLengthMatched = testCase.min_text_length === undefined || retryParsed.text.length >= testCase.min_text_length;
        const retryOk = retryTextMatch.missing.length === 0 && retryParserMatched && retryLengthMatched && retryParsed.text.length > 0;
        const retryImproved = retryTextMatch.matched.length > textMatch.matched.length
          || retryTextMatch.missing.length < textMatch.missing.length
          || (retryTextMatch.matched.length === textMatch.matched.length && retryParsed.text.length > parsed.text.length);
        if (retryOk || retryImproved) {
          parsed = {
            ...retryParsed,
            warnings: [
              ...(parsed.warnings ?? []).map((warning) => `vision_eval_first_attempt:${warning}`),
              ...(retryParsed.warnings ?? []),
            ],
          };
          textMatch = retryTextMatch;
          parserMatched = retryParserMatched;
          lengthMatched = retryLengthMatched;
          ok = retryOk;
        }
      }
      const elapsed = elapsedMs(started);
      latencies.push(elapsed);
      parserCounts[parsed.parser] = (parserCounts[parsed.parser] ?? 0) + 1;
      if (ok) passed += 1;
      rows.push({
        id: testCase.id ?? `case-${i + 1}`,
        filename,
        mime,
        parser: parsed.parser,
        parser_version: parsed.parser_version,
        ok,
        expected_text_count: expected.length,
        matched_text_count: textMatch.matched.length,
        missing_text: textMatch.missing,
        parser_matched: parserMatched,
        expected_parser: testCase.expected_parser ?? null,
        length_matched: lengthMatched,
        min_text_length: testCase.min_text_length ?? null,
        text_length: parsed.text.length,
        document_count: parsed.documents.length,
        record_count: parsed.record_count,
        page_count: parsed.page_count,
        latency_ms: elapsed,
        warnings: parsed.warnings ?? [],
        vision_ocr_models_tried: triedVisionModels,
        vision_ocr_retry_reason: retryReason,
        ...(body.include_text_preview ? { text_preview: parsed.text.slice(0, 1200) } : {}),
      });
    }
    const summary: JsonRecord = {
      project: c.get('tenant'),
      domain,
      n: cases.length,
      pass_rate: passed / cases.length,
      parser_counts: parserCounts,
      latency: summarizeLatencies(latencies),
    };
    const metadataRepo = makeMetadataRepository(c.env);
    const report = await metadataRepo.insertEvalReport({
      project: c.get('tenant'),
      kind: 'parse',
      domain,
      summary,
      rows,
    });
    writeEvalReportAnalytics(c.env, report);
    return c.json({
      ...summary,
      report_id: report.id,
      rows,
    });
  });

  app.post('/v1/kb/evals/query', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as QueryEvalBody;
    const domain = body.domain?.trim();
    if (!domain) return c.json({ error: 'domain is required' }, 400);
    const cases = (Array.isArray(body.cases) ? body.cases : [])
      .filter((testCase) => (testCase.question ?? testCase.query)?.trim())
      .slice(0, MAX_EVAL_CASES);
    if (cases.length === 0) return c.json({ error: 'cases array is required' }, 400);
    const rows = [];
    const latencies = [];
    let hits = 0;
    let cited = 0;
    let aiUsed = 0;
	    let supportedAnswers = 0;
	    let unsupportedTokenTotal = 0;
	    const faithfulnessScores: number[] = [];
	    const modelJudgeScores: number[] = [];
	    let modelJudged = 0;
	    let modelJudgeSupported = 0;
	    const judgeModel = body.judge_model?.trim() || DEFAULT_EVAL_JUDGE_MODEL;
	    for (const [i, testCase] of cases.entries()) {
      const started = performance.now();
      const question = (testCase.question ?? testCase.query ?? '').trim();
      const queryBody: KbQueryBody = {
        domain,
        question,
      };
      if (body.top_k !== undefined) queryBody.top_k = body.top_k;
      if (body.mode !== undefined) queryBody.mode = body.mode;
      if (body.semantic_model !== undefined) queryBody.semantic_model = body.semantic_model;
      if (body.rerank !== undefined) queryBody.rerank = body.rerank;
      if (body.rerank_model !== undefined) queryBody.rerank_model = body.rerank_model;
      if (body.answer_mode !== undefined) queryBody.answer_mode = body.answer_mode;
      if (body.answer_model !== undefined) queryBody.answer_model = body.answer_model;
      if (body.mmr !== undefined) queryBody.mmr = body.mmr;
      if (body.query_rewrite !== undefined) queryBody.query_rewrite = body.query_rewrite;
      if (body.query_decompose !== undefined) queryBody.query_decompose = body.query_decompose;
      const result = await runKbAnswer(c, queryBody, started);
      const elapsed = elapsedMs(started);
      latencies.push(elapsed);
      const expectedText = (
        testCase.expected_answer_text
        ?? testCase.expected_citation_text
        ?? testCase.expected_text
        ?? ''
      ).trim().toLowerCase();
      const evidenceText = [
        result.payload.answer,
        ...result.payload.citations.map((citation) => citation.excerpt),
        ...result.payload.data.map((item) => item.chunk_content),
      ].join('\n').toLowerCase();
      const hit = expectedText ? evidenceText.includes(expectedText) : result.payload.data.length > 0;
	      const hasCitation = result.payload.citations.length > 0 && /\[\d+\]/.test(result.payload.answer);
	      const quality = answerSupportQuality(result.payload.answer, result.payload.citations, result.payload.data);
	      let modelJudge: JsonRecord = {};
	      if (body.ai_judge === true) {
	        try {
	          modelJudge = await judgeAnswerWithAi({
	            env: c.env,
	            question,
	            expectedText,
	            answer: result.payload.answer,
	            citations: result.payload.citations,
	            retrieved: result.payload.data,
	            model: judgeModel,
	          });
	          modelJudged += 1;
	          if (modelJudge.model_judge_status === 'supported') modelJudgeSupported += 1;
	          if (typeof modelJudge.model_judge_score === 'number') modelJudgeScores.push(modelJudge.model_judge_score);
	        } catch (error) {
	          modelJudge = {
	            model_judged: false,
	            model_judge_model: judgeModel,
	            model_judge_error: error instanceof Error ? error.message : String(error),
	          };
	        }
	      }
	      const faithfulnessScore = typeof quality.citation_coverage === 'number' ? quality.citation_coverage : null;
      if (hit) hits += 1;
      if (hasCitation) cited += 1;
      if (result.payload.ai_used) aiUsed += 1;
      if (quality.status === 'supported') supportedAnswers += 1;
      unsupportedTokenTotal += typeof quality.unsupported_answer_token_count === 'number'
        ? quality.unsupported_answer_token_count
        : 0;
      if (faithfulnessScore !== null) faithfulnessScores.push(faithfulnessScore);
      rows.push({
        id: testCase.id ?? `case-${i + 1}`,
        question,
        hit,
        cited: hasCitation,
        faithfulness_status: quality.status,
        faithfulness_score: faithfulnessScore,
        answer_token_count: quality.answer_token_count,
        supported_answer_token_count: quality.supported_answer_token_count,
        unsupported_answer_token_count: quality.unsupported_answer_token_count,
        unsupported_answer_tokens: quality.unsupported_answer_tokens,
        route: result.payload.route,
        ai_used: result.payload.ai_used,
        result_count: result.payload.data.length,
        citation_count: result.payload.citations.length,
	        latency_ms: elapsed,
	        trace_id: result.payload.trace_id,
	        ...modelJudge,
	      });
	    }
	    const summary: JsonRecord = {
      project: c.get('tenant'),
      domain,
      n: cases.length,
      hit_rate: hits / cases.length,
      citation_rate: cited / cases.length,
      faithfulness_rate: supportedAnswers / cases.length,
      avg_faithfulness_score: average(faithfulnessScores),
	      avg_unsupported_answer_tokens: unsupportedTokenTotal / cases.length,
	      ai_use_rate: aiUsed / cases.length,
	      model_judge_enabled: body.ai_judge === true,
	      ...(body.ai_judge === true ? {
	        model_judge_model: judgeModel,
	        model_judged_count: modelJudged,
	        model_judge_support_rate: modelJudged > 0 ? modelJudgeSupported / modelJudged : 0,
	        avg_model_judge_score: average(modelJudgeScores),
	      } : {}),
	      latency: summarizeLatencies(latencies),
	    };
    const metadataRepo = makeMetadataRepository(c.env);
	    const report = await metadataRepo.insertEvalReport({
	      project: c.get('tenant'),
	      kind: 'query',
	      domain,
	      summary,
	      rows,
	    });
	    writeEvalReportAnalytics(c.env, report);
	    return c.json({
      ...summary,
      report_id: report.id,
      rows,
    });
  });

	  app.get('/v1/kb/evals/reports', async (c) => {
	    const metadataRepo = makeMetadataRepository(c.env);
	    const kind = c.req.query('kind')?.trim() || undefined;
	    const domain = c.req.query('domain')?.trim() || undefined;
	    const limit = Number(c.req.query('limit') ?? 50);
	    const reports = await metadataRepo.listEvalReports(c.get('tenant'), kind, domain, limit);
	    return c.json({ project: c.get('tenant'), kind: kind ?? null, domain: domain ?? null, reports });
	  });

	  app.get('/v1/kb/evals/summary', async (c) => {
	    const metadataRepo = makeMetadataRepository(c.env);
	    const kind = c.req.query('kind')?.trim() || undefined;
	    const domain = c.req.query('domain')?.trim() || undefined;
	    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 500), 1), 500);
	    const reports = await metadataRepo.listEvalReports(c.get('tenant'), kind, domain, limit);
	    return c.json({
	      project: c.get('tenant'),
	      kind: kind ?? null,
	      domain: domain ?? null,
	      report_count: reports.length,
	      summaries: summarizeEvalReports(reports),
	    });
	  });

	  app.get('/v1/kb/evals/reports/:id', async (c) => {
    const metadataRepo = makeMetadataRepository(c.env);
    const report = await metadataRepo.getEvalReport(c.get('tenant'), c.req.param('id'));
    if (!report) return c.json({ error: 'eval report not found' }, 404);
    return c.json(report);
  });

  app.post('/v1/indexes/:id/query-vector', async (c) => {
    const started = performance.now();
    const timing: RagTiming = { route: 'query-vector' };
    const body = (await c.req.json().catch(() => ({}))) as QueryBody;
    if (!Array.isArray(body.vector) || body.vector.length === 0) {
      return c.json({ error: 'vector is required' }, 400);
    }
    const tenant = c.get('tenant');
    const cacheKey = buildCacheKey({
      tenant,
      indexId: c.req.param('id'),
      vector: body.vector,
      topK: clampTopK(body.top_k),
      filter: jsonRecord(body.filter),
      minScore: typeof body.min_score === 'number' ? body.min_score : null,
      semanticModel: semanticModelFromBody(body),
    });
    queryCache.configure(parseCacheOptions(c.env));
    const cached = queryCache.get(cacheKey);
    if (cached) return c.json(cached, 200, withTimingHeaders(timing, 'hit', started));
    try {
      const payload = await queryByVector(c, body.vector, body, timing);
      if (payload.data.length > 0) queryCache.set(cacheKey, payload);
      return c.json(payload, 200, withTimingHeaders(timing, 'miss', started));
    } catch (error) {
      if (error instanceof Error && error.message === 'Index not found') {
        return c.json({ error: 'Index not found' }, 404);
      }
      throw error;
    }
  });

  (app as QueueCapableApp).processIngestQueue = async (
    batch: MessageBatch<KbIngestQueueMessage>,
    env: Env,
  ) => {
    for (const message of batch.messages) {
      const body = message.body;
      if (!body || body.kind !== 'kb_ingest' || !body.project || !body.domain) {
        message.ack();
        continue;
      }
      try {
	        const ingestBody: KbIngestRunBody = {
	          domain: body.domain,
	        };
	        if (body.run_id !== undefined) ingestBody.run_id = body.run_id;
	        if (body.file_ids !== undefined) ingestBody.file_ids = body.file_ids;
        if (body.markdown_conversion !== undefined) ingestBody.markdown_conversion = body.markdown_conversion;
        if (body.vision_ocr_model !== undefined) ingestBody.vision_ocr_model = body.vision_ocr_model;
        if (body.chunking !== undefined) ingestBody.chunking = body.chunking;
        await runKbIngest(env, body.project, ingestBody, 'worker-queue');
        message.ack();
      } catch (error) {
        console.error('knowledgebase ingest queue failed', {
          message_id: message.id,
          project: body.project,
          domain: body.domain,
          error: error instanceof Error ? error.message : String(error),
        });
        message.retry({ delaySeconds: Math.min(300, 10 * Math.max(1, message.attempts)) });
      }
    }
  };

  return app;
}

export function createWorker(options: AppOptions = {}) {
  const app = createApp(options) as QueueCapableApp;
  return {
    fetch: app.fetch,
    queue: (batch: MessageBatch<KbIngestQueueMessage>, env: Env): Promise<void> =>
      app.processIngestQueue(batch, env),
  };
}

export default createWorker();
