import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DbHandle } from '@wizard-ads/db';
import { createTestDatabase, databaseAvailable } from '@wizard-ads/db/testing';
import type { TestDatabase } from '@wizard-ads/db/testing';
import { readDashboardOperatingStatus } from './operating-status.js';

const available = await databaseAvailable();
const OWNER_A = '81818181-8181-4181-8181-818181818181';
const OWNER_B = '82828282-8282-4282-8282-828282828282';

describe('readDashboardOperatingStatus', () => {
  it('maps the compact wire row and performs one database call', async () => {
    const sql = vi.fn().mockResolvedValue([{
      campaigns_total: '5',
      campaigns_assigned: '3',
      group_count: '2',
      batch_opt_group: 'rank',
      batch_lever: 'bid-down',
      batch_rows: '4',
      observations_synchronized: '2',
      observations_settling: '1',
      observations_complete: '3',
      observations_hold: '2',
      observations_revert: '1',
      stock_signals: '2',
    }]) as unknown as DbHandle['sql'];

    const result = await readDashboardOperatingStatus({ sql }, {
      orgId: 'synthetic-org',
      profileId: 'synthetic-profile',
    });

    expect(sql).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      campaigns: { total: 5, assigned: 3, unassigned: 2 },
      groupCount: 2,
      stagedBatch: { optGroup: 'rank', lever: 'bid-down', rows: 4 },
      observations: { synchronized: 2, settling: 1, complete: 3, hold: 2, revert: 1 },
      stockSignals: 2,
    });
  });

  it('fails closed to empty counts when the database returns no row', async () => {
    const sql = vi.fn().mockResolvedValue([]) as unknown as DbHandle['sql'];

    await expect(readDashboardOperatingStatus({ sql }, {
      orgId: 'synthetic-org',
      profileId: 'synthetic-profile',
    })).resolves.toEqual({
      campaigns: { total: 0, assigned: 0, unassigned: 0 },
      groupCount: 0,
      stagedBatch: null,
      observations: { synchronized: 0, settling: 0, complete: 0, hold: 0, revert: 0 },
      stockSignals: 0,
    });
  });
});

describe.skipIf(!available)('readDashboardOperatingStatus integration', () => {
  let database: TestDatabase;
  let orgA: string;
  let orgB: string;
  let profileA: string;
  let profileB: string;

  beforeAll(async () => {
    database = await createTestDatabase('wp166_dashboard_status');
    const [tenantA] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('dashboard-status-alpha', ${OWNER_A}, 'owner')
    `;
    const [tenantB] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('dashboard-status-bravo', ${OWNER_B}, 'owner')
    `;
    orgA = tenantA?.seed_tenant_fixture ?? '';
    orgB = tenantB?.seed_tenant_fixture ?? '';
    const [rowA] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgA} limit 1
    `;
    const [rowB] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgB} limit 1
    `;
    profileA = rowA?.id ?? '';
    profileB = rowB?.id ?? '';

    await database.sql`
      insert into public.campaigns
        (org_id, profile_id, amazon_id, ad_product, name, state, budget_amount, budget_type)
      values (${orgA}, ${profileA}, 'c-2', 'SB', 'second campaign', 'enabled', 20, 'daily')
    `;
    await database.sql`
      update public.supa_flags
         set out_of_stock_days = 2
       where org_id = ${orgA} and profile_id = ${profileA}
    `;
    await database.sql`
      insert into public.supa_flags
        (org_id, profile_id, week_start, asin, search_query, rule, out_of_stock_days)
      values (${orgA}, ${profileA}, current_date - extract(dow from current_date)::integer,
              'B0SYNTH002', 'second synthetic query', 'P3', 1)
    `;
    await database.sql`
      update public.recommendation_observations
         set evidence_state = 'observing'
       where org_id = ${orgA} and profile_id = ${profileA}
    `;

    const [group] = await database.sql<{ id: string }[]>`
      select id from public.optimization_groups
       where org_id = ${orgA} and profile_id = ${profileA}
       limit 1
    `;
    const [run] = await database.sql<{ id: string }[]>`
      select id from public.recommendation_runs
       where org_id = ${orgA} and profile_id = ${profileA}
       limit 1
    `;
    const [recommendation] = await database.sql<{ id: string }[]>`
      insert into public.recommendations
        (run_id, org_id, profile_id, reason, entity_type, entity_id, field,
         current_value, proposed_value, inputs)
      values (${run?.id ?? ''}, ${orgA}, ${profileA}, 'high_acos', 'keyword',
              'kw-second', 'bid', '0.80'::jsonb, '0.60'::jsonb, '{}'::jsonb)
      returning id
    `;
    await database.sql`
      insert into public.recommendation_observations
        (org_id, profile_id, recommendation_id, group_id, expected_value,
         synchronized_value, synchronized_at, observation_window_start,
         observation_window_end, evidence_state, decision, evidence_note)
      values (${orgA}, ${profileA}, ${recommendation?.id ?? ''}, ${group?.id ?? ''},
              0.60, 0.60, now(), current_date - 7, current_date,
              'complete', 'revert', 'synthetic no-lift evidence')
    `;

    const [batch] = await database.sql<{ id: string }[]>`
      insert into public.apply_batches
        (org_id, profile_id, tag, opt_group, lever, note, status,
         exported_proposals, reversible_rows, unsupported_rows)
      values (${orgA}, ${profileA}, 'dashboard-status-staged', 'rank', 'bid-down',
              'synthetic', 'staged', 2, 2, 0)
      returning id
    `;
    await database.sql`
      insert into public.apply_rows
        (batch_id, org_id, profile_id, entity_type, entity_id, field, old_value, new_value)
      values
        (${batch?.id ?? ''}, ${orgA}, ${profileA}, 'keyword', 'kw-a', 'bid',
         '0.80'::jsonb, '0.70'::jsonb),
        (${batch?.id ?? ''}, ${orgA}, ${profileA}, 'target', 'tg-a', 'bid',
         '0.90'::jsonb, '0.80'::jsonb)
    `;
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('reconciles exact tenant counts in one statement', async () => {
    let calls = 0;
    const sql: DbHandle['sql'] = new Proxy(database.sql, {
      apply(target, thisArg, args) {
        calls += 1;
        return Reflect.apply(target, thisArg, args);
      },
    });

    const status = await readDashboardOperatingStatus({ sql }, { orgId: orgA, profileId: profileA });

    expect(calls).toBe(1);
    expect(status).toEqual({
      campaigns: { total: 2, assigned: 1, unassigned: 1 },
      groupCount: 1,
      stagedBatch: { optGroup: 'rank', lever: 'bid-down', rows: 2 },
      observations: { synchronized: 1, settling: 1, complete: 1, hold: 1, revert: 1 },
      stockSignals: 2,
    });
  });

  it('never crosses an organisation/profile boundary', async () => {
    const mismatched = await readDashboardOperatingStatus(database, {
      orgId: orgA,
      profileId: profileB,
    });
    expect(mismatched).toEqual({
      campaigns: { total: 0, assigned: 0, unassigned: 0 },
      groupCount: 0,
      stagedBatch: null,
      observations: { synchronized: 0, settling: 0, complete: 0, hold: 0, revert: 0 },
      stockSignals: 0,
    });

    const own = await readDashboardOperatingStatus(database, { orgId: orgB, profileId: profileB });
    expect(own.campaigns).toEqual({ total: 1, assigned: 1, unassigned: 0 });
    expect(own.groupCount).toBe(1);
    expect(own.stagedBatch).toBeNull();
  });
});
