/**
 * The connect flow, against a real migrated database and a fake Amazon.
 *
 * The database is real because the interesting assertions are all about what
 * landed in it: the counts, the upsert's conflict behaviour, and the fact that
 * the refresh token is not in a column. The Amazon side is fake because the
 * wizard-ads redirect URI is not registered on the LWA application yet, so a
 * live grant is not merely undesirable in a test, it is impossible.
 *
 * Region counts here are small and synthetic. The real grant returns roughly
 * two hundred profiles across three regions; what this suite proves is the
 * invariant that holds at any size, `listed === upserted`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAdsRefreshToken } from '@wizard-ads/db';
import { asActor, asUser, createTestDatabase, databaseAvailable } from '@wizard-ads/db/testing';
import type { TestDatabase } from '@wizard-ads/db/testing';
import type { Region } from '@wizard-ads/shared';
import { completeConnection } from '../../app/api/amazon/oauth/_lib/connect';
import { normalizeProfile } from '../../app/api/amazon/oauth/_lib/lwa';
import type { AmazonAdsProfile, AmazonOAuthPort } from '../../app/api/amazon/oauth/_lib/lwa';

const available = await databaseAvailable();
const OWNER = '44444444-4444-4444-8444-444444444444';
const OTHER_OWNER = '66666666-6666-4666-8666-666666666666';

/** Assembled from fragments: no string in this file may look like a credential. */
const fakeToken = (suffix: string) => ['synthetic', 'renewal', 'value', suffix].join('-');
const ACCESS = ['synthetic', 'access'].join('-');

interface FakeOptions {
  perRegion: Partial<Record<Region, number>>;
  failing?: Partial<Record<Region, string>>;
  token?: string;
}

function fakeAmazon(options: FakeOptions): AmazonOAuthPort & { exchanges: number } {
  const port = {
    exchanges: 0,
    async exchangeAuthorizationCode() {
      port.exchanges += 1;
      return {
        accessToken: ACCESS,
        refreshToken: options.token ?? fakeToken('a'),
        expiresIn: 3600,
        scope: 'advertising::campaign_management',
      };
    },
    async listProfiles(region: Region): Promise<AmazonAdsProfile[]> {
      const failure = options.failing?.[region];
      if (failure) throw new Error(failure);
      const count = options.perRegion[region] ?? 0;
      return Array.from({ length: count }, (_unused, index) => ({
        profileId: `${region.toLowerCase()}-profile-${index + 1}`,
        countryCode: region === 'NA' ? 'US' : region === 'EU' ? 'DE' : 'JP',
        currencyCode: region === 'NA' ? 'USD' : region === 'EU' ? 'EUR' : 'JPY',
        timezone: 'UTC',
        accountType: 'seller',
        accountName: `${region} account ${index + 1}`,
        amazonAccountId: `ENTITY${region}${index + 1}`,
      }));
    },
  };
  return port;
}

describe.skipIf(!available)('completeConnection', () => {
  let database: TestDatabase;
  let orgId: string;
  let otherOrgId: string;

  beforeAll(async () => {
    database = await createTestDatabase('weboauth');
    const [org] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('weboauth', ${OWNER}, 'owner')
    `;
    orgId = org?.seed_tenant_fixture ?? '';
    const [other] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('weboauth-other', ${OTHER_OWNER}, 'owner')
    `;
    otherOrgId = other?.seed_tenant_fixture ?? '';
  }, 120_000);

  afterAll(async () => {
    await database?.drop();
  });

  const input = (org: () => string) => ({
    get orgId() {
      return org();
    },
    userId: OWNER,
    label: 'Amazon Ads',
    lwaClientId: 'amzn1.application-oa2-client.synthetic',
    scope: 'advertising::campaign_management',
    code: 'synthetic-authorization-code',
  });

  it('lands every profile Amazon listed, per region, and counts them', async () => {
    const port = fakeAmazon({ perRegion: { NA: 3, EU: 5, FE: 1 } });
    const result = await completeConnection(database, port, input(() => orgId));

    expect(port.exchanges).toBe(1);
    expect(result.totalListed).toBe(9);
    // Program rule 4: the count that matters is what reached the table.
    expect(result.totalUpserted).toBe(result.totalListed);
    expect(
      result.regions.map((outcome) => [outcome.region, outcome.listed, outcome.upserted]),
    ).toEqual([
      ['NA', 3, 3],
      ['EU', 5, 5],
      ['FE', 1, 1],
    ]);

    const [row] = await database.sql<{ n: string }[]>`
      select count(*) as n from public.ad_profiles
       where org_id = ${orgId} and connection_id = ${result.connectionId}
    `;
    expect(Number(row?.n)).toBe(9);
  });

  it('marks the connection active with the credential in Vault, not in a column', async () => {
    const token = fakeToken('b');
    const result = await completeConnection(
      database,
      fakeAmazon({ perRegion: { NA: 1 }, token }),
      input(() => orgId),
    );

    const [connection] = await database.sql<
      { status: string; vault_secret_id: string | null; scope: string | null }[]
    >`
      select status, vault_secret_id, scope from public.ads_connections where id = ${result.connectionId}
    `;
    expect(connection?.status).toBe('active');
    expect(connection?.vault_secret_id).not.toBeNull();
    expect(connection?.scope).toBe('advertising::campaign_management');

    // Nothing on the row equals the value we stored.
    const [leak] = await database.sql<{ hit: boolean }[]>`
      select exists (
        select 1 from public.ads_connections c,
             lateral jsonb_each_text(to_jsonb(c)) as fields(key, value)
         where c.id = ${result.connectionId} and fields.value = ${token}
      ) as hit
    `;
    expect(leak?.hit).toBe(false);

    // The worker's read, as the service role, does return it.
    expect(await getAdsRefreshToken(database, result.connectionId)).toBe(token);
  });

  it('is idempotent: reconnecting reuses the connection row', async () => {
    const before = await database.sql<{ n: string }[]>`
      select count(*) as n from public.ads_connections where org_id = ${orgId}
    `;
    await completeConnection(
      database,
      fakeAmazon({ perRegion: { NA: 1 } }),
      input(() => orgId),
    );
    const after = await database.sql<{ n: string }[]>`
      select count(*) as n from public.ads_connections where org_id = ${orgId}
    `;
    expect(Number(after[0]?.n)).toBe(Number(before[0]?.n));
  });

  it('never re-disables a synced profile or wipes a target on reconnect', async () => {
    await completeConnection(
      database,
      fakeAmazon({ perRegion: { NA: 2 } }),
      input(() => orgId),
    );
    await database.sql`
      update public.ad_profiles
         set sync_enabled = true, target_acos = 0.2500, goal_lens = 'scale'
       where org_id = ${orgId} and amazon_profile_id = 'na-profile-1'
    `;

    const result = await completeConnection(
      database,
      fakeAmazon({ perRegion: { NA: 2 } }),
      input(() => orgId),
    );
    // Second pass: nothing new, everything updated.
    const na = result.regions.find((outcome) => outcome.region === 'NA');
    expect(na?.created).toBe(0);
    expect(na?.upserted).toBe(2);

    const [row] = await database.sql<
      { sync_enabled: boolean; target_acos: string | null; goal_lens: string | null }[]
    >`
      select sync_enabled, target_acos, goal_lens from public.ad_profiles
       where org_id = ${orgId} and amazon_profile_id = 'na-profile-1'
    `;
    expect(row?.sync_enabled).toBe(true);
    expect(Number(row?.target_acos)).toBeCloseTo(0.25, 4);
    expect(row?.goal_lens).toBe('scale');
  });

  it('records a failing region and still lands the others', async () => {
    const result = await completeConnection(
      database,
      fakeAmazon({ perRegion: { NA: 2, EU: 2 }, failing: { FE: 'HTTP 401 unauthorized' } }),
      input(() => otherOrgId),
    );

    const fe = result.regions.find((outcome) => outcome.region === 'FE');
    expect(fe?.error).toMatch(/401/);
    expect(result.totalUpserted).toBe(4);

    const [connection] = await database.sql<{ status: string }[]>`
      select status from public.ads_connections where id = ${result.connectionId}
    `;
    // Partial grants are normal, so the connection stays usable.
    expect(connection?.status).toBe('active');
  });

  it('marks the connection in error when every region refuses', async () => {
    const result = await completeConnection(
      database,
      fakeAmazon({
        perRegion: {},
        failing: { NA: 'HTTP 403', EU: 'HTTP 403', FE: 'HTTP 403' },
      }),
      input(() => otherOrgId),
    );

    expect(result.totalUpserted).toBe(0);
    const [connection] = await database.sql<{ status: string; last_error: string | null }[]>`
      select status, last_error from public.ads_connections where id = ${result.connectionId}
    `;
    expect(connection?.status).toBe('error');
    expect(connection?.last_error).toMatch(/403/);
  });

  it('keeps two orgs with the same Amazon ids in separate rosters', async () => {
    // Both orgs saw `na-profile-1`, and the unique key is (org, profile), so
    // there are two rows and neither connection points at the other's.
    const rows = await database.sql<{ org_id: string; connection_id: string }[]>`
      select org_id, connection_id from public.ad_profiles
       where amazon_profile_id = 'na-profile-1'
       order by org_id
    `;
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.org_id))).toEqual(new Set([orgId, otherOrgId]));
    expect(rows[0]?.connection_id).not.toBe(rows[1]?.connection_id);

    const [mixed] = await database.sql<{ n: string }[]>`
      select count(*) as n
        from public.ad_profiles p
        join public.ads_connections c on c.id = p.connection_id
       where c.org_id <> p.org_id
    `;
    expect(Number(mixed?.n)).toBe(0);
  });

  it('refuses to read the credential as anything but the service role', async () => {
    const [connection] = await database.sql<{ id: string }[]>`
      select id from public.ads_connections where org_id = ${orgId} limit 1
    `;
    const connectionId = connection?.id ?? '';

    await asUser(database, OWNER, async (sql) => {
      await expect(
        sql`select public.get_ads_refresh_token(${connectionId})`,
      ).rejects.toThrow(/permission denied/i);
    });
    await asActor(database, { role: 'anon' }, async (sql) => {
      await expect(
        sql`select public.get_ads_refresh_token(${connectionId})`,
      ).rejects.toThrow(/permission denied/i);
    });
  });
});

describe('normalizeProfile', () => {
  it('turns Amazon numeric ids into strings and uppercases the codes', () => {
    expect(
      normalizeProfile({
        profileId: 1234567890,
        countryCode: 'de',
        currencyCode: 'eur',
        timezone: 'Europe/Berlin',
        accountInfo: { id: 'ENTITY1', type: 'Seller', name: 'Example' },
      }),
    ).toEqual({
      profileId: '1234567890',
      countryCode: 'DE',
      currencyCode: 'EUR',
      timezone: 'Europe/Berlin',
      accountType: 'seller',
      accountName: 'Example',
      amazonAccountId: 'ENTITY1',
    });
  });

  it('drops a row it cannot key or place', () => {
    expect(normalizeProfile({ countryCode: 'US' })).toBeNull();
    expect(normalizeProfile({ profileId: 1, countryCode: 'US' })).toBeNull();
    expect(normalizeProfile(null)).toBeNull();
  });

  it('survives an account type Amazon has not invented yet', () => {
    const profile = normalizeProfile({
      profileId: '1',
      countryCode: 'US',
      currencyCode: 'USD',
      timezone: 'UTC',
      accountInfo: { type: 'marketplace-of-the-future' },
    });
    expect(profile?.accountType).toBeNull();
  });
});
