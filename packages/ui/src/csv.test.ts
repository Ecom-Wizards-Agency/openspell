import { describe, expect, it } from 'vitest';
import { columnsFor } from './columns.js';
import { toCsv } from './csv.js';
import { filterSetOf } from './filter.js';
import { syntheticSearchTermRows } from './fixtures.js';
import { buildGridModel } from './pipeline.js';

const columns = columnsFor('search_terms').filter((column) =>
  ['search_term', 'spend', 'sales', 'acos', 'acos_delta_percent'].includes(column.id),
);
const nestedColumns = columnsFor('search_terms').filter((column) =>
  ['campaign_name', 'ad_group_name', 'match_type', 'spend', 'sales', 'acos'].includes(column.id),
);

describe('toCsv', () => {
  it('exports the filtered set, and counts it against the unfiltered one', () => {
    const rows = syntheticSearchTermRows(2000, { seed: 9 });
    const model = buildGridModel(rows, {
      filter: filterSetOf({ key: 'CLICKS', conditions: [{ operator: '>=', values: ['10'] }] }),
    });

    const result = toCsv(model, { columns, label: 'Search terms', currencyCode: 'USD' });

    expect(result.exported).toBe(model.shown);
    expect(result.total).toBe(2000);
    expect(result.exported).toBeLessThan(result.total);
    // Provenance line + header + one line per row.
    expect(result.csv.trimEnd().split('\n')).toHaveLength(result.exported + 2);
  });

  it('exports raw values, not formatted ones, so a spreadsheet can sum a column', () => {
    const rows = syntheticSearchTermRows(5, { seed: 1 });
    const model = buildGridModel(rows);
    const csv = toCsv(model, { columns, label: 'Search terms', currencyCode: 'EUR' }).csv;
    const dataLines = csv.trimEnd().split('\n').slice(2);

    expect(csv).not.toContain('€');
    // The header row carries "ACOS Δ%" as a label; no *value* is percent-formatted.
    expect(dataLines.join('\n')).not.toContain('%');
    const firstDataLine = csv.split('\n')[2] as string;
    const acos = firstDataLine.split(',')[3];
    // A fraction, not "24.3%": the value the pipeline holds, unchanged.
    expect(Number(acos)).toBeLessThan(10);
  });

  it('states the period, the currency and the counts on the first line', () => {
    const model = buildGridModel(syntheticSearchTermRows(3, { seed: 2 }));
    const result = toCsv(model, {
      columns,
      label: 'Search terms',
      currencyCode: 'JPY',
      period: { start: '2026-07-01', end: '2026-07-31' },
      comparisonPeriod: { start: '2026-06-01', end: '2026-06-30' },
    });
    const header = result.csv.split('\n')[0] as string;
    expect(header).toContain('2026-07-01..2026-07-31');
    expect(header).toContain('2026-06-01..2026-06-30');
    expect(header).toContain('currency JPY');
    expect(header).toContain('3 of 3 source rows');
  });

  it('says so when the export is of grouped rows', () => {
    const model = buildGridModel(syntheticSearchTermRows(500, { seed: 4 }), {
      groupBy: ['campaign_name'],
    });
    const result = toCsv(model, { columns, label: 'Search terms', currencyCode: 'USD' });
    expect(result.csv.split('\n')[0]).toContain('recomputed from summed bases');
    expect(result.exported).toBe(model.shown);
    expect(result.total).toBe(500);
  });

  it('exports deepest nested groups only, so parent summaries cannot double-count totals', () => {
    const rows = syntheticSearchTermRows(3_597, { seed: 41 });
    const model = buildGridModel(rows, {
      groupBy: ['campaign_name', 'ad_group_name', 'match_type'],
    });
    const result = toCsv(model, {
      columns: nestedColumns,
      label: 'Search terms',
      currencyCode: 'USD',
    });
    const lines = result.csv.trimEnd().split('\n');
    const provenance = lines[0] as string;
    const headers = (lines[1] as string).split(',');
    const spendIndex = headers.indexOf('Spend');
    const exportedSpend = lines
      .slice(2)
      .reduce((sum, line) => sum + Number(line.split(',')[spendIndex]), 0);

    expect(model.exported).toBeLessThan(model.shown);
    expect(result.exported).toBe(model.exported);
    expect(lines).toHaveLength(model.exported + 2);
    expect(provenance).toContain('deepest groups');
    expect(provenance).toContain('parent summaries omitted');
    expect(provenance).toContain('campaign_name > ad_group_name > match_type');
    expect(exportedSpend).toBeCloseTo(model.totalsRow?.totals.spend ?? -1, 6);
  });

  it('escapes quotes, commas and newlines', () => {
    const model = buildGridModel([
      {
        id: 'x',
        dimensions: { search_term: 'say "hi", then\nleave' },
        totals: { impressions: 1, clicks: 1, spend: 1, sales: 1, orders: 1, units: 1 },
        comparison: null,
        currencyCode: 'USD',
      },
    ]);
    const csv = toCsv(model, { columns, label: 'x', currencyCode: 'USD' }).csv;
    expect(csv).toContain('"say ""hi"", then\nleave"');
  });

  it('names the file after the view and the day', () => {
    const model = buildGridModel(syntheticSearchTermRows(1, { seed: 1 }));
    const result = toCsv(model, { columns, label: 'Search terms', currencyCode: 'USD' });
    expect(result.filename).toMatch(/^openspell-search-terms-\d{4}-\d{2}-\d{2}\.csv$/);
  });
});
