import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditConsumerRagIntegrations } from '../scripts/audit-consumer-rag-integrations.mjs';

function makeFleet() {
  const fleetRoot = mkdtempSync(resolve(tmpdir(), 'kb-consumer-rag-audit-'));
  return {
    fleetRoot,
    cleanup: () => rmSync(fleetRoot, { recursive: true, force: true }),
  };
}

function write(path: string, content: string) {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

function writeHealthyLinkchat(fleetRoot: string, dirname = 'linkchat') {
  const repo = resolve(fleetRoot, dirname);
  write(resolve(repo, 'package.json'), JSON.stringify({
    scripts: {
      'cf:build': 'next build --webpack && opennextjs-cloudflare build --skipNextBuild',
      'deploy:cf': 'pnpm cf:build && opennextjs-cloudflare deploy',
    },
  }));
  write(resolve(repo, 'wrangler.jsonc'), JSON.stringify({
    services: [{ binding: 'RAG_SERVICE', service: 'knowledgebase' }],
  }));
  write(resolve(repo, 'src/lib/knowledgebase.ts'), [
    'import { getCloudflareContext } from "@opennextjs/cloudflare";',
    'const RAG_SERVICE_URL = "https://knowledgebase.sarthakagrawal927.workers.dev";',
    'function cloudflareEnv() { return getCloudflareContext().env; }',
    'function key() { return process.env.RAG_SERVICE_KEY || cloudflareEnv().RAG_SERVICE_KEY; }',
    'function binding() { return cloudflareEnv().RAG_SERVICE; }',
    'export async function createIndex() { return fetch("/v1/indexes"); }',
    'export async function ingestDocument(indexId, content, metadata) { return fetch(`/v1/indexes/${indexId}/ingest`, { body: JSON.stringify({ documents: [{ content, metadata }] }) }); }',
    'export async function deleteDocument(docId) { return fetch(`/v1/documents/${docId}`); }',
    'export async function search(indexId, query, topK) { return fetch(`/v1/indexes/${indexId}/query`, { body: JSON.stringify({ query, top_k: topK }) }); }',
  ].join('\n'));
  for (const route of [
    'src/app/api/settings/ai-key/route.ts',
    'src/app/api/pages/[pageId]/info/route.ts',
    'src/app/api/pages/[pageId]/info/[blockId]/route.ts',
    'src/app/api/chat/[slug]/route.ts',
  ]) {
    write(resolve(repo, route), 'import { search } from "@/lib/knowledgebase";\n');
  }
}

function writeHealthyStarboard(fleetRoot: string) {
  const repo = resolve(fleetRoot, 'starboard');
  write(resolve(repo, 'package.json'), JSON.stringify({
    scripts: {
      'build:cf': 'next build --webpack && opennextjs-cloudflare build --skipNextBuild',
      'deploy:cf': 'pnpm build:cf && opennextjs-cloudflare deploy',
    },
  }));
  write(resolve(repo, 'wrangler.jsonc'), JSON.stringify({
    vars: { STARBOARD_RAG_INDEX_ID: 'idx-123' },
    services: [{ binding: 'RAG_SERVICE', service: 'knowledgebase' }],
  }));
  write(resolve(repo, 'src/lib/knowledgebase.ts'), [
    'import { getCloudflareContext } from "@opennextjs/cloudflare";',
    'const RAG_SERVICE_URL = "https://knowledgebase.sarthakagrawal927.workers.dev";',
    'function cloudflareEnv() { return getCloudflareContext().env; }',
    'function key() { return process.env.RAG_SERVICE_KEY || cloudflareEnv().RAG_SERVICE_KEY; }',
    'function index() { return process.env.STARBOARD_RAG_INDEX_ID || cloudflareEnv().STARBOARD_RAG_INDEX_ID; }',
    'function binding() { return cloudflareEnv().RAG_SERVICE; }',
    'export async function searchStarboardRag(userId, query, topK) { const body = { query, top_k: topK, mode: "semantic", filter: { user_id: userId } }; const result = { metadata: { repo_id: 1 } }; return [Number(result.metadata.repo_id), fetch(`/v1/indexes/${ragIndexId}/query`, { body })]; }',
    'export async function ingestStarboardRagDocuments() { return fetch(`/v1/indexes/${ragIndexId}/ingest`); }',
  ].join('\n'));
  write(resolve(repo, 'src/app/api/stars/route.ts'), 'import { searchStarboardRag } from "@/lib/knowledgebase";\n');
  write(resolve(repo, 'src/app/api/stars/sync/route.ts'), [
    'import { ingestStarboardRagDocuments } from "@/lib/knowledgebase";',
    'ingestStarboardRagDocuments([{ content: texts[i] ?? "", metadata: { user_id: userId, repo_id: repo.id, full_name: repo.full_name, language: repo.language } }]);',
  ].join('\n'));
}

describe('audit-consumer-rag-integrations', () => {
  it('passes when Linkchat and Starboard are bound to knowledgebase', () => {
    const { fleetRoot, cleanup } = makeFleet();
    try {
      writeHealthyLinkchat(fleetRoot);
      writeHealthyStarboard(fleetRoot);

      const report = auditConsumerRagIntegrations({ fleetRoot });

      expect(report.ok).toBe(true);
      expect(report.blockers).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it('passes when Linkchat has been renamed to Karte locally', () => {
    const { fleetRoot, cleanup } = makeFleet();
    try {
      writeHealthyLinkchat(fleetRoot, 'karte');
      writeHealthyStarboard(fleetRoot);

      const report = auditConsumerRagIntegrations({ fleetRoot });

      expect(report.ok).toBe(true);
      expect(report.blockers).toEqual([]);
      expect(report.consumers[0]?.checks).toContainEqual({
        name: 'repo_exists',
        ok: true,
        detail: 'using karte',
      });
    } finally {
      cleanup();
    }
  });

  it('fails when a consumer still points at the old rag-service Worker', () => {
    const { fleetRoot, cleanup } = makeFleet();
    try {
      writeHealthyLinkchat(fleetRoot);
      writeHealthyStarboard(fleetRoot);
      write(resolve(fleetRoot, 'linkchat/wrangler.jsonc'), JSON.stringify({
        services: [{ binding: 'RAG_SERVICE', service: 'rag-service' }],
      }));

      const report = auditConsumerRagIntegrations({ fleetRoot });

      expect(report.ok).toBe(false);
      expect(report.blockers).toContain('linkchat:rag_service_binding');
    } finally {
      cleanup();
    }
  });

  it('fails when Linkchat/Karte does not expose a Cloudflare deploy command', () => {
    const { fleetRoot, cleanup } = makeFleet();
    try {
      writeHealthyLinkchat(fleetRoot);
      writeHealthyStarboard(fleetRoot);
      write(resolve(fleetRoot, 'linkchat/package.json'), JSON.stringify({
        scripts: { build: 'next build' },
      }));

      const report = auditConsumerRagIntegrations({ fleetRoot });

      expect(report.ok).toBe(false);
      expect(report.blockers).toContain('linkchat:deploy_cf_script');
    } finally {
      cleanup();
    }
  });

  it('fails when Starboard does not expose a Cloudflare deploy command', () => {
    const { fleetRoot, cleanup } = makeFleet();
    try {
      writeHealthyLinkchat(fleetRoot);
      writeHealthyStarboard(fleetRoot);
      write(resolve(fleetRoot, 'starboard/package.json'), JSON.stringify({
        scripts: { 'deploy:cf': 'next deploy' },
      }));

      const report = auditConsumerRagIntegrations({ fleetRoot });

      expect(report.ok).toBe(false);
      expect(report.blockers).toContain('starboard:deploy_cf_script');
    } finally {
      cleanup();
    }
  });

  it('fails when a consumer deploy script bypasses its Cloudflare build pipeline', () => {
    const { fleetRoot, cleanup } = makeFleet();
    try {
      writeHealthyLinkchat(fleetRoot);
      writeHealthyStarboard(fleetRoot);
      write(resolve(fleetRoot, 'linkchat/package.json'), JSON.stringify({
        scripts: {
          'cf:build': 'next build --webpack && opennextjs-cloudflare build --skipNextBuild',
          'deploy:cf': 'opennextjs-cloudflare build && opennextjs-cloudflare deploy',
        },
      }));

      const report = auditConsumerRagIntegrations({ fleetRoot });

      expect(report.ok).toBe(false);
      expect(report.blockers).toContain('linkchat:deploy_cf_script');
    } finally {
      cleanup();
    }
  });

  it('fails when Starboard cannot read Cloudflare Worker vars for RAG', () => {
    const { fleetRoot, cleanup } = makeFleet();
    try {
      writeHealthyLinkchat(fleetRoot);
      writeHealthyStarboard(fleetRoot);
      write(resolve(fleetRoot, 'starboard/src/lib/knowledgebase.ts'), [
        'import { getCloudflareContext } from "@opennextjs/cloudflare";',
        'function key() { return process.env.RAG_SERVICE_KEY; }',
        'function index() { return process.env.STARBOARD_RAG_INDEX_ID; }',
        'function binding() { return getCloudflareContext().env.RAG_SERVICE; }',
        'export async function searchStarboardRag(userId) { const body = { filter: { user_id: userId } }; const result = { metadata: { repo_id: 1 } }; return [Number(result.metadata.repo_id), fetch(`/v1/indexes/${ragIndexId}/query`, { body })]; }',
        'export async function ingestStarboardRagDocuments() { return fetch(`/v1/indexes/${ragIndexId}/ingest`); }',
      ].join('\n'));

      const report = auditConsumerRagIntegrations({ fleetRoot });

      expect(report.ok).toBe(false);
      expect(report.blockers).toContain('starboard:rag_client');
    } finally {
      cleanup();
    }
  });

  it('fails when Linkchat keeps the legacy SaasMaker RAG helper', () => {
    const { fleetRoot, cleanup } = makeFleet();
    try {
      writeHealthyLinkchat(fleetRoot);
      writeHealthyStarboard(fleetRoot);
      write(resolve(fleetRoot, 'linkchat/src/lib/saasmaker.ts'), 'export const SAASMAKER_API_URL = "";\n');

      const report = auditConsumerRagIntegrations({ fleetRoot });

      expect(report.ok).toBe(false);
      expect(report.blockers).toContain('linkchat:legacy_saas_maker_helper_removed');
    } finally {
      cleanup();
    }
  });

  it('fails when a consumer keeps the old rag-service client filename', () => {
    const { fleetRoot, cleanup } = makeFleet();
    try {
      writeHealthyLinkchat(fleetRoot);
      writeHealthyStarboard(fleetRoot);
      write(resolve(fleetRoot, 'starboard/src/lib/rag-service.ts'), 'export const stale = true;\n');

      const report = auditConsumerRagIntegrations({ fleetRoot });

      expect(report.ok).toBe(false);
      expect(report.blockers).toContain('starboard:legacy_rag_service_client_removed');
    } finally {
      cleanup();
    }
  });

  it('fails when a consumer fallback URL points at the retired rag-service Worker', () => {
    const { fleetRoot, cleanup } = makeFleet();
    try {
      writeHealthyLinkchat(fleetRoot);
      writeHealthyStarboard(fleetRoot);
      write(resolve(fleetRoot, 'starboard/src/lib/knowledgebase.ts'), [
        'import { getCloudflareContext } from "@opennextjs/cloudflare";',
        'const RAG_SERVICE_URL = process.env.RAG_SERVICE_URL || "https://rag-service.sarthakagrawal927.workers.dev";',
        'function cloudflareEnv() { return getCloudflareContext().env; }',
        'function key() { return process.env.RAG_SERVICE_KEY || cloudflareEnv().RAG_SERVICE_KEY; }',
        'function index() { return process.env.STARBOARD_RAG_INDEX_ID || cloudflareEnv().STARBOARD_RAG_INDEX_ID; }',
        'function binding() { return cloudflareEnv().RAG_SERVICE; }',
        'export async function searchStarboardRag(userId) { const body = { filter: { user_id: userId } }; const result = { metadata: { repo_id: 1 } }; return [Number(result.metadata.repo_id), fetch(`/v1/indexes/${ragIndexId}/query`, { body })]; }',
        'export async function ingestStarboardRagDocuments() { return fetch(`/v1/indexes/${ragIndexId}/ingest`); }',
      ].join('\n'));

      const report = auditConsumerRagIntegrations({ fleetRoot });

      expect(report.ok).toBe(false);
      expect(report.blockers).toContain('starboard:rag_service_url_fallback');
    } finally {
      cleanup();
    }
  });

  it('fails when Starboard sync no longer ingests through the shared knowledgebase client', () => {
    const { fleetRoot, cleanup } = makeFleet();
    try {
      writeHealthyLinkchat(fleetRoot);
      writeHealthyStarboard(fleetRoot);
      write(resolve(fleetRoot, 'starboard/src/app/api/stars/sync/route.ts'), 'export async function POST() { return Response.json({ ok: true }); }\n');

      const report = auditConsumerRagIntegrations({ fleetRoot });

      expect(report.ok).toBe(false);
      expect(report.blockers).toContain('starboard:stars_sync_route');
    } finally {
      cleanup();
    }
  });

  it('fails when Linkchat loses the full knowledgebase profile-memory client contract', () => {
    const { fleetRoot, cleanup } = makeFleet();
    try {
      writeHealthyLinkchat(fleetRoot);
      writeHealthyStarboard(fleetRoot);
      write(resolve(fleetRoot, 'linkchat/src/lib/knowledgebase.ts'), [
        'import { getCloudflareContext } from "@opennextjs/cloudflare";',
        'const RAG_SERVICE_URL = "https://knowledgebase.sarthakagrawal927.workers.dev";',
        'function cloudflareEnv() { return getCloudflareContext().env; }',
        'function key() { return process.env.RAG_SERVICE_KEY || cloudflareEnv().RAG_SERVICE_KEY; }',
        'function binding() { return cloudflareEnv().RAG_SERVICE; }',
        'export async function search(indexId) { return fetch(`/v1/indexes/${indexId}/query`); }',
      ].join('\n'));

      const report = auditConsumerRagIntegrations({ fleetRoot });

      expect(report.ok).toBe(false);
      expect(report.blockers).toContain('linkchat:rag_client_crud_contract');
    } finally {
      cleanup();
    }
  });

  it('fails when Linkchat keeps function names but drops knowledgebase request payloads', () => {
    const { fleetRoot, cleanup } = makeFleet();
    try {
      writeHealthyLinkchat(fleetRoot);
      writeHealthyStarboard(fleetRoot);
      write(resolve(fleetRoot, 'linkchat/src/lib/knowledgebase.ts'), [
        'import { getCloudflareContext } from "@opennextjs/cloudflare";',
        'const RAG_SERVICE_URL = "https://knowledgebase.sarthakagrawal927.workers.dev";',
        'function cloudflareEnv() { return getCloudflareContext().env; }',
        'function key() { return process.env.RAG_SERVICE_KEY || cloudflareEnv().RAG_SERVICE_KEY; }',
        'function binding() { return cloudflareEnv().RAG_SERVICE; }',
        'export async function createIndex() { return fetch("/v1/indexes"); }',
        'export async function ingestDocument(indexId) { return fetch(`/v1/indexes/${indexId}/ingest`); }',
        'export async function deleteDocument(docId) { return fetch(`/v1/documents/${docId}`); }',
        'export async function search(indexId) { return fetch(`/v1/indexes/${indexId}/query`); }',
      ].join('\n'));

      const report = auditConsumerRagIntegrations({ fleetRoot });

      expect(report.ok).toBe(false);
      expect(report.blockers).toContain('linkchat:rag_client_payload_contract');
    } finally {
      cleanup();
    }
  });

  it('fails when Starboard drops knowledgebase user/repo metadata scoping', () => {
    const { fleetRoot, cleanup } = makeFleet();
    try {
      writeHealthyLinkchat(fleetRoot);
      writeHealthyStarboard(fleetRoot);
      write(resolve(fleetRoot, 'starboard/src/lib/knowledgebase.ts'), [
        'import { getCloudflareContext } from "@opennextjs/cloudflare";',
        'const RAG_SERVICE_URL = "https://knowledgebase.sarthakagrawal927.workers.dev";',
        'function cloudflareEnv() { return getCloudflareContext().env; }',
        'function key() { return process.env.RAG_SERVICE_KEY || cloudflareEnv().RAG_SERVICE_KEY; }',
        'function index() { return process.env.STARBOARD_RAG_INDEX_ID || cloudflareEnv().STARBOARD_RAG_INDEX_ID; }',
        'function binding() { return cloudflareEnv().RAG_SERVICE; }',
        'export async function searchStarboardRag() { return fetch(`/v1/indexes/${ragIndexId}/query`); }',
        'export async function ingestStarboardRagDocuments() { return fetch(`/v1/indexes/${ragIndexId}/ingest`); }',
      ].join('\n'));

      const report = auditConsumerRagIntegrations({ fleetRoot });

      expect(report.ok).toBe(false);
      expect(report.blockers).toContain('starboard:rag_client_user_scope');
    } finally {
      cleanup();
    }
  });

  it('fails when Starboard sync omits metadata needed by knowledgebase results', () => {
    const { fleetRoot, cleanup } = makeFleet();
    try {
      writeHealthyLinkchat(fleetRoot);
      writeHealthyStarboard(fleetRoot);
      write(resolve(fleetRoot, 'starboard/src/app/api/stars/sync/route.ts'), [
        'import { ingestStarboardRagDocuments } from "@/lib/knowledgebase";',
        'ingestStarboardRagDocuments([{ metadata: { repo_id: repo.id } }]);',
      ].join('\n'));

      const report = auditConsumerRagIntegrations({ fleetRoot });

      expect(report.ok).toBe(false);
      expect(report.blockers).toContain('starboard:stars_sync_metadata_contract');
    } finally {
      cleanup();
    }
  });

  it('fails when Starboard sync omits document content for knowledgebase ingest', () => {
    const { fleetRoot, cleanup } = makeFleet();
    try {
      writeHealthyLinkchat(fleetRoot);
      writeHealthyStarboard(fleetRoot);
      write(resolve(fleetRoot, 'starboard/src/app/api/stars/sync/route.ts'), [
        'import { ingestStarboardRagDocuments } from "@/lib/knowledgebase";',
        'ingestStarboardRagDocuments([{ metadata: { user_id: userId, repo_id: repo.id, full_name: repo.full_name, language: repo.language } }]);',
      ].join('\n'));

      const report = auditConsumerRagIntegrations({ fleetRoot });

      expect(report.ok).toBe(false);
      expect(report.blockers).toContain('starboard:stars_sync_content_contract');
    } finally {
      cleanup();
    }
  });
});
