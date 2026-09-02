import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureFactPartitions } from '@wizard-ads/db';
import { createTestDatabase, databaseAvailable } from '@wizard-ads/db/testing';
import type { TestDatabase } from '@wizard-ads/db/testing';
import { loadOptimizerCampaignFacts } from './optimizer-campaigns';

const available = await databaseAvailable();
const suite = available ? describe : describe.skip;

const PERIOD = { start: '2026-08-10', end: '2026-08-11' };
const COMPARISON = { start: '2026-08-08', end: '2026-08-09' };

suite('optimizer campaign fact aggregation', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileId: string;

  beforeAll(async () => {
    database = await createTestDatabase('wp100_optimizer_campaigns');
    const [org] = await database.sql<{ id: string }[]>`
      select app.seed_tenant_fixture(
        'wp100-optimizer',
        '00000000-0000-4000-8000-000000010000'::uuid
      ) as id
    `;
    orgId = org?.id ?? '';
    const [profile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgId} limit 1
    `;
    profileId = profile?.id ?? '';
    await ensureFactPartitions(database, '2026-08-01', 1);

    await database.sql`
      insert into public.campaigns
        (org_id, profile_id, amazon_id, ad_product, name, state, budget_amount, budget_type)
      values
        (${orgId}, ${profileId}, 'perf-sp', 'SP', 'Synthetic SP', 'enabled', 10, 'daily'),
        (${orgId}, ${profileId}, 'perf-sb', 'SB', 'Synthetic SB', 'paused', 20, 'daily'),
        (${orgId}, ${profileId}, 'perf-sd', 'SD', 'Synthetic SD', 'enabled', 30, 'daily'),
        (${orgId}, ${profileId}, 'perf-empty', 'SP', 'Synthetic empty', 'enabled', 40, 'daily'),
        (${orgId}, ${profileId}, 'perf-deleted', 'SP', 'Synthetic deleted', 'enabled', 50, 'daily')
    `;
    await database.sql`
      update public.campaigns set deleted_at = now()
       where org_id = ${orgId} and profile_id = ${profileId} and amazon_id = 'perf-deleted'
    `;

    await database.sql`
      insert into public.fact_sp_target_daily
        (org_id, profile_id, date, ad_product, campaign_id, ad_group_id, target_id,
         target_kind, match_type, impressions, clicks, cost, purchases_7d, sales_7d)
      values
        (${orgId}, ${profileId}, '2026-08-10', 'SP', 'perf-sp', 'sp-group', 'sp-one',
         'keyword', 'exact', 100, 10, 5, 1, 20),
        (${orgId}, ${profileId}, '2026-08-11', 'SP', 'perf-sp', 'sp-group', 'sp-two',
         'keyword', 'exact', 200, 20, 15, 2, 30),
        (${orgId}, ${profileId}, '2026-08-09', 'SP', 'perf-sp', 'sp-group', 'sp-one',
         'keyword', 'exact', 80, 8, 8, 1, 16)
    `;
    await database.sql`
      insert into public.fact_sb_daily
        (org_id, profile_id, date, campaign_id, ad_group_id,
         impressions, clicks, cost, purchases_7d, sales_7d)
      values
        (${orgId}, ${profileId}, '2026-08-10', 'perf-sb', 'sb-one', 300, 30, 12, 3, 60),
        (${orgId}, ${profileId}, '2026-08-10', 'perf-sb', 'sb-two', 150, 15, 8, 2, 40),
        (${orgId}, ${profileId}, '2026-08-08', 'perf-sb', 'sb-one', 100, 10, 4, 1, 20)
    `;
    await database.sql`
      insert into public.fact_sd_daily
        (org_id, profile_id, date, campaign_id, ad_group_id,
         impressions, clicks, cost, purchases_7d, sales_7d)
      values
        (${orgId}, ${profileId}, '2026-08-11', 'perf-sd', 'sd-one', 500, 25, 25, 5, 100),
        (${orgId}, ${profileId}, '2026-08-08', 'perf-sd', 'sd-one', 120, 6, 6, 1, 24),
        (${orgId}, ${profileId}, '2026-08-09', 'perf-sd', 'sd-two', 180, 9, 9, 2, 36)
    `;
  }, 120_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('preserves exact SP, SB, and SD current/comparison metrics after source pre-aggregation', async () => {
    const rows = await loadOptimizerCampaignFacts(database, {
      orgId,
      profileId,
      period: PERIOD,
      comparison: COMPARISON,
    });
    const byId = new Map(rows.map((row) => [row.campaignId, row]));

    expect(byId.get('perf-sp')).toMatchObject({
      adProduct: 'SP',
      currentRows: 2,
      impressions: 300,
      clicks: 30,
      spend: 20,
      sales: 50,
      orders: 3,
      comparisonRows: 1,
      comparisonSpend: 8,
    });
    expect(byId.get('perf-sb')).toMatchObject({
      adProduct: 'SB',
      currentRows: 2,
      impressions: 450,
      clicks: 45,
      spend: 20,
      sales: 100,
      orders: 5,
      comparisonRows: 1,
      comparisonSpend: 4,
    });
    expect(byId.get('perf-sd')).toMatchObject({
      adProduct: 'SD',
      currentRows: 1,
      impressions: 500,
      clicks: 25,
      spend: 25,
      sales: 100,
      orders: 5,
      comparisonRows: 2,
      comparisonSpend: 15,
    });
    expect(byId.get('perf-empty')).toMatchObject({
      currentRows: 0,
      impressions: 0,
      clicks: 0,
      spend: 0,
      sales: 0,
      orders: 0,
      comparisonRows: 0,
      comparisonSpend: 0,
    });
    expect(byId.get('perf-deleted')).toMatchObject({
      state: 'deleted',
      currentRows: 0,
      spend: 0,
    });

    expect([...byId.keys()]).toEqual(expect.arrayContaining([
      'perf-sp',
      'perf-sb',
      'perf-sd',
      'perf-empty',
      'perf-deleted',
    ]));
  });
});
