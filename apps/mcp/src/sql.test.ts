/**
 * The builder's contract, without a database: what it refuses, and what it
 * always emits no matter what it was asked for.
 */
import { describe, expect, it } from 'vitest';
import { ToolError } from './errors.js';
import { buildFactQuery } from './sql.js';
import type { FactQuerySpec } from './sql.js';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const PROFILE = '00000000-0000-4000-8000-0000000000b1';

const spec = (overrides: Partial<FactQuerySpec> = {}): FactQuerySpec => ({
  level: 'keyword',
  orgId: ORG,
  profileId: PROFILE,
  window: { from: '2026-08-01', to: '2026-08-07' },
  grain: 'period',
  limit: 100,
  ...overrides,
});

describe('the profile predicate', () => {
  it('is on every statement, at every level, whatever else was asked for', () => {
    for (const level of ['campaign', 'ad_group', 'keyword', 'target', 'search_term', 'placement', 'product', 'profile'] as const) {
      const built = buildFactQuery(spec({ level }));
      expect(built.text, level).toContain('f.profile_id = $2::uuid');
      expect(built.text, level).toContain('f.org_id = $1::uuid');
      expect(built.params[0]).toBe(ORG);
      expect(built.params[1]).toBe(PROFILE);
    }
  });

  it('repeats it on the comparison window too', () => {
    const built = buildFactQuery(
      spec({ compare: { from: '2026-07-25', to: '2026-07-31' } }),
    );
    const occurrences = built.text.match(/profile_id = \$\d+::uuid/g) ?? [];
    expect(occurrences.length).toBe(2);
  });
});

describe('the whitelist', () => {
  it('refuses a dimension the level does not have', () => {
    expect(() => buildFactQuery(spec({ dimensions: ['campaign_name; drop table orgs'] }))).toThrow(
      ToolError,
    );
  });

  it('refuses an unknown metric', () => {
    expect(() => buildFactQuery(spec({ metrics: ['margin' as never] }))).toThrow(/unknown metric/);
  });

  it('refuses a metric the level does not report, and says why', () => {
    expect(() => buildFactQuery(spec({ level: 'placement', metrics: ['units'] }))).toThrow(
      /property of the report/,
    );
  });

  it('refuses a filter key that is not a column at all', () => {
    expect(() =>
      buildFactQuery(spec({ filters: [{ key: 'SECRET', operator: '=', values: ['1'] }] })),
    ).toThrow(/no filter key/);
  });

  it('refuses a sort column that is not a column at all', () => {
    expect(() =>
      buildFactQuery(spec({ sort: [{ column: 'profit', direction: 'desc' }] })),
    ).toThrow(/cannot sort by/);
  });

  it('selects a column a filter or a sort names, rather than making the caller repeat it', () => {
    const built = buildFactQuery(
      spec({
        metrics: ['spend'],
        filters: [{ key: 'CAMPAIGN_STATE', operator: '=', values: ['enabled'] }],
        sort: [{ column: 'acos', direction: 'desc' }],
      }),
    );
    const names = built.columns.map((column) => column.name);
    expect(names).toContain('campaign_state');
    expect(names).toContain('acos');
  });

  it('refuses an unknown operator', () => {
    expect(() =>
      buildFactQuery(spec({ filters: [{ key: 'SPEND', operator: ';--' as never, values: ['1'] }] })),
    ).toThrow(/unknown filter operator/);
  });
});

describe('values', () => {
  it('binds every filter value as a parameter, never as text in the statement', () => {
    const nasty = "'; drop table public.orgs; --";
    const built = buildFactQuery(
      spec({ filters: [{ key: 'CAMPAIGN_NAME', operator: 'LIKE', values: [nasty] }] }),
    );
    expect(built.text).not.toContain('drop table');
    expect(built.params).toContain(nasty);
  });

  it('rejects a non-numeric value on a numeric column', () => {
    expect(() =>
      buildFactQuery(spec({ filters: [{ key: 'SPEND', operator: '>', values: ['lots'] }] })),
    ).toThrow(/expected a number/);
  });

  it('requires exactly one value for a scalar comparison', () => {
    expect(() =>
      buildFactQuery(spec({ filters: [{ key: 'SPEND', operator: '>', values: ['1', '2'] }] })),
    ).toThrow(/exactly one value/);
  });
});

describe('shape', () => {
  it('emits the four-column model only when a comparison window is given', () => {
    const plain = buildFactQuery(spec({ metrics: ['spend'] }));
    expect(plain.columns.map((column) => column.name)).toEqual(['target_id', 'spend']);

    const compared = buildFactQuery(
      spec({ metrics: ['spend'], compare: { from: '2026-07-25', to: '2026-07-31' } }),
    );
    expect(compared.columns.map((column) => column.name)).toEqual([
      'target_id',
      'spend',
      'spend_comparison',
      'spend_delta_absolute',
      'spend_delta_percent',
    ]);
  });

  it('adds date to a daily-grain query even when it was not asked for', () => {
    const built = buildFactQuery(spec({ grain: 'daily', metrics: ['clicks'] }));
    expect(built.columns.map((column) => column.name)).toContain('date');
    expect(built.text).not.toContain('group by');
  });

  it('always joins the ASIN map at the product level', () => {
    const built = buildFactQuery(spec({ level: 'product', metrics: ['spend'] }));
    expect(built.text).toContain('count(distinct asin) = 1');
  });

  it('keeps a level-defining predicate that the caller cannot remove', () => {
    expect(buildFactQuery(spec({ level: 'keyword' })).text).toContain("f.target_kind = 'keyword'");
    expect(buildFactQuery(spec({ level: 'target' })).text).toContain("f.target_kind = 'target'");
  });

  it('refuses ACOS_TO_TARGET when the profile has no target', () => {
    expect(() =>
      buildFactQuery(spec({ filters: [{ key: 'ACOS_TO_TARGET', operator: '>=', values: ['1.1'] }] })),
    ).toThrow(/target ACOS/);
  });

  it('accepts ACOS_TO_TARGET when the profile has one', () => {
    const built = buildFactQuery(
      spec({
        targetAcos: 0.25,
        filters: [{ key: 'ACOS_TO_TARGET', operator: '>=', values: ['1.1'] }],
      }),
    );
    expect(built.text).toContain('acos / 0.25');
  });
});
