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
import { getTableColumns } from 'drizzle-orm';
import { DailyFact, ProfileFact, SearchTermFact } from '@wizard-ads/shared';
import {
  DuplicateFactGrain,
  FactLoadCountMismatch,
  assertUniqueFactGrain,
  readSpTargetFacts,
  toDailyFact,
  toProfileFact,
  toSearchTermFact,
  upsertPlacementFacts,
  upsertProfileFacts,
  upsertSearchTermFacts,
  upsertSpTargetFacts,
} from './queries/facts.js';
import { chunkForInsert } from './queries/chunk.js';
import { upsertMirrorRows } from './queries/entities.js';
import { keywords, negatives } from './schema/entities.js';
import * as enums from './schema/enums.js';
import { factProfileDaily, factSearchTermDaily, factSpTargetDaily } from './schema/facts.js';
import { expectRejection } from './testing/errors.js';
import { createTestDatabase, databaseAvailable } from './testing/harness.js';
import type { DbHandle } from './client.js';
import type { NewSpTargetFact } from './schema/facts.js';
import type { TestDatabase } from './testing/harness.js';

const available = await databaseAvailable();
const USER = '66666666-6666-4666-8666-666666666666';
const PROFILE = '77777777-7777-4777-8777-777777777777';
const ORG = '88888888-8888-4888-8888-888888888888';

/**
 * The conflict-key check is pure, so it runs whether or not a database is
 * reachable — which is the point of it. Before chunking, two rows sharing a
 * grain met one `ON CONFLICT DO UPDATE` statement and Postgres refused them.
 * After chunking, two copies in different chunks are two statements: both
 * succeed, the summed count still matches, and the later one quietly overwrites
 * the earlier. The loaders therefore check the whole batch themselves, before
 * they touch the handle.
 */
describe('duplicate conflict keys, independent of chunk boundaries', () => {
  /** A handle that fails the test if a loader reaches for it. */
  const unusableHandle = {
    get db(): never {
      throw new Error('the loader reached the database before checking the batch');
    },
    get sql(): never {
      throw new Error('the loader reached the database before checking the batch');
    },
  } as unknown as DbHandle;

  const targetRow = (targetId: string): NewSpTargetFact => ({
    orgId: ORG,
    profileId: PROFILE,
    date: '2026-08-01',
    adProduct: 'SP',
    campaignId: 'c-1',
    adGroupId: 'ag-1',
    targetId,
    targetKind: 'keyword',
    impressions: 1,
    clicks: 0,
    cost: 0,
  });

  it('passes a batch whose keys are all distinct', () => {
    expect(() =>
      assertUniqueFactGrain('fact_profile_daily', [{ p: 'a' }, { p: 'b' }], (row) => [row.p]),
    ).not.toThrow();
  });

  it('names the table, the number of repeated keys, and the keys themselves', () => {
    const rows = [{ p: 'a' }, { p: 'b' }, { p: 'a' }, { p: 'b' }, { p: 'c' }];
    try {
      assertUniqueFactGrain('fact_profile_daily', rows, (row) => [row.p]);
      expect.unreachable('a repeated key must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(DuplicateFactGrain);
      const failure = error as DuplicateFactGrain;
      expect(failure.table).toBe('fact_profile_daily');
      expect(failure.duplicateKeys).toBe(2);
      expect(failure.samples).toEqual(['["a"]', '["b"]']);
      expect(failure.message).toContain('fact_profile_daily');
      expect(failure.message).toContain('2 conflict keys appear more than once');
    }
  });

  it('lists at most five offending keys however many there are', () => {
    const rows = Array.from({ length: 24 }, (_unused, index) => ({ p: `k-${index % 12}` }));
    try {
      assertUniqueFactGrain('fact_search_term_daily', rows, (row) => [row.p]);
      expect.unreachable('a repeated key must throw');
    } catch (error) {
      const failure = error as DuplicateFactGrain;
      expect(failure.duplicateKeys).toBe(12);
      expect(failure.samples).toHaveLength(5);
      expect(failure.message).toContain('first 5');
    }
  });

  it('reports key columns only, never a metric value', () => {
    const rows = [
      { targetId: 'kw-1', cost: 41.37 },
      { targetId: 'kw-1', cost: 99.99 },
    ];
    try {
      assertUniqueFactGrain('fact_sp_target_daily', rows, (row) => [row.targetId]);
      expect.unreachable('a repeated key must throw');
    } catch (error) {
      expect((error as DuplicateFactGrain).message).not.toContain('41.37');
      expect((error as DuplicateFactGrain).message).not.toContain('99.99');
    }
  });

  it('treats null and undefined as one value, as `nulls not distinct` does', () => {
    // fact_search_term_daily's grain index is declared `nulls not distinct`, so
    // two auto-target rows with no target id are the same grain to Postgres.
    expect(() =>
      assertUniqueFactGrain(
        'fact_search_term_daily',
        [{ targetId: null }, { targetId: undefined }],
        (row) => [row.targetId],
      ),
    ).toThrow(DuplicateFactGrain);
  });

  it('does not confuse a null component with a row that differs elsewhere', () => {
    expect(() =>
      assertUniqueFactGrain(
        'fact_search_term_daily',
        [
          { targetId: null, term: 'widget' },
          { targetId: null, term: 'widget set' },
        ],
        (row) => [row.targetId, row.term],
      ),
    ).not.toThrow();
  });

  it('catches a duplicate pair split across chunks, before any statement runs', async () => {
    // 26 columns puts the chunk cap around 2 500 rows; a pair at the two ends of
    // a 3 000-row batch therefore lands in different statements, where the old
    // single-statement behaviour saw nothing.
    const rows: NewSpTargetFact[] = Array.from({ length: 3_000 }, (_unused, index) =>
      targetRow(`kw-split-${index}`),
    );
    rows[rows.length - 1] = targetRow('kw-split-0');

    const width = Object.keys(getTableColumns(factSpTargetDaily)).length;
    const chunks = chunkForInsert(rows, width);
    expect(chunks.length, 'the duplicate pair must straddle a chunk boundary').toBeGreaterThan(1);
    expect(chunks[0]).toContain(rows[0]);
    expect(chunks[0]).not.toContain(rows.at(-1));

    await expect(upsertSpTargetFacts(unusableHandle, rows)).rejects.toBeInstanceOf(
      DuplicateFactGrain,
    );
  });

  it('checks every loader, each against its own conflict target', async () => {
    await expect(
      upsertSpTargetFacts(unusableHandle, [targetRow('kw-1'), targetRow('kw-1')]),
    ).rejects.toThrow(/fact_sp_target_daily/);

    const searchTerm = {
      orgId: ORG,
      profileId: PROFILE,
      date: '2026-08-01',
      adProduct: 'SP' as const,
      campaignId: 'c-1',
      adGroupId: 'ag-1',
      targetId: null,
      searchTerm: 'widget',
    };
    await expect(
      upsertSearchTermFacts(unusableHandle, [searchTerm, searchTerm]),
    ).rejects.toThrow(/fact_search_term_daily/);

    const placement = {
      orgId: ORG,
      profileId: PROFILE,
      date: '2026-08-01',
      adProduct: 'SP' as const,
      campaignId: 'c-1',
      placement: 'top_of_search' as const,
    };
    await expect(upsertPlacementFacts(unusableHandle, [placement, placement])).rejects.toThrow(
      /fact_placement_daily/,
    );

    const profile = {
      orgId: ORG,
      profileId: PROFILE,
      date: '2026-08-01',
      currencyCode: 'USD',
    };
    await expect(upsertProfileFacts(unusableHandle, [profile, profile])).rejects.toThrow(
      /fact_profile_daily/,
    );
  });

  it('lets through rows that differ only in a column the conflict target names', async () => {
    // Same everything but the target id: two grains, not a duplicate. The check
    // must not fire, so the loader gets as far as the handle it cannot use.
    await expect(
      upsertSpTargetFacts(unusableHandle, [targetRow('kw-1'), targetRow('kw-2')]),
    ).rejects.toThrow(/reached the database/);
  });
});

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
      // Two rows for one grain is a parse bug upstream. It must fail, not
      // silently collapse into one row and report two written. The loader now
      // catches it itself rather than leaving it to Postgres, so the same batch
      // fails the same way whether or not the pair shares a chunk.
      await expectRejection(
        upsertSpTargetFacts(database, [row, row]),
        /fact_sp_target_daily: 1 conflict key appears more than once/i,
      );

      const [stored] = await database.sql<{ n: string }[]>`
        select count(*) as n from public.fact_sp_target_daily
         where profile_id = ${profileId} and target_id = 'kw-duplicate'
      `;
      expect(Number(stored?.n), 'a refused batch writes nothing').toBe(0);
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

  it('refuses an older provider listing that finishes after newer targeted evidence', async () => {
    const newer = new Date('2026-08-29T12:00:02.000Z');
    const older = new Date('2026-08-29T12:00:01.000Z');
    const newerRow = {
      orgId,
      profileId,
      amazonId: 'kw-out-of-order',
      adProduct: 'SP',
      name: 'newer provider state',
      state: 'enabled',
      campaignId: 'c-1',
      adGroupId: 'ag-1',
      keywordText: 'synthetic',
      matchType: 'exact',
      bid: 0.72,
      syncedAt: newer,
    } as const;
    await upsertMirrorRows(database, keywords, [newerRow]);
    await expect(upsertMirrorRows(database, keywords, [newerRow])).resolves.toEqual({
      listed: 1, upserted: 1,
    });
    await expect(upsertMirrorRows(database, keywords, [{
      orgId,
      profileId,
      amazonId: 'kw-out-of-order',
      adProduct: 'SP',
      name: 'stale provider state',
      state: 'enabled',
      campaignId: 'c-1',
      adGroupId: 'ag-1',
      keywordText: 'synthetic',
      matchType: 'exact',
      bid: 0.70,
      syncedAt: older,
    }])).resolves.toEqual({ listed: 1, upserted: 0, superseded: 1 });
    const [stored] = await database.sql<{ bid: string; synced_at: Date | string }[]>`
      select bid::text as bid, synced_at
        from public.keywords
       where profile_id = ${profileId} and amazon_id = 'kw-out-of-order'
    `;
    expect(Number(stored?.bid)).toBe(0.72);
    expect(new Date(stored?.synced_at ?? 0).toISOString()).toBe(newer.toISOString());
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
