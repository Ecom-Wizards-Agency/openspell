/**
 * Generic integration metadata and Vault custody.
 *
 * The value is synthetic and assembled at runtime so the public-repo scanner
 * never sees a credential-shaped literal. The suite proves both halves of the
 * boundary: safe metadata is tenant-scoped, while the value is service-role
 * only and never lands in `integration_connections`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  IntegrationSecretStoreError,
  createIntegrationConnection,
  getIntegrationSecret,
  listIntegrationConnections,
  revokeIntegrationSecret,
  setIntegrationConnectionStatus,
  storeIntegrationSecret,
} from './queries/integrations.js';
import { expectRejection } from './testing/errors.js';
import { createTestDatabase, databaseAvailable } from './testing/harness.js';
import { asActor, asUser } from './testing/rls.js';
import type { TestDatabase } from './testing/harness.js';
import type { IntegrationQueryHandle } from './queries/integrations.js';

const available = await databaseAvailable();
const USER = '99999999-9999-4999-8999-999999999999';
const FAKE_VALUE = ['synthetic', 'external', 'key', '0123456789'].join('-');

describe('integration secret error boundary', () => {
  it('drops postgres.js bind parameters before an error reaches its caller', async () => {
    const driverError = new Error('synthetic database failure');
    Object.defineProperty(driverError, 'parameters', { value: [FAKE_VALUE] });
    const handle = {
      sql: async () => Promise.reject(driverError),
    } as unknown as IntegrationQueryHandle;

    try {
      await storeIntegrationSecret(handle, 'connection-id', FAKE_VALUE);
      expect.unreachable('a failed store must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(IntegrationSecretStoreError);
      expect(error).not.toHaveProperty('parameters');
      expect(error).not.toHaveProperty('cause');
      expect((error as Error).message).not.toContain(FAKE_VALUE);
    }
  });
});

describe.skipIf(!available)('integration connections and secret RPCs', () => {
  let database: TestDatabase;
  let orgId: string;
  let connectionId: string;

  beforeAll(async () => {
    database = await createTestDatabase('integrations');
    const [org] = await database.sql<{ seed_tenant_fixture: string }[]>`
      select app.seed_tenant_fixture('integrations', ${USER}, 'owner')
    `;
    orgId = org?.seed_tenant_fixture ?? '';

    const created = await createIntegrationConnection(database, {
      orgId,
      provider: 'datadive',
      label: 'Primary',
      connectedBy: USER,
      config: { cadence: 'daily' },
    });
    connectionId = created.id;
  }, 60_000);

  afterAll(async () => {
    await database?.drop();
  });

  it('creates and lists a safe, org-scoped metadata projection', async () => {
    const rows = await listIntegrationConnections(database, orgId);
    const created = rows.find((row) => row.id === connectionId);

    expect(created).toMatchObject({
      orgId,
      provider: 'datadive',
      label: 'Primary',
      config: { cadence: 'daily' },
      status: 'pending',
      hasSecret: false,
      connectedBy: USER,
      connectedAt: null,
      lastSyncedAt: null,
      lastError: null,
    });
    expect(Object.keys(created ?? {})).not.toContain('vaultSecretId');
  });

  it('sets status and error only inside the named org', async () => {
    const failed = await setIntegrationConnectionStatus(database, {
      orgId,
      connectionId,
      status: 'error',
      lastError: 'Synthetic provider failure',
    });
    expect(failed.status).toBe('error');
    expect(failed.lastError).toBe('Synthetic provider failure');

    await expect(
      setIntegrationConnectionStatus(database, {
        orgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        connectionId,
        status: 'active',
      }),
    ).rejects.toThrow(/not found/i);

    const retry = await createIntegrationConnection(database, {
      orgId,
      provider: 'datadive',
      label: 'Primary',
      connectedBy: USER,
      config: { cadence: 'weekly' },
    });
    expect(retry.id).toBe(connectionId);
    expect(retry.status).toBe('pending');
    expect(retry.lastError).toBeNull();
    // Reconnecting changes custody state, not provider settings a later work
    // package may already have stored.
    expect(retry.config).toEqual({ cadence: 'daily' });
  });

  it('refuses an empty value without changing the connection', async () => {
    await expect(
      database.sql`select public.store_integration_secret(${connectionId}, ${''})`,
    ).rejects.toThrow(/empty token/i);
    await expect(storeIntegrationSecret(database, connectionId, '')).rejects.toBeInstanceOf(
      IntegrationSecretStoreError,
    );
    expect(await getIntegrationSecret(database, connectionId)).toBeNull();
  });

  it('stores and reads the value through Vault, never through the table', async () => {
    const secretId = await storeIntegrationSecret(database, connectionId, FAKE_VALUE);
    expect(secretId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await getIntegrationSecret(database, connectionId)).toBe(FAKE_VALUE);

    const [row] = await database.sql<
      { vault_secret_id: string; status: string; connected_at: string; leaked: boolean }[]
    >`
      select c.vault_secret_id,
             c.status::text as status,
             c.connected_at,
             exists (
               select 1
                 from lateral jsonb_each_text(to_jsonb(c)) as fields(key, value)
                where fields.value = ${FAKE_VALUE}
             ) as leaked
        from public.integration_connections c
       where c.id = ${connectionId}
    `;
    expect(row?.vault_secret_id).toBe(secretId);
    expect(row?.status).toBe('active');
    expect(row?.connected_at).toBeTruthy();
    expect(row?.leaked).toBe(false);
  });

  it('rotates in place instead of orphaning a Vault row', async () => {
    const before = await database.sql<{ n: string }[]>`select count(*) as n from vault.secrets`;
    const rotated = `${FAKE_VALUE}-rotated`;
    await storeIntegrationSecret(database, connectionId, rotated);
    const after = await database.sql<{ n: string }[]>`select count(*) as n from vault.secrets`;

    expect(Number(after[0]?.n)).toBe(Number(before[0]?.n));
    expect(await getIntegrationSecret(database, connectionId)).toBe(rotated);
  });

  it('serializes simultaneous stores onto one Vault row', async () => {
    const before = await database.sql<{ n: string }[]>`select count(*) as n from vault.secrets`;
    const values = [`${FAKE_VALUE}-parallel-a`, `${FAKE_VALUE}-parallel-b`] as const;
    const ids = await Promise.all(
      values.map((value) => storeIntegrationSecret(database, connectionId, value)),
    );
    const after = await database.sql<{ n: string }[]>`select count(*) as n from vault.secrets`;

    expect(new Set(ids).size).toBe(1);
    expect(Number(after[0]?.n)).toBe(Number(before[0]?.n));
    expect(values).toContain(await getIntegrationSecret(database, connectionId));
  });

  it('serializes a store racing a revoke without orphaning a Vault row', async () => {
    const name = `wizard-ads:integration-connection:${connectionId}`;
    await Promise.all([
      storeIntegrationSecret(database, connectionId, `${FAKE_VALUE}-store-race`),
      revokeIntegrationSecret(database, connectionId),
    ]);

    const [connection] = await database.sql<{ vault_secret_id: string | null }[]>`
      select vault_secret_id from public.integration_connections where id = ${connectionId}
    `;
    const [vault] = await database.sql<{ ids: string[] }[]>`
      select coalesce(array_agg(id), '{}') as ids from vault.secrets where name = ${name}
    `;
    const ids = vault?.ids ?? [];
    expect(ids).toHaveLength(connection?.vault_secret_id === null ? 0 : 1);
    if (connection?.vault_secret_id) expect(ids).toEqual([connection.vault_secret_id]);

    // The remaining permission/revoke checks start from a live credential.
    await storeIntegrationSecret(database, connectionId, `${FAKE_VALUE}-after-race`);
  });

  it('refuses authenticated and anonymous callers at the grant', async () => {
    await asUser(database, USER, async (sql) => {
      await expect(
        sql`select public.get_integration_secret(${connectionId})`,
      ).rejects.toThrow(/permission denied/i);
      await expect(
        sql`select public.store_integration_secret(${connectionId}, ${FAKE_VALUE})`,
      ).rejects.toThrow(/permission denied/i);
      await expect(
        sql`select public.revoke_integration_secret(${connectionId})`,
      ).rejects.toThrow(/permission denied/i);
    });
    await asActor(database, { role: 'anon' }, async (sql) => {
      await expect(
        sql`select public.get_integration_secret(${connectionId})`,
      ).rejects.toThrow(/permission denied/i);
    });
  });

  it('keeps the service-role assertion as a second gate', async () => {
    const reserved = await database.sql.reserve();
    try {
      await reserved`select set_config('request.jwt.claims', ${JSON.stringify({
        sub: USER,
        role: 'authenticated',
      })}, false)`;
      await expectRejection(
        reserved`select public.get_integration_secret(${connectionId})`,
        /service-role only/i,
      );
    } finally {
      await reserved`select set_config('request.jwt.claims', '', false)`;
      reserved.release();
    }
  });

  it('revokes the connection and deletes the Vault row', async () => {
    expect(await revokeIntegrationSecret(database, connectionId)).toBe(true);
    expect(await getIntegrationSecret(database, connectionId)).toBeNull();

    const [row] = await database.sql<{ status: string; vault_secret_id: string | null }[]>`
      select status::text as status, vault_secret_id
        from public.integration_connections
       where id = ${connectionId}
    `;
    expect(row?.status).toBe('revoked');
    expect(row?.vault_secret_id).toBeNull();
    expect(await revokeIntegrationSecret(database, connectionId)).toBe(false);
  });
});
