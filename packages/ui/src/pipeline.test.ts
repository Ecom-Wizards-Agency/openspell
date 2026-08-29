import { describe, expect, it } from 'vitest';
import { isGroupedRow } from './aggregate.js';
import { syntheticSearchTermRows } from './fixtures.js';
import { buildGridModel } from './pipeline.js';

describe('nested grid pipeline', () => {
  it('keeps parents with their sorted children and exports deepest groups only', () => {
    const rows = syntheticSearchTermRows(3_597, { seed: 29 });
    const model = buildGridModel(rows, {
      groupBy: ['campaign_name', 'ad_group_name', 'match_type'],
      sort: [{ columnId: 'spend', direction: 'desc' }],
    });

    expect(model.groupBy).toEqual(['campaign_name', 'ad_group_name', 'match_type']);
    expect(model.rows).toHaveLength(model.shown);
    expect(model.exportRows).toHaveLength(model.exported);
    expect(model.exported).toBeLessThan(model.shown);
    expect(model.exportRows.every((row) => isGroupedRow(row) && row.isLeafGroup)).toBe(true);
    expect(
      model.exportRows.reduce(
        (count, row) => count + (isGroupedRow(row) ? row.groupSize : 0),
        0,
      ),
    ).toBe(model.matched);

    for (const row of model.rows) {
      if (!isGroupedRow(row) || row.parentGroupId === null) continue;
      const parentIndex = model.rows.findIndex((candidate) => candidate.id === row.parentGroupId);
      const rowIndex = model.rows.findIndex((candidate) => candidate.id === row.id);
      expect(parentIndex).toBeGreaterThanOrEqual(0);
      expect(parentIndex).toBeLessThan(rowIndex);
    }

    const roots = model.rows.filter(
      (row) => isGroupedRow(row) && row.parentGroupId === null,
    );
    for (let index = 1; index < roots.length; index += 1) {
      expect(roots[index - 1]!.totals.spend).toBeGreaterThanOrEqual(roots[index]!.totals.spend);
    }
  });

  it('normalizes duplicate grouping levels from a stale saved view', () => {
    const model = buildGridModel(syntheticSearchTermRows(100, { seed: 5 }), {
      groupBy: ['campaign_name', 'match_type', 'campaign_name', 'match_type'],
    });
    expect(model.groupBy).toEqual(['campaign_name', 'match_type']);
    expect(model.rows.every((row) => !isGroupedRow(row) || row.groupBy.length === 2)).toBe(true);
  });
});
