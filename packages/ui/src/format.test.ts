import { describe, expect, it } from 'vitest';
import { columnsFor, defaultVisibleColumns, metricColumns } from './columns.js';
import { EMPTY_CELL, formatDelta, formatValue } from './format.js';
import { METRIC_SPECS, deriveMetric, safeRatio } from './metrics.js';
import { resolveField } from './rows.js';
import type { GridRow } from './rows.js';

const usd = { currencyCode: 'USD' };

describe('formatValue', () => {
  it('renders an absent value as an em dash, never as zero', () => {
    expect(formatValue(null, 'money', usd)).toBe(EMPTY_CELL);
    expect(formatValue(undefined, 'percent', usd)).toBe(EMPTY_CELL);
    expect(formatValue('', 'text', usd)).toBe(EMPTY_CELL);
    expect(formatValue(0, 'money', usd)).not.toBe(EMPTY_CELL);
  });

  it('renders a percent from the stored fraction', () => {
    // The 2430% bug: a fraction rendered as if it were already a percent.
    expect(formatValue(0.243, 'percent', usd)).toBe('24.3%');
  });

  it('renders money in the profile currency, not a locale default', () => {
    expect(formatValue(1234.5, 'money', { currencyCode: 'USD' })).toContain('$');
    expect(formatValue(1234.5, 'money', { currencyCode: 'EUR' })).toContain('€');
    expect(formatValue(1234.5, 'money', { currencyCode: 'JPY' })).toContain('¥');
  });

  it('takes scale from the column, not from the number', () => {
    expect(formatValue(2.5, 'ratio', usd)).toBe('2.50');
    expect(formatValue(2.5, 'percent', usd)).toBe('250.0%');
    expect(formatValue(2.5, 'integer', usd)).toBe('3');
  });

  it('renders a non-finite number as absent rather than as "Infinity"', () => {
    expect(formatValue(Number.POSITIVE_INFINITY, 'money', usd)).toBe(EMPTY_CELL);
    expect(formatValue(Number.NaN, 'percent', usd)).toBe(EMPTY_CELL);
  });
});

describe('locale independence', () => {
  /**
   * Regression guard for a hydration failure found in a real browser: the grid
   * footer used a bare `toLocaleString()`, so Node rendered "50,000" and a
   * German browser rendered "50.000", and React threw the whole subtree away.
   * Every user-visible number in this package has to come out of `format.ts`.
   */
  it('never uses a bare toLocaleString on a rendered number', async () => {
    const { readFile, readdir } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const root = fileURLToPath(new URL('.', import.meta.url));

    const offenders: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = `${dir}${entry.name}`;
        if (entry.isDirectory()) await walk(`${path}/`);
        // `format.ts` names the API in its own comment explaining why nothing
        // else may call it. It uses `Intl.NumberFormat` with an explicit locale.
        else if (/\.tsx?$/.test(entry.name) && !entry.name.includes('.test.') && entry.name !== 'format.ts') {
          const source = await readFile(path, 'utf8');
          if (source.includes('toLocaleString(')) offenders.push(entry.name);
        }
      }
    };
    await walk(root);

    expect(offenders).toEqual([]);
  });

  it('formats the same on any runtime default, because the locale is explicit', () => {
    expect(formatValue(50_000, 'integer', usd)).toBe('50,000');
    expect(formatValue(50_000, 'integer', { ...usd, locale: 'de-DE' })).toBe('50.000');
  });
});

describe('formatDelta', () => {
  it('signs every non-zero delta so +3% and -3% never look alike', () => {
    expect(formatDelta(0.03, 'percent', usd)).toBe('+3.0%');
    expect(formatDelta(-0.03, 'percent', usd)).toBe('−3.0%');
    expect(formatDelta(0, 'percent', usd)).toBe('0.0%');
    expect(formatDelta(null, 'percent', usd)).toBe(EMPTY_CELL);
  });
});

describe('safeRatio', () => {
  it('is null on a zero denominator, never zero and never Infinity', () => {
    expect(safeRatio(5, 0)).toBeNull();
    expect(safeRatio(0, 0)).toBeNull();
    expect(safeRatio(0, 5)).toBe(0);
  });
});

describe('the four-column metric model', () => {
  const row: GridRow = {
    id: 'r',
    dimensions: {},
    totals: { impressions: 1000, clicks: 50, spend: 40, sales: 100, orders: 5, units: 5 },
    comparison: { impressions: 800, clicks: 40, spend: 20, sales: 80, orders: 4, units: 4 },
    currencyCode: 'USD',
  };

  it('gives every metric exactly four columns', () => {
    for (const spec of METRIC_SPECS) {
      const columns = metricColumns(spec.key);
      expect(columns.map((column) => column.id)).toEqual([
        spec.key,
        `${spec.key}_comparison`,
        `${spec.key}_delta_absolute`,
        `${spec.key}_delta_percent`,
      ]);
    }
  });

  it('resolves all four parts consistently', () => {
    expect(resolveField(row, 'acos')).toBeCloseTo(0.4, 12);
    expect(resolveField(row, 'acos_comparison')).toBeCloseTo(0.25, 12);
    expect(resolveField(row, 'acos_delta_absolute')).toBeCloseTo(0.15, 12);
    // One convention everywhere: delta_percent is a fraction. 0.4 vs 0.25 = +60%.
    expect(resolveField(row, 'acos_delta_percent')).toBeCloseTo(0.6, 12);
  });

  it('nulls every delta when there is no comparison row, rather than treating it as zero', () => {
    const noComparison = { ...row, comparison: null };
    expect(resolveField(noComparison, 'acos_comparison')).toBeNull();
    expect(resolveField(noComparison, 'acos_delta_absolute')).toBeNull();
    expect(resolveField(noComparison, 'acos_delta_percent')).toBeNull();
  });

  it('reads an unknown column as absent rather than throwing', () => {
    expect(resolveField(row, 'not_a_column')).toBeNull();
    expect(deriveMetric('not_a_metric', row.totals)).toBeNull();
  });
});

describe('column sets', () => {
  it.each(['campaigns', 'ad_groups', 'targets', 'search_terms', 'placements'] as const)(
    '%s has unique column ids and every default is one of them',
    (level) => {
      const columns = columnsFor(level);
      const ids = columns.map((column) => column.id);
      expect(new Set(ids).size).toBe(ids.length);

      const available = new Set(ids);
      for (const id of defaultVisibleColumns(level)) expect(available.has(id)).toBe(true);
    },
  );

  it('uses one name for one concept: match_type is singular on every level that has it', () => {
    for (const level of ['targets', 'search_terms'] as const) {
      const ids = columnsFor(level).map((column) => column.id);
      expect(ids).toContain('match_type');
      expect(ids).not.toContain('match_types');
    }
  });

  it('pins the identifying column on every level', () => {
    for (const level of ['campaigns', 'ad_groups', 'targets', 'search_terms', 'placements'] as const) {
      expect(columnsFor(level).filter((column) => column.pinned)).toHaveLength(1);
    }
  });
});
