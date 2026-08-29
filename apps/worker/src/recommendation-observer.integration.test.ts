import { createTestDatabase, databaseAvailable, type TestDatabase } from '@wizard-ads/db/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { reconcileRecommendationObservations } from './recommendation-observer.js';

const available = await databaseAvailable();
const USER = '77777777-7777-4777-8777-777777777778';

describe.skipIf(!available)('recommendation observation reconciler + Postgres', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileId: string;
  let dates: { pre1: string; pre2: string; post1: string; post2: string };

  beforeAll(async () => {
    database = await createTestDatabase('recommendation_observer');
    const [org] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('observer', ${USER}, 'owner')
    `;
    orgId = org?.seed_tenant_fixture ?? '';
    const [profile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgId} limit 1
    `;
    profileId = profile?.id ?? '';
    const [clock] = await database.sql<{ post2: string }[]>`
      select (current_date - 8)::text as post2
    `;
    const post2 = clock?.post2 ?? '';
    dates = {
      post2,
      post1: shift(post2, -1),
      pre2: shift(post2, -2),
      pre1: shift(post2, -3),
    };
    await database.sql`select app.ensure_fact_partitions(${dates.pre1}::date, 1)`;
  }, 60_000);

  beforeEach(async () => {
    await database.sql`delete from public.recommendation_observations where org_id = ${orgId}`;
    await database.sql`delete from public.entity_changes where org_id = ${orgId} and apply_row_id is not null`;
    await database.sql`
      delete from public.apply_batches batch
       where batch.org_id = ${orgId}
         and not exists (
           select 1 from public.amazon_write_approvals approval
            where approval.apply_batch_id = batch.id
         )
    `;
    await database.sql`delete from public.recommendation_runs where org_id = ${orgId}`;
    await database.sql`delete from public.optimization_groups where org_id = ${orgId}`;
    await database.sql`delete from public.report_coverage where org_id = ${orgId}`;
    await database.sql`
      delete from public.fact_sp_target_daily
       where org_id = ${orgId} and date between ${dates.pre1}::date and ${dates.post2}::date
    `;
  });

  afterAll(async () => { await database?.drop(); }, 30_000);

  it('moves idempotently from awaiting sync to observing to exact revert evidence', async () => {
    const seeded = await seedExport({ withPolicy: true });
    const observedAt = new Date();

    expect(await reconcileRecommendationObservations(database, { now: observedAt })).toMatchObject({
      scanned: 1, evaluated: 1, inserted: 1, unchanged: 0, refused: 0,
    });
    expect(await latest(seeded.recommendationId)).toMatchObject({
      evidence_state: 'awaiting_sync', decision: 'hold', synchronized_value: null,
    });

    expect(await reconcileRecommendationObservations(database, { now: observedAt })).toMatchObject({
      scanned: 0, evaluated: 0, inserted: 0, unchanged: 0, refused: 0,
    });
    expect(await observationCount(seeded.recommendationId)).toBe(1);

    await database.sql`
      insert into public.entity_changes
        (org_id, profile_id, entity_type, amazon_id, field, old_value, new_value,
         source, apply_batch_id, apply_row_id, observed_at)
      values (${orgId}, ${profileId}, 'keyword', 'kw-1', 'bid', '0.90'::jsonb,
              '1.01'::jsonb, 'sync', ${seeded.batchId}, ${seeded.applyRowId},
              ${`${dates.pre2}T01:00:00Z`})
    `;
    await upsertCoverage(dates.post1);

    expect(await reconcileRecommendationObservations(database, { now: new Date(observedAt.getTime() + 1_000) }))
      .toMatchObject({ scanned: 1, evaluated: 1, inserted: 1, unchanged: 0, refused: 0 });
    expect(await latest(seeded.recommendationId)).toMatchObject({
      evidence_state: 'observing', decision: 'hold', synchronized_value: '1.010000',
    });

    await insertFact(dates.pre1, 4);
    await insertFact(dates.pre2, 6);
    await insertFact(dates.post1, 3);
    await insertFact(dates.post2, 6);
    await upsertCoverage(dates.post2);

    expect(await reconcileRecommendationObservations(database, { now: new Date(observedAt.getTime() + 2_000) }))
      .toMatchObject({ scanned: 1, evaluated: 1, inserted: 1, unchanged: 0, refused: 0 });
    const final = await latest(seeded.recommendationId);
    expect(final).toMatchObject({
      evidence_state: 'complete',
      decision: 'revert',
      pre_incremental_volume: '10.000000',
      post_incremental_volume: '9.000000',
    });
    expect(final?.evidence_note).toContain('exact_revert_value=0.9');
    expect(final?.evidence_note).toContain('incremental_volume=purchases_7d');
    expect(await observationCount(seeded.recommendationId)).toBe(3);
  });

  it('refuses absent tenant policy without writing a guessed observation', async () => {
    const seeded = await seedExport({ withPolicy: false });
    expect(await reconcileRecommendationObservations(database)).toMatchObject({
      scanned: 1,
      evaluated: 0,
      inserted: 0,
      unchanged: 0,
      refused: 1,
      refusalReasons: { missing_evidence_policy: 1 },
    });
    expect(await observationCount(seeded.recommendationId)).toBe(0);
  });

  it('persists continue only after settled matched evidence clears tenant lift gates', async () => {
    const seeded = await seedExport({ withPolicy: true });
    await database.sql`
      insert into public.entity_changes
        (org_id, profile_id, entity_type, amazon_id, field, old_value, new_value,
         source, apply_batch_id, apply_row_id, observed_at)
      values (${orgId}, ${profileId}, 'keyword', 'kw-1', 'bid', '0.90'::jsonb,
              '1.01'::jsonb, 'sync', ${seeded.batchId}, ${seeded.applyRowId},
              ${`${dates.pre2}T01:00:00Z`})
    `;
    await insertFact(dates.pre1, 4);
    await insertFact(dates.pre2, 6);
    await insertFact(dates.post1, 6);
    await insertFact(dates.post2, 7);
    await upsertCoverage(dates.post2);

    expect(await reconcileRecommendationObservations(database)).toMatchObject({
      scanned: 1, evaluated: 1, inserted: 1, unchanged: 0, refused: 0,
    });
    expect(await latest(seeded.recommendationId)).toMatchObject({
      evidence_state: 'complete', decision: 'continue',
      pre_incremental_volume: '10.000000', post_incremental_volume: '13.000000',
    });
  });

  async function seedExport(options: { withPolicy: boolean }): Promise<{
    recommendationId: string; batchId: string; applyRowId: string;
  }> {
    const [group] = await database.sql<{ id: string }[]>`
      insert into public.optimization_groups
        (org_id, profile_id, name, role, target_acos, bid_increase_cap,
         bid_decrease_cap, placement_increase_cap, placement_decrease_cap,
         cadence, prioritization)
      values (${orgId}, ${profileId}, 'Synthetic observer group', 'profit', 0.3,
              0.2, 0.2, 0.2, 0.2, interval '7 days', 'balanced')
      returning id
    `;
    const groupId = group?.id ?? '';
    const groupSnapshot = {
      id: groupId, orgId, profileId, name: 'Synthetic observer group', role: 'profit',
      targetAcos: 0.3, bidFloor: null, bidCeiling: null, bidIncreaseCap: 0.2,
      bidDecreaseCap: 0.2, placementIncreaseCap: 0.2, placementDecreaseCap: 0.2,
      exclusions: [], cadence: '7 days', prioritization: 'balanced', enabled: true,
    };
    const strategy = {
      schema: 'wizard-ads.tenant-strategy.v1', pacing: {}, opt_groups: {}, rank_lifecycle: {},
      staged_apply: {}, bids: {}, sv_bands: {}, caps: {}, pat_split: {}, naming: {},
      ...(options.withPolicy ? {
        recommendation_evidence: {
          synchronizationTolerance: 0.001,
          minimumMatchedPairs: 2,
          minimumCombinedIncrementalVolume: 1,
          minimumAbsoluteLift: 1,
          minimumRelativeLift: 0.1,
        },
      } : {}),
    };
    const [run] = await database.sql<{ id: string }[]>`
      insert into public.recommendation_runs
        (org_id, profile_id, status, lookback_days, window_start, window_end,
         strategy_snapshot, group_id, group_role, group_snapshot, due_at)
      values (${orgId}, ${profileId}, 'succeeded', 2, ${dates.pre1}::date, ${dates.pre2}::date,
              ${JSON.stringify(strategy)}::jsonb, ${groupId}, 'profit',
              ${JSON.stringify(groupSnapshot)}::jsonb, ${`${dates.pre1}T00:00:00Z`})
      returning id
    `;
    const runId = run?.id;
    if (!runId) throw new Error('Synthetic recommendation run was not inserted');
    const [recommendation] = await database.sql<{ id: string }[]>`
      insert into public.recommendations
        (run_id, org_id, profile_id, reason, entity_type, entity_id, ad_product,
         campaign_id, ad_group_id, field, current_value, proposed_value, inputs, status)
      values (${runId}, ${orgId}, ${profileId}, 'low_visibility', 'keyword', 'kw-1', 'SP',
              'c-1', 'ag-1', 'bid', '0.90'::jsonb, '1.01'::jsonb,
              '{"rpc":1,"clicks":1,"cvrSourceLevel":"keyword","ceilingApplied":null,"capClamped":false}'::jsonb,
              'exported')
      returning id
    `;
    const recommendationId = recommendation?.id ?? '';
    const [batch] = await database.sql<{ id: string }[]>`
      insert into public.apply_batches
        (org_id, profile_id, tag, opt_group, lever, note, status, exported_at,
         artifact_sha256, exported_proposals, reversible_rows, unsupported_rows)
      values (${orgId}, ${profileId}, 'synthetic-observer', 'profit', 'bid', 'synthetic',
              'staged', ${`${dates.pre2}T00:00:00Z`}, ${'a'.repeat(64)}, 1, 1, 0)
      returning id
    `;
    const batchId = batch?.id ?? '';
    const [applyRow] = await database.sql<{ id: string }[]>`
      insert into public.apply_rows
        (batch_id, org_id, profile_id, recommendation_id, entity_type, entity_id,
         field, old_value, new_value, lever)
      values (${batchId}, ${orgId}, ${profileId}, ${recommendationId}, 'keyword', 'kw-1',
              'bid', '0.90'::jsonb, '1.01'::jsonb, 'bid')
      returning id
    `;
    await database.sql`
      update public.recommendations set export_batch_id = ${batchId}
       where org_id = ${orgId} and id = ${recommendationId}
    `;
    return { recommendationId, batchId, applyRowId: applyRow?.id ?? '' };
  }

  async function insertFact(date: string, purchases: number): Promise<void> {
    await database.sql`
      insert into public.fact_sp_target_daily
        (org_id, profile_id, date, ad_product, campaign_id, ad_group_id, target_id,
         target_kind, match_type, impressions, clicks, cost, purchases_7d, sales_7d, units_sold_7d)
      values (${orgId}, ${profileId}, ${date}, 'SP', 'c-1', 'ag-1', 'kw-1',
              'keyword', 'exact', 100, 10, 5, ${purchases}, ${purchases * 10}, ${purchases})
    `;
  }

  async function upsertCoverage(settled: string): Promise<void> {
    await database.sql`
      insert into public.report_coverage
        (org_id, profile_id, report_type, grain, source, status,
         earliest_returned_date, latest_loaded_date, latest_settled_date)
      values (${orgId}, ${profileId}, 'spTargeting', 'sp_target', 'amazon_reporting_v3', 'complete',
              ${dates.pre1}, ${dates.post2}, ${settled})
      on conflict (profile_id, report_type, grain, source) do update
        set status = excluded.status, latest_loaded_date = excluded.latest_loaded_date,
            latest_settled_date = excluded.latest_settled_date
    `;
  }

  async function observationCount(recommendationId: string): Promise<number> {
    const [row] = await database.sql<{ count: number }[]>`
      select count(*)::int as count from public.recommendation_observations
       where org_id = ${orgId} and recommendation_id = ${recommendationId}
    `;
    return row?.count ?? 0;
  }

  async function latest(recommendationId: string): Promise<{
    evidence_state: string; decision: string; synchronized_value: string | null;
    pre_incremental_volume: string | null; post_incremental_volume: string | null;
    evidence_note: string;
  } | undefined> {
    const rows = await database.sql<{
      evidence_state: string; decision: string; synchronized_value: string | null;
      pre_incremental_volume: string | null; post_incremental_volume: string | null;
      evidence_note: string;
    }[]>`
      select evidence_state::text as evidence_state, decision::text as decision,
             synchronized_value::text as synchronized_value,
             pre_incremental_volume::text as pre_incremental_volume,
             post_incremental_volume::text as post_incremental_volume, evidence_note
        from public.recommendation_observations
       where org_id = ${orgId} and recommendation_id = ${recommendationId}
       order by observed_at desc, id desc limit 1
    `;
    return rows[0];
  }
});

function shift(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
