import type { Env } from './types';

// OpenAI-compatible client for the fleet free-ai gateway
// (https://github.com/.../free-ai). Routes embeddings and chat through free
// upstream providers (Gemini/Groq/Voyage) instead of Cloudflare Workers AI.

const DEFAULT_BASE_URL = 'https://free-ai-gateway.sarthakagrawal927.workers.dev/v1';
// gemini-embedding-001 is Matryoshka-trained; the gateway forwards `dimensions`
// to its output_dimensionality, so we request 1536 (fits Vectorize's 1536-dim
// ceiling) and validate the response length. Gemini's free tier sustains bursts
// where voyage's ~3 rpm does not.
const DEFAULT_EMBED_MODEL = 'gemini-embedding-001';
const DEFAULT_EMBED_PROVIDER = 'gemini';
const DEFAULT_SYNTH_MODEL = 'gemini-2.5-flash';
const DEFAULT_PROJECT_ID = 'knowledgebase';
const DEFAULT_DIMENSIONS = 1536;
const EMBED_BATCH_SIZE = 100;

export interface FreeAiChatBody {
  messages: Array<{ role: string; content: string }>;
  max_tokens?: number;
  temperature?: number;
  response_format?: unknown;
}

export function freeAiEmbedEnabled(env: Env): boolean {
  return env.RAG_EMBED_PROVIDER === 'free_ai';
}

export function freeAiSynthEnabled(env: Env): boolean {
  return env.RAG_SYNTH_PROVIDER === 'free_ai';
}

export function freeAiSynthModel(env: Env): string {
  return env.FREE_AI_SYNTH_MODEL?.trim() || DEFAULT_SYNTH_MODEL;
}

function baseUrl(env: Env): string {
  return (env.FREE_AI_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function projectId(env: Env): string {
  return env.FREE_AI_PROJECT_ID?.trim() || DEFAULT_PROJECT_ID;
}

function authHeaders(env: Env): Record<string, string> {
  const key = env.FREE_AI_API_KEY?.trim();
  if (!key) throw new Error('FREE_AI_API_KEY is not configured');
  return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
}

// Use the service binding when available (required for same-zone worker calls),
// otherwise fall back to a plain fetch (local dev / tests).
function gatewayFetch(env: Env, url: string, init: RequestInit): Promise<Response> {
  return env.FREE_AI ? env.FREE_AI.fetch(url, init) : fetch(url, init);
}

// Free upstream providers (Gemini/Voyage) rate-limit under burst. Retry 429/503
// with bounded backoff (honoring Retry-After) so transient limits don't fail
// ingest or queries outright.
const RETRY_STATUSES = new Set([429, 503]);
const MAX_RETRIES = 2;

async function gatewayFetchRetry(env: Env, url: string, init: RequestInit): Promise<Response> {
  let res = await gatewayFetch(env, url, init);
  for (let attempt = 0; attempt < MAX_RETRIES && RETRY_STATUSES.has(res.status); attempt += 1) {
    const retryAfter = Number(res.headers.get('retry-after'));
    const backoffMs =
      Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 4000) : 400 * 2 ** attempt;
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
    res = await gatewayFetch(env, url, init);
  }
  return res;
}

// The free-ai path uses a single embedding model whose output dimension matches
// the bound Vectorize index (default 1536 for gemini-embedding-001). The caller's
// CF model id is ignored; the configured dimension is authoritative and validated.
function expectedDimensions(env: Env): number {
  const configured = Number(env.FREE_AI_EMBED_DIMENSIONS ?? DEFAULT_DIMENSIONS);
  return Number.isFinite(configured) && configured > 0 ? Math.trunc(configured) : DEFAULT_DIMENSIONS;
}

function extractVector(row: unknown): number[] | null {
  if (Array.isArray(row) && row.every((value) => typeof value === 'number')) {
    return row as number[];
  }
  if (row && typeof row === 'object') {
    const embedding = (row as { embedding?: unknown }).embedding;
    if (Array.isArray(embedding) && embedding.every((value) => typeof value === 'number')) {
      return embedding as number[];
    }
  }
  return null;
}

// Drop-in replacement for embedTexts (same signature) that calls the free-ai
// gateway. The provider/model are pinned via force headers so the gateway
// cannot silently fall back to a different-dimension embedding model and
// corrupt the index; the response dimension is validated and fails closed.
export async function freeAiEmbed(
  env: Env,
  texts: string[],
  options: { model?: string } = {},
): Promise<number[][]> {
  if (texts.length === 0) return [];
  void options.model; // CF model id is irrelevant on the free-ai path
  const model = env.FREE_AI_EMBED_MODEL?.trim() || DEFAULT_EMBED_MODEL;
  const provider = env.FREE_AI_EMBED_PROVIDER?.trim() || DEFAULT_EMBED_PROVIDER;
  const dimensions = expectedDimensions(env);
  const url = `${baseUrl(env)}/embeddings`;
  const pid = projectId(env);
  const vectors: number[][] = [];

  for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
    const batch = texts.slice(start, start + EMBED_BATCH_SIZE);
    const res = await gatewayFetchRetry(env, url, {
      method: 'POST',
      headers: {
        ...authHeaders(env),
        'x-gateway-force-provider': provider,
        'x-gateway-force-model': model,
        'x-gateway-project-id': pid,
      },
      body: JSON.stringify({
        model,
        input: batch,
        dimensions,
        encoding_format: 'float',
        project_id: pid,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`free-ai embeddings failed ${res.status}: ${detail.slice(0, 200)}`);
    }
    const payload = (await res.json()) as { data?: unknown };
    const rows = Array.isArray(payload.data) ? payload.data : [];
    if (rows.length !== batch.length) {
      throw new Error(`free-ai embeddings count mismatch: got ${rows.length} for ${batch.length} inputs`);
    }
    // Preserve input order when the gateway returns OpenAI-style index fields.
    const ordered = rows
      .map((row, i) => ({ row, index: typeof (row as { index?: number }).index === 'number' ? (row as { index: number }).index : i }))
      .sort((a, b) => a.index - b.index)
      .map((entry) => entry.row);
    for (const row of ordered) {
      const vector = extractVector(row);
      if (!vector || vector.length !== dimensions) {
        throw new Error(
          `free-ai embedding dimension mismatch: expected ${dimensions}, got ${vector ? vector.length : 'none'}`,
        );
      }
      vectors.push(vector);
    }
  }
  return vectors;
}

// Workers AI exposes json_schema response_format; the OpenAI-compatible gateway
// expects json_object. Map it so the judge path keeps JSON-mode behavior.
function mapResponseFormat(responseFormat: unknown): unknown {
  if (!responseFormat || typeof responseFormat !== 'object') return undefined;
  const type = (responseFormat as { type?: string }).type;
  if (type === 'json_schema') return { type: 'json_object' };
  return responseFormat;
}

// Returns a Workers-AI-shaped { response } object so existing aiTextResponse()
// parsing works unchanged for both providers.
export async function freeAiChatRaw(env: Env, model: string, body: FreeAiChatBody): Promise<{ response: string }> {
  const url = `${baseUrl(env)}/chat/completions`;
  const pid = projectId(env);
  const responseFormat = mapResponseFormat(body.response_format);
  const res = await gatewayFetchRetry(env, url, {
    method: 'POST',
    headers: { ...authHeaders(env), 'x-gateway-project-id': pid },
    body: JSON.stringify({
      model,
      messages: body.messages,
      ...(typeof body.max_tokens === 'number' ? { max_tokens: body.max_tokens } : {}),
      ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
      ...(responseFormat ? { response_format: responseFormat } : {}),
      project_id: pid,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`free-ai chat failed ${res.status}: ${detail.slice(0, 200)}`);
  }
  const payload = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content ?? '';
  return { response: content };
}
