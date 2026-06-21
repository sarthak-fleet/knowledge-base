import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditSiblingRagService, formatAuditReportForCli } from '../scripts/audit-sibling-rag-service.mjs';

function makeFleet() {
  const fleetRoot = mkdtempSync(resolve(tmpdir(), 'kb-sibling-audit-'));
  const repoRoot = resolve(fleetRoot, 'knowledgebase');
  mkdirSync(repoRoot, { recursive: true });
  return { fleetRoot, repoRoot };
}

describe('audit-sibling-rag-service', () => {
  it('fails while the sibling deployable Worker folder still exists', () => {
    const { fleetRoot, repoRoot } = makeFleet();
    const sibling = resolve(fleetRoot, 'rag-service');
    mkdirSync(resolve(sibling, 'src'), { recursive: true });
    writeFileSync(resolve(sibling, 'package.json'), '{"name":"@fleet/rag-service"}');
    writeFileSync(resolve(sibling, 'wrangler.jsonc'), '{"name":"rag-service"}');
    writeFileSync(resolve(sibling, 'src/index.ts'), 'export default {};');

    const report = auditSiblingRagService({
      fleetRoot,
      repoRoot,
      externalRepos: [],
    });

    expect(report.ok).toBe(false);
    expect(report.blockers).toEqual([
      'sibling_directory_exists',
      'sibling_deployable_surfaces_exist',
    ]);
    expect(report.sibling_deployable_surfaces).toEqual([
      'rag-service/package.json',
      'rag-service/wrangler.jsonc',
      'rag-service/src/',
    ]);
  });

  it('reports sibling runtime, migration, and test surfaces that must be removed before deletion', () => {
    const { fleetRoot, repoRoot } = makeFleet();
    const sibling = resolve(fleetRoot, 'rag-service');
    for (const dir of ['src', 'scripts', 'migrations', 'tests', 'fixtures']) {
      mkdirSync(resolve(sibling, dir), { recursive: true });
    }
    writeFileSync(resolve(sibling, 'package.json'), '{"name":"@fleet/rag-service"}');
    writeFileSync(resolve(sibling, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0');
    writeFileSync(resolve(sibling, 'worker-configuration.d.ts'), 'export interface Env {}');
    writeFileSync(resolve(sibling, 'tsconfig.json'), '{}');
    writeFileSync(resolve(sibling, 'vitest.config.ts'), 'export default {};');

    const report = auditSiblingRagService({
      fleetRoot,
      repoRoot,
      externalRepos: [],
    });

    expect(report.sibling_deployable_surfaces).toEqual([
      'rag-service/package.json',
      'rag-service/pnpm-lock.yaml',
      'rag-service/worker-configuration.d.ts',
      'rag-service/tsconfig.json',
      'rag-service/vitest.config.ts',
      'rag-service/src/',
      'rag-service/scripts/',
      'rag-service/migrations/',
      'rag-service/tests/',
      'rag-service/fixtures/',
    ]);
    expect(report.blockers).toContain('sibling_deployable_surfaces_exist');
  });

  it('reports active external references to the old rag-service Worker', () => {
    const { fleetRoot, repoRoot } = makeFleet();
    const app = resolve(fleetRoot, 'linkchat');
    mkdirSync(app, { recursive: true });
    writeFileSync(resolve(app, 'wrangler.jsonc'), JSON.stringify({
      services: [{ binding: 'RAG_SERVICE', service: 'rag-service' }],
    }));

    const report = auditSiblingRagService({
      fleetRoot,
      repoRoot,
      siblingPath: resolve(fleetRoot, 'missing-rag-service'),
      externalRepos: [app],
    });

    expect(report.ok).toBe(false);
    expect(report.external_references_ok).toBe(false);
    expect(report.blockers).toEqual(['active_external_references_exist']);
    expect(report.active_external_references).toEqual([
      expect.objectContaining({
        repo: 'linkchat',
        file: 'wrangler.jsonc',
        line: 1,
      }),
    ]);
  });

  it('reports JS, TOML, YAML, and env-style references to the old rag-service Worker', () => {
    const { fleetRoot, repoRoot } = makeFleet();
    const app = resolve(fleetRoot, 'mixed-consumer');
    mkdirSync(app, { recursive: true });
    writeFileSync(resolve(app, 'worker.ts'), 'export const binding = { binding: "RAG_SERVICE", service: "rag-service" };\n');
    writeFileSync(resolve(app, 'wrangler.toml'), 'service = "rag-service"\n');
    writeFileSync(resolve(app, 'service.yml'), 'service: rag-service\n');
    writeFileSync(resolve(app, 'settings.yaml'), 'RAG_SERVICE: rag-service\n');

    const report = auditSiblingRagService({
      fleetRoot,
      repoRoot,
      siblingPath: resolve(fleetRoot, 'missing-rag-service'),
      externalRepos: [app],
    });

    expect(report.ok).toBe(false);
    expect(report.external_references_ok).toBe(false);
    expect(report.active_external_references).toEqual([
      expect.objectContaining({
        repo: 'mixed-consumer',
        file: 'service.yml',
        line: 1,
      }),
      expect.objectContaining({
        repo: 'mixed-consumer',
        file: 'settings.yaml',
        line: 1,
      }),
      expect.objectContaining({
        repo: 'mixed-consumer',
        file: 'worker.ts',
        line: 1,
      }),
      expect.objectContaining({
        repo: 'mixed-consumer',
        file: 'wrangler.toml',
        line: 1,
      }),
    ]);
  });

  it('does not report equivalent config that points at knowledgebase', () => {
    const { fleetRoot, repoRoot } = makeFleet();
    const app = resolve(fleetRoot, 'knowledgebase-consumer');
    mkdirSync(app, { recursive: true });
    writeFileSync(resolve(app, 'worker.ts'), 'export const binding = { binding: "RAG_SERVICE", service: "knowledgebase" };\n');
    writeFileSync(resolve(app, 'wrangler.toml'), 'service = "knowledgebase"\n');
    writeFileSync(resolve(app, 'service.yml'), 'service: knowledgebase\n');
    writeFileSync(resolve(app, 'settings.yaml'), 'RAG_SERVICE: knowledgebase\n');

    const report = auditSiblingRagService({
      fleetRoot,
      repoRoot,
      siblingPath: resolve(fleetRoot, 'missing-rag-service'),
      externalRepos: [app],
    });

    expect(report.ok).toBe(true);
    expect(report.active_external_references).toEqual([]);
  });

  it('discovers sibling fleet repos by default instead of only named consumers', () => {
    const { fleetRoot, repoRoot } = makeFleet();
    const app = resolve(fleetRoot, 'reader');
    mkdirSync(app, { recursive: true });
    writeFileSync(resolve(app, 'wrangler.jsonc'), JSON.stringify({
      services: [{ binding: 'RAG_SERVICE', service: 'rag-service' }],
    }));

    const report = auditSiblingRagService({
      fleetRoot,
      repoRoot,
      siblingPath: resolve(fleetRoot, 'missing-rag-service'),
    });

    expect(report.ok).toBe(false);
    expect(report.blockers).toEqual(['active_external_references_exist']);
    expect(report.active_external_references).toEqual([
      expect.objectContaining({
        repo: 'reader',
        file: 'wrangler.jsonc',
      }),
    ]);
    expect(report.external_repos_scanned).toContain('reader');
  });

  it('excludes knowledgebase, rag-service, and out-of-fleet sandboxes from default external scans', () => {
    const { fleetRoot, repoRoot } = makeFleet();
    for (const dir of ['knowledgebase', 'rag-service', 'local-ai', 'port-whisperer']) {
      mkdirSync(resolve(fleetRoot, dir), { recursive: true });
      writeFileSync(resolve(fleetRoot, dir, 'wrangler.jsonc'), JSON.stringify({
        services: [{ binding: 'RAG_SERVICE', service: 'rag-service' }],
      }));
    }

    const report = auditSiblingRagService({
      fleetRoot,
      repoRoot,
      siblingPath: resolve(fleetRoot, 'missing-rag-service'),
    });

    expect(report.ok).toBe(true);
    expect(report.external_repos_scanned).toEqual([]);
    expect(report.active_external_references).toEqual([]);
  });

  it('passes after the sibling folder is gone and apps point at knowledgebase', () => {
    const { fleetRoot, repoRoot } = makeFleet();
    const app = resolve(fleetRoot, 'starboard');
    mkdirSync(app, { recursive: true });
    writeFileSync(resolve(app, 'wrangler.jsonc'), JSON.stringify({
      services: [{ binding: 'RAG_SERVICE', service: 'knowledgebase' }],
    }));

    const report = auditSiblingRagService({
      fleetRoot,
      repoRoot,
      siblingPath: resolve(fleetRoot, 'missing-rag-service'),
      externalRepos: [app],
    });

    expect(report).toMatchObject({
      ok: true,
      external_references_ok: true,
      sibling_exists: false,
      sibling_deployable_surfaces: [],
      external_repos_scanned: ['starboard'],
      active_external_references: [],
      blockers: [],
    });
  });

  it('ignores generated smoke snapshots under .symphony', () => {
    const { fleetRoot, repoRoot } = makeFleet();
    const app = resolve(fleetRoot, 'saas-maker');
    mkdirSync(resolve(app, '.symphony/fleet-production-smoke'), { recursive: true });
    writeFileSync(resolve(app, '.symphony/fleet-production-smoke/latest.json'), JSON.stringify({
      prodUrl: 'https://rag-service.sarthakagrawal927.workers.dev',
    }));

    const report = auditSiblingRagService({
      fleetRoot,
      repoRoot,
      siblingPath: resolve(fleetRoot, 'missing-rag-service'),
      externalRepos: [app],
    });

    expect(report.ok).toBe(true);
    expect(report.active_external_references).toEqual([]);
  });

  it('formats the no-external-references CLI gate independently from sibling deletion readiness', () => {
    const { fleetRoot, repoRoot } = makeFleet();
    const sibling = resolve(fleetRoot, 'rag-service');
    mkdirSync(resolve(sibling, 'src'), { recursive: true });
    writeFileSync(resolve(sibling, 'package.json'), '{"name":"@fleet/rag-service"}');

    const report = auditSiblingRagService({
      fleetRoot,
      repoRoot,
      externalRepos: [],
    });
    const cliReport = formatAuditReportForCli(report, {
      requireNoExternalReferences: true,
      requireRetired: false,
    });

    expect(report.ok).toBe(false);
    expect(cliReport).toMatchObject({
      ok: true,
      gate: 'external_rag_service_references',
      retirement_ok: false,
      external_reference_gate_ok: true,
      blockers: [],
      retirement_blockers: [
        'sibling_directory_exists',
        'sibling_deployable_surfaces_exist',
      ],
    });
  });
});
