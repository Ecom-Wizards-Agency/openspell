/**
 * Credential custody.
 *
 * The acceptance check is "callable only with the service role", and it is
 * tested from both sides of the gate: the grant (an `authenticated` client is
 * refused before the body runs) and the assertion inside the body (a caller
 * whose JWT says `authenticated` is refused even if the grant were restored).
 *
 * Against a plain Postgres these run on the Vault shim, which stores its values
 * in plaintext. That is why the only values in this file are obviously fake and
 * assembled at runtime: nothing here is, or resembles, a credential.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAdsRefreshToken, revokeAdsRefreshToken, storeAdsRefreshToken } from './queries/tokens.js';
import { expectRejection } from './testing/errors.js';
import { createTestDatabase, databaseAvailable } from './testing/harness.js';
import { asActor, asUser } from './testing/rls.js';
import type { TestDatabase } from './testing/harness.js';

const available = await databaseAvailable();
const USER = '55555555-5555-4555-8555-555555555555';

/** Assembled from fragments so a reviewer grepping the repo finds no credential shape. */
const FAKE_VALUE = ['synthetic', 'not', 'a', 'credential', '0123456789'].join('-');

describe.skipIf(!available)('refresh token RPCs', () => {
  let database: TestDatabase;
  let connectionId: string;

  beforeAll(async () => {
    database = await createTestDatabase('vault');
    const [org] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('vault', ${USER}, 'owner')
    `;
    const [connection] = await database.sql<{ id: string }[]>`
      select id from public.ads_connections where org_id = ${org?.seed_tenant_fixture ?? null}
    `;
    connectionId = connection?.id ?? '';
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('stores a value and hands back a secret id, not the value', async () => {
    const secretId = await storeAdsRefreshToken(database, connectionId, FAKE_VALUE);
    expect(secretId).toMatch(/^[0-9a-f-]{36}$/);

    const [row] = await database.sql<{ vault_secret_id: string; status: string }[]>`
      select vault_secret_id, status from public.ads_connections where id = ${connectionId}
    `;
    expect(row?.vault_secret_id).toBe(secretId);
    expect(row?.status).toBe('active');
  });

  it('never writes the value into a table column', async () => {
    // Every text column on the connection row, checked for the value we stored.
    const [row] = await database.sql<{ hit: boolean }[]>`
      select exists (
        select 1
        from public.ads_connections c,
             lateral jsonb_each_text(to_jsonb(c)) as fields(key, value)
        where c.id = ${connectionId} and fields.value = ${FAKE_VALUE}
      ) as hit
    `;
    expect(row?.hit).toBe(false);
  });

  it('reads the value back for the service role', async () => {
    const value = await getAdsRefreshToken(database, connectionId);
    expect(value).toBe(FAKE_VALUE);
  });

  it('updates in place rather than orphaning a secret', async () => {
    const before = await database.sql<{ n: string }[]>`select count(*) as n from vault.secrets`;
    const secondValue = `${FAKE_VALUE}-rotated`;
    await storeAdsRefreshToken(database, connectionId, secondValue);
    const after = await database.sql<{ n: string }[]>`select count(*) as n from vault.secrets`;

    expect(Number(after[0]?.n)).toBe(Number(before[0]?.n));
    expect(await getAdsRefreshToken(database, connectionId)).toBe(secondValue);
  });

  it('refuses an authenticated caller at the grant', async () => {
    await asUser(database, USER, async (sql) => {
      await expect(
        sql`select public.get_ads_refresh_token(${connectionId})`,
      ).rejects.toThrow(/permission denied/i);
      await expect(
        sql`select public.store_ads_refresh_token(${connectionId}, ${FAKE_VALUE})`,
      ).rejects.toThrow(/permission denied/i);
    });
  });

  it('refuses an anonymous caller', async () => {
    await asActor(database, { role: 'anon' }, async (sql) => {
      await expect(
        sql`select public.get_ads_refresh_token(${connectionId})`,
      ).rejects.toThrow(/permission denied/i);
    });
  });

  it('refuses a caller whose claims say authenticated, even with the grant', async () => {
    // The second gate. This connection is the owner, so the grant lets the call
    // through; the assertion inside the function body is what refuses it,
    // purely because the JWT claims a non-service role.
    const reserved = await database.sql.reserve();
    try {
      await reserved`select set_config('request.jwt.claims', ${JSON.stringify({
        sub: USER,
        role: 'authenticated',
      })}, false)`;
      await expectRejection(
        reserved`select public.get_ads_refresh_token(${connectionId})`,
        /service-role only/i,
      );
    } finally {
      await reserved`select set_config('request.jwt.claims', '', false)`;
      reserved.release();
    }
  });

  it('revokes: the secret is gone and the connection says so', async () => {
    expect(await revokeAdsRefreshToken(database, connectionId)).toBe(true);
    expect(await getAdsRefreshToken(database, connectionId)).toBeNull();

    const [row] = await database.sql<{ status: string; vault_secret_id: string | null }[]>`
      select status, vault_secret_id from public.ads_connections where id = ${connectionId}
    `;
    expect(row?.status).toBe('revoked');
    expect(row?.vault_secret_id).toBeNull();
  });
});
