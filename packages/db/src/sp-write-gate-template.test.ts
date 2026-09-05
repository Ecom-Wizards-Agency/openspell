import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase, databaseAvailable, type TestDatabase } from './testing/harness.js';

const available = await databaseAvailable();
const template = await readFile(new URL('../../../_local/sp-write-gate-seed.TEMPLATE.sql', import.meta.url), 'utf8');

describe.skipIf(!available)('first UI pilot gate template', () => {
  let database: TestDatabase;
  let values: Record<string, string>;
  beforeEach(async () => {
    database = await createTestDatabase('pilot_template');
    const user = randomUUID();
    const [tenant] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture(${randomUUID()}, ${user}, 'owner') as id`;
    const [scope] = await database.sql<{ profile_id: string; connection_id: string; amazon_profile_id: string;
      region: string; marketplace_id: string; currency_code: string; grant_id: string; version_id: string }[]>`
      select * from public.sp_write_profile_grant_versions where org_id = ${tenant!.id}`;
    values = { ORG_ID: tenant!.id, OPERATOR_USER_ID: user, PROFILE_ID: scope!.profile_id,
      CONNECTION_ID: scope!.connection_id, AMAZON_PROFILE_ID: scope!.amazon_profile_id,
      REGION: scope!.region, MARKETPLACE_ID: scope!.marketplace_id, CURRENCY_CODE: scope!.currency_code,
      ENVIRONMENT_VERSION_ID: randomUUID(), GRANT_ID: scope!.grant_id, GRANT_VERSION_ID: randomUUID(),
      EXPECTED_PRIOR_GRANT_VERSION_OR_EMPTY: scope!.version_id,
      WINDOW_EXPIRES_AT: new Date(Date.now() + 60_000).toISOString() };
  }, 60_000);
  afterEach(async () => { await database?.drop(); });

  function render(overrides: Record<string, string> = {}) {
    const data = { ...values, ...overrides };
    return template.replace(/__([A-Z_]+)__/g, (_, key: string) => {
      if (data[key] === undefined) throw new Error(`Missing template value ${key}`);
      return data[key].replaceAll("'", "''");
    });
  }
  async function execute(source: string) {
    const sql = await database.sql.reserve();
    try { await sql.unsafe(source).simple(); }
    finally { await sql`rollback`; sql.release(); }
  }
  async function current() {
    const [row] = await database.sql<{ environment: number; grant: number; mcp: number; approvals: number }[]>`
      select (select count(*)::int from public.sp_write_environment_gate_head) as environment,
        (select count(*)::int from public.sp_write_profile_grant_heads where version_id = ${values['GRANT_VERSION_ID']!}) as grant,
        (select count(*)::int from mcp.write_gate_head) as mcp,
        (select count(*)::int from public.sp_write_authorization_receipts) as approvals`;
    return row!;
  }

  it('cannot execute with unresolved scope placeholders', async () => {
    const before = await current();
    await expect(execute(template)).rejects.toMatchObject({ code: '22P02' });
    expect(await current()).toEqual(before);
  });
  it('rehearses without persistence, then creates exactly one environment and scoped grant', async () => {
    const before = await current();
    await execute(render());
    expect(await current()).toEqual(before);
    await execute(render().replace(/rollback;\s*$/, 'commit;'));
    expect(await current()).toEqual({ ...before, environment: 1, grant: 1 });
    await expect(execute(render().replace(/rollback;\s*$/, 'commit;'))).rejects.toThrow('existing environment head');
    expect(await current()).toEqual({ ...before, environment: 1, grant: 1 });
  });
  const refusalCases: Record<string, string>[] = [
    { CONNECTION_ID: '00000000-0000-4000-8000-000000000099' },
    { EXPECTED_PRIOR_GRANT_VERSION_OR_EMPTY: '00000000-0000-4000-8000-000000000098' },
    { WINDOW_EXPIRES_AT: '2000-01-01T00:00:00.000Z' },
  ];
  it.each(refusalCases)('refuses changed routing, grant or an expired window: %j', async (override) => {
    const before = await current();
    await expect(execute(render(override))).rejects.toThrow();
    expect(await current()).toEqual(before);
  });
});
