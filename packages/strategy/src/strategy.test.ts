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

/**
 * The WP-00.1 widening, seen from the resolver.
 *
 * The contract tests prove the new keys parse; these prove they survive the
 * thing that actually happens to them in production, which is a four-layer
 * merge, and that a document written before the widening still resolves.
 */
describe('the widened contract, through the resolver', () => {
  const WIDENED = {
    ...TENANT,
    pacing: {
      ...TENANT.pacing,
      warn_above: 1.1,
      act_above: 1.2,
      underpace_below: 0.8,
      rank_cut_requires_operator: true,
    },
    opt_groups: {
      ...TENANT.opt_groups,
      rank: {
        ...TENANT.opt_groups.rank,
        preset: 'synthetic-preset',
        bid_floor_unit: 'absolute' as const,
        bid_floor_value: 0.3,
        bid_ceiling_unit: 'times_cpc' as const,
        bid_ceiling_value: 2,
        placement_max_decrease: 0.4,
        placement_max_increase: 0.4,
        spend_share_max: 0.6,
        tacos_x_breakeven: 1.5,
        tacos_x_breakeven_min: 1.2,
        tacos_x_breakeven_max: 1.8,
      },
    },
    rank_lifecycle: {
      ...TENANT.rank_lifecycle,
      graduate_weeks_stable: 2,
      stepdown_cycles_min: 1,
      stepdown_cycles_max: 3,
      regression_reescalate: 'synthetic-stage',
    },
    staged_apply: {
      ...TENANT.staged_apply,
      max_batches_per_run: 2,
      cooldown_bypasses: ['waste-cut'],
      tag_format: 'synthetic-{run}',
      push_rank_min_days: 5,
      priority_order: ['waste-cut', 'bid-down'],
      group_cadence: { rank: 'synthetic-cadence' },
      batch_unit: 'rows',
    },
    discovery: { min_root_words: 2 },
    expanded_candidate_filter: { min_relevancy: 0.5, max_sv: 1000 },
  };

  it('resolves a document that uses every new field', () => {
    const resolved = resolveStrategy({ tenant: WIDENED });
    const rank = optGroup(resolved.value, 'rank');
    expect(rank?.bid_ceiling_unit).toBe('times_cpc');
    expect(rank?.bid_ceiling_value).toBe(2);
    expect(rank?.bid_floor_unit).toBe('absolute');
    expect(rank?.placement_max_decrease).toBe(0.4);
    expect(rank?.spend_share_max).toBe(0.6);
    expect(rank?.tacos_x_breakeven_min).toBe(1.2);
    expect(resolved.value.pacing.act_above).toBe(1.2);
    expect(resolved.value.pacing.rank_cut_requires_operator).toBe(true);
    expect(resolved.value.rank_lifecycle.graduate_weeks_stable).toBe(2);
    expect(resolved.value.staged_apply.group_cadence).toEqual({ rank: 'synthetic-cadence' });
    expect(resolved.value.discovery?.min_root_words).toBe(2);
    expect(resolved.value.expanded_candidate_filter?.max_sv).toBe(1000);
  });

  it('lets a profile override one new leaf without losing its siblings', () => {
    const resolved = resolveStrategy({
      tenant: WIDENED,
      profile: { opt_groups: { rank: { bid_ceiling_value: 3 } } },
    });
    const rank = optGroup(resolved.value, 'rank');
    expect(rank?.bid_ceiling_value).toBe(3);
    expect(rank?.bid_ceiling_unit).toBe('times_cpc');
    expect(layerOf(resolved.provenance, 'opt_groups.rank.bid_ceiling_value')).toBe('profile');
    expect(layerOf(resolved.provenance, 'opt_groups.rank.bid_ceiling_unit')).toBe('tenant');
  });

  it('still resolves a document written before the widening', () => {
    const resolved = resolveStrategy({ tenant: TENANT });
    expect(resolved.value.discovery).toBeUndefined();
    expect(resolved.value.expanded_candidate_filter).toBeUndefined();
    expect(resolved.value.pacing.run_rate_tolerance).toBe(0.2);
    expect(optGroup(resolved.value, 'rank')?.bid_ceiling_unit).toBeUndefined();
  });

  it('rejects a bid-bound unit outside the vocabulary', () => {
    expect(() =>
      resolveStrategy({
        tenant: {
          ...WIDENED,
          opt_groups: { rank: { ...WIDENED.opt_groups.rank, bid_ceiling_unit: 'furlongs' } },
        },
      }),
    ).toThrow();
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

  /**
   * Structure yes, numbers no. The template is how an operator discovers that a
   * field exists at all, so a widened contract with an unwidened template is a
   * field nobody will ever fill in.
   */
  it('declares every section and key the WP-00.1 widening added', () => {
    const raw = JSON.parse(readFileSync(templatePath, 'utf8')) as Record<string, never>;
    const at = (path: string): unknown =>
      path.split('.').reduce<unknown>((node, key) => (node as Record<string, unknown>)?.[key], raw);

    const group = '<your-group-name>';
    const added = [
      'discovery.min_root_words',
      'expanded_candidate_filter.min_relevancy',
      'expanded_candidate_filter.max_sv',
      'pacing.warn_above',
      'pacing.act_above',
      'pacing.underpace_below',
      'pacing.rank_cut_requires_operator',
      'pacing.run_rate_tolerance',
      `opt_groups.${group}.bid_floor_unit`,
      `opt_groups.${group}.bid_floor_value`,
      `opt_groups.${group}.bid_ceiling_unit`,
      `opt_groups.${group}.bid_ceiling_value`,
      `opt_groups.${group}.placement_max_decrease`,
      `opt_groups.${group}.spend_share_max`,
      `opt_groups.${group}.preset`,
      `opt_groups.${group}.tacos_x_breakeven`,
      `opt_groups.${group}.tacos_x_breakeven_min`,
      `opt_groups.${group}.tacos_x_breakeven_max`,
      'rank_lifecycle.graduate_weeks_stable',
      'rank_lifecycle.stepdown_cycles_min',
      'rank_lifecycle.stepdown_cycles_max',
      'rank_lifecycle.regression_reescalate',
      'staged_apply.max_batches_per_run',
      'staged_apply.cooldown_bypasses',
      'staged_apply.tag_format',
      'staged_apply.push_rank_min_days',
      'staged_apply.priority_order',
      'staged_apply.group_cadence',
      'staged_apply.batch_unit',
    ];
    expect(added.filter((path) => at(path) === undefined)).toEqual([]);
  });

  it('states the unit on both rank-lifecycle durations', () => {
    const raw = JSON.parse(readFileSync(templatePath, 'utf8')) as {
      rank_lifecycle: Record<string, string>;
    };
    expect(raw.rank_lifecycle['dwell_days']).toContain('DAYS');
    expect(raw.rank_lifecycle['graduate_weeks_stable']).toContain('WEEKS');
  });
});
