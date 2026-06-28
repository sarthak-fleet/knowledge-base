import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs, runConsumerAuthSmokes } from '../scripts/consumer-auth-smokes.mjs';

function makePublicFetch() {
  return async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    if (href.endsWith('/api/chat/atlas-demo/conversations')) {
      return Response.json({ id: 'conv-public-smoke' }, { status: 201 });
    }
    if (href.endsWith('/api/chat/atlas-demo')) {
      return new Response('Atlas demo response', { status: 200 });
    }
    if (href === 'https://starboard.test/') {
      return new Response('<html>Starboard</html>', { status: 200 });
    }
    if (href === 'https://karte.test/') {
      return new Response('<html>Karte</html>', { status: 200 });
    }
    return new Response(`unexpected ${init?.method ?? 'GET'} ${href}`, { status: 404 });
  };
}

describe('consumer-auth-smokes', () => {
  it('accepts the pnpm run argument separator', () => {
    expect(parseArgs(['--', '--json', '--require-authenticated'])).toEqual({
      jsonOnly: true,
      requireAuthenticated: true,
    });
  });

  it('reports missing session cookies as explicit skipped authenticated smokes', async () => {
    const fleetRoot = await mkdtemp(join(tmpdir(), 'kb-consumer-smokes-'));
    try {
      await mkdir(join(fleetRoot, 'karte'));
      await mkdir(join(fleetRoot, 'starboard'));

      const report = await runConsumerAuthSmokes({
        fleetRoot,
        env: {
          KARTE_BASE_URL: 'https://karte.test',
          STARBOARD_BASE_URL: 'https://starboard.test',
        },
        fetchImpl: makePublicFetch(),
      });

      expect(report.ok).toBe(true);
      expect(report.public).toBe(true);
      expect(report.authenticated).toBe(false);
      expect(report.blockers).toEqual([
        'karte:KARTE_SESSION_COOKIE_missing',
        'starboard:STARBOARD_SESSION_COOKIE_missing',
      ]);
      expect(report.public_consumers).toEqual([
        expect.objectContaining({ consumer: 'karte', public: true, ok: true, kind: 'public_demo_chat' }),
        expect.objectContaining({ consumer: 'starboard', public: true, ok: true, kind: 'public_app' }),
      ]);
      expect(report.consumers).toEqual([
        expect.objectContaining({ consumer: 'karte', skipped: true, blocker: 'KARTE_SESSION_COOKIE_missing' }),
        expect.objectContaining({ consumer: 'starboard', skipped: true, blocker: 'STARBOARD_SESSION_COOKIE_missing' }),
      ]);
    } finally {
      await rm(fleetRoot, { recursive: true, force: true });
    }
  });

  it('reports missing consumer repos as hard blockers', async () => {
    const fleetRoot = await mkdtemp(join(tmpdir(), 'kb-consumer-smokes-'));
    try {
      const report = await runConsumerAuthSmokes({
        fleetRoot,
        env: {
          KARTE_BASE_URL: 'https://karte.test',
          STARBOARD_BASE_URL: 'https://starboard.test',
        },
        fetchImpl: makePublicFetch(),
      });

      expect(report.ok).toBe(false);
      expect(report.public).toBe(true);
      expect(report.blockers).toEqual(['karte:repo_missing', 'starboard:repo_missing']);
      expect(report.consumers).toEqual([
        expect.objectContaining({ consumer: 'karte', skipped: false, blocker: 'repo_missing' }),
        expect.objectContaining({ consumer: 'starboard', skipped: false, blocker: 'repo_missing' }),
      ]);
    } finally {
      await rm(fleetRoot, { recursive: true, force: true });
    }
  });
});
