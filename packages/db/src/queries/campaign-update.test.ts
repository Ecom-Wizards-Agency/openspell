/** WP-50's synced-state boundary, against a migrated database. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable } from '../testing/harness.js';
import type { TestDatabase } from '../testing/harness.js';
import { loadCampaignUpdateEntities } from './campaign-update.js';

const available = await databaseAvailable();
const OWNER_A = '50505050-5050-4050-8050-505050505051';
const OWNER_B = '50505050-5050-4050-8050-505050505052';

describe.skipIf(!available)('WP-50 campaign UPDATE entity loader', () => {
  let database: TestDatabase;
  let orgA = '';
  let orgB = '';
  let profileA = '';
  let profileB = '';

  beforeAll(async () => {
    database = await createTestDatabase('wp50_campaign_update');
    const [a] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('wp50-update-alpha', ${OWNER_A}, 'owner')
    `;
    const [b] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('wp50-update-bravo', ${OWNER_B}, 'owner')
    `;
    orgA = a?.seed_tenant_fixture ?? '';
    orgB = b?.seed_tenant_fixture ?? '';
    const [pa] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgA} limit 1
    `;
    const [pb] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgB} limit 1
    `;
    profileA = pa?.id ?? '';
    profileB = pb?.id ?? '';

    // Replace the general seed entities with a shape that covers every UPDATE
    // loader branch and leaves the count assertion easy to audit.
    await database.sql`delete from public.negatives where profile_id = ${profileA}`;
    await database.sql`delete from public.targets where profile_id = ${profileA}`;
    await database.sql`delete from public.keywords where profile_id = ${profileA}`;
    await database.sql`delete from public.product_ads where profile_id = ${profileA}`;
    await database.sql`delete from public.ad_groups where profile_id = ${profileA}`;
    await database.sql`delete from public.campaigns where profile_id = ${profileA}`;

    await database.sql`
      insert into public.campaigns
        (org_id, profile_id, amazon_id, ad_product, name, state, portfolio_amazon_id,
         budget_amount, budget_type, targeting_type, bidding_strategy, placement_bidding,
         start_date, end_date)
      values
        (${orgA}, ${profileA}, '1001', 'SP', 'Synthetic campaign', 'enabled', '9001',
         20.00, 'daily', 'manual', 'legacy_for_sales',
         ${JSON.stringify({ topOfSearch: 25, productPages: 0, restOfSearch: null })}::text::jsonb,
         '2026-08-01', '2026-12-31'),
        (${orgA}, ${profileA}, '1002', 'SB', 'Wrong ad product', 'enabled', null,
         20.00, 'daily', 'manual', 'manual', null, null, null),
        (${orgA}, ${profileA}, '1003', 'SP', 'Deleted campaign', 'archived', null,
         20.00, 'daily', 'manual', 'manual', null, null, null)
    `;
    await database.sql`
      update public.campaigns set deleted_at = now()
       where profile_id = ${profileA} and amazon_id = '1003'
    `;
    await database.sql`
      insert into public.ad_groups
        (org_id, profile_id, amazon_id, ad_product, name, state, campaign_id, default_bid)
      values (${orgA}, ${profileA}, '2001', 'SP', 'Synthetic ad group', 'enabled', '1001', 1.25)
    `;
    await database.sql`
      insert into public.product_ads
        (org_id, profile_id, amazon_id, ad_product, name, state, campaign_id, ad_group_id, asin, sku)
      values (${orgA}, ${profileA}, '3001', 'SP', null, 'enabled', '1001', '2001',
              'B000000001', 'SKU-SYNTHETIC')
    `;
    await database.sql`
      insert into public.keywords
        (org_id, profile_id, amazon_id, ad_product, name, state, campaign_id, ad_group_id,
         keyword_text, match_type, bid)
      values (${orgA}, ${profileA}, '4001', 'SP', 'synthetic widget', 'enabled', '1001',
              '2001', 'synthetic widget', 'exact', 0.88)
    `;
    await database.sql`
      insert into public.targets
        (org_id, profile_id, amazon_id, ad_product, name, state, campaign_id, ad_group_id,
         expression, resolved_expression, bid)
      values (${orgA}, ${profileA}, '6001', 'SP', 'asin="B000000011"', 'enabled', '1001',
              '2001', ${JSON.stringify([{ type: 'asin_same_as', value: 'B000000011' }])}::text::jsonb,
              'asin="B000000011"', 0.91)
    `;
    await database.sql`
      insert into public.negatives
        (org_id, profile_id, amazon_id, ad_product, name, state, campaign_id, ad_group_id,
         scope, keyword_text, expression, match_type)
      values
        (${orgA}, ${profileA}, '5001', 'SP', 'free synthetic widget', 'paused', '1001',
         '2001', 'ad_group', 'free synthetic widget', null, 'negative_exact'),
        (${orgA}, ${profileA}, '5002', 'SP', 'asin="B000000012"', 'enabled', '1001',
         '2001', 'ad_group', null,
         ${JSON.stringify([{ type: 'asin_same_as', value: 'B000000012' }])}::text::jsonb,
         'asin_same_as')
    `;
  }, 90_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('loads every live SP entity and counts the complete snapshot', async () => {
    const snapshot = await loadCampaignUpdateEntities(database, { orgId: orgA, profileId: profileA });
    expect(snapshot.counts).toEqual({
      campaigns: 1,
      adGroups: 1,
      productAds: 1,
      keywords: 1,
      targets: 1,
      negatives: 2,
    });
    expect(snapshot.entities).toHaveLength(7);
    expect(new Set(snapshot.entities.map((entity) => entity.amazonId)).size).toBe(7);

    const campaign = snapshot.entities.find((entity) => entity.entityType === 'campaign');
    expect(campaign).toMatchObject({
      amazonId: '1001',
      profileId: profileA,
      portfolioId: '9001',
      budgetAmount: 20,
      biddingStrategy: 'legacy_for_sales',
      endDate: '2026-12-31',
    });
    const target = snapshot.entities.find((entity) => entity.entityType === 'target');
    expect(target).toMatchObject({
      amazonId: '6001',
      expression: [{ type: 'asin_same_as', value: 'B000000011' }],
      bid: 0.91,
    });
  });

  it('excludes deleted rows and other ad products', async () => {
    const snapshot = await loadCampaignUpdateEntities(database, { orgId: orgA, profileId: profileA });
    expect(snapshot.entities.map((entity) => entity.amazonId)).not.toContain('1002');
    expect(snapshot.entities.map((entity) => entity.amazonId)).not.toContain('1003');
  });

  it('requires the owning organisation and profile together', async () => {
    await expect(
      loadCampaignUpdateEntities(database, { orgId: orgB, profileId: profileA }),
    ).resolves.toEqual({
      entities: [],
      counts: { campaigns: 0, adGroups: 0, productAds: 0, keywords: 0, targets: 0, negatives: 0 },
    });
    await expect(
      loadCampaignUpdateEntities(database, { orgId: orgA, profileId: profileB }),
    ).resolves.toEqual({
      entities: [],
      counts: { campaigns: 0, adGroups: 0, productAds: 0, keywords: 0, targets: 0, negatives: 0 },
    });
  });
});
