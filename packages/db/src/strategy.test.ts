/**
 * Doctrine storage and the staged-apply cooldown.
 *
 * Every value in this file is synthetic. The operator's real strategy document
 * is confidential and lives in a gitignored local file; what is tested here is
 * the shape, the resolution order, and the refusal to accept a document that
 * does not validate.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyCooldownConflicts,
  parseStrategyDocument,
  resolveStrategy,
  upsertStrategy,
} from './queries/profiles.js';
import { createTestDatabase, databaseAvailable } from './testing/harness.js';
import type { TestDatabase } from './testing/harness.js';

const available = await databaseAvailable();
const USER = '77777777-7777-4777-8777-777777777777';

/** A complete, synthetic doctrine document. Not anybody's numbers. */
const SYNTHETIC_STRATEGY = {
  schema: 'wizard-ads.tenant-strategy.v1',
  refreshed_at: '2026-08-13',
  pacing: { cut_order: ['waste', 'discovery', 'profit', 'rank'], run_rate_tolerance: 0.1 },
  opt_groups: {
    'test-group': { target_acos: 0.25, max_increase: 0.2, max_decrease: 0.3, goal_lens: 'profit' },
  },
  rank_lifecycle: { source: 'manual', graduation_rank: 10, dwell_days: 14 },
  staged_apply: { cooldown_days: 7, max_rows_per_batch: 50, require_snapshot: true },
  bids: { start_bid_pct_of_recommended: -20 },
  sv_bands: { rank_skw: { min: 100, max: 10_000, severity_outside: 'warn' } },
  caps: { max_bid_increase: 0.25, max_bid_decrease: 0.5 },
  pat_split: { method: 'median_revenue' },
  naming: { delimiter: ' | ', skw_mode: true },
} as const;

describe.skipIf(!available)('strategy and cooldown', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileId: string;

  beforeAll(async () => {
    database = await createTestDatabase('strategy');
    const [org] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('strategy', ${USER}, 'owner')
    `;
    orgId = org?.seed_tenant_fixture ?? '';
    const [profile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgId} limit 1
    `;
    profileId = profile?.id ?? '';
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('rejects a document that does not match the contract', () => {
    expect(() => parseStrategyDocument({ ...SYNTHETIC_STRATEGY, opt_groups: 'nope' })).toThrow();
    // The template ships placeholders where numbers belong, so seeding it by
    // mistake fails at the contract rather than producing meaningless advice.
    expect(() =>
      parseStrategyDocument({
        ...SYNTHETIC_STRATEGY,
        caps: { max_bid_increase: '<fraction>' },
      }),
    ).toThrow();
  });

  it('stores an org default and reads it back through the contract', async () => {
    await upsertStrategy(database, { orgId, profileId: null, doc: SYNTHETIC_STRATEGY });
    const resolved = await resolveStrategy(database, orgId, profileId);
    expect(resolved?.opt_groups['test-group']?.target_acos).toBe(0.25);
  });

  it('prefers a profile override over the org default', async () => {
    await upsertStrategy(database, {
      orgId,
      profileId,
      doc: {
        ...SYNTHETIC_STRATEGY,
        opt_groups: { 'test-group': { ...SYNTHETIC_STRATEGY.opt_groups['test-group'], target_acos: 0.4 } },
      },
    });

    const forProfile = await resolveStrategy(database, orgId, profileId);
    expect(forProfile?.opt_groups['test-group']?.target_acos).toBe(0.4);

    const orgDefault = await resolveStrategy(database, orgId, null);
    expect(orgDefault?.opt_groups['test-group']?.target_acos).toBe(0.25);
  });

  it('upserts rather than accumulating rows for one scope', async () => {
    await upsertStrategy(database, { orgId, profileId: null, doc: SYNTHETIC_STRATEGY });
    const [row] = await database.sql<{ n: string }[]>`
      select count(*) as n from public.profile_strategy
      where org_id = ${orgId} and profile_id is null
    `;
    expect(Number(row?.n)).toBe(1);
  });

  describe('cooldown', () => {
    it('reports entities an applied batch touched inside the window', async () => {
      // The fixture applied a batch today touching keyword:kw-1.
      const conflicts = await applyCooldownConflicts(database, profileId, [
        'keyword:kw-1',
        'keyword:kw-untouched',
      ]);

      expect(conflicts.map((row) => row.entityKey)).toEqual(['keyword:kw-1']);
      expect(conflicts[0]?.daysAgo).toBe(0);
      expect(conflicts[0]?.batchTag).toContain('strategy-');
    });

    it('lets an entity go once the cooldown has passed', async () => {
      await database.sql`
        update public.apply_batches set applied_on = current_date - 10
         where org_id = ${orgId} and tag like 'strategy-%-rank-bid-down'
      `;
      const conflicts = await applyCooldownConflicts(database, profileId, ['keyword:kw-1'], 7);
      expect(conflicts).toEqual([]);
    });

    it('ignores batches that were staged but never applied', async () => {
      await database.sql`
        update public.apply_batches set status = 'staged', applied_on = current_date
        where org_id = ${orgId} and tag like 'strategy-%-rank-bid-down'
      `;
      const conflicts = await applyCooldownConflicts(database, profileId, ['keyword:kw-1']);
      expect(conflicts).toEqual([]);
    });
  });
});
