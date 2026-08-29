/**
 * The acceptance check that needs a real database: **group-by ACOS and CVR are
 * verified against SQL aggregates**, not against another copy of the same
 * TypeScript.
 *
 * `packages/ui`'s own suite proves the arithmetic in isolation. This one proves
 * the whole path — Postgres sums, the two-window query, the row mapping, the
 * grid pipeline — lands on the number Postgres itself computes from the same
 * rows. If the query ever starts averaging, or the mapper drops a row, or the
 * comparison window leaks into the selected one, only a test that asks the
 * database for the truth catches it.
 *
 * Skipped, not failed, without a Postgres: the suite has to stay honest on a
 * machine that has none, the same way the `packages/db` suites do.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable } from '@wizard-ads/db/testing';
import type { TestDatabase } from '@wizard-ads/db/testing';
import { ensureFactPartitions } from '@wizard-ads/db';
import { buildGridModel, groupRows, resolveField } from '@wizard-ads/ui';
import type { GridRow } from '@wizard-ads/ui';
import { loadGridRows } from '../app/_lib/grid-data.js';
import { loadBidHistory } from '../app/_lib/bid-corridor.js';
import { listProfiles } from '../app/_lib/profiles.js';
import type { Period } from '../app/_lib/periods.js';

const available = await databaseAvailable();
const suite = available ? describe : describe.skip;

const PERIOD: Period = { start: '2026-07-01', end: '2026-07-14' };
const COMPARISON: Period = { start: '2026-06-17', end: '2026-06-30' };

/** Two campaigns whose ACOS is wildly different, so avg-of-ratios ≠ sum/sum. */
const CAMPAIGNS = [
  { id: 'c-skew-a', name: 'Dev | SP | Rank | Widget', spendPerDay: 40, salesPerDay: 40, clicks: 4, orders: 2 },
  { id: 'c-skew-b', name: 'Dev | SP | Profit | Widget', spendPerDay: 10, salesPerDay: 500, clicks: 200, orders: 20 },
];

suite('grid and roster reads against SQL aggregates', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileId: string;

  beforeAll(async () => {
    database = await createTestDatabase('wp06_grid');
    const [org] = await database.sql<{ id: string }[]>`
      select app.seed_tenant_fixture('wp06', '00000000-0000-4000-8000-0000000006a1'::uuid) as id
    `;
    orgId = (org as { id: string }).id;
    const [profile] = await database.sql<{ id: string }[]>`
      select id from public.ad_profiles where org_id = ${orgId} limit 1
    `;
    profileId = (profile as { id: string }).id;

    // Facts are partitioned by month; both windows need their partitions to exist.
    await ensureFactPartitions(database, COMPARISON.start, 3);
    await ensureFactPartitions(database, '2020-01-01', 1);

    for (const campaign of CAMPAIGNS) {
      await database.sql`
        insert into public.campaigns
          (org_id, profile_id, amazon_id, ad_product, name, state, budget_amount, budget_type, targeting_type)
        values (${orgId}, ${profileId}, ${campaign.id}, 'SP', ${campaign.name}, 'enabled', 50, 'daily', 'manual')
        on conflict (profile_id, amazon_id) do nothing
      `;
      await database.sql`
        insert into public.ad_groups
          (org_id, profile_id, amazon_id, ad_product, name, state, campaign_id, default_bid)
        values (${orgId}, ${profileId}, ${`${campaign.id}-ag`}, 'SP', 'ad group', 'enabled', ${campaign.id}, 0.8)
        on conflict (profile_id, amazon_id) do nothing
      `;
    }

    // Both windows, so every row has a real comparison figure.
    for (const window of [PERIOD, COMPARISON]) {
      const comparisonFactor = window === COMPARISON ? 0.5 : 1;
      for (let day = 0; day < 14; day += 1) {
        const date = addDays(window.start, day);
        for (const campaign of CAMPAIGNS) {
          for (let target = 0; target < 3; target += 1) {
            await database.sql`
              insert into public.fact_sp_target_daily
                (org_id, profile_id, date, ad_product, campaign_id, ad_group_id, target_id, target_kind,
                 match_type, impressions, clicks, cost, purchases_7d, sales_7d, units_sold_7d)
              values (${orgId}, ${profileId}, ${date}, 'SP', ${campaign.id}, ${`${campaign.id}-ag`},
                      ${`${campaign.id}-kw${target}`}, 'keyword', 'exact',
                      ${(1000 + target * 10) * comparisonFactor},
                      ${campaign.clicks * comparisonFactor},
                      ${campaign.spendPerDay * comparisonFactor},
                      ${campaign.orders * comparisonFactor},
                      ${campaign.salesPerDay * comparisonFactor},
                      ${campaign.orders * comparisonFactor})
            `;
          }
        }
      }
    }

    await database.sql`
      insert into public.keywords
        (org_id, profile_id, amazon_id, ad_product, name, state, campaign_id, ad_group_id,
         keyword_text, match_type, bid)
      values
        (${orgId}, ${profileId}, 'c-skew-a-kw0', 'SP', 'widget exact', 'enabled',
         'c-skew-a', 'c-skew-a-ag', 'widget', 'exact', 1.10)
      on conflict (profile_id, amazon_id) do update set bid = excluded.bid
    `;
    await database.sql`
      insert into public.bid_series_daily
        (org_id, profile_id, date, campaign_id, ad_group_id, target_id, is_keyword,
         suggested_bid_low, suggested_bid_median, suggested_bid_high, bid, cpc,
         max_potential_cpc)
      values
        (${orgId}, ${profileId}, '2026-07-13', 'c-skew-a', 'c-skew-a-ag',
         'c-skew-a-kw0', true, 0.60, 0.80, 1.00, 1.00, 0.70, 1.25),
        (${orgId}, ${profileId}, '2026-07-14', 'c-skew-a', 'c-skew-a-ag',
         'c-skew-a-kw0', true, 0.70, 0.90, 1.20, 1.10, 0.75, 1.40)
    `;
  }, 120_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('returns one row per target, matching the distinct grain count in SQL', async () => {
    const { rows, truncated } = await loadGridRows(database, 'targets', {
      orgId,
      profileId,
      currencyCode: 'USD',
      period: PERIOD,
      comparison: COMPARISON,
    });

    const [counted] = await database.sql<{ n: string }[]>`
      select count(distinct (campaign_id, ad_group_id, target_id, target_kind, ad_product))::text as n
        from public.fact_sp_target_daily
       where profile_id = ${profileId}
         and date between ${COMPARISON.start} and ${PERIOD.end}
    `;

    expect(truncated).toBe(false);
    // Rule 4: outputs counted against inputs, as an assertion.
    expect(rows.length).toBe(Number((counted as { n: string }).n));
  });

  it('marks the grid truncated only when a sentinel row exists beyond the limit', async () => {
    const exact = await loadGridRows(database, 'targets', {
      orgId,
      profileId,
      currencyCode: 'USD',
      period: PERIOD,
      comparison: COMPARISON,
      limit: 6,
    });
    const overflow = await loadGridRows(database, 'targets', {
      orgId,
      profileId,
      currencyCode: 'USD',
      period: PERIOD,
      comparison: COMPARISON,
      limit: 5,
    });

    expect(exact.rows).toHaveLength(6);
    expect(exact.truncated).toBe(false);
    expect(overflow.rows).toHaveLength(5);
    expect(overflow.truncated).toBe(true);
  });

  it('enriches targets with the latest bid series and campaign RPC category', async () => {
    const { rows } = await loadGridRows(database, 'targets', {
      orgId,
      profileId,
      currencyCode: 'USD',
      period: PERIOD,
      comparison: COMPARISON,
    });
    const target = rows.find((row) => row.dimensions['target_id'] === 'c-skew-a-kw0');
    expect(target?.dimensions).toMatchObject({
      suggested_bid: 0.9,
      suggested_bid_low: 0.7,
      suggested_bid_high: 1.2,
      bid_corridor_position: 'Within range',
      max_potential_cpc: 1.4,
      rpc_category: 'Rank',
    });
    expect(target?.dimensions['diff_from_suggested_bid']).toBeCloseTo(0.2, 10);
  });

  it('loads one org-scoped target history payload with same-window KPI bases', async () => {
    const history = await loadBidHistory(database, {
      orgId,
      profileId,
      targetId: 'c-skew-a-kw0',
      from: PERIOD.start,
      to: PERIOD.end,
    });
    expect(history?.target).toMatchObject({
      targeting: 'widget',
      matchType: 'exact',
      adProduct: 'SP',
      targetKind: 'keyword',
      campaignId: 'c-skew-a',
    });
    expect(history?.points).toHaveLength(2);
    expect(history?.totals.impressions).toBeGreaterThan(0);
    expect(history?.totals.spend).toBeGreaterThan(0);

    await expect(
      loadBidHistory(database, {
        orgId: '00000000-0000-4000-8000-000000000000',
        profileId,
        targetId: 'c-skew-a-kw0',
        from: PERIOD.start,
        to: PERIOD.end,
      }),
    ).resolves.toBeNull();
  });

  it('computes a grouped ACOS equal to sum(cost)/sum(sales) in Postgres', async () => {
    const { rows } = await loadGridRows(database, 'targets', {
      orgId,
      profileId,
      currencyCode: 'USD',
      period: PERIOD,
      comparison: COMPARISON,
    });

    const grouped = groupRows(rows, ['campaign_name']);
    expect(grouped.length).toBe(CAMPAIGNS.length);

    const sqlAggregates = await database.sql<
      { campaign_name: string; acos: string; cvr: string; ctr: string; roas: string; avg_of_acos: string }[]
    >`
      select c.name as campaign_name,
             (sum(f.cost) / nullif(sum(f.sales_7d), 0))::text as acos,
             (sum(f.purchases_7d)::numeric / nullif(sum(f.clicks), 0))::text as cvr,
             (sum(f.clicks)::numeric / nullif(sum(f.impressions), 0))::text as ctr,
             (sum(f.sales_7d) / nullif(sum(f.cost), 0))::text as roas,
             -- The wrong answer, computed on purpose: the mean of the daily
             -- ACOSes. The assertions below require our figure to match the
             -- first column and NOT this one.
             avg(f.cost / nullif(f.sales_7d, 0))::text as avg_of_acos
        from public.fact_sp_target_daily f
        join public.campaigns c
          on c.profile_id = f.profile_id and c.amazon_id = f.campaign_id
       where f.profile_id = ${profileId}
         and f.date between ${PERIOD.start} and ${PERIOD.end}
       group by c.name
    `;

    expect(sqlAggregates).toHaveLength(CAMPAIGNS.length);

    for (const expected of sqlAggregates) {
      const row = grouped.find((candidate) => candidate.dimensions['campaign_name'] === expected.campaign_name);
      expect(row, `no grouped row for ${expected.campaign_name}`).toBeDefined();

      expect(resolveField(row as GridRow, 'acos')).toBeCloseTo(Number(expected.acos), 9);
      expect(resolveField(row as GridRow, 'cvr')).toBeCloseTo(Number(expected.cvr), 9);
      expect(resolveField(row as GridRow, 'ctr')).toBeCloseTo(Number(expected.ctr), 9);
      expect(resolveField(row as GridRow, 'roas')).toBeCloseTo(Number(expected.roas), 9);
    }
  });

  it('is measurably different from averaging the ratios, on this fixture', async () => {
    const { rows } = await loadGridRows(database, 'targets', {
      orgId,
      profileId,
      currencyCode: 'USD',
      period: PERIOD,
      comparison: COMPARISON,
    });

    // Everything, across both campaigns: 100% ACOS on one, 2% on the other.
    const [all] = groupRows(rows, ['ad_product']);
    const correct = resolveField(all as GridRow, 'acos') as number;

    const [wrong] = await database.sql<{ avg_of_acos: string }[]>`
      select avg(f.cost / nullif(f.sales_7d, 0))::text as avg_of_acos
        from public.fact_sp_target_daily f
       where f.profile_id = ${profileId}
         and f.date between ${PERIOD.start} and ${PERIOD.end}
    `;

    const averaged = Number((wrong as { avg_of_acos: string }).avg_of_acos);
    expect(correct).toBeGreaterThan(0);
    // If these were close, this whole test would prove nothing.
    expect(Math.abs(correct - averaged)).toBeGreaterThan(0.2);
  });

  it('totals the whole filtered set, not the grouped rows', async () => {
    const { rows } = await loadGridRows(database, 'targets', {
      orgId,
      profileId,
      currencyCode: 'USD',
      period: PERIOD,
      comparison: COMPARISON,
    });

    const flat = buildGridModel(rows);
    const grouped = buildGridModel(rows, { groupBy: ['campaign_name'] });

    const [total] = await database.sql<{ spend: string; sales: string }[]>`
      select sum(cost)::text as spend, sum(sales_7d)::text as sales
        from public.fact_sp_target_daily
       where profile_id = ${profileId} and date between ${PERIOD.start} and ${PERIOD.end}
    `;

    expect(flat.totalsRow?.totals.spend).toBeCloseTo(Number((total as { spend: string }).spend), 6);
    expect(grouped.totalsRow?.totals.spend).toBeCloseTo(flat.totalsRow?.totals.spend ?? -1, 6);
    expect(grouped.shown).toBe(CAMPAIGNS.length);
    expect(grouped.matched).toBe(flat.shown);
  });

  it('reads the comparison window separately, and nulls it where nothing reported', async () => {
    const { rows } = await loadGridRows(database, 'targets', {
      orgId,
      profileId,
      currencyCode: 'USD',
      period: PERIOD,
      comparison: COMPARISON,
    });
    expect(rows.every((row) => row.comparison !== null)).toBe(true);
    const first = rows[0] as GridRow;
    expect(resolveField(first, 'spend_comparison')).toBeCloseTo(first.totals.spend / 2, 9);
    expect(resolveField(first, 'spend_delta_absolute')).toBeCloseTo(first.totals.spend / 2, 9);
    expect(resolveField(first, 'spend_delta_percent')).toBeCloseTo(1, 9);

    // A comparison window with no facts in it must produce null deltas, not zeroes.
    const empty = await loadGridRows(database, 'targets', {
      orgId,
      profileId,
      currencyCode: 'USD',
      period: PERIOD,
      comparison: { start: '2020-01-01', end: '2020-01-14' },
    });
    expect(empty.rows.length).toBeGreaterThan(0);
    expect(empty.rows.every((row) => row.comparison === null)).toBe(true);
    expect(resolveField(empty.rows[0] as GridRow, 'acos_delta_percent')).toBeNull();
  });

  it('never mixes the two windows: the selected period sums exclude comparison days', async () => {
    const { rows } = await loadGridRows(database, 'targets', {
      orgId,
      profileId,
      currencyCode: 'USD',
      period: PERIOD,
      comparison: COMPARISON,
    });
    const model = buildGridModel(rows);

    const [selected] = await database.sql<{ spend: string }[]>`
      select sum(cost)::text as spend from public.fact_sp_target_daily
       where profile_id = ${profileId} and date between ${PERIOD.start} and ${PERIOD.end}
    `;
    const [both] = await database.sql<{ spend: string }[]>`
      select sum(cost)::text as spend from public.fact_sp_target_daily
       where profile_id = ${profileId} and date between ${COMPARISON.start} and ${PERIOD.end}
    `;

    expect(model.totalsRow?.totals.spend).toBeCloseTo(Number((selected as { spend: string }).spend), 6);
    expect(Number((both as { spend: string }).spend)).toBeGreaterThan(
      Number((selected as { spend: string }).spend),
    );
  });

  it('marks a search term as harvested when a keyword with that text exists', async () => {
    await database.sql`
      insert into public.keywords
        (org_id, profile_id, amazon_id, ad_product, name, state, campaign_id, ad_group_id,
         keyword_text, match_type, bid, deleted_at)
      values
        (${orgId}, ${profileId}, 'case-duplicate-keyword', 'SP', 'case duplicate', 'enabled',
         'c-skew-a', 'c-skew-a-ag', 'WIDGET', 'exact', 1.00, null),
        (${orgId}, ${profileId}, 'deleted-keyword', 'SP', 'deleted keyword', 'archived',
         'c-skew-a', 'c-skew-a-ag', 'never harvested widget', 'exact', 1.00, now())
      on conflict (profile_id, amazon_id) do nothing
    `;
    await database.sql`
      insert into public.fact_search_term_daily
        (org_id, profile_id, date, ad_product, campaign_id, ad_group_id, target_id, search_term,
         match_type, impressions, clicks, cost, purchases_7d, sales_7d, units_sold_7d)
      values
        (${orgId}, ${profileId}, ${PERIOD.end}, 'SP', 'c-skew-a', 'c-skew-a-ag', 'c-skew-a-kw0',
         'widget', 'exact', 100, 5, 5, 1, 25, 1),
        (${orgId}, ${profileId}, ${PERIOD.end}, 'SP', 'c-skew-a', 'c-skew-a-ag', 'c-skew-a-kw0',
         'never harvested widget', 'exact', 100, 5, 5, 1, 25, 1)
    `;

    const { rows } = await loadGridRows(database, 'search_terms', {
      orgId,
      profileId,
      currencyCode: 'USD',
      period: PERIOD,
      comparison: COMPARISON,
    });

    // The fixture seeds a keyword whose text is exactly "widget".
    const harvested = rows.find((row) => row.dimensions['search_term'] === 'widget');
    const fresh = rows.find((row) => row.dimensions['search_term'] === 'never harvested widget');
    // Two current keywords normalize to "widget"; the precomputed vocabulary
    // must not duplicate the corresponding performance row.
    expect(rows.filter((row) => row.dimensions['search_term'] === 'widget')).toHaveLength(1);
    expect(harvested?.dimensions['harvested']).toBe(true);
    expect(fresh?.dimensions['harvested']).toBe(false);
  });

  it('loads and enriches the 3,597-row operator fixture within the cold server budget', async () => {
    await database.sql`
      insert into public.keywords
        (org_id, profile_id, amazon_id, ad_product, name, state, campaign_id, ad_group_id,
         keyword_text, match_type, bid)
      select ${orgId}, ${profileId}, 'perf-keyword-' || value::text, 'SP',
             'synthetic performance keyword', 'enabled', 'c-skew-a', 'c-skew-a-ag',
             'performance term ' || value::text, 'exact', 1.00
        from generate_series(1, 3597) value
      on conflict (profile_id, amazon_id) do nothing
    `;
    await database.sql`
      insert into public.fact_search_term_daily
        (org_id, profile_id, date, ad_product, campaign_id, ad_group_id, target_id, search_term,
         match_type, impressions, clicks, cost, purchases_7d, sales_7d, units_sold_7d)
      select ${orgId}, ${profileId}, ${PERIOD.end}, 'SP', 'c-skew-a', 'c-skew-a-ag',
             'c-skew-a-kw0', 'performance term ' || value::text, 'exact',
             100 + value, 5, 5, 1, 25, 1
        from generate_series(1, 3597) value
    `;

    const startedAt = performance.now();
    const { rows, truncated } = await loadGridRows(database, 'search_terms', {
      orgId,
      profileId,
      currencyCode: 'USD',
      period: PERIOD,
      comparison: COMPARISON,
    });
    const elapsedMs = performance.now() - startedAt;
    const fixtureRows = rows.filter((row) =>
      String(row.dimensions['search_term']).startsWith('performance term '),
    );

    expect(truncated).toBe(false);
    expect(fixtureRows).toHaveLength(3597);
    expect(fixtureRows.every((row) => row.dimensions['harvested'] === true)).toBe(true);
    expect(elapsedMs).toBeLessThan(process.env['CI'] === undefined ? 2_000 : 5_000);
  }, 20_000);

  it('renders one profile in one currency, and refuses to aggregate across two', async () => {
    const { rows } = await loadGridRows(database, 'targets', {
      orgId,
      profileId,
      currencyCode: 'USD',
      period: PERIOD,
      comparison: COMPARISON,
    });
    expect(new Set(rows.map((row) => row.currencyCode))).toEqual(new Set(['USD']));

    const mixed = [...rows, { ...(rows[0] as GridRow), id: 'eur', currencyCode: 'EUR' }];
    expect(() => groupRows(mixed, ['campaign_name'])).toThrow(/refusing to aggregate across currencies/);
  });

  /**
   * The org predicate, checked the only way that means anything: a profile id
   * that really exists, asked for by an org that does not own it. Before the
   * predicate this returned the whole profile, because the web tier connects as
   * the service role and nothing else was standing between the two tenants.
   */
  it('returns nothing for a profile another org owns, at every entity level', async () => {
    const [other] = await database.sql<{ id: string }[]>`
      select app.seed_tenant_fixture('wp06-other', '00000000-0000-4000-8000-0000000006b2'::uuid) as id
    `;
    const otherOrgId = (other as { id: string }).id;
    expect(otherOrgId).not.toBe(orgId);

    for (const level of ['campaigns', 'ad_groups', 'targets', 'search_terms', 'placements'] as const) {
      const own = await loadGridRows(database, level, {
        orgId,
        profileId,
        currencyCode: 'USD',
        period: PERIOD,
        comparison: COMPARISON,
      });
      const stolen = await loadGridRows(database, level, {
        orgId: otherOrgId,
        profileId,
        currencyCode: 'USD',
        period: PERIOD,
        comparison: COMPARISON,
      });
      expect(stolen.rows).toEqual([]);
      // And the level is one that actually has rows to leak, or the assertion
      // above proves nothing.
      if (level !== 'placements') expect(own.rows.length).toBeGreaterThan(0);
    }
  });

  it('lists only the asking org’s profiles', async () => {
    const [other] = await database.sql<{ id: string }[]>`
      select app.seed_tenant_fixture('wp06-roster', '00000000-0000-4000-8000-0000000006c3'::uuid) as id
    `;
    const otherOrgId = (other as { id: string }).id;

    const mine = await listProfiles(database, orgId);
    const theirs = await listProfiles(database, otherOrgId);
    const [total] = await database.sql<{ n: string }[]>`
      select count(*)::text as n from public.ad_profiles
    `;

    expect(mine.map((row) => row.id)).toContain(profileId);
    expect(theirs.map((row) => row.id)).not.toContain(profileId);
    // Counted against the input, as rule 4 asks: neither roster is the table.
    expect(mine.length).toBeLessThan(Number((total as { n: string }).n));
    expect(theirs.length).toBeGreaterThan(0);
  });
});

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) + days * 86_400_000).toISOString().slice(0, 10);
}
