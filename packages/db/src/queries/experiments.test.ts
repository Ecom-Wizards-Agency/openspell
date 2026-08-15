/**
 * WP-19's database half: the tracker's reads and writes, the transition rules
 * that a policy alone cannot express, and — the part worth the most scrutiny —
 * the before/during/after comparison, whose sums are checked against a direct
 * SQL sum so "sum/sum" is proven, not asserted.
 *
 * The query helpers run on the admin handle, which is what the web request layer
 * uses, so they prove the org predicates. The policy rules a browser client
 * would meet run through `asUser`, which switches role and JWT claims exactly as
 * PostgREST does.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable } from '../testing/harness.js';
import { asUser } from '../testing/rls.js';
import type { TestDatabase } from '../testing/harness.js';
import {
  ExperimentNotFound,
  ExperimentProfileNotFound,
  InvalidExperimentTransition,
  InvalidExperimentWindow,
  profileBelongsToOrg,
  canTransition,
  computeComparison,
  createExperiment,
  getExperiment,
  listEntityChangesInWindow,
  listExperimentEvents,
  listExperimentWindows,
  listExperiments,
  transitionExperiment,
  updateExperiment,
} from './experiments.js';

const available = await databaseAvailable();

const OWNER_A = '19191919-1919-4191-8191-191919191919';
const ANALYST_A = '19292929-2929-4292-8292-292929292929';
const VIEWER_A = '19393939-3939-4393-8393-393939393939';
const OWNER_B = '19494949-4949-4494-8494-494949494949';

describe.skipIf(!available)('WP-19 experiment queries', () => {
  let database: TestDatabase;
  let orgA: string;
  let orgB: string;
  let profileA: string;

  beforeAll(async () => {
    database = await createTestDatabase('wp19_experiments');
    const [a] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('exp-alpha', ${OWNER_A}, 'owner')
    `;
    const [b] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('exp-bravo', ${OWNER_B}, 'owner')
    `;
    orgA = a?.seed_tenant_fixture ?? '';
    orgB = b?.seed_tenant_fixture ?? '';
    const [profile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgA} limit 1
    `;
    profileA = profile?.id ?? '';

    for (const [user, role] of [
      [ANALYST_A, 'analyst'],
      [VIEWER_A, 'viewer'],
    ] as const) {
      await database.sql`select public.auth_user_stub(${user})`;
      await database.sql`
        insert into public.org_members (org_id, user_id, role) values (${orgA}, ${user}, ${role})
      `;
    }
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('creates an experiment, captures its scope, and logs a creation event', async () => {
    const created = await createExperiment(database, {
      orgId: orgA,
      profileId: profileA,
      createdBy: OWNER_A,
      name: '  Push  bids  on blue widget  ',
      hypothesis: 'Higher bids will lift sales without wrecking ACOS.',
      type: 'bid_push',
      metricFocus: 'sales',
      scope: { campaignIds: ['c-1', 'c-1', ''], targetIds: ['kw-1'], note: 'the SKW set' },
      status: 'planned',
    });

    expect(created.name).toBe('Push bids on blue widget');
    // Scope de-duped and cleaned.
    expect(created.scope.campaignIds).toEqual(['c-1']);
    expect(created.scope.targetIds).toEqual(['kw-1']);
    expect(created.status).toBe('planned');

    const events = await listExperimentEvents(database, { orgId: orgA, experimentId: created.id });
    expect(events).toHaveLength(1);
    expect(events[0]?.fromStatus).toBeNull();
    expect(events[0]?.toStatus).toBe('planned');
  });

  it('moves through the lifecycle, stamping end_at on ended and logging each move', async () => {
    const created = await createExperiment(database, {
      orgId: orgA,
      profileId: profileA,
      createdBy: OWNER_A,
      name: 'Lifecycle test',
      type: 'placement',
      metricFocus: 'acos',
    });

    const running = await transitionExperiment(database, {
      orgId: orgA,
      experimentId: created.id,
      to: 'running',
      actorId: OWNER_A,
    });
    expect(running.status).toBe('running');
    expect(running.endAt).toBeNull();

    const ended = await transitionExperiment(database, {
      orgId: orgA,
      experimentId: created.id,
      to: 'ended',
      resultNote: 'ACOS fell four points.',
      actorId: OWNER_A,
    });
    expect(ended.status).toBe('ended');
    expect(ended.endAt).not.toBeNull();
    expect(ended.resultNote).toBe('ACOS fell four points.');

    const events = await listExperimentEvents(database, { orgId: orgA, experimentId: created.id });
    // created, running, ended
    expect(events.map((event) => event.toStatus)).toEqual(['planned', 'running', 'ended']);
  });

  it('refuses an impossible transition', async () => {
    expect(canTransition('ended', 'planned')).toBe(false);
    const created = await createExperiment(database, {
      orgId: orgA,
      profileId: profileA,
      createdBy: OWNER_A,
      name: 'Bad transition',
      type: 'other',
      metricFocus: 'ctr',
    });
    await expect(
      transitionExperiment(database, { orgId: orgA, experimentId: created.id, to: 'analyzed' }),
    ).rejects.toBeInstanceOf(InvalidExperimentTransition);
  });

  it('reads a foreign experiment as not-found from org A', async () => {
    const [profileB] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgB} limit 1
    `;
    const foreignExperiment = await createExperiment(database, {
      orgId: orgB,
      profileId: profileB?.id as string,
      createdBy: OWNER_B,
      name: 'Bravo experiment',
      type: 'price',
      metricFocus: 'sales',
    });
    const seen = await getExperiment(database, { orgId: orgA, experimentId: foreignExperiment.id });
    expect(seen).toBeNull();
    await expect(
      transitionExperiment(database, { orgId: orgA, experimentId: foreignExperiment.id, to: 'running' }),
    ).rejects.toBeInstanceOf(ExperimentNotFound);
  });

  it('lists windows for the shading provider, only for live experiments', async () => {
    const windows = await listExperimentWindows(database, { orgId: orgA, profileId: profileA });
    // The fixture seeds one running experiment; the lifecycle test above ended one.
    expect(windows.length).toBeGreaterThanOrEqual(2);
    for (const window of windows) {
      expect(['running', 'ended', 'analyzed']).toContain(window.status);
    }
  });

  it('lists entity_changes inside the window, narrowed to the scope', async () => {
    // The fixture seeds a change to kw-1 at now(); an experiment whose window
    // spans it and whose scope names kw-1 should surface it.
    const experiment = await createExperiment(database, {
      orgId: orgA,
      profileId: profileA,
      createdBy: OWNER_A,
      name: 'Window changes',
      type: 'bid_push',
      metricFocus: 'sales',
      scope: { targetIds: ['kw-1'] },
      startAt: new Date(Date.now() - 86_400_000),
      status: 'running',
    });
    const changes = await listEntityChangesInWindow(database, experiment);
    expect(changes.some((change) => change.amazonId === 'kw-1' && change.field === 'bid')).toBe(true);
  });

  it('derives before/during sums from facts, verified against a direct SQL sum', async () => {
    // A clean second profile so the sums are only this test's rows.
    const [conn] = await database.sql<{ id: string }[]>`
      select id from public.ads_connections where org_id = ${orgA} limit 1
    `;
    const connectionId = conn?.id ?? '';
    const [profile] = await database.sql<{ id: string }[]>`
      insert into public.ad_profiles
        (org_id, connection_id, amazon_profile_id, region, country_code, currency_code, timezone, sync_enabled)
      values (${orgA}, ${connectionId}, 'exp-cmp-profile', 'NA', 'US', 'USD', 'UTC', true)
      returning id
    `;
    const profileId = profile?.id as string;

    // Dates anchored to the current month, which is the partition the fixture
    // has already opened. during: day 10..12 (3 days). before: day 07..09.
    const dayOf = (day: number): string => {
      const base = new Date();
      base.setUTCDate(day);
      return base.toISOString().slice(0, 10);
    };
    const beforeDate = dayOf(8);
    const duringStart = dayOf(10);
    const duringEnd = dayOf(12);
    const targetRows = [
      { date: beforeDate, cost: 5, sales: 20, imp: 100, clk: 10, ord: 1 }, // before
      { date: dayOf(10), cost: 8, sales: 40, imp: 200, clk: 20, ord: 2 }, // during
      { date: dayOf(11), cost: 12, sales: 60, imp: 300, clk: 30, ord: 3 }, // during
    ];
    for (const row of targetRows) {
      await database.sql`
        insert into public.fact_sp_target_daily
          (org_id, profile_id, date, ad_product, campaign_id, ad_group_id, target_id, target_kind,
           match_type, impressions, clicks, cost, purchases_7d, sales_7d, units_sold_7d)
        values (${orgA}, ${profileId}, ${row.date}, 'SP', 'c-9', 'ag-9', 'kw-9', 'keyword',
                'exact', ${row.imp}, ${row.clk}, ${row.cost}, ${row.ord}, ${row.sales}, ${row.ord})
      `;
      await database.sql`
        insert into public.fact_profile_daily
          (org_id, profile_id, date, currency_code, impressions, clicks, cost, purchases_7d, sales_7d,
           units_sold_7d, provisional)
        values (${orgA}, ${profileId}, ${row.date}, 'USD', ${row.imp}, ${row.clk}, ${row.cost},
                ${row.ord}, ${row.sales}, ${row.ord}, false)
      `;
    }

    const experiment = await createExperiment(database, {
      orgId: orgA,
      profileId,
      createdBy: OWNER_A,
      name: 'Comparison',
      type: 'bid_push',
      metricFocus: 'acos',
      scope: { campaignIds: ['c-9'] },
      startAt: `${duringStart}T00:00:00Z`,
      endAt: `${duringEnd}T00:00:00Z`,
      status: 'ended',
    });

    const comparison = await computeComparison(
      database,
      experiment,
      new Date(`${dayOf(28)}T00:00:00Z`),
    );
    expect(comparison.hasScopedFacts).toBe(true);
    expect(comparison.windowDays).toBe(3);

    const during = comparison.windows.find((window) => window.label === 'during');
    const before = comparison.windows.find((window) => window.label === 'before');
    expect(during?.scoped?.spend).toBe(20); // 8 + 12
    expect(during?.scoped?.sales).toBe(100); // 40 + 60
    // ACOS recomputed from summed bases: 20 / 100.
    expect(during?.scoped?.acos).toBeCloseTo(0.2, 10);
    expect(before?.scoped?.spend).toBe(5);

    // Verified against a direct SQL sum over the during window.
    const [sql] = await database.sql<{ spend: string; sales: string }[]>`
      select coalesce(sum(cost),0) as spend, coalesce(sum(sales_7d),0) as sales
        from public.fact_sp_target_daily
       where org_id = ${orgA} and profile_id = ${profileId} and campaign_id = 'c-9'
         and date between ${duringStart} and ${duringEnd}
    `;
    expect(during?.scoped?.spend).toBe(Number(sql?.spend));
    expect(during?.scoped?.sales).toBe(Number(sql?.sales));
  });

  it('has no after-window while an experiment is still running', async () => {
    const experiment = await createExperiment(database, {
      orgId: orgA,
      profileId: profileA,
      createdBy: OWNER_A,
      name: 'Still running',
      type: 'bid_push',
      metricFocus: 'sales',
      scope: { campaignIds: ['c-1'] },
      startAt: new Date(Date.now() - 3 * 86_400_000),
      status: 'running',
    });
    const comparison = await computeComparison(database, experiment);
    expect(comparison.windows.map((window) => window.label)).toEqual(['before', 'during']);
  });

  it('lets an analyst create their own but refuses a viewer', async () => {
    // Analyst creates as themselves — allowed.
    await asUser(database, ANALYST_A, async (sql) => {
      const rows = await sql`
        insert into public.experiments (org_id, profile_id, name, type, metric_focus, created_by)
        values (${orgA}, ${profileA}, 'Analyst experiment', 'bid_push', 'sales', ${ANALYST_A})
        returning id
      `;
      expect(rows.length).toBe(1);
    });

    // Viewer cannot insert at all.
    await asUser(database, VIEWER_A, async (sql) => {
      await expect(
        sql`
          insert into public.experiments (org_id, profile_id, name, type, metric_focus, created_by)
          values (${orgA}, ${profileA}, 'Viewer experiment', 'bid_push', 'sales', ${VIEWER_A})
          returning id
        `,
      ).rejects.toThrow(/row-level security/i);
    });
  });

  it('shows a member of org A none of org B, and refuses cross-org writes', async () => {
    await asUser(database, OWNER_A, async (sql) => {
      const rows = await sql<{ org_id: string }[]>`select org_id from public.experiments`;
      expect(rows.every((row) => row.org_id === orgA)).toBe(true);

      await expect(
        sql`
          insert into public.experiments (org_id, profile_id, name, type, metric_focus, created_by)
          values (${orgB}, ${profileA}, 'Stolen', 'bid_push', 'sales', ${OWNER_A})
        `,
      ).rejects.toThrow(/row-level security/i);
    });
  });

  it('edits descriptive fields without moving the status', async () => {
    const created = await createExperiment(database, {
      orgId: orgA,
      profileId: profileA,
      createdBy: OWNER_A,
      name: 'Editable',
      type: 'other',
      metricFocus: 'ctr',
    });
    const edited = await updateExperiment(database, {
      orgId: orgA,
      experimentId: created.id,
      hypothesis: 'A revised hypothesis.',
      scope: { asins: ['B0TEST0001'] },
    });
    expect(edited.hypothesis).toBe('A revised hypothesis.');
    expect(edited.scope.asins).toEqual(['B0TEST0001']);
    expect(edited.status).toBe('planned');
    const listed = await listExperiments(database, { orgId: orgA, profileId: profileA });
    expect(listed.some((experiment) => experiment.id === created.id)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Tenancy of the named profile, and the window rules
  // -------------------------------------------------------------------------

  it('refuses to create an experiment on another org\'s profile', async () => {
    const [foreign] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgB} limit 1
    `;
    const profileB = foreign?.id ?? '';
    expect(profileB).not.toBe('');

    // The only fence below this is a foreign key to ad_profiles (id), which
    // org B's profile satisfies perfectly well.
    expect(await profileBelongsToOrg(database, { orgId: orgA, profileId: profileB })).toBe(false);
    expect(await profileBelongsToOrg(database, { orgId: orgA, profileId: profileA })).toBe(true);
    // An id that is not even a uuid answers "no" rather than raising a cast error.
    expect(await profileBelongsToOrg(database, { orgId: orgA, profileId: 'not-a-uuid' })).toBe(false);

    await expect(
      createExperiment(database, {
        orgId: orgA,
        profileId: profileB,
        createdBy: OWNER_A,
        name: 'Cross-tenant profile',
        type: 'other',
        metricFocus: 'ctr',
      }),
    ).rejects.toBeInstanceOf(ExperimentProfileNotFound);

    // Nothing of org A's now points at org B's profile (org B's own
    // experiments on it, from the read tests above, are untouched).
    const [leaked] = await database.sql<{ n: string }[]>`
      select count(*) as n from public.experiments
       where profile_id = ${profileB} and org_id = ${orgA}
    `;
    expect(Number(leaked?.n)).toBe(0);
  });

  it('refuses a window that ends before it starts, in words rather than a constraint name', async () => {
    await expect(
      createExperiment(database, {
        orgId: orgA,
        profileId: profileA,
        createdBy: OWNER_A,
        name: 'Backwards window',
        type: 'other',
        metricFocus: 'ctr',
        startAt: '2026-08-10T00:00:00Z',
        endAt: '2026-08-01T00:00:00Z',
      }),
    ).rejects.toBeInstanceOf(InvalidExperimentWindow);

    const created = await createExperiment(database, {
      orgId: orgA,
      profileId: profileA,
      createdBy: OWNER_A,
      name: 'Editable window',
      type: 'other',
      metricFocus: 'ctr',
      startAt: '2026-08-01T00:00:00Z',
    });
    await transitionExperiment(database, { orgId: orgA, experimentId: created.id, to: 'running' });
    const ended = await transitionExperiment(database, { orgId: orgA, experimentId: created.id, to: 'ended' });
    expect(ended.endAt).not.toBeNull();

    // Moving the start past the recorded end is the edit that used to reach the
    // check constraint and surface as a raw Postgres error.
    await expect(
      updateExperiment(database, {
        orgId: orgA,
        experimentId: created.id,
        startAt: '2099-01-01T00:00:00Z',
      }),
    ).rejects.toBeInstanceOf(InvalidExperimentWindow);
    // …and the row is untouched.
    const after = await getExperiment(database, { orgId: orgA, experimentId: created.id });
    expect(after?.startAt.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('can end a future-dated experiment, stamping the end at its own start', async () => {
    const startAt = new Date(Date.now() + 7 * 86_400_000);
    const created = await createExperiment(database, {
      orgId: orgA,
      profileId: profileA,
      createdBy: OWNER_A,
      name: 'Starts next week',
      type: 'other',
      metricFocus: 'ctr',
      startAt,
      status: 'running',
    });

    // `now()` is before the start, so a plain now() stamp would end the test
    // before it began and the window constraint would refuse the whole move.
    const ended = await transitionExperiment(database, {
      orgId: orgA,
      experimentId: created.id,
      to: 'ended',
      actorId: OWNER_A,
    });
    expect(ended.status).toBe('ended');
    expect(ended.endAt?.getTime()).toBe(created.startAt.getTime());
  });
});
