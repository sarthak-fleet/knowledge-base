import { describe, expect, it } from 'vitest';
import { CONSUMER_CLOUDFLARE_BUILD_STEPS, runConsumerCloudflareBuilds } from '../scripts/consumer-cloudflare-builds.mjs';

describe('consumer-cloudflare-builds', () => {
  it('runs Karte and Starboard Cloudflare builds in order', async () => {
    const calls: string[] = [];

    const report = await runConsumerCloudflareBuilds({
      runCommand: async (step) => {
        calls.push(`${step.repo}:${step.command.join(' ')}`);
        return { exit_code: 0, signal: null, stdout: `${step.repo} ok`, stderr: '' };
      },
    });

    expect(report.ok).toBe(true);
    expect(calls).toEqual([
      'karte:pnpm run cf:build',
      'starboard:pnpm run build:cf',
    ]);
    expect(report.checks).toEqual([
      expect.objectContaining({
        name: 'karte-cf-build',
        repo: 'karte',
        ok: true,
        command: 'pnpm run cf:build',
      }),
      expect.objectContaining({
        name: 'starboard-build-cf',
        repo: 'starboard',
        ok: true,
        command: 'pnpm run build:cf',
      }),
    ]);
  });

  it('stops after the first failed consumer build', async () => {
    const calls: string[] = [];

    const report = await runConsumerCloudflareBuilds({
      runCommand: async (step) => {
        calls.push(step.repo);
        return step.repo === 'karte'
          ? { exit_code: 1, signal: null, stdout: '', stderr: 'build failed' }
          : { exit_code: 0, signal: null, stdout: 'unexpected', stderr: '' };
      },
    });

    expect(report.ok).toBe(false);
    expect(calls).toEqual(['karte']);
    expect(report.checks).toEqual([
      expect.objectContaining({
        repo: 'karte',
        ok: false,
        exit_code: 1,
        stderr_tail: 'build failed',
      }),
    ]);
  });

  it('reports spawn errors as structured build blockers', async () => {
    const report = await runConsumerCloudflareBuilds({
      steps: [
        {
          ...CONSUMER_CLOUDFLARE_BUILD_STEPS[0]!,
          cwd: '/definitely/missing/consumer',
        },
      ],
    });

    expect(report.ok).toBe(false);
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]).toMatchObject({
      repo: 'karte',
      ok: false,
      exit_code: null,
      signal: 'spawn_error',
    });
    expect(report.checks[0]?.stderr_tail).toContain('spawn');
  });

  it('keeps the release build command contract stable', () => {
    expect(CONSUMER_CLOUDFLARE_BUILD_STEPS.map((step) => ({
      repo: step.repo,
      command: step.command.join(' '),
    }))).toEqual([
      { repo: 'karte', command: 'pnpm run cf:build' },
      { repo: 'starboard', command: 'pnpm run build:cf' },
    ]);
  });
});
