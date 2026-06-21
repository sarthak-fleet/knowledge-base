import { describe, expect, it } from 'vitest';
import { LOCAL_PREDEPLOY_STEPS, runLocalPredeployGate } from '../scripts/predeploy-local.mjs';

describe('predeploy-local', () => {
  it('runs the local Cloudflare cutover gate in the intended order', async () => {
    const calls: string[] = [];
    const result = await runLocalPredeployGate({
      runCommand: async (command) => {
        const step = LOCAL_PREDEPLOY_STEPS[calls.length]!;
        calls.push(`${step.name}:${command.join(' ')}`);
        return { exit_code: 0, stdout: `${step.name} ok`, stderr: '' };
      },
    });

    expect(result.ok).toBe(true);
    expect(calls).toEqual(LOCAL_PREDEPLOY_STEPS.map((step) => `${step.name}:${step.command.join(' ')}`));
    expect(result.checks).toHaveLength(LOCAL_PREDEPLOY_STEPS.length);
  });

  it('fails fast when a predeploy step fails', async () => {
    const calls: string[] = [];
    const result = await runLocalPredeployGate({
      runCommand: async (command) => {
        const step = LOCAL_PREDEPLOY_STEPS[calls.length]!;
        calls.push(step.name);
        return {
          exit_code: step.name === 'local-cutover-smoke' ? 1 : 0,
          stdout: command.join(' '),
          stderr: step.name === 'local-cutover-smoke' ? 'alias smoke failed' : '',
        };
      },
    });

    expect(result.ok).toBe(false);
    expect(calls).toEqual([
      'worker-check',
      'preflight',
      'python-runtime-retirement',
      'external-rag-service-references',
      'nvda-scanned-ocr-dry-run',
      'local-cutover-smoke',
    ]);
    expect(result.checks.at(-1)).toMatchObject({
      name: 'local-cutover-smoke',
      ok: false,
      exit_code: 1,
      stderr_tail: 'alias smoke failed',
    });
  });
});
