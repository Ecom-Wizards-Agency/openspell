/**
 * The mirror matches the database, and rows coming out of it match the
 * contracts in `@wizard-ads/shared`.
 *
 * This is where "Drizzle types compile against shared" stops being a claim
 * about the type checker and becomes an assertion about values: a row is
 * loaded, mapped, and parsed by the contract's own zod schema. A column typed
 * `numeric` that arrives as a string, or an enum label that drifted by one
 * character, fails here rather than in a grid three packages away.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DailyFact, ProfileFact, SearchTermFact } from '@wizard-ads/shared';
import {
  FactLoadCountMismatch,
  readSpTargetFacts,
  toDailyFact,
  toProfileFact,
  toSearchTermFact,
  upsertProfileFacts,
  upsertSearchTermFacts,
  upsertSpTargetFacts,
} from './queries/facts.js';
import { upsertMirrorRows } from './queries/entities.js';
import { keywords, negatives } from './schema/entities.js';
import * as enums from './schema/enums.js';
import { factProfileDaily, factSearchTermDaily } from './schema/facts.js';
import { expectRejection } from './testing/errors.js';
import { createTestDatabase, databaseAvailable } from './testing/harness.js';
import type { TestDatabase } from './testing/harness.js';

const available = await databaseAvailable();
const USER = '66666666-6666-4666-8666-666666666666';

describe.skipIf(!available)('schema and contracts', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileId: string;
  const today = new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    database = await createTestDatabase('contracts');
    const [org] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('contracts', ${USER}, 'owner')
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

  it('declares every enum with exactly the labels the database has', async () => {
    const rows = await database.sql<{ typname: string; labels: string[] }[]>`
      select t.typname, array_agg(e.enumlabel order by e.enumsortorder) as labels
      from pg_catalog.pg_type t
      join pg_catalog.pg_enum e on e.enumtypid = t.oid
      join pg_catalog.pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'public'
      group by t.typname
    `;
    const database_ = new Map(rows.map((row) => [row.typname, row.labels]));

    const declared = (Object.values(enums) as unknown[]).filter(
      (value): value is { enumName: string; enumValues: readonly string[] } =>
        typeof value === 'function' && 'enumName' in value && 'enumValues' in value,
    );
    expect(declared.length).toBeGreaterThan(15);

    for (const declaration of declared) {
      const actual = database_.get(declaration.enumName);
      expect(actual, `enum ${declaration.enumName} is not in the database`).toBeDefined();
      expect([...declaration.enumValues], `enum ${declaration.enumName}`).toEqual(actual);
    }
  });

  it('round-trips a target fact into the contract shape', async () => {
    const counts = await upsertSpTargetFacts(database, [
      {
        orgId,
        profileId,
        date: today,
        adProduct: 'SP',
        campaignId: 'c-1',
        adGroupId: 'ag-1',
        targetId: 'kw-round-trip',
        targetKind: 'keyword',
        matchType: 'phrase',
        impressions: 1234,
        clicks: 56,
        cost: 41.37,
        purchases1d: 1,
        purchases7d: 3,
        purchases14d: 4,
        purchases30d: 4,
        sales1d: 19.99,
        sales7d: 59.97,
        sales14d: 79.96,
        sales30d: 79.96,
        unitsSold7d: 3,
        topOfSearchImpressionShare: 0.1234,
      },
    ]);
    expect(counts).toEqual({ offered: 1, written: 1 });

    const rows = await readSpTargetFacts(database, profileId, today, today);
    const row = rows.find((candidate) => candidate.targetId === 'kw-round-trip');
    expect(row).toBeDefined();
    if (!row) return;

    // Numeric columns must arrive as numbers, not strings: the contract says
    // `z.number()` and zod does not coerce.
    expect(typeof row.cost).toBe('number');
    expect(row.cost).toBe(41.37);

    const fact = DailyFact.parse(toDailyFact(row));
    expect(fact.targetId).toBe('kw-round-trip');
    expect(fact.sales7d).toBe(59.97);
    expect(fact.topOfSearchImpressionShare).toBeCloseTo(0.1234, 6);
  });

  it('round-trips a search-term fact with a null target id', async () => {
    await upsertSearchTermFacts(database, [
      {
        orgId,
        profileId,
        date: today,
        adProduct: 'SP',
        campaignId: 'c-1',
        adGroupId: 'ag-1',
        targetId: null,
        searchTerm: 'auto target term',
        matchType: null,
        impressions: 10,
        clicks: 2,
        cost: 1.1,
        purchases7d: 0,
        sales7d: 0,
        unitsSold7d: 0,
      },
    ]);

    const rows = await database.db.select().from(factSearchTermDaily);
    const row = rows.find((candidate) => candidate.searchTerm === 'auto target term');
    expect(row).toBeDefined();
    if (row) expect(SearchTermFact.parse(toSearchTermFact(row)).targetId).toBeNull();
  });

  it('round-trips a profile fact, provisional flag included', async () => {
    await upsertProfileFacts(database, [
      {
        orgId,
        profileId,
        date: today,
        currencyCode: 'USD',
        impressions: 100,
        clicks: 10,
        cost: 9.5,
        purchases7d: 1,
        sales7d: 25,
        unitsSold7d: 1,
        provisional: true,
      },
    ]);
    const rows = await database.db.select().from(factProfileDaily);
    const row = rows.find((candidate) => candidate.date === today);
    expect(row).toBeDefined();
    if (row) expect(ProfileFact.parse(toProfileFact(row)).provisional).toBe(true);
  });

  describe('count verification', () => {
    it('upserts idempotently: a re-pull overwrites the same grain', async () => {
      const row = {
        orgId,
        profileId,
        date: today,
        adProduct: 'SP' as const,
        campaignId: 'c-1',
        adGroupId: 'ag-1',
        targetId: 'kw-restated',
        targetKind: 'keyword' as const,
        impressions: 10,
        clicks: 1,
        cost: 0.5,
        sales7d: 0,
        purchases7d: 0,
        unitsSold7d: 0,
      };

      await upsertSpTargetFacts(database, [row]);
      // Sales restate for 14+ days; the trailing re-pull is a normal Tuesday.
      await upsertSpTargetFacts(database, [{ ...row, sales7d: 25, purchases7d: 1 }]);

      const [count] = await database.sql<{ n: string }[]>`
        select count(*) as n from public.fact_sp_target_daily
        where profile_id = ${profileId} and target_id = 'kw-restated'
      `;
      expect(Number(count?.n)).toBe(1);

      const stored = (await readSpTargetFacts(database, profileId, today, today)).find(
        (candidate) => candidate.targetId === 'kw-restated',
      );
      expect(stored?.sales7d).toBe(25);
    });

    it('refuses a batch that contains the same grain twice', async () => {
      const row = {
        orgId,
        profileId,
        date: today,
        adProduct: 'SP' as const,
        campaignId: 'c-1',
        adGroupId: 'ag-1',
        targetId: 'kw-duplicate',
        targetKind: 'keyword' as const,
        impressions: 1,
        clicks: 0,
        cost: 0,
      };
      // Two rows for one grain in one statement is a parse bug upstream. It must
      // fail, not silently collapse into one row and report two written.
      await expectRejection(
        upsertSpTargetFacts(database, [row, row]),
        /cannot affect row a second time/i,
      );
    });

    it('reports the counts it wrote', async () => {
      const counts = await upsertSpTargetFacts(database, []);
      expect(counts).toEqual({ offered: 0, written: 0 });
      expect(FactLoadCountMismatch.name).toBe('FactLoadCountMismatch');
    });
  });

  it('counts mirror rows upserted against rows listed', async () => {
    const counts = await upsertMirrorRows(database, keywords, [
      {
        orgId,
        profileId,
        amazonId: 'kw-mirror-1',
        adProduct: 'SP',
        name: 'widget',
        state: 'enabled',
        campaignId: 'c-1',
        adGroupId: 'ag-1',
        keywordText: 'widget',
        matchType: 'exact',
        bid: 0.75,
      },
      {
        orgId,
        profileId,
        amazonId: 'kw-mirror-2',
        adProduct: 'SP',
        name: 'widget set',
        state: 'paused',
        campaignId: 'c-1',
        adGroupId: 'ag-1',
        keywordText: 'widget set',
        matchType: 'phrase',
        bid: 0.55,
      },
    ]);
    expect(counts).toEqual({ listed: 2, upserted: 2 });

    // A second pass with a changed state overwrites rather than duplicating.
    await upsertMirrorRows(database, keywords, [
      {
        orgId,
        profileId,
        amazonId: 'kw-mirror-1',
        adProduct: 'SP',
        name: 'widget',
        state: 'archived',
        campaignId: 'c-1',
        adGroupId: 'ag-1',
        keywordText: 'widget',
        matchType: 'exact',
        bid: 0.75,
      },
    ]);
    const [row] = await database.sql<{ state: string }[]>`
      select state from public.keywords where profile_id = ${profileId} and amazon_id = 'kw-mirror-1'
    `;
    expect(row?.state).toBe('archived');
  });

  /**
   * Postgres binds at most 65535 parameters per statement, so a single
   * multi-row insert caps out at a few thousand rows. Both batches below are
   * past that cap: one statement each and they fail with a protocol error
   * carrying the whole truncated SQL, which is what the mirror did on the
   * first large live profile.
   */
  describe('batches larger than one statement can bind', () => {
    it('upserts more negatives than a sixteen-column statement can hold', async () => {
      const rows = Array.from({ length: 4_200 }, (_unused, index) => ({
        orgId,
        profileId,
        amazonId: `neg-bulk-${index}`,
        adProduct: 'SP' as const,
        name: `negative ${index}`,
        state: 'enabled' as const,
        campaignId: 'c-1',
        adGroupId: 'ag-1',
        scope: 'ad_group' as const,
        keywordText: `negative ${index}`,
        expression: null,
        matchType: 'negative_exact' as const,
      }));

      const counts = await upsertMirrorRows(database, negatives, rows);
      expect(counts).toEqual({ listed: 4_200, upserted: 4_200 });

      const [stored] = await database.sql<{ n: string }[]>`
        select count(*) as n from public.negatives
         where profile_id = ${profileId} and amazon_id like 'neg-bulk-%'
      `;
      expect(Number(stored?.n)).toBe(4_200);
    });

    it('loads more target facts than a twenty-six-column statement can hold', async () => {
      const rows = Array.from({ length: 3_000 }, (_unused, index) => ({
        orgId,
        profileId,
        date: today,
        adProduct: 'SP' as const,
        campaignId: 'c-bulk',
        adGroupId: 'ag-bulk',
        targetId: `kw-bulk-${index}`,
        targetKind: 'keyword' as const,
        matchType: 'exact' as const,
        impressions: index,
        clicks: 1,
        cost: 0.25,
      }));

      const counts = await upsertSpTargetFacts(database, rows);
      expect(counts).toEqual({ offered: 3_000, written: 3_000 });

      const [stored] = await database.sql<{ n: string }[]>`
        select count(*) as n from public.fact_sp_target_daily
         where profile_id = ${profileId} and campaign_id = 'c-bulk'
      `;
      expect(Number(stored?.n)).toBe(3_000);
    });
  });
});
