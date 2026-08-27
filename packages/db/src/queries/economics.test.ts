import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbHandle } from '../client.js';
import type { NewProductEconomics } from '../schema/economics.js';
import { createTestDatabase, databaseAvailable } from '../testing/harness.js';
import type { TestDatabase } from '../testing/harness.js';
import {
  ProductEconomicsLoadCountMismatch,
  latestProductEconomics,
  upsertProductEconomics,
} from './economics.js';
import { DuplicateFactGrain } from './facts.js';

const available = await databaseAvailable();
const OWNER = '44444444-4444-4444-8444-444444444444';

describe('product economics grain checks without a database', () => {
  const unusableHandle = {
    get db(): never {
      throw new Error('loader touched the database before validating its grain');
    },
  } as unknown as DbHandle;

  it('rejects duplicate profile, ASIN and capture-day grains before writing', async () => {
    const row: NewProductEconomics = {
      orgId: OWNER,
      profileId: OWNER,
      asin: 'B0TEST4405',
      capturedOn: '2026-08-20',
      salePrice: 20,
    };
    await expect(upsertProductEconomics(unusableHandle, [row, row]))
      .rejects.toBeInstanceOf(DuplicateFactGrain);
  });

  it('names offered and written counts in mismatch failures', () => {
    const failure = new ProductEconomicsLoadCountMismatch({ offered: 2, written: 1 });
    expect(failure.message).toMatch(/offered 2 rows, wrote 1/);
  });
});

describe.skipIf(!available)('WP-44 product economics database', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileId: string;

  beforeAll(async () => {
    database = await createTestDatabase('wp44_economics');
    const [org] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('economics-alpha', ${OWNER}, 'owner')
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

  function row(overrides: Partial<NewProductEconomics> = {}): NewProductEconomics {
    return {
      orgId,
      profileId,
      asin: 'B0TEST4405',
      capturedOn: '2026-08-20',
      salePrice: 29.99,
      cogs: 8,
      fbaFees: 4.5,
      referralFees: 4.5,
      otherFees: 1,
      margin: 11.99,
      ltvRevenue: 52,
      ltvOrders: 1.6,
      repeatRate: 0.2,
      currency: 'USD',
      details: { syntheticCohort: 'all-buyers' },
      ...overrides,
    };
  }

  it('loads every offered row at the profile/ASIN/day grain', async () => {
    const counts = await upsertProductEconomics(database, [
      row(),
      row({ asin: 'B0TEST4406', salePrice: 19.99 }),
    ]);
    expect(counts).toEqual({ offered: 2, written: 2 });
  });

  it('reloading a grain overwrites metrics and details rather than duplicating', async () => {
    const counts = await upsertProductEconomics(database, [
      row({ salePrice: 31.5, details: { revision: 2 } }),
    ]);
    expect(counts).toEqual({ offered: 1, written: 1 });
    const rows = await latestProductEconomics(database, { orgId, profileId });
    const updated = rows.find((candidate) => candidate.asin === 'B0TEST4405');
    expect(updated?.salePrice).toBe(31.5);
    expect(updated?.details).toEqual({ revision: 2 });
  });

  it('returns exactly the newest captured row per ASIN', async () => {
    await upsertProductEconomics(database, [
      row({ capturedOn: '2026-08-21', salePrice: 33 }),
      row({ asin: 'B0TEST4406', capturedOn: '2026-08-19', salePrice: 18 }),
    ]);
    const rows = await latestProductEconomics(database, { orgId, profileId });
    expect(rows.filter((candidate) => candidate.asin === 'B0TEST4405')).toHaveLength(1);
    expect(rows.find((candidate) => candidate.asin === 'B0TEST4405')).toMatchObject({
      capturedOn: '2026-08-21',
      salePrice: 33,
    });
    expect(rows.find((candidate) => candidate.asin === 'B0TEST4406')).toMatchObject({
      capturedOn: '2026-08-20',
      salePrice: 19.99,
    });
  });

  it('requires both the owning organisation and profile on reads', async () => {
    expect(await latestProductEconomics(database, {
      orgId: '00000000-0000-4000-8000-000000000000',
      profileId,
    })).toEqual([]);
  });

  it('enforces the currency check in the migrated table', async () => {
    await expect(database.sql`
      insert into public.product_economics
        (org_id, profile_id, asin, captured_on, sale_price, currency)
      values (${orgId}, ${profileId}, 'B0TEST4407', '2026-08-20', 10, 'usd')
    `).rejects.toThrow(/product_economics_currency_check/i);
  });
});
