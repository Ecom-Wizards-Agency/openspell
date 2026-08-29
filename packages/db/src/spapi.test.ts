import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  SpApiCredentialStoreError,
  createSpApiConnection,
  getSpApiRefreshToken,
  listSqpScheduleScopes,
  resolveActiveSpApiProfileBinding,
  revokeSpApiRefreshToken,
  storeSpApiRefreshToken,
  upsertSpApiProfileBinding,
} from './queries/spapi.js';
import { createTestDatabase, databaseAvailable } from './testing/harness.js';
import { asActor, asUser } from './testing/rls.js';
import type { TestDatabase } from './testing/harness.js';

const available = await databaseAvailable();
const OWNER_A = '77777777-7777-4777-8777-777777777771';
const OWNER_B = '77777777-7777-4777-8777-777777777772';
const VALUE = ['synthetic', 'spapi', 'credential', '0123456789'].join('-');

describe('SP-API credential error boundary', () => {
  it('drops postgres bind parameters before surfacing a failed store', async () => {
    const driverError = new Error('synthetic database failure');
    Object.defineProperty(driverError, 'parameters', { value: [VALUE] });
    const handle = { sql: async () => Promise.reject(driverError) } as never;
    const error = await storeSpApiRefreshToken(handle, {
      orgId: 'org-id',
      connectionId: 'connection-id',
      refreshToken: VALUE,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SpApiCredentialStoreError);
    expect(error).not.toHaveProperty('parameters');
    expect(error).not.toHaveProperty('cause');
    expect((error as Error).message).not.toContain(VALUE);
  });
});

describe.skipIf(!available)('SP-API profile bindings and Vault custody', () => {
  let database: TestDatabase;
  let orgA: string;
  let orgB: string;
  let profileA: string;
  let connectionA: string;
  let connectionB: string;
  let extraProfileId: string;
  const marketplaceA = 'ATVPDKIKX0DER';

  beforeAll(async () => {
    database = await createTestDatabase('spapi_binding');
    const [a] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('spapi-a', ${OWNER_A}, 'owner')
    `;
    const [b] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('spapi-b', ${OWNER_B}, 'owner')
    `;
    orgA = a?.seed_tenant_fixture ?? '';
    orgB = b?.seed_tenant_fixture ?? '';
    const [scopeA] = await database.sql<{ profile_id: string; connection_id: string }[]>`
      select profile_id, connection_id
        from public.spapi_profile_bindings
       where org_id = ${orgA}
    `;
    const [scopeB] = await database.sql<{ connection_id: string }[]>`
      select connection_id
        from public.spapi_profile_bindings
       where org_id = ${orgB}
    `;
    profileA = scopeA?.profile_id ?? '';
    connectionA = scopeA?.connection_id ?? '';
    connectionB = scopeB?.connection_id ?? '';
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('makes a cross-tenant profile/connection pair unrepresentable', async () => {
    const [extra] = await database.sql<{ id: string }[]>`
      insert into public.ad_profiles
        (org_id, amazon_profile_id, region, country_code, currency_code, timezone)
      values (${orgA}, 'spapi-extra-profile', 'NA', 'US', 'USD', 'UTC')
      returning id
    `;
    extraProfileId = extra?.id ?? '';
    await expect(database.sql`
      insert into public.spapi_profile_bindings
        (org_id, profile_id, connection_id, marketplace_id)
      values (${orgA}, ${extra?.id ?? ''}, ${connectionB}, 'spapi-b-market')
    `).rejects.toThrow(/foreign key|not authorized/i);
  });

  it('creates safe metadata and assigns one exact marketplace through typed queries', async () => {
    const created = await createSpApiConnection(database, {
      orgId: orgA,
      label: 'Secondary',
      sellingPartnerId: 'synthetic-secondary-seller',
      marketplaceIds: [` ${marketplaceA} `, marketplaceA],
    });
    expect(created).toMatchObject({
      orgId: orgA,
      label: 'Secondary',
      marketplaceIds: [marketplaceA],
      status: 'pending',
      hasCredential: false,
    });
    expect(Object.keys(created)).not.toContain('vaultSecretId');

    await expect(upsertSpApiProfileBinding(database, {
      orgId: orgA,
      profileId: extraProfileId,
      connectionId: created.id,
      marketplaceId: marketplaceA,
    })).resolves.toMatchObject({
      orgId: orgA,
      profileId: extraProfileId,
      connectionId: created.id,
      marketplaceId: marketplaceA,
      region: 'NA',
      enabled: true,
    });

    await expect(upsertSpApiProfileBinding(database, {
      orgId: orgB,
      profileId: profileA,
      connectionId: connectionA,
      marketplaceId: marketplaceA,
    })).rejects.toThrow(/returned no row|not authorized/i);
  });

  it('rejects unsupported and wrong-region marketplaces before scheduling', async () => {
    const [profile] = await database.sql<{ id: string }[]>`
      insert into public.ad_profiles
        (org_id, amazon_profile_id, region, country_code, currency_code, timezone)
      values (${orgA}, 'spapi-region-profile', 'NA', 'US', 'USD', 'UTC')
      returning id
    `;
    const euMarketplace = 'A1PA6795UKMFR9';
    const connection = await createSpApiConnection(database, {
      orgId: orgA,
      label: 'Wrong region',
      sellingPartnerId: 'synthetic-region-seller',
      marketplaceIds: [euMarketplace],
    });
    await expect(upsertSpApiProfileBinding(database, {
      orgId: orgA,
      profileId: profile?.id ?? '',
      connectionId: connection.id,
      marketplaceId: euMarketplace,
    })).rejects.toThrow(/does not match.*region/i);

    const unsupportedConnection = await createSpApiConnection(database, {
      orgId: orgA,
      label: 'Unsupported marketplace',
      sellingPartnerId: 'synthetic-unsupported-seller',
      marketplaceIds: ['unsupported-marketplace'],
    });
    await expect(upsertSpApiProfileBinding(database, {
      orgId: orgA,
      profileId: profile?.id ?? '',
      connectionId: unsupportedConnection.id,
      marketplaceId: 'unsupported-marketplace',
    })).rejects.toThrow(/unsupported/i);
  });

  it('prevents a profile-region edit from invalidating an existing binding', async () => {
    await expect(database.sql`
      update public.ad_profiles set region = 'EU' where id = ${profileA}
    `).rejects.toThrow(/invalidate/i);
  });

  it('rejects a marketplace outside the connection authorization', async () => {
    await expect(database.sql`
      update public.spapi_profile_bindings
         set marketplace_id = 'not-authorized'
       where org_id = ${orgA}
    `).rejects.toThrow(/not authorized/i);
    await expect(database.sql`
      update public.spapi_connections
         set marketplace_ids = array['different-market']
       where id = ${connectionA}
    `).rejects.toThrow(/orphan/i);
  });

  it('stores, reads, and rotates one credential without table leakage', async () => {
    const secretId = await storeSpApiRefreshToken(database, {
      orgId: orgA,
      connectionId: connectionA,
      refreshToken: VALUE,
    });
    expect(secretId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await getSpApiRefreshToken(database, {
      orgId: orgA,
      connectionId: connectionA,
    })).toBe(VALUE);
    const [row] = await database.sql<{ leaked: boolean; status: string }[]>`
      select c.status::text as status,
             exists (
               select 1 from lateral jsonb_each_text(to_jsonb(c)) fields(key, value)
                where fields.value = ${VALUE}
             ) as leaked
        from public.spapi_connections c where c.id = ${connectionA}
    `;
    expect(row).toMatchObject({ leaked: false, status: 'active' });

    const before = await database.sql<{ count: string }[]>`select count(*) from vault.secrets`;
    const rotated = `${VALUE}-rotated`;
    expect(await storeSpApiRefreshToken(database, {
      orgId: orgA,
      connectionId: connectionA,
      refreshToken: rotated,
    })).toBe(secretId);
    const after = await database.sql<{ count: string }[]>`select count(*) from vault.secrets`;
    expect(after[0]?.count).toBe(before[0]?.count);
    expect(await getSpApiRefreshToken(database, {
      orgId: orgA,
      connectionId: connectionA,
    })).toBe(rotated);
  });

  it('resolves only the exact active profile and marketplace', async () => {
    await expect(resolveActiveSpApiProfileBinding(database, {
      orgId: orgA,
      profileId: profileA,
      marketplaceId: marketplaceA,
    })).resolves.toMatchObject({
      orgId: orgA,
      profileId: profileA,
      connectionId: connectionA,
      marketplaceId: marketplaceA,
      region: 'NA',
    });
    await expect(resolveActiveSpApiProfileBinding(database, {
      orgId: orgA,
      profileId: profileA,
      marketplaceId: 'wrong-market',
    })).resolves.toBeNull();
    await expect(resolveActiveSpApiProfileBinding(database, {
      orgId: orgB,
      profileId: profileA,
      marketplaceId: marketplaceA,
    })).resolves.toBeNull();
  });

  it('reconciles valid, duplicate, invalid, and missing advertised ASIN rows', async () => {
    await database.sql`
      insert into public.product_ads
        (org_id, profile_id, amazon_id, ad_product, state, campaign_id, ad_group_id, asin)
      values
        (${orgA}, ${profileA}, 'spapi-pa-duplicate', 'SP', 'enabled', 'c-1', 'ag-1', 'b0test0001'),
        (${orgA}, ${profileA}, 'spapi-pa-invalid', 'SP', 'enabled', 'c-1', 'ag-1', 'invalid'),
        (${orgA}, ${profileA}, 'spapi-pa-missing', 'SP', 'enabled', 'c-1', 'ag-1', null)
    `;
    const scopes = await listSqpScheduleScopes(database);
    const scope = scopes.find((candidate) => candidate.profileId === profileA);
    expect(scope).toMatchObject({
      asins: ['B0TEST0001'],
      sourceRows: 4,
      duplicateRows: 1,
      refusedRows: 2,
    });
  });

  it('refuses browser callers at the Vault grant and revokes worker access', async () => {
    await asUser(database, OWNER_A, async (sql) => {
      await expect(sql`select public.get_spapi_refresh_token(${connectionA})`)
        .rejects.toThrow(/permission denied/i);
    });
    await asActor(database, { role: 'anon' }, async (sql) => {
      await expect(sql`select public.get_spapi_refresh_token(${connectionA})`)
        .rejects.toThrow(/permission denied/i);
    });
    expect(await revokeSpApiRefreshToken(database, {
      orgId: orgA,
      connectionId: connectionA,
    })).toBe(true);
    expect(await getSpApiRefreshToken(database, {
      orgId: orgA,
      connectionId: connectionA,
    })).toBeNull();
    await expect(resolveActiveSpApiProfileBinding(database, {
      orgId: orgA,
      profileId: profileA,
      marketplaceId: marketplaceA,
    })).resolves.toBeNull();
  });
});
