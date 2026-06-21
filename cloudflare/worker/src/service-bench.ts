interface Env {
  RAG_SERVICE: Fetcher;
  RAG_SERVICE_KEY?: string;
  RAG_BENCH_TOKEN?: string;
}

interface BenchBody {
  index_id?: string;
  queries?: string[];
  repeat?: number;
  warmup?: number;
  top_k?: number;
  mode?: 'auto' | 'semantic' | 'lexical' | 'hybrid';
  semantic_model?: 'base' | 'small';
  rerank?: boolean;
  rerank_model?: 'keyword' | 'workers_ai';
  mmr?: boolean;
}

const MAX_QUERIES = 200;
const MAX_REPEAT = 500;
const MAX_WARMUP = 50;

function elapsedMs(started: number): number {
  return Math.round((performance.now() - started) * 100) / 100;
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

function readBearer(request: Request): string {
  const auth = request.headers.get('Authorization') ?? '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? '';
}

function isAuthorized(request: Request, env: Env): boolean {
  const expected = env.RAG_BENCH_TOKEN?.trim();
  return Boolean(expected && readBearer(request) === expected);
}

async function callRag(env: Env, path: string, body: unknown): Promise<{ payload: any; cache: string; timing: any }> {
  const key = env.RAG_SERVICE_KEY?.trim();
  if (!key) throw new Error('RAG_SERVICE_KEY is not configured');
  const res = await env.RAG_SERVICE.fetch(new Request(`https://knowledgebase.internal${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }));
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`RAG request failed ${res.status}: ${JSON.stringify(payload)}`);
  return {
    payload,
    cache: res.headers.get('X-RAG-Cache') || 'none',
    timing: JSON.parse(res.headers.get('X-RAG-Timing') || 'null'),
  };
}

async function handleBenchmark(request: Request, env: Env): Promise<Response> {
  if (!isAuthorized(request, env)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as BenchBody;
  const indexId = body.index_id?.trim();
  if (!indexId) return Response.json({ error: 'index_id is required' }, { status: 400 });
  const queries = (Array.isArray(body.queries) ? body.queries : [])
    .map((query) => String(query || '').trim())
    .filter(Boolean)
    .slice(0, MAX_QUERIES);
  if (queries.length === 0) return Response.json({ error: 'queries array is required' }, { status: 400 });
  const repeat = Math.min(Math.max(Math.trunc(Number(body.repeat ?? 10)), 1), MAX_REPEAT);
  const warmup = Math.min(Math.max(Math.trunc(Number(body.warmup ?? 1)), 0), MAX_WARMUP);
  const topK = Math.min(Math.max(Math.trunc(Number(body.top_k ?? 5)), 1), 50);

  for (let pass = 0; pass < warmup; pass += 1) {
    for (const query of queries) {
      await callRag(env, `/v1/indexes/${indexId}/query`, {
        query,
	        top_k: topK,
	        mode: body.mode,
	        semantic_model: body.semantic_model,
	        rerank: body.rerank,
	        rerank_model: body.rerank_model,
	        mmr: body.mmr,
	      });
    }
  }

  const samples: number[] = [];
  const ragServerSamples: number[] = [];
  const measurements: Array<{
    query: string;
    pass: number;
    ms: number;
    rag_server_ms: number | null;
    cache: string;
    result_count: number;
    top_score: number | null;
  }> = [];
  let cacheHits = 0;
  for (let pass = 0; pass < repeat; pass += 1) {
    for (const query of queries) {
      const started = performance.now();
      const result = await callRag(env, `/v1/indexes/${indexId}/query`, {
        query,
	        top_k: topK,
	        mode: body.mode,
	        semantic_model: body.semantic_model,
	        rerank: body.rerank,
	        rerank_model: body.rerank_model,
	        mmr: body.mmr,
	      });
      const ms = elapsedMs(started);
      const data = Array.isArray(result.payload.data) ? result.payload.data : [];
      const ragServerMs = typeof result.timing?.total_ms === 'number' ? result.timing.total_ms : null;
      if (result.cache === 'hit') cacheHits += 1;
      samples.push(ms);
      if (ragServerMs !== null) ragServerSamples.push(ragServerMs);
      measurements.push({
        query,
        pass,
        ms,
        rag_server_ms: ragServerMs,
        cache: result.cache,
        result_count: data.length,
        top_score: data[0]?.score ?? null,
      });
    }
  }

  return Response.json({
    index_id: indexId,
    queries: queries.length,
    repeat,
    warmup,
    samples: samples.length,
    service_binding_latency: summarizeLatencies(samples),
    rag_server_latency: summarizeLatencies(ragServerSamples),
    cache_hits: cacheHits,
    cache_hit_rate: samples.length ? cacheHits / samples.length : 0,
    first_measurements: measurements.slice(0, 5),
    last_measurements: measurements.slice(-5),
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') return Response.json({ ok: true });
    if (url.pathname === '/bench/query' && request.method === 'POST') {
      return handleBenchmark(request, env);
    }
    return Response.json({ error: 'Not found' }, { status: 404 });
  },
};
