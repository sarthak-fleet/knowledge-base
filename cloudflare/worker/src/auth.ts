import type { Context, Next } from 'hono';
import type { Env } from './types';

export interface Variables {
  tenant: string;
}

type AppContext = Context<{ Bindings: Env; Variables: Variables }>;

function constantTimeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const left = enc.encode(a);
  const right = enc.encode(b);
  const len = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < len; i += 1) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

function readPresentedKey(c: AppContext): string {
  const xKey = c.req.header('X-RAG-Key');
  if (xKey) return xKey.trim();
  const auth = c.req.header('Authorization') ?? '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? '';
}

function parseKeyMap(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, tenant] of Object.entries(parsed)) {
      if (typeof key === 'string' && typeof tenant === 'string' && key && tenant) {
        out[key] = tenant;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export async function requireServiceKey(c: AppContext, next: Next): Promise<Response | void> {
  const presented = readPresentedKey(c);
  const keyMap = {
    ...parseKeyMap(c.env.RAG_SERVICE_KEYS),
    ...parseKeyMap(c.env.RAG_SERVICE_KEYS_APPEND),
  };
  for (const [candidate, tenant] of Object.entries(keyMap)) {
    if (presented && constantTimeEqual(presented, candidate)) {
      c.set('tenant', tenant);
      await next();
      return undefined;
    }
  }
  return c.json({ error: 'Unauthorized' }, 401);
}
