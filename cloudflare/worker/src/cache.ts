export interface CacheOptions {
  enabled: boolean;
  ttlMs: number;
  maxEntries: number;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class TtlCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(private options: CacheOptions) {}

  configure(options: CacheOptions): void {
    this.options = options;
    if (!options.enabled) this.entries.clear();
  }

  get(key: string): T | null {
    if (!this.options.enabled) return null;
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    if (!this.options.enabled) return;
    while (this.entries.size >= this.options.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: Date.now() + this.options.ttlMs });
  }

  clear(): void {
    this.entries.clear();
  }
}

export function parseCacheOptions(env: {
  RAG_CACHE_ENABLED?: string;
  RAG_CACHE_TTL_SECONDS?: string;
  RAG_CACHE_MAX_ENTRIES?: string;
}): CacheOptions {
  const ttl = Number(env.RAG_CACHE_TTL_SECONDS ?? 300);
  const maxEntries = Number(env.RAG_CACHE_MAX_ENTRIES ?? 1000);
  return {
    enabled: env.RAG_CACHE_ENABLED !== 'false',
    ttlMs: Number.isFinite(ttl) && ttl > 0 ? Math.trunc(ttl * 1000) : 300_000,
    maxEntries: Number.isFinite(maxEntries) && maxEntries > 0 ? Math.trunc(maxEntries) : 1000,
  };
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(',')}}`;
}
