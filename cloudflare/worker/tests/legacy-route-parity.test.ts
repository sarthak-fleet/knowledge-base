import { describe, expect, it } from 'vitest';
import { LEGACY_ROUTE_REQUIREMENTS, legacyRouteParityReport } from '../scripts/audit-legacy-route-parity.mjs';

describe('legacy route parity audit', () => {
  it('covers the retired FastAPI public route inventory', async () => {
    const report = await legacyRouteParityReport();

    expect(report.ok).toBe(true);
    expect(report.total).toBe(41);
    expect(report.missing).toEqual([]);
    expect(LEGACY_ROUTE_REQUIREMENTS.map((item) => `${item.method} ${item.legacy}`)).toEqual(expect.arrayContaining([
      'GET /healthz',
      'GET /metrics',
      'GET /readyz',
      'POST /search',
      'POST /agent/search',
      'POST /search/eval',
      'POST /query',
      'POST /query/stream',
      'POST /schemas/infer/files',
      'GET /ingest/jobs',
    ]));
  });

  it('fails closed when the alias middleware is absent', async () => {
    const report = await legacyRouteParityReport({ sourceText: '' });

    expect(report.ok).toBe(false);
    expect(report.missing_count).toBeGreaterThan(0);
    expect(report.missing).toEqual(expect.arrayContaining([
      expect.objectContaining({ legacy: '/search', target: '/v1/kb/search' }),
      expect.objectContaining({ legacy: '*', target: '/v1/kb/*' }),
    ]));
  });
});
