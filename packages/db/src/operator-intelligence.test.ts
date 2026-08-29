/**
 * WP-56 invariants run against the real migrations on disposable Postgres.
 * The worker may retry, reorder and redeliver; these tests prove the database
 * makes the unsafe outcomes unrepresentable rather than trusting call order.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asUser } from './testing/rls.js';
import { createTestDatabase, databaseAvailable } from './testing/harness.js';
import type { TestDatabase } from './testing/harness.js';

const available = await databaseAvailable();
const OWNER_A = '15151515-1515-4515-8515-151515151515';
const OWNER_B = '16161616-1616-4616-8616-161616161616';

describe.skipIf(!available)('WP-56 operator-intelligence foundations', () => {
  let database: TestDatabase;
  let orgA: string;
  let orgB: string;
  let profileA: string;
  let profileB: string;

  beforeAll(async () => {
    database = await createTestDatabase('wp56');
    const [a] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('wp56-a', ${OWNER_A}, 'owner')
    `;
    const [b] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('wp56-b', ${OWNER_B}, 'owner')
    `;
    orgA = a?.seed_tenant_fixture ?? '';
    orgB = b?.seed_tenant_fixture ?? '';
    const [aProfile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgA} limit 1
    `;
    const [bProfile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgB} limit 1
    `;
    profileA = aProfile?.id ?? '';
    profileB = bProfile?.id ?? '';
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('keeps nullable hashes non-identifying while Amazon Asset ID stays unique', async () => {
    const rows = await database.sql<{ id: string }[]>`
      insert into public.creative_assets
        (org_id, profile_id, amazon_asset_id, kind, content_hash, name)
      values
        (${orgA}, ${profileA}, 'asset-synthetic-1', 'video', null, 'First'),
        (${orgA}, ${profileA}, 'asset-synthetic-2', 'video', null, 'Second')
      returning id
    `;
    expect(rows).toHaveLength(2);

    await expect(database.sql`
      insert into public.creative_assets
        (org_id, profile_id, amazon_asset_id, kind, content_hash)
      values (${orgA}, ${profileA}, 'asset-synthetic-1', 'video', null)
    `).rejects.toThrow(/creative_assets_profile_amazon_asset_key/i);

    // Equal content is not equal Amazon identity. Two authoritative Asset IDs
    // may legitimately point at identical uploaded bytes.
    const sameContent = await database.sql`
      insert into public.creative_assets
        (org_id, profile_id, amazon_asset_id, kind, content_hash)
      values
        (${orgA}, ${profileA}, 'asset-synthetic-3', 'video', 'same-content'),
        (${orgA}, ${profileA}, 'asset-synthetic-4', 'video', 'same-content')
      returning id
    `;
    expect(sameContent).toHaveLength(2);

    await expect(database.sql`
      insert into public.creative_assets
        (org_id, profile_id, amazon_asset_id, kind)
      values (${orgA}, ${profileB}, 'asset-cross-tenant', 'video')
    `).rejects.toThrow(/creative_assets_org_profile_fkey/i);

    const [foreignAsset] = await database.sql<{ id: string }[]>`
      insert into public.creative_assets
        (org_id, profile_id, amazon_asset_id, kind)
      values (${orgB}, ${profileB}, 'asset-foreign', 'video')
      returning id
    `;
    await expect(database.sql`
      insert into public.ad_creative_asset_mappings (
        org_id, profile_id, source_mapping_key, ad_product, campaign_id,
        ad_group_id, ad_id, creative_id, creative_asset_id, amazon_asset_id,
        attribution_state, observed_at
      ) values (
        ${orgA}, ${profileA}, 'mapping-cross-tenant', 'SB', 'campaign-1',
        'ad-group-1', 'ad-1', 'creative-1', ${foreignAsset?.id ?? ''}, 'asset-foreign',
        'mapped', now()
      )
    `).rejects.toThrow(/ad_creative_asset_mappings_asset_fkey/i);

    await database.sql`
      insert into public.fact_creative_daily (
        org_id, profile_id, date, ad_product, campaign_id, ad_group_id,
        ad_id, attribution_state
      ) values (
        ${orgA}, ${profileA}, current_date, 'SB', 'campaign-reclassify',
        'ad-group-reclassify', 'ad-reclassify', 'ambiguous'
      )
    `;
    await expect(database.sql`
      insert into public.fact_creative_daily (
        org_id, profile_id, date, ad_product, campaign_id, ad_group_id,
        ad_id, attribution_state
      ) values (
        ${orgA}, ${profileA}, current_date, 'SB', 'campaign-reclassify',
        'ad-group-reclassify', 'ad-reclassify', 'unmapped'
      )
    `).rejects.toThrow(/duplicate key value/i);
  });

  it('permits exactly one optimization-group assignment per campaign and profile', async () => {
    const [first] = await database.sql<{ id: string }[]>`
      insert into public.optimization_groups (
        org_id, profile_id, name, role, target_acos,
        bid_increase_cap, bid_decrease_cap,
        placement_increase_cap, placement_decrease_cap,
        cadence, review_weekdays, review_local_time, schedule_migration_state,
        prioritization
      ) values (
        ${orgA}, ${profileA}, 'Synthetic Rank', 'rank', 0.2,
        0.1, 0.1, 0.1, 0.1, interval '1 day', array['monday'], time '04:00',
        'native', 'balanced'
      ) returning id
    `;
    const [second] = await database.sql<{ id: string }[]>`
      insert into public.optimization_groups (
        org_id, profile_id, name, role, target_acos,
        bid_increase_cap, bid_decrease_cap,
        placement_increase_cap, placement_decrease_cap,
        cadence, review_weekdays, review_local_time, schedule_migration_state,
        prioritization
      ) values (
        ${orgA}, ${profileA}, 'Synthetic Profit', 'profit', 0.2,
        0.1, 0.1, 0.1, 0.1, interval '1 day', array['monday'], time '04:00',
        'native', 'balanced'
      ) returning id
    `;
    const firstId = first?.id ?? '';
    const secondId = second?.id ?? '';
    expect(firstId).not.toBe('');
    expect(secondId).not.toBe('');

    await database.sql`
      insert into public.campaign_optimization_assignments
        (org_id, profile_id, campaign_id, group_id, assigned_by)
      values (${orgA}, ${profileA}, 'campaign-synthetic-1', ${firstId}, ${OWNER_A})
    `;
    await expect(database.sql`
      insert into public.campaign_optimization_assignments
        (org_id, profile_id, campaign_id, group_id, assigned_by)
      values (${orgA}, ${profileA}, 'campaign-synthetic-1', ${secondId}, ${OWNER_A})
    `).rejects.toThrow(/campaign_optimization_assignments_pkey/i);

    const [foreignGroup] = await database.sql<{ id: string }[]>`
      insert into public.optimization_groups (
        org_id, profile_id, name, role, target_acos,
        bid_increase_cap, bid_decrease_cap,
        placement_increase_cap, placement_decrease_cap,
        cadence, review_weekdays, review_local_time, schedule_migration_state,
        prioritization
      ) values (
        ${orgB}, ${profileB}, 'Foreign Synthetic', 'shield', 0.2,
        0.1, 0.1, 0.1, 0.1, interval '1 day', array['monday'], time '04:00',
        'native', 'balanced'
      ) returning id
    `;
    const foreignGroupId = foreignGroup?.id ?? '';
    expect(foreignGroupId).not.toBe('');
    await expect(database.sql`
      insert into public.campaign_optimization_assignments
        (org_id, profile_id, campaign_id, group_id)
      values (${orgA}, ${profileA}, 'campaign-synthetic-2', ${foreignGroupId})
    `).rejects.toThrow(/campaign_optimization_assignments_group_fkey/i);
  });

  it('deduplicates Marketing Stream redelivery and preserves later revisions', async () => {
    const insertEvent = (revision: number, hash: string) => database.sql`
      insert into public.marketing_stream_events (
        org_id, profile_id, message_id, dataset, ad_product,
        event_time, received_at, revision, payload_hash, raw_payload
      ) values (
        ${orgA}, ${profileA}, 'message-synthetic-1', 'conversion', 'SP',
        '2026-08-01T10:00:00Z', '2026-08-01T10:01:00Z',
        ${revision}, ${hash}, ${JSON.stringify({ synthetic: true })}::jsonb
      ) returning id
    `;

    expect(await insertEvent(0, 'hash-synthetic-0')).toHaveLength(1);
    await expect(insertEvent(0, 'hash-conflict')).rejects.toThrow(
      /marketing_stream_events_profile_id_dataset_message_id_revis_key/i,
    );
    expect(await insertEvent(2, 'hash-synthetic-2')).toHaveLength(1);
    expect(await insertEvent(1, 'hash-synthetic-1')).toHaveLength(1);

    const [count] = await database.sql<{ n: string }[]>`
      select count(*) as n from public.marketing_stream_events
       where profile_id = ${profileA} and message_id = 'message-synthetic-1'
    `;
    expect(Number(count?.n)).toBe(3);
  });

  it('refuses unreconciled promotion counts and an older late promotion', async () => {
    await expect(database.sql`
      insert into public.report_promotion_watermarks (
        org_id, profile_id, report_type, report_date, source,
        report_request_id, requested_at,
        source_rows, parsed_rows, refused_rows, promoted_rows, canonical_rows
      ) values (
        ${orgA}, ${profileA}, 'syntheticReport', '2026-08-01', 'amazon_unified_reporting',
        '17171717-1717-4717-8717-171717171717', '2026-08-02T10:00:00Z',
        10, 8, 1, 8, 8
      )
    `).rejects.toThrow(/report_promotion_source_reconciled/i);

    await database.sql`
      insert into public.report_promotion_watermarks (
        org_id, profile_id, report_type, report_date, source,
        report_request_id, requested_at,
        source_rows, parsed_rows, refused_rows, promoted_rows, canonical_rows
      ) values (
        ${orgA}, ${profileA}, 'syntheticReport', '2026-08-01', 'amazon_unified_reporting',
        '18181818-1818-4818-8818-181818181818', '2026-08-02T10:00:00Z',
        10, 9, 1, 9, 9
      )
    `;

    await expect(database.sql`
      update public.report_promotion_watermarks
         set requested_at = '2026-08-02T09:00:00Z',
             report_request_id = '19191919-1919-4919-8919-191919191919'
       where profile_id = ${profileA}
         and report_type = 'syntheticReport'
         and report_date = '2026-08-01'
    `).rejects.toThrow(/older report request cannot replace/i);
  });

  it('makes attribution observations idempotent at their source key', async () => {
    const insert = () => database.sql`
      insert into public.attribution_observations (
        org_id, profile_id, source_observation_key, event_date, ad_product,
        report_type, source, observed_at, attribution_window_days,
        event_date_age_days, impressions, clicks, cost, purchases, sales
      ) values (
        ${orgA}, ${profileA}, 'observation-synthetic-1', '2026-08-01', 'SB',
        'syntheticReport', 'amazon_reporting_v3', '2026-08-02T00:00:00Z', 14,
        1, 100, 10, 12.5, 2, 30
      ) returning id
    `;
    expect(await insert()).toHaveLength(1);
    await expect(insert()).rejects.toThrow(
      /attribution_observations_profile_id_source_source_observati_key/i,
    );
  });

  it('enforces Sunday SQP weeks and bounded share values for new rows', async () => {
    await expect(database.sql`
      insert into public.fact_sqp_weekly (
        org_id, profile_id, week_start, asin, search_query,
        search_volume, impression_share
      ) values (
        ${orgA}, ${profileA}, '2026-08-03', 'ASIN-SYNTHETIC', 'synthetic query',
        10, 0.5
      )
    `).rejects.toThrow(/fact_sqp_weekly_sunday_start/i);

    await expect(database.sql`
      insert into public.fact_sqp_weekly (
        org_id, profile_id, week_start, asin, search_query,
        search_volume, impression_share
      ) values (
        ${orgA}, ${profileA}, '2026-08-02', 'ASIN-SYNTHETIC', 'synthetic query',
        10, 1.1
      )
    `).rejects.toThrow(/fact_sqp_weekly_shares_bounded/i);

    await expect(database.sql`
      insert into public.fact_sqp_weekly (
        org_id, profile_id, week_start, marketplace_id, asin, search_query,
        normalized_query, search_volume, impression_share
      ) values (
        ${orgA}, ${profileA}, '2026-08-02', 'market-synthetic',
        'ASIN-SYNTHETIC', 'synthetic query', 'synthetic query', 10, 0.5
      )
    `).rejects.toThrow(/fact_sqp_weekly_contract_complete/i);

    const insertComplete = (searchQuery: string) => database.sql`
      insert into public.fact_sqp_weekly (
        org_id, profile_id, week_start, marketplace_id, asin, search_query,
        normalized_query, search_volume,
        total_impressions, asin_impressions, impression_share,
        total_clicks, asin_clicks, click_share,
        total_cart_adds, asin_cart_adds, asin_cart_add_share,
        total_purchases, asin_purchases, purchase_share
      ) values (
        ${orgA}, ${profileA}, '2026-08-02', 'market-synthetic',
        'ASIN-SYNTHETIC', ${searchQuery}, 'synthetic query', 10,
        100, 10, 0.1, 20, 4, 0.2, 8, 2, 0.25, 4, 1, 0.25
      ) returning search_query
    `;
    expect(await insertComplete('Synthetic Query')).toHaveLength(1);
    await expect(insertComplete('synthetic-query')).rejects.toThrow(/duplicate key value/i);
  });

  it('tenant-scopes every new table and keeps worker evidence append-only for users', async () => {
    await database.sql`
      insert into public.report_coverage
        (org_id, profile_id, report_type, grain, source)
      values (${orgA}, ${profileA}, 'syntheticReport', 'daily', 'amazon_reporting_v3')
    `;
    await database.sql`
      insert into public.report_coverage
        (org_id, profile_id, report_type, grain, source)
      values (${orgB}, ${profileB}, 'syntheticReport', 'daily', 'amazon_reporting_v3')
    `;

    await asUser(database, OWNER_A, async (sql) => {
      const rows = await sql<{ org_id: string }[]>`select org_id from public.report_coverage`;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.org_id === orgA)).toBe(true);

      await expect(sql`
        insert into public.report_coverage
          (org_id, profile_id, report_type, grain, source)
        values (${orgA}, ${profileA}, 'user-write', 'daily', 'amazon_reporting_v3')
      `).rejects.toThrow(/permission denied|row-level security/i);

      const vocabulary = await sql`
        insert into public.query_vocabulary
          (org_id, marketplace_id, kind, value, normalized_value, source)
        values (${orgA}, 'market-synthetic', 'core_term', 'Synthetic', 'synthetic', 'operator')
        returning id
      `;
      expect(vocabulary).toHaveLength(1);

      await expect(sql`
        insert into public.query_vocabulary
          (org_id, marketplace_id, kind, value, normalized_value, source)
        values (${orgB}, 'market-synthetic', 'core_term', 'Foreign', 'foreign', 'operator')
      `).rejects.toThrow(/row-level security/i);
    });
  });
});
