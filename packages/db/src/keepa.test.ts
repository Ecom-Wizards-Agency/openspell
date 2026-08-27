import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createCompetitorLink,
  latestKeepaObservations,
  listCompetitorLinks,
  loadKeepaBsrObservations,
  loadNewCompetitorPriceEvents,
  removeCompetitorLink,
} from './queries/keepa.js';
import { DuplicateFactGrain } from './queries/facts.js';
import { createTestDatabase, databaseAvailable } from './testing/harness.js';
import type { DbHandle } from './client.js';
import type { TestDatabase } from './testing/harness.js';

const available = await databaseAvailable();
const ORG = '11111111-1111-4111-8111-111111111111';
const observedAt = new Date('2026-08-27T12:00:00.000Z');

describe('Keepa identity grain checks', () => {
  const unusable = {
    get db(): never { throw new Error('database reached before duplicate check'); },
  } as unknown as DbHandle;

  it('rejects duplicate observation keys before touching the database', async () => {
    const row = { orgId: ORG, asin: 'B0TEST0001', observedAt, category: '' };
    await expect(loadKeepaBsrObservations(unusable, [row, row])).rejects.toBeInstanceOf(DuplicateFactGrain);
  });

  it('rejects duplicate event keys before touching the database', async () => {
    const row = { orgId: ORG, asin: 'B0TEST0002', eventKind: 'deal_start' as const, detectedAt: observedAt };
    await expect(loadNewCompetitorPriceEvents(unusable, [row, row])).rejects.toBeInstanceOf(DuplicateFactGrain);
  });
});

describe.skipIf(!available)('Keepa database loaders', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileId: string;

  beforeAll(async () => {
    database = await createTestDatabase('keepa');
    const [org] = await database.sql<{ id: string }[]>`
      insert into public.orgs (slug, name) values ('keepa-test', 'Keepa test') returning id
    `;
    orgId = org?.id ?? '';
    const [connection] = await database.sql<{ id: string }[]>`
      insert into public.ads_connections (org_id, label) values (${orgId}, 'ads') returning id
    `;
    const [profile] = await database.sql<{ id: string }[]>`
      insert into public.ad_profiles
        (org_id, connection_id, amazon_profile_id, region, country_code, currency_code, timezone)
      values (${orgId}, ${connection?.id ?? ''}, 'profile', 'NA', 'US', 'USD', 'UTC') returning id
    `;
    profileId = profile?.id ?? '';
  }, 60_000);

  afterAll(async () => database?.drop());

  it('accounts new and existing observation/event identities exactly', async () => {
    const observation = {
      orgId,
      asin: 'B0TEST0001',
      observedAt,
      category: '123',
      price: 19.99,
      buyBoxPrice: 18.99,
      lightningDeal: true,
      coupon: [-10, 0] as const,
    };
    expect(await loadKeepaBsrObservations(database, [observation])).toEqual({ offered: 1, existing: 0, written: 1 });
    expect(await loadKeepaBsrObservations(database, [observation])).toEqual({ offered: 1, existing: 1, written: 0 });
    expect((await latestKeepaObservations(database, orgId, [observation.asin]))[0]).toMatchObject({
      asin: observation.asin,
      category: '123',
      buyBoxPrice: 18.99,
    });

    const event = { orgId, asin: 'B0TEST0002', eventKind: 'deal_start' as const, detectedAt: observedAt };
    expect(await loadNewCompetitorPriceEvents(database, [event])).toMatchObject({ offered: 1, existing: 0, written: 1 });
    expect(await loadNewCompetitorPriceEvents(database, [event])).toMatchObject({ offered: 1, existing: 1, written: 0 });
  });

  it('creates, lists, and removes a profile-scoped competitor pair', async () => {
    const created = await createCompetitorLink(database, {
      orgId,
      profileId,
      ourAsin: 'b0test0001',
      competitorAsin: 'b0test0002',
    });
    expect(created).toMatchObject({ ourAsin: 'B0TEST0001', competitorAsin: 'B0TEST0002', marketplace: 'US' });
    expect(await listCompetitorLinks(database, orgId, profileId)).toHaveLength(1);
    await removeCompetitorLink(database, { orgId, id: created.id });
    expect(await listCompetitorLinks(database, orgId, profileId)).toEqual([]);
  });
});
