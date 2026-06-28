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
          exit_code: step.name === 'full-port-gaps' ? 1 : 0,
          stdout: command.join(' '),
          stderr: step.name === 'full-port-gaps' ? 'full-port gap remains' : '',
        };
      },
    });

    expect(result.ok).toBe(false);
    expect(calls).toEqual([
      'worker-check',
      'preflight',
      'python-runtime-retirement',
      'external-rag-service-references',
      'consumer-rag-integrations',
      'consumer-public-smoke',
      'typed-client-contract',
      'consumer-cloudflare-builds',
      'free-ai-embedding-contract',
      'free-ai-local-check',
      'vectorize-embedding-bindings',
      'full-port-gaps',
    ]);
    expect(result.checks.at(-1)).toMatchObject({
      name: 'full-port-gaps',
      ok: false,
      exit_code: 1,
      stderr_tail: 'full-port gap remains',
    });
  });

  it('reports command spawn errors as structured predeploy failures', async () => {
    const result = await runLocalPredeployGate({ cwd: '/definitely/missing/predeploy' });

    expect(result.ok).toBe(false);
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({
      name: 'worker-check',
      ok: false,
      exit_code: null,
      signal: 'spawn_error',
    });
    expect(result.checks[0]?.stderr_tail).toContain('spawn');
  });

  it('keeps the local predeploy gate non-mutating', () => {
    const mutatingPatterns = [
      /\bwrangler\s+deploy\b(?!\s+--dry-run)/,
      /\bwrangler\s+d1\s+migrations\s+apply\b/,
      /\bwrangler\s+d1\s+execute\b/,
      /\bwrangler\s+vectorize\s+create\b/,
      /\bdeploy:cf\b/,
      /\bsmoke:rag-crud\b/,
      /\bsmoke:rag-crud:embedding-model\b/,
      /\breadiness:full-port\b/,
      /\beval:parse:nvda-scanned:live\b/,
    ];

    for (const step of LOCAL_PREDEPLOY_STEPS) {
      const command = step.command.join(' ');
      for (const pattern of mutatingPatterns) {
        expect(command, `${step.name} must stay non-mutating`).not.toMatch(pattern);
      }
    }

    expect(LOCAL_PREDEPLOY_STEPS.find((step) => step.name === 'deploy-dry-run')?.command).toEqual([
      'pnpm',
      'run',
      'deploy:dry-run',
    ]);
  });
});
