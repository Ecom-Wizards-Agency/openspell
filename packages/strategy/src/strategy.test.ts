/**
 * Strategy resolution tests.
 *
 * The two that matter most are the merge-order test, because six packages will
 * read whatever this resolver decides, and the "no numbers in the repository"
 * test, because that rule is invisible to the type system and easy to break
 * with one well-meaning default.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TENANT_STRATEGY_SCHEMA } from '@wizard-ads/shared';

import { GOAL_LENS_STRATEGIES, NEUTRAL_DEFAULTS } from './defaults.js';
import { loadStrategy, staticLoader } from './loader.js';
import { mergeLayers } from './merge.js';
import {
  changeCapsFor,
  cutOnAcosAlone,
  layerOf,
  optGroup,
  parseTenantStrategy,
  resolveStrategy,
  targetAcosFor,
} from './resolve.js';

/** A synthetic tenant document. Every number here is invented for this test. */
const TENANT = {
  schema: TENANT_STRATEGY_SCHEMA,
  pacing: { monthly_budget: 1000, run_rate_tolerance: 0.2, lookback_days: 30 },
  opt_groups: {
    rank: { target_acos: 0.5, max_increase: 0.25, max_decrease: 0.25 },
    profit: { target_acos: 0.2, max_increase: 0.1, max_decrease: 0.5, cut_on_acos_alone: true },
  },
  rank_lifecycle: { source: 'rank_radar' as const, graduation_rank: 3, dwell_days: 14 },
  staged_apply: { cooldown_days: 7, max_rows_per_batch: 50 },
  bids: { start_bid_pct_of_recommended: -20 },
  sv_bands: { rank_skw: { min: 500, max: 5000, severity_outside: 'warn' as const } },
  caps: { max_bid_increase: 0.15, max_bid_decrease: 0.3, max_placement_increase: 0.33 },
  pat_split: { method: 'median_revenue' as const },
  naming: { delimiter: ' | ' },
};

describe('neutral defaults', () => {
  it('validate against the frozen contract', () => {
    expect(() => parseTenantStrategy(NEUTRAL_DEFAULTS)).not.toThrow();
  });

  it('carry method and not numbers', () => {
    const numbers: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (typeof node === 'number') numbers.push(path);
      else if (Array.isArray(node)) node.forEach((v, i) => walk(v, `${path}[${i}]`));
      else if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
      }
    };
    walk(NEUTRAL_DEFAULTS, '');
    expect(numbers).toEqual([]);
  });

  it('state the fixed cut order, which is method rather than a threshold', () => {
    expect(NEUTRAL_DEFAULTS.pacing.cut_order).toEqual(['waste', 'discovery', 'profit', 'rank']);
  });
});

describe('merge order', () => {
  it('applies defaults, then goal lens, then tenant, then profile', () => {
    const merged = mergeLayers<{ a: number; b: number; c: number; d: number }>([
      ['defaults', { a: 1, b: 1, c: 1, d: 1 }],
      ['goal_lens', { b: 2, c: 2, d: 2 }],
      ['tenant', { c: 3, d: 3 }],
      ['profile', { d: 4 }],
    ]);
    expect(merged.value).toEqual({ a: 1, b: 2, c: 3, d: 4 });
    expect(merged.provenance).toEqual({ a: 'defaults', b: 'goal_lens', c: 'tenant', d: 'profile' });
  });

  it('merges leaf by leaf, so one override does not erase a section', () => {
    const resolved = resolveStrategy({
      tenant: TENANT,
      profile: { opt_groups: { profit: { target_acos: 0.15 } } },
    });
    expect(targetAcosFor(resolved.value, 'profit')).toBe(0.15);
    // The rest of the profit group, and the whole rank group, survive.
    expect(optGroup(resolved.value, 'profit')?.max_decrease).toBe(0.5);
    expect(targetAcosFor(resolved.value, 'rank')).toBe(0.5);
    expect(layerOf(resolved.provenance, 'opt_groups.profit.target_acos')).toBe('profile');
    expect(layerOf(resolved.provenance, 'opt_groups.rank.target_acos')).toBe('tenant');
  });

  it('replaces an array wholesale rather than concatenating it', () => {
    const resolved = resolveStrategy({
      tenant: { ...TENANT, pacing: { ...TENANT.pacing, cut_order: ['waste', 'discovery'] } },
    });
    expect(resolved.value.pacing.cut_order).toEqual(['waste', 'discovery']);
  });

  it('lets an explicit null override a default, unlike an absent key', () => {
    const resolved = resolveStrategy({ tenant: { ...TENANT, pacing: { monthly_budget: null } } });
    expect(resolved.value.pacing.monthly_budget).toBeNull();
    // The default cut order is still there: absence never overwrites.
    expect(resolved.value.pacing.cut_order).toEqual(['waste', 'discovery', 'profit', 'rank']);
  });
});

describe('goal lens layer', () => {
  it('protects declared groups from ACOS-only cuts under a rank-launch goal', () => {
    const resolved = resolveStrategy({ goal: 'rank-launch', tenant: TENANT });
    expect(cutOnAcosAlone(resolved.value, 'rank')).toBe(false);
    // The tenant said `true` for profit, and the tenant outranks the lens.
    expect(cutOnAcosAlone(resolved.value, 'profit')).toBe(true);
    expect(layerOf(resolved.provenance, 'opt_groups.rank.cut_on_acos_alone')).toBe('goal_lens');
  });

  it('never invents an opt group the tenant has not declared', () => {
    const resolved = resolveStrategy({ goal: 'rank-launch' });
    expect(Object.keys(resolved.value.opt_groups)).toEqual([]);
  });

  it('falls back to the neutral lens for an unknown goal', () => {
    expect(resolveStrategy({ goal: 'not-a-real-goal', tenant: TENANT }).goal).toBe('neutral');
    expect(Object.keys(GOAL_LENS_STRATEGIES)).toContain('neutral');
  });
});

describe('accessors', () => {
  it('return null rather than a default when a tenant has not stated a value', () => {
    const resolved = resolveStrategy({ tenant: TENANT });
    expect(targetAcosFor(resolved.value, 'nonexistent-group')).toBeNull();
    expect(optGroup(resolved.value, 'nonexistent-group')).toBeNull();
  });

  it('take group caps first and fall back to the document-wide caps', () => {
    const resolved = resolveStrategy({ tenant: TENANT });
    expect(changeCapsFor(resolved.value, 'rank')).toEqual({
      maxIncrease: 0.25,
      maxDecrease: 0.25,
      maxPlacementIncrease: 0.33,
    });
    expect(changeCapsFor(resolved.value, 'unstated')).toEqual({
      maxIncrease: 0.15,
      maxDecrease: 0.3,
      maxPlacementIncrease: 0.33,
    });
  });

  it('report no caps at all when neither level states them', () => {
    const resolved = resolveStrategy({
      tenant: { ...TENANT, caps: {} },
    });
    expect(changeCapsFor(resolved.value, 'unstated')).toBeNull();
  });

  it('treat a missing cut_on_acos_alone as no, the protective reading', () => {
    const resolved = resolveStrategy({ tenant: TENANT });
    expect(cutOnAcosAlone(resolved.value, 'rank')).toBe(false);
  });
});

describe('validation', () => {
  it('rejects a document whose placeholders were never filled in', () => {
    expect(() =>
      resolveStrategy({ tenant: { ...TENANT, pacing: { run_rate_tolerance: '<fraction>' } } }),
    ).toThrow();
  });

  it('rejects a document carrying the wrong schema id', () => {
    expect(() => parseTenantStrategy({ ...TENANT, schema: 'something.else.v1' })).toThrow();
  });
});

describe('loader seam', () => {
  it('composes a loader with the resolver without the package doing any I/O', async () => {
    const resolved = await loadStrategy(
      staticLoader({ tenant: TENANT, profile: { caps: { max_bid_increase: 0.05 } } }),
      { orgId: 'org-1', profileId: 'profile-1', goal: 'defend' },
    );
    expect(resolved.value.caps.max_bid_increase).toBe(0.05);
    expect(resolved.goal).toBe('defend');
    expect(layerOf(resolved.provenance, 'caps.max_bid_increase')).toBe('profile');
  });

  it('resolves to the defaults when nothing is seeded', async () => {
    const resolved = await loadStrategy(staticLoader({}), { orgId: 'org-1', profileId: 'profile-1' });
    expect(resolved.value.schema).toBe(TENANT_STRATEGY_SCHEMA);
    expect(resolved.value.opt_groups).toEqual({});
  });
});

describe('the tracked template ships no doctrine values', () => {
  const templatePath = fileURLToPath(new URL('../../../_local/strategy.TEMPLATE.json', import.meta.url));

  it('exists and parses', () => {
    const raw = JSON.parse(readFileSync(templatePath, 'utf8')) as Record<string, unknown>;
    expect(raw['schema']).toBe(TENANT_STRATEGY_SCHEMA);
  });

  it('contains no numeric leaf outside the keys that are structure', () => {
    const raw = JSON.parse(readFileSync(templatePath, 'utf8')) as unknown;
    const numbers: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (typeof node === 'number') numbers.push(path);
      else if (Array.isArray(node)) node.forEach((v, i) => walk(v, `${path}[${i}]`));
      else if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
      }
    };
    walk(raw, '');
    // A filled-in threshold in the tracked template is a doctrine leak, and it
    // is exactly the kind that survives review because the file looks like an
    // example.
    expect(numbers).toEqual([]);
  });
});
