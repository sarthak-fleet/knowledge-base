import { describe, expect, it } from 'vitest';
import { FULL_PORT_ITEMS, fullPortReport, runFullPortGapGate } from '../scripts/full-port-gaps.mjs';

type FullPortItem = {
  feature: string;
  status: string;
};

describe('full-port-gaps', () => {
  it('reports the Cloudflare full-port as complete with no remaining blockers', () => {
    const report = fullPortReport();

    expect(report.ok).toBe(true);
    expect(report.total).toBe(14);
    expect(report.remaining).toBe(0);
    expect(report.items.filter((item: FullPortItem) => item.status !== 'done').map((item: FullPortItem) => item.feature)).toEqual([]);
  });

  it('returns a deploy-readiness compatible success when no blockers remain', async () => {
    const gate = await runFullPortGapGate();

    expect(gate.ok).toBe(true);
    expect(gate.exit_code).toBe(0);
    expect(gate.payload.remaining).toBe(0);
  });

  it('can report a complete gate when every item is done', () => {
    const report = fullPortReport({
      items: FULL_PORT_ITEMS.map((item: FullPortItem) => ({ ...item, status: 'done' })),
    });

    expect(report.ok).toBe(true);
    expect(report.remaining).toBe(0);
    expect(report.items).toHaveLength(14);
  });

  it('reports a failing gate when any item is still partial', async () => {
    const partialItems = FULL_PORT_ITEMS.map((item: FullPortItem, index: number) =>
      index === 0 ? { ...item, status: 'partial' } : { ...item, status: 'done' },
    );

    const report = fullPortReport({ items: partialItems });
    expect(report.ok).toBe(false);
    expect(report.remaining).toBe(1);

    const gate = await runFullPortGapGate({ items: partialItems });
    expect(gate.ok).toBe(false);
    expect(gate.exit_code).toBe(1);
    expect(gate.payload.remaining).toBe(1);
  });
});
