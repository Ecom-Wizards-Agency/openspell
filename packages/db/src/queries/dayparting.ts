/**
 * Counted Marketing Stream persistence and read-only dayparting storage.
 *
 * The raw ledger is append-only. Hourly facts are replaceable projections of
 * the latest revision of every logical Stream message in an affected
 * `(profile, ad product, UTC hour)` scope. Projection writes carry the exact
 * source event IDs they were calculated from; the transaction re-reads those
 * IDs under a scoped advisory lock and refuses a stale calculation instead of
 * allowing an out-of-order worker to overwrite newer evidence.
 */
import { createHash } from 'node:crypto';
import type { Sql } from '../client.js';
import {
  DaypartingScheduleProposal,
  MarketingStreamHourlyFact,
  MarketingStreamLedgerEvent,
  MarketingStreamSubscriptionBinding,
  type AmazonMarketingStreamDatasetId,
  type AdProduct,
  type DaypartingScheduleProposal as DaypartingScheduleProposalValue,
  type HourSettlingState,
  type MarketingStreamHourlyFact as MarketingStreamHourlyFactValue,
  type MarketingStreamLedgerEvent as MarketingStreamLedgerEventValue,
  type MarketingStreamSubscriptionBinding as MarketingStreamSubscriptionBindingValue,
} from '@wizard-ads/shared';
import type { DbHandle } from '../client.js';

export interface MarketingStreamScope {
  adProduct: AdProduct;
  /** UTC hour, truncated to the hour. */
  utcHour: string;
}

export interface StoredMarketingStreamEvent extends MarketingStreamLedgerEventValue {
  id: string;
  orgId: string;
}

export interface MarketingStreamAppendResult {
  offeredMessages: number;
  insertedMessages: number;
  duplicateMessages: number;
  revisedMessages: number;
  affectedScopes: MarketingStreamScope[];
  /** Fingerprint of the latest canonical ledger revisions in affected scopes. */
  sourceFingerprint?: string | null;
}

export interface MarketingStreamSnapshot {
  orgId: string;
  profileId: string;
  scopes: MarketingStreamScope[];
  events: StoredMarketingStreamEvent[];
  /** Exact latest-revision event IDs by `marketingStreamScopeKey`. */
  sourceEventIds: Record<string, string[]>;
}

export interface MarketingStreamProjectionResult {
  scopesReplaced: number;
  factsDeleted: number;
  factsInserted: number;
  factsReadBack: number;
}

export interface MarketingStreamProjectionBlock {
  orgId: string;
  profileId: string;
  scopes: MarketingStreamScope[];
  firstBlockedAt: string;
  lastBlockedAt: string;
  retryCount: number;
  alertState: 'pending' | 'alerted';
  lastReason: string;
  generation: number;
}

export interface ReadMarketingStreamFactsInput {
  orgId: string;
  profileId: string;
  campaignId?: string;
  fromUtcHour?: string;
  toUtcHour?: string;
  settlingStates?: readonly HourSettlingState[];
}

export class MarketingStreamPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarketingStreamPersistenceError';
  }
}

const MAX_BLOCKED_MARKETING_STREAM_SCOPES = 4_096;

/** Resolve provider traffic only through an explicit active subscription binding. */
export async function resolveMarketingStreamSubscriptionBinding(
  handle: DbHandle,
  input: {
    advertiserId: string;
    marketplaceId: string;
    datasetId: AmazonMarketingStreamDatasetId;
  },
): Promise<MarketingStreamSubscriptionBindingValue> {
  const rows = await handle.sql<BindingWireRow[]>`
    select id, org_id, profile_id, subscription_id,
           provider_dataset_id, advertiser_id, marketplace_id, active
      from public.marketing_stream_subscription_bindings
     where active = true
       and advertiser_id = ${input.advertiserId}
       and marketplace_id = ${input.marketplaceId}
       and provider_dataset_id = ${input.datasetId}
  `;
  if (rows.length === 0) {
    throw new MarketingStreamPersistenceError(
      'provider advertiser, marketplace, and dataset have no active subscription binding',
    );
  }
  if (rows.length !== 1) {
    throw new MarketingStreamPersistenceError(
      'provider advertiser, marketplace, and dataset resolve ambiguously',
    );
  }
  const row = rows[0]!;
  return MarketingStreamSubscriptionBinding.parse({
    id: row.id,
    orgId: row.org_id,
    profileId: row.profile_id,
    subscriptionId: row.subscription_id,
    datasetId: row.provider_dataset_id,
    advertiserId: row.advertiser_id,
    marketplaceId: row.marketplace_id,
    active: row.active,
  });
}

/** A retryable projection lost a race with a newer ledger event. */
export class StaleMarketingStreamProjection extends MarketingStreamPersistenceError {
  constructor(readonly scope: MarketingStreamScope) {
    super(`Marketing Stream projection for ${marketingStreamScopeKey(scope)} is stale`);
    this.name = 'StaleMarketingStreamProjection';
  }
}

interface EventWireRow {
  id: string;
  org_id: string;
  profile_id: string;
  message_id: string;
  dataset: MarketingStreamLedgerEventValue['dataset'];
  ad_product: AdProduct;
  event_time: Date | string;
  received_at: Date | string;
  revision: number;
  payload_hash: string;
  raw_payload: Record<string, unknown>;
  binding_id: string | null;
  provider_subscription_id: string | null;
  provider_dataset_id: AmazonMarketingStreamDatasetId | null;
  provider_event_id: string | null;
  provider_advertiser_id: string | null;
  provider_marketplace_id: string | null;
}

interface BindingWireRow {
  id: string;
  org_id: string;
  profile_id: string;
  subscription_id: string;
  provider_dataset_id: AmazonMarketingStreamDatasetId;
  advertiser_id: string;
  marketplace_id: string;
  active: boolean;
}

interface FactWireRow {
  profile_id: string;
  ad_product: AdProduct;
  campaign_id: string;
  utc_hour: Date | string;
  profile_timezone: string;
  local_date: string;
  local_hour: number;
  local_day_of_week: number;
  currency_code: string;
  impressions: number | string;
  clicks: number | string;
  cost: number | string;
  purchases: number | string;
  sales: number | string;
  budget_usage_percent: number | string | null;
  budget_capped: boolean;
  settling_state: HourSettlingState;
  source_events: number | string;
}

interface ProjectionBlockWireRow {
  org_id: string;
  profile_id: string;
  scope_keys: string[];
  first_blocked_at: Date | string;
  last_blocked_at: Date | string;
  retry_count: number;
  alert_state: 'pending' | 'alerted';
  last_reason: string;
  generation: number | string;
}

/** Append valid shared-contract events without collapsing later revisions. */
export async function appendMarketingStreamEvents(
  handle: DbHandle,
  input: {
    orgId: string;
    profileId: string;
    events: readonly MarketingStreamLedgerEventValue[];
  },
): Promise<MarketingStreamAppendResult> {
  assertUuid('orgId', input.orgId);
  assertUuid('profileId', input.profileId);

  const uniqueEvents: MarketingStreamLedgerEventValue[] = [];
  const eventByRevisionKey = new Map<string, MarketingStreamLedgerEventValue>();
  let duplicateMessages = 0;
  for (const [index, value] of input.events.entries()) {
    const event = MarketingStreamLedgerEvent.parse(value);
    if (event.profileId !== input.profileId) {
      throw new MarketingStreamPersistenceError(`event ${index} belongs to another profile`);
    }
    if (new Date(event.receivedAt) < new Date(event.eventTime)) {
      throw new MarketingStreamPersistenceError(`event ${index} was received before it occurred`);
    }
    const key = revisionKey(event);
    const prior = eventByRevisionKey.get(key);
    if (prior) {
      assertSameRevision(prior, event);
      duplicateMessages += 1;
      continue;
    }
    eventByRevisionKey.set(key, event);
    uniqueEvents.push(event);
  }

  if (uniqueEvents.length === 0) {
    return {
      offeredMessages: input.events.length,
      insertedMessages: 0,
      duplicateMessages,
      revisedMessages: 0,
      affectedScopes: [],
      sourceFingerprint: null,
    };
  }

  return handle.sql.begin(async (transaction) => {
    const sql = transaction as unknown as Sql;
    await sql`select pg_advisory_xact_lock(hashtextextended(${input.profileId}, 0))`;

    const messageIds = [...new Set(uniqueEvents.map((event) => event.messageId))];
    const existing = await sql<EventWireRow[]>`
      select id, org_id, profile_id, message_id,
             dataset::text as dataset, ad_product::text as ad_product,
             event_time, received_at, revision, payload_hash, raw_payload,
             binding_id, provider_subscription_id, provider_dataset_id, provider_event_id,
             provider_advertiser_id, provider_marketplace_id
        from public.marketing_stream_events
       where org_id = ${input.orgId}
         and profile_id = ${input.profileId}
         and message_id = any (${messageIds}::text[])
       order by dataset, message_id, revision
    `;
    const existingByRevision = new Map(existing.map((row) => [revisionKey(rowToEvent(row)), row]));
    const logicalKeys = new Set(existing.map((row) => logicalKey(rowToEvent(row))));

    let insertedMessages = 0;
    let revisedMessages = 0;
    for (const event of uniqueEvents) {
      const exact = existingByRevision.get(revisionKey(event));
      if (exact) {
        assertSameRevision(rowToEvent(exact), event);
        duplicateMessages += 1;
        continue;
      }

      const isRevision = logicalKeys.has(logicalKey(event));
      const inserted = await sql<{ id: string }[]>`
        insert into public.marketing_stream_events (
          org_id, profile_id, message_id, dataset, ad_product,
          event_time, received_at, revision, payload_hash, raw_payload,
          binding_id, provider_subscription_id, provider_dataset_id, provider_event_id,
          provider_advertiser_id, provider_marketplace_id
        ) values (
          ${input.orgId}, ${input.profileId}, ${event.messageId},
          ${event.dataset}::public.marketing_stream_dataset,
          ${event.adProduct}::public.ad_product,
          ${event.eventTime}::timestamptz, ${event.receivedAt}::timestamptz,
          ${event.revision}, ${event.payloadHash}, ${JSON.stringify(event.rawPayload)}::jsonb,
          ${event.provider?.bindingId ?? null}::uuid,
          ${event.provider?.subscriptionId ?? null},
          ${event.provider?.datasetId ?? null}, ${event.provider?.eventId ?? null},
          ${event.provider?.advertiserId ?? null}, ${event.provider?.marketplaceId ?? null}
        )
        on conflict (profile_id, dataset, message_id, revision) do nothing
        returning id
      `;
      if (inserted.length === 0) {
        const [concurrent] = await sql<EventWireRow[]>`
          select id, org_id, profile_id, message_id,
                 dataset::text as dataset, ad_product::text as ad_product,
                 event_time, received_at, revision, payload_hash, raw_payload,
                 binding_id, provider_subscription_id, provider_dataset_id, provider_event_id,
                 provider_advertiser_id, provider_marketplace_id
            from public.marketing_stream_events
           where profile_id = ${input.profileId}
             and org_id = ${input.orgId}
             and dataset = ${event.dataset}::public.marketing_stream_dataset
             and message_id = ${event.messageId}
             and revision = ${event.revision}
        `;
        if (!concurrent) {
          throw new MarketingStreamPersistenceError('a Stream event conflicted but was not readable');
        }
        assertSameRevision(rowToEvent(concurrent), event);
        duplicateMessages += 1;
        continue;
      }
      if (inserted.length !== 1) {
        throw new MarketingStreamPersistenceError(`expected one inserted event, wrote ${inserted.length}`);
      }
      insertedMessages += 1;
      if (isRevision) revisedMessages += 1;
      logicalKeys.add(logicalKey(event));
    }

    if (insertedMessages + duplicateMessages !== input.events.length) {
      throw new MarketingStreamPersistenceError(
        `event counts do not reconcile: ${input.events.length} offered != ` +
          `${insertedMessages} inserted + ${duplicateMessages} duplicate`,
      );
    }

    const allRevisions = await sql<Pick<EventWireRow, 'ad_product' | 'event_time'>[]>`
      select ad_product::text as ad_product, event_time
        from public.marketing_stream_events
       where org_id = ${input.orgId}
         and profile_id = ${input.profileId}
         and message_id = any (${messageIds}::text[])
    `;
    const affectedScopes = uniqueScopes(allRevisions.map((row) => ({
      adProduct: row.ad_product,
      utcHour: truncateUtcHour(row.event_time),
    })));
    const latest = await latestEventsForScopes(sql, input.orgId, input.profileId, affectedScopes);
    const sourceFingerprint = createHash('sha256')
      .update(latest.map((event) => event.id).sort().join('\n'))
      .digest('hex');
    return {
      offeredMessages: input.events.length,
      insertedMessages,
      duplicateMessages,
      revisedMessages,
      affectedScopes,
      sourceFingerprint,
    };
  });
}

/** Read the latest logical message revisions for complete affected scopes. */
export async function snapshotLatestMarketingStreamEvents(
  handle: DbHandle,
  input: {
    orgId: string;
    profileId: string;
    scopes: readonly MarketingStreamScope[];
  },
): Promise<MarketingStreamSnapshot> {
  const scopes = validateScopes(input.scopes);
  const events = await latestEventsForScopes(handle.sql, input.orgId, input.profileId, scopes);
  return snapshot(input.orgId, input.profileId, scopes, events);
}

/** Resolve a queued replay job back to its complete affected hour scopes. */
export async function marketingStreamScopesForMessageIds(
  handle: DbHandle,
  input: {
    orgId: string;
    profileId: string;
    messageIds: readonly string[];
  },
): Promise<{
  requestedMessages: number;
  foundMessages: number;
  scopes: MarketingStreamScope[];
}> {
  assertUuid('orgId', input.orgId);
  assertUuid('profileId', input.profileId);
  assertUniqueIds('normalize message IDs', input.messageIds);
  if (input.messageIds.length === 0) {
    throw new MarketingStreamPersistenceError('normalize job has no message IDs');
  }
  const rows = await handle.sql<{
    message_id: string;
    ad_product: AdProduct;
    event_time: Date | string;
  }[]>`
    select message_id, ad_product::text as ad_product, event_time
      from public.marketing_stream_events
     where org_id = ${input.orgId}
       and profile_id = ${input.profileId}
       and message_id = any (${[...input.messageIds]}::text[])
  `;
  const foundMessages = new Set(rows.map((row) => row.message_id)).size;
  if (foundMessages !== input.messageIds.length) {
    throw new MarketingStreamPersistenceError(
      `normalize job resolved ${foundMessages} of ${input.messageIds.length} messages`,
    );
  }
  return {
    requestedMessages: input.messageIds.length,
    foundMessages,
    scopes: uniqueScopes(rows.map((row) => ({
      adProduct: row.ad_product,
      utcHour: truncateUtcHour(row.event_time),
    }))),
  };
}

/**
 * Accumulate scopes behind one durable profile-level missing-policy block.
 * Concurrent message-set jobs converge here instead of producing independent
 * unbounded retry chains.
 */
export async function markMarketingStreamProjectionBlocked(
  handle: DbHandle,
  input: {
    orgId: string;
    profileId: string;
    scopes: readonly MarketingStreamScope[];
    blockedAt: Date;
    retryAttempt: number;
    retryLimit: number;
    reason: string;
  },
): Promise<MarketingStreamProjectionBlock> {
  assertUuid('orgId', input.orgId);
  assertUuid('profileId', input.profileId);
  const scopes = validateScopes(input.scopes);
  if (scopes.length === 0) throw new MarketingStreamPersistenceError('blocked projection has no scopes');
  if (!Number.isFinite(input.blockedAt.getTime())) {
    throw new MarketingStreamPersistenceError('blocked projection timestamp is invalid');
  }
  if (!Number.isInteger(input.retryAttempt) || input.retryAttempt < 0) {
    throw new MarketingStreamPersistenceError('blocked projection retry attempt is invalid');
  }
  if (!Number.isInteger(input.retryLimit) || input.retryLimit < 1) {
    throw new MarketingStreamPersistenceError('blocked projection retry limit is invalid');
  }
  if (input.reason.trim().length === 0) {
    throw new MarketingStreamPersistenceError('blocked projection reason is empty');
  }
  const scopeKeys = scopes.map(marketingStreamScopeKey);
  if (scopeKeys.length > MAX_BLOCKED_MARKETING_STREAM_SCOPES) {
    throw new MarketingStreamPersistenceError('blocked projection exceeds the bounded scope limit');
  }
  const [row] = await handle.sql<ProjectionBlockWireRow[]>`
    insert into public.marketing_stream_projection_blocks (
      org_id, profile_id, scope_keys, first_blocked_at, last_blocked_at,
      retry_count, alert_state, last_reason, generation
    ) values (
      ${input.orgId}, ${input.profileId}, ${scopeKeys}::text[],
      ${input.blockedAt.toISOString()}::timestamptz,
      ${input.blockedAt.toISOString()}::timestamptz,
      ${input.retryAttempt},
      ${input.retryAttempt >= input.retryLimit ? 'alerted' : 'pending'},
      ${input.reason.trim()}, 1
    )
    on conflict (org_id, profile_id) do update
       set scope_keys = (
             select array_agg(distinct scope_key order by scope_key)
               from unnest(
                 public.marketing_stream_projection_blocks.scope_keys || excluded.scope_keys
               ) as scope_key
           ),
           last_blocked_at = greatest(
             public.marketing_stream_projection_blocks.last_blocked_at,
             excluded.last_blocked_at
           ),
           retry_count = greatest(
             public.marketing_stream_projection_blocks.retry_count,
             excluded.retry_count
           ),
           alert_state = case
             when public.marketing_stream_projection_blocks.alert_state = 'alerted'
               or greatest(
                 public.marketing_stream_projection_blocks.retry_count,
                 excluded.retry_count
               ) >= ${input.retryLimit}
             then 'alerted'
             else 'pending'
           end,
           last_reason = excluded.last_reason,
           generation = public.marketing_stream_projection_blocks.generation + 1
     where cardinality((
             select array_agg(distinct scope_key)
               from unnest(
                 public.marketing_stream_projection_blocks.scope_keys || excluded.scope_keys
               ) as scope_key
           )) <= ${MAX_BLOCKED_MARKETING_STREAM_SCOPES}
    returning org_id, profile_id, scope_keys, first_blocked_at,
              last_blocked_at, retry_count, alert_state, last_reason, generation
  `;
  if (!row) throw new MarketingStreamPersistenceError('blocked projection exceeds the bounded scope limit');
  return rowToProjectionBlock(row);
}

export async function readMarketingStreamProjectionBlock(
  handle: DbHandle,
  input: { orgId: string; profileId: string },
): Promise<MarketingStreamProjectionBlock | null> {
  assertUuid('orgId', input.orgId);
  assertUuid('profileId', input.profileId);
  const [row] = await handle.sql<ProjectionBlockWireRow[]>`
    select org_id, profile_id, scope_keys, first_blocked_at,
           last_blocked_at, retry_count, alert_state, last_reason, generation
      from public.marketing_stream_projection_blocks
     where org_id = ${input.orgId} and profile_id = ${input.profileId}
  `;
  return row ? rowToProjectionBlock(row) : null;
}

export async function clearMarketingStreamProjectionBlock(
  handle: DbHandle,
  input: { orgId: string; profileId: string; expectedGeneration: number },
): Promise<boolean> {
  assertUuid('orgId', input.orgId);
  assertUuid('profileId', input.profileId);
  const rows = await handle.sql<{ profile_id: string }[]>`
    delete from public.marketing_stream_projection_blocks
     where org_id = ${input.orgId} and profile_id = ${input.profileId}
       and generation = ${input.expectedGeneration}
    returning profile_id
  `;
  if (rows.length > 1) throw new MarketingStreamPersistenceError('cleared more than one projection block');
  return rows.length === 1;
}

/**
 * Replace complete hourly scopes iff their latest ledger event IDs still match
 * the source snapshot used by the worker.
 */
export async function replaceMarketingStreamHourlyFacts(
  handle: DbHandle,
  input: {
    orgId: string;
    profileId: string;
    scopes: readonly MarketingStreamScope[];
    expectedSourceEventIds: Readonly<Record<string, readonly string[]>>;
    facts: readonly MarketingStreamHourlyFactValue[];
  },
): Promise<MarketingStreamProjectionResult> {
  assertUuid('orgId', input.orgId);
  assertUuid('profileId', input.profileId);
  const scopes = validateScopes(input.scopes);
  const scopeKeys = new Set(scopes.map(marketingStreamScopeKey));

  const facts = input.facts.map((value, index) => {
    const fact = MarketingStreamHourlyFact.parse(value);
    if (fact.profileId !== input.profileId) {
      throw new MarketingStreamPersistenceError(`fact ${index} belongs to another profile`);
    }
    const key = marketingStreamScopeKey({ adProduct: fact.adProduct, utcHour: fact.utcHour });
    if (!scopeKeys.has(key)) {
      throw new MarketingStreamPersistenceError(`fact ${index} is outside the replacement scopes`);
    }
    if (fact.sourceEvents < 1) {
      throw new MarketingStreamPersistenceError(`fact ${index} has no source event`);
    }
    if (fact.clicks > fact.impressions) {
      throw new MarketingStreamPersistenceError(`fact ${index} has more clicks than impressions`);
    }
    return fact;
  });
  const factKeys = new Set<string>();
  for (const fact of facts) {
    const key = [fact.adProduct, fact.campaignId, truncateUtcHour(fact.utcHour)].join('|');
    if (factKeys.has(key)) {
      throw new MarketingStreamPersistenceError(`duplicate hourly fact ${key}`);
    }
    factKeys.add(key);
  }
  for (const scope of scopes) {
    const key = marketingStreamScopeKey(scope);
    const expected = input.expectedSourceEventIds[key];
    if (!expected) {
      throw new MarketingStreamPersistenceError(`scope ${key} has no source-event assertion`);
    }
    assertUniqueIds(`source events for ${key}`, expected);
    for (const [index, fact] of facts.entries()) {
      if (
        marketingStreamScopeKey({ adProduct: fact.adProduct, utcHour: fact.utcHour }) === key &&
        fact.sourceEvents > expected.length
      ) {
        throw new MarketingStreamPersistenceError(
          `fact ${index} cites ${fact.sourceEvents} source events but scope ${key} has ${expected.length}`,
        );
      }
    }
  }

  return handle.sql.begin(async (transaction) => {
    const sql = transaction as unknown as Sql;
    // Append takes this same profile lock. Taking it before the sorted scope
    // locks gives append and projection one compatible order, so a snapshot
    // can never be promoted while a provider correction is being appended.
    await sql`select pg_advisory_xact_lock(hashtextextended(${input.profileId}, 0))`;
    for (const scope of scopes) {
      await sql`select pg_advisory_xact_lock(hashtextextended(${scopeLock(input.profileId, scope)}, 0))`;
    }
    const currentEvents = await latestEventsForScopes(sql, input.orgId, input.profileId, scopes);
    const current = snapshot(input.orgId, input.profileId, scopes, currentEvents);
    for (const scope of scopes) {
      const key = marketingStreamScopeKey(scope);
      if (!sameStrings(current.sourceEventIds[key] ?? [], input.expectedSourceEventIds[key] ?? [])) {
        throw new StaleMarketingStreamProjection(scope);
      }
    }

    const scopeJson = scopeWireJson(scopes);
    const deleted = await sql<{ id: string }[]>`
      with requested as (
        select scope.ad_product, scope.utc_hour::timestamptz as utc_hour
          from jsonb_to_recordset(${scopeJson}::jsonb)
               as scope(ad_product text, utc_hour text)
      )
      delete from public.marketing_stream_hourly_facts as fact
       using requested
       where fact.org_id = ${input.orgId}
         and fact.profile_id = ${input.profileId}
         and fact.ad_product::text = requested.ad_product
         and fact.utc_hour = requested.utc_hour
      returning fact.id
    `;

    let factsInserted = 0;
    for (const fact of facts) {
      const inserted = await sql<{ id: string }[]>`
        insert into public.marketing_stream_hourly_facts (
          org_id, profile_id, ad_product, campaign_id, utc_hour,
          profile_timezone, local_date, local_hour, local_day_of_week,
          currency_code, impressions, clicks, cost, purchases, sales,
          budget_usage_percent, budget_capped, settling_state, source_events
        ) values (
          ${input.orgId}, ${input.profileId}, ${fact.adProduct}::public.ad_product,
          ${fact.campaignId}, ${truncateUtcHour(fact.utcHour)}::timestamptz,
          ${fact.profileTimeZone}, ${fact.localDate}::date, ${fact.localHour},
          ${fact.localDayOfWeek}, ${fact.currencyCode}, ${fact.impressions},
          ${fact.clicks}, ${fact.cost}, ${fact.purchases}, ${fact.sales},
          ${fact.budgetUsagePercent}, ${fact.budgetCapped},
          ${fact.settlingState}::public.hour_settling_state, ${fact.sourceEvents}
        )
        returning id
      `;
      factsInserted += inserted.length;
    }
    if (factsInserted !== facts.length) {
      throw new MarketingStreamPersistenceError(
        `fact writes do not reconcile: ${facts.length} offered, ${factsInserted} inserted`,
      );
    }

    const [readBack] = await sql<{ facts: number }[]>`
      with requested as (
        select scope.ad_product, scope.utc_hour::timestamptz as utc_hour
          from jsonb_to_recordset(${scopeJson}::jsonb)
               as scope(ad_product text, utc_hour text)
      )
      select count(*)::int as facts
        from public.marketing_stream_hourly_facts as fact
        join requested
          on fact.ad_product::text = requested.ad_product
         and fact.utc_hour = requested.utc_hour
       where fact.org_id = ${input.orgId}
         and fact.profile_id = ${input.profileId}
    `;
    const factsReadBack = readBack?.facts ?? 0;
    if (factsReadBack !== facts.length) {
      throw new MarketingStreamPersistenceError(
        `fact read-back does not reconcile: ${facts.length} staged, ${factsReadBack} canonical`,
      );
    }
    return {
      scopesReplaced: scopes.length,
      factsDeleted: deleted.length,
      factsInserted,
      factsReadBack,
    };
  });
}

/** Tenant-scoped hourly facts for heatmaps or pure proposal generation. */
export async function readMarketingStreamHourlyFacts(
  handle: DbHandle,
  input: ReadMarketingStreamFactsInput,
): Promise<MarketingStreamHourlyFactValue[]> {
  const rows = await handle.sql<FactWireRow[]>`
    select profile_id, ad_product::text as ad_product, campaign_id, utc_hour,
           profile_timezone, local_date::text as local_date, local_hour,
           local_day_of_week, currency_code, impressions, clicks, cost,
           purchases, sales, budget_usage_percent, budget_capped,
           settling_state::text as settling_state, source_events
      from public.marketing_stream_hourly_facts
     where org_id = ${input.orgId}
       and profile_id = ${input.profileId}
       and (${input.campaignId ?? null}::text is null or campaign_id = ${input.campaignId ?? null})
       and (${input.fromUtcHour ?? null}::timestamptz is null or utc_hour >= ${input.fromUtcHour ?? null}::timestamptz)
       and (${input.toUtcHour ?? null}::timestamptz is null or utc_hour <= ${input.toUtcHour ?? null}::timestamptz)
       and (${input.settlingStates ? [...input.settlingStates] : null}::public.hour_settling_state[] is null
            or settling_state = any (${input.settlingStates ? [...input.settlingStates] : null}::public.hour_settling_state[]))
     order by utc_hour, ad_product, campaign_id
  `;
  return rows.map(rowToFact);
}

/** Persist a deterministic proposal ID without mutating Amazon. */
export async function persistDaypartingScheduleProposal(
  handle: DbHandle,
  input: { orgId: string; proposal: DaypartingScheduleProposalValue },
): Promise<{ status: 'inserted' | 'already_present'; proposal: DaypartingScheduleProposalValue }> {
  const proposal = DaypartingScheduleProposal.parse(input.proposal);
  if (proposal.status !== 'proposed') {
    throw new MarketingStreamPersistenceError('the generator may persist proposed schedules only');
  }

  return handle.sql.begin(async (sql) => {
    const inserted = proposal.id
      ? await sql<{ id: string }[]>`
          insert into public.dayparting_schedule_proposals (
            id, org_id, profile_id, campaign_id, baseline_label,
            evidence_start, evidence_end, settled_hours, blocks, status
          ) values (
            ${proposal.id}, ${input.orgId}, ${proposal.profileId}, ${proposal.campaignId},
            ${proposal.baselineLabel}, ${proposal.evidenceStart}::date,
            ${proposal.evidenceEnd}::date, ${proposal.settledHours},
            ${JSON.stringify(proposal.blocks)}::jsonb, 'proposed'
          )
          on conflict (id) do nothing
          returning id
        `
      : await sql<{ id: string }[]>`
          insert into public.dayparting_schedule_proposals (
            org_id, profile_id, campaign_id, baseline_label,
            evidence_start, evidence_end, settled_hours, blocks, status
          ) values (
            ${input.orgId}, ${proposal.profileId}, ${proposal.campaignId},
            ${proposal.baselineLabel}, ${proposal.evidenceStart}::date,
            ${proposal.evidenceEnd}::date, ${proposal.settledHours},
            ${JSON.stringify(proposal.blocks)}::jsonb, 'proposed'
          )
          returning id
        `;
    const id = inserted[0]?.id ?? proposal.id;
    if (!id) throw new MarketingStreamPersistenceError('proposal insert returned no ID');

    const [row] = await sql<{
      id: string;
      profile_id: string;
      campaign_id: string;
      baseline_label: string;
      evidence_start: string;
      evidence_end: string;
      settled_hours: number | string;
      blocks: DaypartingScheduleProposalValue['blocks'];
      status: DaypartingScheduleProposalValue['status'];
    }[]>`
      select id, profile_id, campaign_id, baseline_label,
             evidence_start::text as evidence_start,
             evidence_end::text as evidence_end, settled_hours, blocks, status
        from public.dayparting_schedule_proposals
       where id = ${id} and org_id = ${input.orgId} and profile_id = ${proposal.profileId}
    `;
    if (!row) throw new MarketingStreamPersistenceError('proposal ID belongs to another tenant or profile');
    const stored = DaypartingScheduleProposal.parse({
      id: row.id,
      profileId: row.profile_id,
      campaignId: row.campaign_id,
      baselineLabel: row.baseline_label,
      evidenceStart: row.evidence_start,
      evidenceEnd: row.evidence_end,
      settledHours: Number(row.settled_hours),
      blocks: row.blocks,
      status: row.status,
    });
    const expected = DaypartingScheduleProposal.parse({ ...proposal, id });
    if (JSON.stringify(stored) !== JSON.stringify(expected)) {
      throw new MarketingStreamPersistenceError('proposal ID already exists with different content');
    }
    return { status: inserted.length === 1 ? 'inserted' : 'already_present', proposal: stored };
  });
}

export function marketingStreamScopeKey(scope: MarketingStreamScope): string {
  return `${scope.adProduct}|${truncateUtcHour(scope.utcHour)}`;
}

function revisionKey(event: Pick<MarketingStreamLedgerEventValue, 'dataset' | 'messageId' | 'revision'>): string {
  return `${event.dataset}|${event.messageId}|${event.revision}`;
}

function logicalKey(event: Pick<MarketingStreamLedgerEventValue, 'dataset' | 'messageId'>): string {
  return `${event.dataset}|${event.messageId}`;
}

function assertSameRevision(
  existing: MarketingStreamLedgerEventValue,
  offered: MarketingStreamLedgerEventValue,
): void {
  if (
    existing.profileId !== offered.profileId ||
    existing.dataset !== offered.dataset ||
    existing.messageId !== offered.messageId ||
    existing.revision !== offered.revision ||
    existing.adProduct !== offered.adProduct ||
    toIso(existing.eventTime) !== toIso(offered.eventTime) ||
    existing.payloadHash !== offered.payloadHash ||
    !sameProviderIdentity(existing.provider, offered.provider)
  ) {
    throw new MarketingStreamPersistenceError(
      `message ${offered.messageId} revision ${offered.revision} changed its immutable identity`,
    );
  }
}

function sameProviderIdentity(
  left: MarketingStreamLedgerEventValue['provider'],
  right: MarketingStreamLedgerEventValue['provider'],
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.datasetId === right.datasetId
    && left.advertiserId === right.advertiserId
    && left.marketplaceId === right.marketplaceId
    && left.eventId === right.eventId;
}

function rowToEvent(row: EventWireRow): StoredMarketingStreamEvent {
  const provider = providerIdentityFromRow(row);
  return {
    id: row.id,
    orgId: row.org_id,
    profileId: row.profile_id,
    messageId: row.message_id,
    dataset: row.dataset,
    adProduct: row.ad_product,
    eventTime: toIso(row.event_time),
    receivedAt: toIso(row.received_at),
    revision: Number(row.revision),
    payloadHash: row.payload_hash,
    rawPayload: row.raw_payload,
    ...(provider === undefined ? {} : { provider }),
  };
}

function providerIdentityFromRow(
  row: EventWireRow,
): MarketingStreamLedgerEventValue['provider'] {
  const values = [
    row.binding_id,
    row.provider_subscription_id,
    row.provider_dataset_id,
    row.provider_event_id,
    row.provider_advertiser_id,
    row.provider_marketplace_id,
  ];
  if (values.every((value) => value === null)) return undefined;
  if (values.some((value) => value === null)) {
    throw new MarketingStreamPersistenceError('database returned an incomplete provider identity');
  }
  return {
    bindingId: row.binding_id!,
    subscriptionId: row.provider_subscription_id!,
    datasetId: row.provider_dataset_id!,
    eventId: row.provider_event_id!,
    advertiserId: row.provider_advertiser_id!,
    marketplaceId: row.provider_marketplace_id!,
  };
}

function rowToFact(row: FactWireRow): MarketingStreamHourlyFactValue {
  return MarketingStreamHourlyFact.parse({
    profileId: row.profile_id,
    adProduct: row.ad_product,
    campaignId: row.campaign_id,
    utcHour: truncateUtcHour(row.utc_hour),
    profileTimeZone: row.profile_timezone,
    localDate: row.local_date,
    localHour: Number(row.local_hour),
    localDayOfWeek: Number(row.local_day_of_week),
    currencyCode: row.currency_code,
    impressions: Number(row.impressions),
    clicks: Number(row.clicks),
    cost: Number(row.cost),
    purchases: Number(row.purchases),
    sales: Number(row.sales),
    budgetUsagePercent: row.budget_usage_percent === null ? null : Number(row.budget_usage_percent),
    budgetCapped: row.budget_capped,
    settlingState: row.settling_state,
    sourceEvents: Number(row.source_events),
  });
}

function rowToProjectionBlock(row: ProjectionBlockWireRow): MarketingStreamProjectionBlock {
  return {
    orgId: row.org_id,
    profileId: row.profile_id,
    scopes: uniqueScopes(row.scope_keys.map(marketingStreamScopeFromKey)),
    firstBlockedAt: toIso(row.first_blocked_at),
    lastBlockedAt: toIso(row.last_blocked_at),
    retryCount: Number(row.retry_count),
    alertState: row.alert_state,
    lastReason: row.last_reason,
    generation: Number(row.generation),
  };
}

function marketingStreamScopeFromKey(value: string): MarketingStreamScope {
  const separator = value.indexOf('|');
  if (separator < 1) throw new MarketingStreamPersistenceError('stored projection block has an invalid scope');
  const adProduct = value.slice(0, separator);
  const utcHour = value.slice(separator + 1);
  if (!['SP', 'SB', 'SD'].includes(adProduct)) {
    throw new MarketingStreamPersistenceError('stored projection block has an invalid ad product');
  }
  return { adProduct: adProduct as AdProduct, utcHour: truncateUtcHour(utcHour) };
}

async function latestEventsForScopes(
  sql: Sql,
  orgId: string,
  profileId: string,
  scopes: readonly MarketingStreamScope[],
): Promise<StoredMarketingStreamEvent[]> {
  if (scopes.length === 0) return [];
  const rows = await sql<EventWireRow[]>`
    with ranked as (
      select event.*,
             row_number() over (
               partition by event.profile_id, event.dataset, event.message_id
               order by event.revision desc, event.received_at desc, event.id desc
             ) as revision_position
        from public.marketing_stream_events as event
       where event.org_id = ${orgId} and event.profile_id = ${profileId}
    ), requested as (
      select scope.ad_product, scope.utc_hour::timestamptz as utc_hour
        from jsonb_to_recordset(${scopeWireJson(scopes)}::jsonb)
             as scope(ad_product text, utc_hour text)
    )
    select ranked.id, ranked.org_id, ranked.profile_id, ranked.message_id,
           ranked.dataset::text as dataset, ranked.ad_product::text as ad_product,
           ranked.event_time, ranked.received_at, ranked.revision,
           ranked.payload_hash, ranked.raw_payload, ranked.binding_id,
           ranked.provider_subscription_id,
           ranked.provider_dataset_id, ranked.provider_event_id,
           ranked.provider_advertiser_id, ranked.provider_marketplace_id
      from ranked
      join requested
        on ranked.ad_product::text = requested.ad_product
       and date_trunc('hour', ranked.event_time) = requested.utc_hour
     where ranked.revision_position = 1
     order by ranked.event_time, ranked.dataset, ranked.message_id
  `;
  return rows.map(rowToEvent);
}

function snapshot(
  orgId: string,
  profileId: string,
  scopes: MarketingStreamScope[],
  events: StoredMarketingStreamEvent[],
): MarketingStreamSnapshot {
  const sourceEventIds = Object.fromEntries(scopes.map((scope) => [marketingStreamScopeKey(scope), [] as string[]]));
  for (const event of events) {
    const key = marketingStreamScopeKey({ adProduct: event.adProduct, utcHour: event.eventTime });
    sourceEventIds[key]?.push(event.id);
  }
  for (const ids of Object.values(sourceEventIds)) ids.sort();
  return { orgId, profileId, scopes, events, sourceEventIds };
}

function validateScopes(scopes: readonly MarketingStreamScope[]): MarketingStreamScope[] {
  const normalized = uniqueScopes(scopes.map((scope) => ({
    adProduct: scope.adProduct,
    utcHour: truncateUtcHour(scope.utcHour),
  })));
  if (normalized.length !== scopes.length) {
    throw new MarketingStreamPersistenceError('replacement scopes must be unique');
  }
  return normalized;
}

function uniqueScopes(scopes: readonly MarketingStreamScope[]): MarketingStreamScope[] {
  const map = new Map<string, MarketingStreamScope>();
  for (const scope of scopes) {
    if (!['SP', 'SB', 'SD'].includes(scope.adProduct)) {
      throw new MarketingStreamPersistenceError(`unsupported ad product ${scope.adProduct}`);
    }
    const normalized = { adProduct: scope.adProduct, utcHour: truncateUtcHour(scope.utcHour) };
    map.set(marketingStreamScopeKey(normalized), normalized);
  }
  return [...map.values()].sort((left, right) => marketingStreamScopeKey(left).localeCompare(marketingStreamScopeKey(right)));
}

function truncateUtcHour(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new MarketingStreamPersistenceError(`invalid UTC hour ${String(value)}`);
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
}

function toIso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new MarketingStreamPersistenceError('database returned an invalid timestamp');
  return date.toISOString();
}

function scopeLock(profileId: string, scope: MarketingStreamScope): string {
  return `${profileId}|${marketingStreamScopeKey(scope)}`;
}

function scopeWireJson(scopes: readonly MarketingStreamScope[]): string {
  return JSON.stringify(scopes.map((scope) => ({
    ad_product: scope.adProduct,
    utc_hour: truncateUtcHour(scope.utcHour),
  })));
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function assertUniqueIds(label: string, ids: readonly string[]): void {
  if (new Set(ids).size !== ids.length) throw new MarketingStreamPersistenceError(`${label} contains duplicates`);
}

function assertUuid(label: string, value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new MarketingStreamPersistenceError(`${label} must be a UUID`);
  }
}
