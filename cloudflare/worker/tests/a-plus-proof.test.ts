import { describe, expect, it } from 'vitest';
import { buildPlan, parseArgs, runAPlusProof } from '../scripts/a-plus-proof.mjs';

describe('a-plus-proof', () => {
  it('accepts the pnpm run argument separator and normalizes options', () => {
    expect(parseArgs([
      '--',
      '--base-url',
      'https://kb.example/',
      '--domain',
      'manuals',
      '--input',
      'fixtures/benchmark.sample.json',
      '--output-dir',
      '/tmp/kb-proof',
      '--repeat',
      '5',
      '--top-k',
      '7',
      '--dry-run',
      '--json',
    ])).toMatchObject({
      baseUrl: 'https://kb.example',
      domain: 'manuals',
      input: 'fixtures/benchmark.sample.json',
      outputDir: '/tmp/kb-proof',
      repeat: 5,
      topK: 7,
      dryRun: true,
      jsonOnly: true,
    });
  });

  it('builds the current A plus proof plan', () => {
    expect(buildPlan({
      baseUrl: 'https://kb.example',
      domain: 'manuals',
      input: 'fixtures/benchmark.sample.json',
      outputDir: '/tmp/kb-proof',
      repeat: 5,
      topK: 5,
      expectedDeployFingerprint: 'fp',
      requireGrade: 'A+',
    })).toMatchObject({
      base_url: 'https://kb.example',
      domain: 'manuals',
      steps: [
        'deploy-readiness',
        'operator-report',
        'benchmark:kb-search:lexical',
        'benchmark:kb-query:semantic',
        'scorecard:a-plus',
      ],
      scorecard_requirements: {
        require_readiness_report: true,
        required_domain: 'manuals',
        required_benchmark_modes: ['lexical', 'semantic'],
        required_benchmark_surfaces: ['kb-search', 'kb-query'],
        min_benchmark_repeat: 5,
        min_benchmark_samples: 10,
        required_eval_kinds: ['query'],
      },
    });
  });

  it('does not require a service key or network calls for dry-run proof planning', async () => {
    const result = await runAPlusProof({
      ...parseArgs([
        '--domain',
        'manuals',
        '--dry-run',
      ]),
      key: '',
    });

    expect(result).toMatchObject({
      ok: true,
      dry_run: true,
      plan: {
        domain: 'manuals',
      },
      artifacts: {},
    });
  });
});
