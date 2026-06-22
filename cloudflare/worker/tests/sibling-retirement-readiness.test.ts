import { describe, expect, it, vi } from 'vitest';
import { runSiblingRetirementReadiness } from '../scripts/sibling-retirement-readiness.mjs';

const deployedAuthAndOcrReady = async () => ({
  ok: true,
  checks: [
    { name: 'public-health', ok: true },
    { name: 'authenticated-index-list', ok: true },
    { name: 'nvda-scanned-ocr-live', ok: true },
  ],
});

const deployedLegacyRoutesReady = async () => ({
  ok: true,
  checked: 11,
  failed: [],
  deploy_fingerprint: 'knowledgebase-cloudflare-embedding-models-2026-06-21',
});

const preflightReady = async () => ({
  ok: true,
  errors: 0,
  warnings: 0,
  checks: [],
});

const siblingOnlyAudit = async () => ({
  ok: false,
  sibling_exists: true,
  external_references_ok: true,
  sibling_deployable_surfaces: ['rag-service/package.json'],
  active_external_references: [],
  blockers: ['sibling_directory_exists', 'sibling_deployable_surfaces_exist'],
});

const onlySiblingGapRemains = async () => ({
  ok: false,
  exit_code: 1,
  payload: {
    ok: false,
    remaining: 1,
    items: [
      { feature: 'shared_rag_api', status: 'done' },
      { feature: 'sibling_rag_service_retirement', status: 'partial' },
      { feature: 'deployed_worker_cutover', status: 'done' },
      { feature: 'ocr_and_office_parsing', status: 'done' },
    ],
  },
});

describe('sibling-retirement-readiness', () => {
  it('passes when deployed cutover, OCR, preflight, external refs, and gap matrix are ready for deletion', async () => {
    const deployReadinessRunner = vi.fn(deployedAuthAndOcrReady);
    const result = await runSiblingRetirementReadiness({
      baseUrl: 'http://rag.local',
      key: 'service-key',
      allowLiveOcr: true,
      deployReadinessRunner,
      legacyRouteRunner: deployedLegacyRoutesReady,
      preflightRunner: preflightReady,
      siblingAuditRunner: siblingOnlyAudit,
      fullPortRunner: onlySiblingGapRemains,
    });

    expect(result.ok).toBe(true);
    expect(deployReadinessRunner).toHaveBeenCalledWith(expect.objectContaining({
      requireNvdaOcr: true,
      allowLiveOcr: true,
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'full-port-gaps-clear-for-sibling-retirement',
      ok: true,
      remaining_features: ['sibling_rag_service_retirement'],
    }));
  });

  it('fails when deployed auth or OCR readiness is not proven', async () => {
    const result = await runSiblingRetirementReadiness({
      baseUrl: 'http://rag.local',
      key: '',
      deployReadinessRunner: async () => ({
        ok: false,
        checks: [
          { name: 'authenticated-key-present', ok: false },
          { name: 'nvda-scanned-ocr-live', ok: false },
        ],
      }),
      legacyRouteRunner: deployedLegacyRoutesReady,
      preflightRunner: preflightReady,
      siblingAuditRunner: siblingOnlyAudit,
      fullPortRunner: onlySiblingGapRemains,
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'deployed-auth-and-ocr-ready',
      ok: false,
      failed_checks: ['authenticated-key-present', 'nvda-scanned-ocr-live'],
    }));
  });

  it('fails when deployed aliases are stale', async () => {
    const deployReadinessRunner = vi.fn(deployedAuthAndOcrReady);
    const result = await runSiblingRetirementReadiness({
      baseUrl: 'http://rag.local',
      key: 'service-key',
      deployReadinessRunner,
      legacyRouteRunner: async () => ({
        ok: false,
        checked: 11,
        failed: [{ path: '/search', status: 404 }],
        deploy_fingerprint: null,
      }),
      preflightRunner: preflightReady,
      siblingAuditRunner: siblingOnlyAudit,
      fullPortRunner: onlySiblingGapRemains,
    });

    expect(result.ok).toBe(false);
    expect(deployReadinessRunner).toHaveBeenCalledWith(expect.objectContaining({
      requireNvdaOcr: false,
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'deployed-legacy-route-parity',
      ok: false,
      failed: [{ path: '/search', status: 404 }],
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'deployed-worker-fingerprint',
      ok: false,
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'deployed-auth-and-ocr-ready',
      ok: false,
      failed_checks: ['nvda-scanned-ocr-live'],
      live_ocr_skipped_until_current_deploy: true,
    }));
  });

  it('fails when deploy or OCR gaps remain in the full-port matrix', async () => {
    const result = await runSiblingRetirementReadiness({
      baseUrl: 'http://rag.local',
      key: 'service-key',
      deployReadinessRunner: deployedAuthAndOcrReady,
      legacyRouteRunner: deployedLegacyRoutesReady,
      preflightRunner: preflightReady,
      siblingAuditRunner: siblingOnlyAudit,
      fullPortRunner: async () => ({
        ok: false,
        exit_code: 1,
        payload: {
          ok: false,
          remaining: 3,
          items: [
            { feature: 'sibling_rag_service_retirement', status: 'partial' },
            { feature: 'deployed_worker_cutover', status: 'partial' },
            { feature: 'ocr_and_office_parsing', status: 'partial' },
          ],
        },
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'full-port-gaps-clear-for-sibling-retirement',
      ok: false,
      remaining_features: [
        'deployed_worker_cutover',
        'ocr_and_office_parsing',
        'sibling_rag_service_retirement',
      ],
    }));
  });

  it('fails when the gap matrix says sibling retirement is done while the sibling folder still exists', async () => {
    const result = await runSiblingRetirementReadiness({
      baseUrl: 'http://rag.local',
      key: 'service-key',
      deployReadinessRunner: deployedAuthAndOcrReady,
      legacyRouteRunner: deployedLegacyRoutesReady,
      preflightRunner: preflightReady,
      siblingAuditRunner: siblingOnlyAudit,
      fullPortRunner: async () => ({
        ok: true,
        exit_code: 0,
        payload: {
          ok: true,
          remaining: 0,
          items: [
            { feature: 'sibling_rag_service_retirement', status: 'done' },
            { feature: 'deployed_worker_cutover', status: 'done' },
            { feature: 'ocr_and_office_parsing', status: 'done' },
          ],
        },
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'sibling-retirement-gap-matches-audit',
      ok: false,
      sibling_exists: true,
      sibling_gap_open: false,
      remaining_features: [],
    }));
  });

  it('fails when the sibling folder is gone but the gap matrix still lists sibling retirement as open', async () => {
    const result = await runSiblingRetirementReadiness({
      baseUrl: 'http://rag.local',
      key: 'service-key',
      deployReadinessRunner: deployedAuthAndOcrReady,
      legacyRouteRunner: deployedLegacyRoutesReady,
      preflightRunner: preflightReady,
      siblingAuditRunner: async () => ({
        ok: true,
        sibling_exists: false,
        external_references_ok: true,
        sibling_deployable_surfaces: [],
        active_external_references: [],
        blockers: [],
      }),
      fullPortRunner: onlySiblingGapRemains,
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'sibling-rag-service-delete-target-known',
      ok: true,
      sibling_exists: false,
    }));
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'sibling-retirement-gap-matches-audit',
      ok: false,
      sibling_exists: false,
      sibling_gap_open: true,
      remaining_features: ['sibling_rag_service_retirement'],
    }));
  });
});
