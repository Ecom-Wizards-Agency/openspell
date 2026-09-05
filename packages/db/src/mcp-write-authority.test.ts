import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SpWriteExecutionApprovalMode } from '@wizard-ads/shared/sp-writes';
import { applySqlFile, createTestDatabase, databaseAvailable } from './testing/harness.js';

const available = await databaseAvailable();
const migration = fileURLToPath(new URL('../../../supabase/migrations/20260906000000_mcp_write_delegation_mode.sql', import.meta.url));

describe.skipIf(!available)('MCP write authority migration boundary', () => {
  it('requires a commit before consuming the enum and leaves authority and execution empty', async () => {
    const database = await createTestDatabase('mcp_mode', {
      throughMigration: '20260905040000_recommendation_proposal_revisions.sql', applyFixture: false,
    });
    try {
      const text = await readFile(migration, 'utf8');
      await expect(database.sql.begin(async (sql) => {
        await sql.unsafe(text);
        await sql`select 'delegated_mcp'::public.sp_write_approval_mode`;
      })).rejects.toMatchObject({ code: '55P04' });
      const labels = () => database.sql<{ label: string }[]>`
        select e.enumlabel as label from pg_catalog.pg_enum e
        where e.enumtypid = 'public.sp_write_approval_mode'::regtype order by e.enumsortorder
      `;
      expect((await labels()).map((row) => row.label)).toEqual(['manual', 'bounded_live_test']);
      await applySqlFile(database, migration);
      expect((await labels()).map((row) => row.label)).toEqual(SpWriteExecutionApprovalMode.options);
      const [value] = await database.sql<{ mode: string }[]>`select 'delegated_mcp'::public.sp_write_approval_mode as mode`;
      expect(value?.mode).toBe('delegated_mcp');
      const [state] = await database.sql<{ keys: number; grants: number; gate: number; receipts: number; wakes: number }[]>`
        select (select count(*)::int from mcp.api_keys) as keys,
          (select count(*)::int from public.sp_write_profile_grant_heads) as grants,
          (select count(*)::int from public.sp_write_environment_gate_head) as gate,
          (select count(*)::int from public.sp_write_authorization_receipts) as receipts,
          (select count(*)::int from public.sp_write_outbox) as wakes
      `;
      expect(state).toEqual({ keys: 0, grants: 0, gate: 0, receipts: 0, wakes: 0 });
    } finally { await database.drop(); }
  }, 60_000);
});
