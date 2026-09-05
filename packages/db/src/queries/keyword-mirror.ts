import { isDeepStrictEqual } from 'node:util';
import { KeywordMirrorMergeCounts, KeywordMirrorMergeRequest } from '@wizard-ads/shared/sp-write-mirror';
import type { DbHandle } from '../client.js';

/** Capture before provider listing; retain PostgreSQL microseconds across the round trip. */
export async function readKeywordMirrorStart(handle: Pick<DbHandle, 'sql'>): Promise<string> {
  const [row] = await handle.sql<{ at: string }[]>`
    select to_char(clock_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at`;
  if (!row) throw new Error('keyword mirror clock unavailable');
  return row.at;
}

type Snapshot = Record<string, unknown>;
type Existing = {
  amazonId: string; snapshot: Snapshot; deletedAt: string | null; syncedAt: string;
  bidObservedAt: string | null; bidCurrent: boolean; entityCurrent: boolean;
};
type Change = { amazonId: string; entityName: string | null; field: string; oldValue: unknown; newValue: unknown };

/**
 * No network while locked. Serialize a profile's keyword merge with the native
 * observation writer (which takes a profile key-share lock before its row lock).
 * The same transaction owns both the mirror and all its actual keyword diffs.
 */
export async function mergeKeywordMirror(
  handle: Pick<DbHandle, 'sql'>, rawRequest: KeywordMirrorMergeRequest,
): Promise<KeywordMirrorMergeCounts> {
  const request = KeywordMirrorMergeRequest.parse(rawRequest);
  return handle.sql.begin(async (sql) => {
    const org = await sql`select id from public.orgs where id = ${request.orgId}::uuid for key share`;
    const profile = await sql`select id from public.ad_profiles
      where org_id = ${request.orgId}::uuid and id = ${request.profileId}::uuid for update`;
    if (org.length !== 1 || profile.length !== 1) throw new Error('keyword mirror scope unavailable');
    const [window] = await sql<{ valid: boolean; previous: string | null }[]>`
      select ${request.readStartedAt}::timestamptz <= clock_timestamp() as valid,
        current_setting('app.keyword_bid_read_started_at', true) as previous`;
    if (!window?.valid) throw new Error('keyword mirror read window is in the future');
    await sql`select set_config('app.keyword_bid_read_started_at', ${request.readStartedAt}, true)`;

    const existing = await sql<Existing[]>`
      select amazon_id as "amazonId", jsonb_build_object(
        'amazonId', amazon_id, 'adProduct', ad_product, 'name', name, 'state', state,
        'campaignId', campaign_id, 'adGroupId', ad_group_id,
        'keywordText', keyword_text, 'matchType', match_type, 'bid', bid
      ) as snapshot,
        to_char(deleted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "deletedAt",
        to_char(synced_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "syncedAt",
        to_char(bid_observed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "bidObservedAt",
        (bid_observed_at is null or bid_observed_at <= ${request.readStartedAt}::timestamptz) as "bidCurrent",
        synced_at <= ${request.readStartedAt}::timestamptz as "entityCurrent"
      from public.keywords where org_id = ${request.orgId}::uuid and profile_id = ${request.profileId}::uuid
      order by amazon_id for update`;
    const byId = new Map(existing.map((row) => [row.amazonId, row]));
    const seen = new Set(request.rows.map((row) => row.amazonId));
    const counts: KeywordMirrorMergeCounts = {
      listed: request.rows.length, upserted: 0, currentBidInputs: 0, staleBidInputs: 0, bidChanges: 0,
      changes: 0, tombstonesOffered: 0, tombstoned: 0, staleTombstones: 0,
    };
    const changes: Change[] = [];
    const rows = request.rows.map((row) => {
      const prior = byId.get(row.amazonId);
      if (prior && prior.snapshot['adProduct'] !== row.adProduct) throw new Error('keyword mirror product identity changed');
      const { profileId: _profileId, syncedAt: _syncedAt, entityType: _entityType, ...incoming } = row;
      const snapshot: Snapshot = prior && !prior.entityCurrent ? { ...prior.snapshot } : { ...incoming };
      const bidCurrent = prior?.bidCurrent ?? true;
      snapshot['bid'] = bidCurrent ? row.bid : prior!.snapshot['bid'];
      if (bidCurrent) counts.currentBidInputs += 1;
      else counts.staleBidInputs += 1;
      // An old listing cannot resurrect a newer tombstone either.
      const deletedAt = prior && (!bidCurrent || !prior.entityCurrent) ? prior.deletedAt : null;
      const addChange = (field: string, oldValue: unknown, newValue: unknown) => changes.push({
        amazonId: row.amazonId, entityName: snapshot['name'] as string | null, field, oldValue, newValue,
      });
      if (!prior) addChange('entity', null, snapshot);
      else {
        for (const [field, value] of Object.entries(snapshot)) {
          if (!isDeepStrictEqual(prior.snapshot[field], value)) {
            addChange(field, prior.snapshot[field] ?? null, value ?? null);
            if (field === 'bid') counts.bidChanges += 1;
          }
        }
        if (prior.deletedAt !== deletedAt) addChange('deletedAt', prior.deletedAt, deletedAt);
      }
      return { ...snapshot, amazonId: row.amazonId, deletedAt,
        syncedAt: prior && !prior.entityCurrent ? prior.syncedAt : request.readStartedAt,
        bidObservedAt: bidCurrent ? request.readStartedAt : prior!.bidObservedAt };
    });

    if (rows.length > 0) {
      const encoded = JSON.stringify(rows);
      const [precision] = await sql<{ valid: boolean }[]>`
        select coalesce(bool_and(bid is null or (bid >= 0 and bid = bid::numeric(12,4))), true) as valid
        from jsonb_to_recordset(${encoded}::text::jsonb) as row(bid numeric)`;
      if (!precision?.valid) throw new Error('keyword mirror bid exceeds storage precision');
      // UPDATE existing rows separately: an INSERT trigger also runs before
      // ON CONFLICT, and a preserved newer head intentionally differs from this read window.
      const updated = await sql<{ amazon_id: string }[]>`
        update public.keywords k set
          ad_product = row."adProduct", name = row.name, state = row.state,
          campaign_id = row."campaignId", ad_group_id = row."adGroupId",
          keyword_text = row."keywordText", match_type = row."matchType", bid = row.bid,
          synced_at = row."syncedAt", deleted_at = row."deletedAt", bid_observed_at = row."bidObservedAt"
        from jsonb_to_recordset(${encoded}::text::jsonb) as row(
          "amazonId" text, "adProduct" public.ad_product, name text, state public.entity_state,
          "campaignId" text, "adGroupId" text, "keywordText" text, "matchType" public.match_type,
          bid numeric, "syncedAt" timestamptz, "deletedAt" timestamptz, "bidObservedAt" timestamptz)
        where k.org_id = ${request.orgId}::uuid and k.profile_id = ${request.profileId}::uuid
          and k.amazon_id = row."amazonId" returning k.amazon_id`;
      const newRows = rows.filter((row) => !byId.has(row.amazonId));
      const inserted = await sql<{ amazon_id: string }[]>`
        insert into public.keywords
          (org_id, profile_id, amazon_id, ad_product, name, state, campaign_id, ad_group_id,
           keyword_text, match_type, bid, synced_at, deleted_at, bid_observed_at)
        select ${request.orgId}::uuid, ${request.profileId}::uuid, "amazonId", "adProduct", name, state,
          "campaignId", "adGroupId", "keywordText", "matchType", bid, "syncedAt", "deletedAt", "bidObservedAt"
        from jsonb_to_recordset(${JSON.stringify(newRows)}::text::jsonb) as row(
          "amazonId" text, "adProduct" public.ad_product, name text, state public.entity_state,
          "campaignId" text, "adGroupId" text, "keywordText" text, "matchType" public.match_type,
          bid numeric, "syncedAt" timestamptz, "deletedAt" timestamptz, "bidObservedAt" timestamptz)
        on conflict (profile_id, amazon_id) do nothing
        returning amazon_id`;
      counts.upserted = updated.length + inserted.length;
    }

    const missing = request.full ? existing.filter((row) => row.deletedAt === null && !seen.has(row.amazonId)
      && (request.adProduct === undefined || row.snapshot['adProduct'] === request.adProduct)) : [];
    counts.tombstonesOffered = missing.length;
    const currentMissing = missing.filter((row) => row.bidCurrent && row.entityCurrent);
    counts.staleTombstones = missing.length - currentMissing.length;
    if (currentMissing.length > 0) {
      const written = await sql`
        update public.keywords set deleted_at = ${request.readStartedAt}::timestamptz,
          synced_at = ${request.readStartedAt}::timestamptz, bid_observed_at = ${request.readStartedAt}::timestamptz
        where org_id = ${request.orgId}::uuid and profile_id = ${request.profileId}::uuid
          and amazon_id = any(${currentMissing.map((row) => row.amazonId)}::text[]) returning amazon_id`;
      counts.tombstoned = written.length;
      for (const row of currentMissing) changes.push({ amazonId: row.amazonId,
        entityName: row.snapshot['name'] as string | null, field: 'deletedAt', oldValue: null, newValue: request.readStartedAt });
    }
    if (changes.length > 0) {
      const written = await sql`
        insert into public.entity_changes
          (org_id, profile_id, entity_type, amazon_id, entity_name, field, old_value, new_value, source, observed_at)
        select ${request.orgId}::uuid, ${request.profileId}::uuid, 'keyword', "amazonId", "entityName", field,
          "oldValue", "newValue", 'sync', ${request.readStartedAt}::timestamptz
        from jsonb_to_recordset(${JSON.stringify(changes)}::text::jsonb) as row(
          "amazonId" text, "entityName" text, field text, "oldValue" jsonb, "newValue" jsonb) returning id`;
      counts.changes = written.length;
      if (counts.changes !== changes.length) throw new Error('keyword mirror diff count does not close');
    }
    await sql`select set_config('app.keyword_bid_read_started_at', ${window.previous ?? ''}, true)`;
    return KeywordMirrorMergeCounts.parse(counts);
  });
}
