import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { createTestDatabase, databaseAvailable, type TestDatabase } from './testing/harness.js';
import { asAnon, asServiceRole, asUser } from './testing/rls.js';
import { seedSyntheticMcpProposal, type SyntheticMcpSource } from './testing/mcp-write-source.js';
import { mcpWritePreviews, mcpBidProposalSources } from './schema/mcp.js';
import { getExportBatch } from './queries/recommendations.js';
import { previewSpWrite } from './queries/sp-write-plan-builder.js';
import { reconcileEntityChangeLinks } from './queries/entities.js';
import { createReversionExport, getReversionBatchPreview, listTimeline, listTimelineFacets, listReversionBatches } from './queries/time-machine.js';

const available = await databaseAvailable();
describe.skipIf(!available)('MCP proposal source closure and legacy boundaries', () => {
  let database: TestDatabase;
  beforeAll(async () => { database = await createTestDatabase('mcp_source'); }, 60_000);
  afterAll(async () => { await database?.drop(); });
  async function fixture() {
    const userId = randomUUID();
    const [tenant] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture(${randomUUID()}, ${userId}, 'owner') as id`;
    const orgId = tenant!.id;
    const [profile] = await database.sql<{ id: string }[]>`select id from public.ad_profiles where org_id = ${orgId}`;
    return { actor: { orgId, userId }, profileId: profile!.id };
  }
  async function counts(orgId: string) {
    const [row] = await database.sql`select
      (select count(*)::int from public.sp_write_plans where org_id = ${orgId}) as plans,
      (select count(*)::int from public.apply_batches where org_id = ${orgId}) as batches,
      (select count(*)::int from public.apply_rows where org_id = ${orgId}) as rows,
      (select count(*)::int from mcp.write_previews where org_id = ${orgId}) as previews,
      (select count(*)::int from mcp.bid_proposal_sources where org_id = ${orgId}) as sources`;
    return row;
  }

  it('mirrors private columns and keeps proposal sources inaccessible to browser roles', async () => {
    for (const table of [mcpWritePreviews, mcpBidProposalSources]) {
      const config = getTableConfig(table);
      const columns = await database.sql<{ name: string; not_null: boolean }[]>`
        select column_name as name, is_nullable = 'NO' as not_null from information_schema.columns
        where table_schema = ${config.schema!} and table_name = ${config.name} order by column_name`;
      expect(columns).toEqual(config.columns.map((column) => ({ name: column.name, not_null: column.notNull }))
        .sort((a, b) => a.name.localeCompare(b.name)));
      await expect(asAnon(database, (sql) => sql.unsafe(`select * from mcp.${config.name}`))).rejects.toMatchObject({ code: '42501' });
    }
  });

  const invalid: Array<[string, (source: SyntheticMcpSource) => void]> = [
    ['missing source', (s) => { s.omitSource = true; }],
    ['wrong issuer', (s) => { s.artifact.issuerUserId = randomUUID(); }],
    ['wrong key', (s) => { s.artifact.keyId = randomUUID(); }],
    ['wrong request', (s) => { s.artifact.requestId = randomUUID(); }],
    ['wrong prepared time', (s) => { s.batchPreparedAt = new Date(Date.parse(s.artifact.preparedAt) - 1).toISOString(); }],
    ['wrong plan source', (s) => { if (s.plan.source.kind === 'apply_batch') s.plan.source.applyBatchId = randomUUID(); }],
    ['wrong requested action', (s) => { const a = s.plan.actions[0]!; if (a.routeKey === 'sp.v3.keywords.update' && a.changes.bid) a.changes.bid.requested.amount = '0.7'; }],
    ['wrong action ancestry', (s) => { s.plan.actions[0]!.sources = [{ kind: 'apply_row', applyRowId: randomUUID(), changeKey: 'keyword.bid' }]; }],
    ['request rows differ', (s) => { if (s.request.source.kind === 'keyword_proposals') s.request.source.rows[0]!.requestedBid = '0.7'; }],
  ];
  it.each(invalid)('rolls back every source and plan row on %s', async (_name, mutate) => {
    const { actor, profileId } = await fixture();
    const before = await counts(actor.orgId);
    await expect(seedSyntheticMcpProposal(database, actor, profileId, mutate)).rejects.toMatchObject({ code: expect.any(String) });
    expect(await counts(actor.orgId)).toEqual(before);
  });

  it('keeps complete drafts out of exports and preserves exact ordinary sync without attribution', async () => {
    const { actor, profileId } = await fixture(); const orgId = actor.orgId;
    await database.sql`delete from public.entity_changes where org_id = ${orgId}`;
    await database.sql`delete from public.apply_batches where org_id = ${orgId}`;
    const before = await counts(orgId);
    const source = await seedSyntheticMcpProposal(database, actor, profileId);
    const batchId = source.artifact.applyBatchId;
    expect(await counts(orgId)).toEqual({ plans: Number(before!['plans']) + 1, batches: 1, rows: 1, previews: 1, sources: 1 });
    expect(await getExportBatch(database, { orgId, batchId })).toBeNull();
    expect(await getReversionBatchPreview(database, { orgId, batchId })).toBeNull();
    expect(await listReversionBatches(database, { orgId, profileId })).toEqual([]);
    expect(await listTimeline(database, { orgId, profileId })).toEqual([]);
    expect(await listTimelineFacets(database, { orgId, profileId })).toEqual({ entityTypes: [], fields: [] });
    await expect(previewSpWrite(database, actor, { requestId: randomUUID(), profileId, applyBatchId: batchId }))
      .rejects.toMatchObject({ code: 'not_found' });
    await expect(createReversionExport(database, { orgId, batchId, tag: 'refused', note: 'Synthetic refusal' })).rejects.toThrow('Not found');
    const [change] = await database.sql<{ id: string }[]>`insert into public.entity_changes
      (org_id, profile_id, entity_type, amazon_id, field, old_value, new_value, source, observed_at)
      values (${orgId}, ${profileId}, 'keyword', 'kw-1', 'bid', '"0.9"'::jsonb, '"0.8"'::jsonb, 'sync', clock_timestamp()) returning id::text`;
    expect(await reconcileEntityChangeLinks(database, { orgId, profileId })).toEqual({ offered: 0, linked: 0, ambiguous: 0, unmatched: 0 });
    const [direct] = await database.sql`select * from app.link_exact_apply_changes(array[${change!.id}::bigint])`;
    expect(direct).toEqual({ offered: 1, linked: 0, ambiguous: 0, unmatched: 1 });
    // A legacy link alone must never erase a real observation.
    await database.sql`update public.entity_changes set apply_batch_id = ${batchId}, apply_row_id = ${source.artifact.rows[0]!.applyRowId}
      where id = ${change!.id}::bigint`;
    expect((await listTimeline(database, { orgId, profileId })).map((entry) => entry.id)).toEqual([`change:${change!.id}`]);
    expect(await listTimelineFacets(database, { orgId, profileId })).toEqual({ entityTypes: ['keyword'], fields: ['bid'] });
  });

  it('refuses row or marker mutation and extra rows while allowing an explicit tenant purge', async () => {
    const { actor, profileId } = await fixture(); const orgId = actor.orgId;
    const source = await seedSyntheticMcpProposal(database, actor, profileId);
    const batchId = source.artifact.applyBatchId; const rowId = source.artifact.rows[0]!.applyRowId;
    for (const run of [asServiceRole, (db: TestDatabase, fn: Parameters<typeof asServiceRole>[1]) => asUser(db, actor.userId, fn)]) {
      await expect(run(database, (sql) => sql`update public.apply_rows set new_value = '"0.7"'::jsonb where id = ${rowId}`)).rejects.toMatchObject({ code: '55000' });
      await expect(run(database, (sql) => sql`delete from public.apply_batches where id = ${batchId}`)).rejects.toMatchObject({ code: '55000' });
      await expect(run(database, (sql) => sql`insert into public.apply_rows
        (batch_id, org_id, profile_id, entity_type, entity_id, field, old_value, new_value)
        values (${batchId}, ${orgId}, ${profileId}, 'keyword', 'extra', 'bid', '"0.9"'::jsonb, '"0.8"'::jsonb)`)).rejects.toMatchObject({ code: '42501' });
      await expect(run(database, (sql) => sql`insert into public.apply_batches
        (org_id, profile_id, tag, opt_group, lever, note, source_batch_id)
        values (${orgId}, ${profileId}, 'refused', 'synthetic', 'bid', 'Synthetic inverse', ${batchId})`)).rejects.toMatchObject({ code: '55000' });
    }
    await expect(database.sql`insert into public.apply_rows (batch_id, org_id, profile_id, entity_type, entity_id, field, old_value, new_value)
      values (${batchId}, ${orgId}, ${profileId}, 'keyword', 'extra', 'bid', '"0.9"'::jsonb, '"0.8"'::jsonb)`)
      .rejects.toMatchObject({ code: '55000' });
    await asServiceRole(database, (sql) => sql`delete from public.orgs where id = ${orgId}`);
    expect(await counts(orgId)).toEqual({ plans: 0, batches: 0, rows: 0, previews: 0, sources: 0 });
  });
});
