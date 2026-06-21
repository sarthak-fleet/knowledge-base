import { describe, expect, it } from 'vitest';
import { embedTexts } from '../src/embeddings';
import type { Env } from '../src/types';

function makeEnv(calls: string[][], models: string[] = [], options: unknown[] = []): Env {
  return {
    EMBEDDING_MODEL: '@cf/test-embedding',
    RAG_AI_GATEWAY_ID: 'test-gateway',
    RAG_AI_GATEWAY_CACHE_TTL_SECONDS: '120',
    AI: {
      run: async (model: string, input: { text: string[] }, opts?: unknown) => {
        models.push(model);
        options.push(opts);
        calls.push(input.text);
        return { data: input.text.map((text) => [text.length]) };
      },
    } as unknown as Ai,
    DB: {} as D1Database,
    VECTORIZE: {} as Env['VECTORIZE'],
  };
}

describe('embedTexts', () => {
  it('returns an empty vector list without calling Workers AI for empty input', async () => {
    const calls: string[][] = [];
    const vectors = await embedTexts(makeEnv(calls), []);

    expect(vectors).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('batches Workers AI embedding calls in groups of 100', async () => {
    const calls: string[][] = [];
    const texts = Array.from({ length: 205 }, (_, i) => `text-${i}`);
    const vectors = await embedTexts(makeEnv(calls), texts);

    expect(calls.map((call) => call.length)).toEqual([100, 100, 5]);
    expect(vectors).toHaveLength(205);
    expect(vectors[0]).toEqual([6]);
    expect(vectors.at(-1)).toEqual([8]);
  });

  it('passes explicit model and AI Gateway cache options to Workers AI', async () => {
    const calls: string[][] = [];
    const models: string[] = [];
    const options: unknown[] = [];
    await embedTexts(makeEnv(calls, models, options), ['alpha'], { model: '@cf/test-small' });

    expect(models).toEqual(['@cf/test-small']);
    expect(options).toEqual([{ gateway: { id: 'test-gateway', skipCache: false, cacheTtl: 120 } }]);
  });
});
