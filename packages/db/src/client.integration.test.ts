import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { createDb } from './client.js';
import { adminConnectionString, databaseAvailable } from './testing/harness.js';

const available = await databaseAvailable();

describe.skipIf(!available)('createDb physical connection lifecycle', () => {
  it('releases the physical session after the configured idle interval', async () => {
    const applicationName = `openspell_pool_${randomUUID().slice(0, 8)}`;
    const connectionUrl = new URL(adminConnectionString());
    connectionUrl.searchParams.set('application_name', applicationName);

    const observer = postgres(adminConnectionString(), { max: 1, prepare: false });
    const handle = createDb({
      connectionString: connectionUrl.toString(),
      max: 1,
      idleTimeoutSeconds: 1,
    });

    try {
      await handle.sql`select 1`;
      const opened = await sessionCount(observer, applicationName);
      expect(opened).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 1_600));
      const released = await sessionCount(observer, applicationName);
      expect(released).toBe(0);
    } finally {
      await handle.close();
      await observer.end({ timeout: 1 });
    }
  });
});

async function sessionCount(sql: postgres.Sql, applicationName: string): Promise<number> {
  const rows = await sql<{ count: number }[]>`
    select count(*)::int as count
      from pg_stat_activity
     where application_name = ${applicationName}
  `;
  return rows[0]?.count ?? 0;
}
