import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { KeywordRow } from '@wizard-ads/shared';
import { createTestDatabase, databaseAvailable, type TestDatabase } from '../testing/harness.js';
import { mergeKeywordMirror, readKeywordMirrorStart } from './keyword-mirror.js';

const available = await databaseAvailable();
const owner = '31313131-3131-4131-8131-313131313131';
describe.skipIf(!available)('keyword mirror read windows', () => {
  let database: TestDatabase;
  let orgId: string;
  let profileId: string;
  beforeEach(async () => {
    database = await createTestDatabase('keyword_windows');
    const [org] = await database.sql<{ id: string }[]>`select app.seed_tenant_fixture('keyword-window', ${owner}, 'owner') as id`;
    orgId = org!.id;
    const [profile] = await database.sql<{ id: string }[]>`select id from public.ad_profiles where org_id = ${orgId} limit 1`;
    profileId = profile!.id;
    await database.sql`delete from public.keywords where org_id = ${orgId}`;
  }, 60_000);
  afterEach(async () => { await database?.drop(); });
  const row = (bid: number): KeywordRow => ({ entityType: 'keyword', profileId, amazonId: 'merge-keyword', adProduct: 'SP',
    name: 'Synthetic keyword', state: 'enabled', campaignId: 'merge-campaign', adGroupId: 'merge-group',
    keywordText: 'synthetic', matchType: 'exact', bid });
  const request = (readStartedAt: string, rows: KeywordRow[], full = false) => ({
    orgId, profileId, adProduct: 'SP' as const, readStartedAt, rows, full,
  });
  async function current() {
    const [value] = await database.sql<{ bid: string; deleted: boolean; head: string; synced: string; name: string }[]>`
      select bid::text, deleted_at is not null as deleted, name,
        to_char(bid_observed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as head,
        to_char(synced_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as synced
      from public.keywords where profile_id = ${profileId} and amazon_id = 'merge-keyword'`;
    return value;
  }

  it('counts stale bid inputs and tombstones while preserving newer field and entity evidence', async () => {
    const older = await readKeywordMirrorStart(database);
    expect(await mergeKeywordMirror(database, request(older, [row(0.9)]))).toMatchObject({ listed: 1, upserted: 1, changes: 1 });
    const newer = await readKeywordMirrorStart(database);
    expect(await mergeKeywordMirror(database, request(newer, [row(0.7)]))).toMatchObject({ bidChanges: 1, changes: 1 });
    const settled = await current();
    expect(settled).toMatchObject({ bid: '0.7000', head: newer, synced: newer, deleted: false });
    expect(await mergeKeywordMirror(database, request(older, [{ ...row(0.9), name: 'Stale name' }]))).toMatchObject({
      listed: 1, upserted: 1, currentBidInputs: 0, staleBidInputs: 1, bidChanges: 0, changes: 0,
    });
    expect(await mergeKeywordMirror(database, request(older, [], true))).toMatchObject({
      tombstonesOffered: 1, staleTombstones: 1, tombstoned: 0, changes: 0,
    });
    expect(await current()).toEqual(settled);
    const [diffs] = await database.sql<{ count: number }[]>`select count(*)::int from public.entity_changes
      where profile_id = ${profileId} and amazon_id = 'merge-keyword'`;
    expect(diffs!.count).toBe(2);
    const [context] = await database.sql<{ clean: boolean }[]>`select coalesce(current_setting('app.keyword_bid_read_started_at', true), '') = '' as clean`;
    expect(context!.clean).toBe(true);
  });

  it('does not resurrect a newer tombstone and admits a later observed resurrection', async () => {
    const older = await readKeywordMirrorStart(database);
    await mergeKeywordMirror(database, request(older, [row(0.9)]));
    const removed = await readKeywordMirrorStart(database);
    expect(await mergeKeywordMirror(database, request(removed, [], true))).toMatchObject({ tombstoned: 1, changes: 1 });
    expect(await mergeKeywordMirror(database, request(older, [row(0.9)]))).toMatchObject({ staleBidInputs: 1, changes: 0 });
    expect(await current()).toMatchObject({ deleted: true, head: removed });
    expect(await mergeKeywordMirror(database, request(await readKeywordMirrorStart(database), [row(0.8)])))
      .toMatchObject({ currentBidInputs: 1, bidChanges: 1, changes: 2 });
    expect(await current()).toMatchObject({ deleted: false, bid: '0.8000' });
  });

  it('rolls back mirror changes when actual diff counts do not match offered diffs', async () => {
    const initial = await readKeywordMirrorStart(database);
    await mergeKeywordMirror(database, request(initial, [row(0.9)]));
    await database.sql.unsafe(`create function app.synthetic_drop_keyword_diff() returns trigger language plpgsql as $$
      begin return null; end $$;
      create trigger synthetic_drop_keyword_diff before insert on public.entity_changes
      for each row execute function app.synthetic_drop_keyword_diff()`);
    await expect(mergeKeywordMirror(database, request(await readKeywordMirrorStart(database), [row(0.7)])))
      .rejects.toThrow('diff count does not close');
    expect(await current()).toMatchObject({ bid: '0.9000', head: initial });
  });

  it('refuses false scope, future reads and values that would be rounded by storage', async () => {
    const started = await readKeywordMirrorStart(database);
    await expect(mergeKeywordMirror(database, { ...request(started, [row(0.9)]), orgId: owner })).rejects.toThrow('scope unavailable');
    await expect(mergeKeywordMirror(database, request('9999-01-01T00:00:00.000Z', [row(0.9)]))).rejects.toThrow('future');
    await expect(mergeKeywordMirror(database, request(started, [row(0.70001)]))).rejects.toThrow('storage precision');
    expect(await current()).toBeUndefined();
  });
});
