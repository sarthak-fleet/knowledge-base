import type { Env } from './types';

const DEFAULT_MODEL = '@cf/baai/bge-base-en-v1.5';
const DEFAULT_BATCH_SIZE = 100;

interface EmbeddingResponse {
  data: number[][];
}

interface EmbeddingOptions {
  model?: string;
}

function gatewayOptions(env: Env): AiOptions | undefined {
  const id = env.RAG_AI_GATEWAY_ID?.trim();
  if (!id) return undefined;
  const ttl = Number(env.RAG_AI_GATEWAY_CACHE_TTL_SECONDS ?? 3600);
  return {
    gateway: {
      id,
      skipCache: false,
      cacheTtl: Number.isFinite(ttl) && ttl > 0 ? Math.trunc(ttl) : 3600,
    },
  };
}

export async function embedTexts(env: Env, texts: string[], options: EmbeddingOptions = {}): Promise<number[][]> {
  if (texts.length === 0) return [];
  const model = options.model || env.EMBEDDING_MODEL || DEFAULT_MODEL;
  const vectors: number[][] = [];
  const aiOptions = gatewayOptions(env);
  for (let start = 0; start < texts.length; start += DEFAULT_BATCH_SIZE) {
    const batch = texts.slice(start, start + DEFAULT_BATCH_SIZE);
    const result = (await env.AI.run(model, { text: batch }, aiOptions)) as unknown as EmbeddingResponse;
    if (!Array.isArray(result.data) || result.data.length !== batch.length) {
      throw new Error('Workers AI embedding response shape mismatch');
    }
    vectors.push(...result.data);
  }
  return vectors;
}
