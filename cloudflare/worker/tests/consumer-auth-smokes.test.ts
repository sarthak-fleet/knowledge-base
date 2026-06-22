import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs, runConsumerAuthSmokes } from '../scripts/consumer-auth-smokes.mjs';

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

      const report = await runConsumerAuthSmokes({ fleetRoot, env: {} });

      expect(report.ok).toBe(false);
      expect(report.authenticated).toBe(false);
      expect(report.blockers).toEqual([
        'karte:KARTE_SESSION_COOKIE_missing',
        'starboard:STARBOARD_SESSION_COOKIE_missing',
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
      const report = await runConsumerAuthSmokes({ fleetRoot, env: {} });

      expect(report.ok).toBe(false);
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
