import {
  DataDiveClient,
  DataDiveConfigError,
  DataDiveHttpError,
  DataDiveParseError,
  DataDiveThrottleError,
  DataDiveTransportError,
  type DataDiveQuota,
  type RankRadar,
  type RankRadarData,
  type RankRadarList,
} from '@wizard-ads/datadive-api';
import { chunkForInsert, type DbHandle } from '@wizard-ads/db';
import { getIntegrationSecret } from '@wizard-ads/db/worker';
import type { RankSyncJob } from '@wizard-ads/shared';
import { PermanentJobError, RetryableJobError } from './worker.js';

const SOURCE = 'rank_radar' as const;
const INSERT_COLUMNS = 8;
const DEFAULT_QUOTA_RETRY_SECONDS = 24 * 60 * 60;

export interface RankObservationInput {
  orgId: string;
  profileId: string;
  asin: string;
  keyword: string;
  observedOn: string;
  organicRank: number | null;
  marketplace: string;
  source: typeof SOURCE;
}

export interface RankObservationLoadCounts {
  offered: number;
  unique: number;
  duplicates: number;
  written: number;
}

export class ConflictingRankObservation extends Error {
  constructor(readonly grain: string) {
    super(`DataDive returned conflicting observations for grain ${grain}`);
    this.name = 'ConflictingRankObservation';
  }
}

export class RankObservationLoadCountMismatch extends Error {
  constructor(readonly counts: RankObservationLoadCounts) {
    super(
      `rank_observations: offered ${counts.unique} unique rows, wrote ${counts.written}. ` +
        'A rank load that loses rows must fail loudly.',
    );
    this.name = 'RankObservationLoadCountMismatch';
  }
}

export interface DataDiveRankClient {
  getQuota(): Promise<DataDiveQuota>;
  listRankRadars(): Promise<RankRadarList>;
  getRankRadarData(id: string, range: { startDate: string; endDate: string }): Promise<RankRadarData>;
}

export interface DataDiveSyncContext {
  connectionId: string;
  credential: string;
  countryCode: string;
  timezone: string;
  configuredRadarIds?: string[];
}

export interface DataDiveRankSyncStore {
  resolve(payload: RankSyncJob): Promise<DataDiveSyncContext>;
  load(rows: readonly RankObservationInput[]): Promise<RankObservationLoadCounts>;
  recordSuccess(connectionId: string): Promise<void>;
  recordFailure(connectionId: string, message: string, permanent: boolean): Promise<void>;
}

export interface DataDiveRankSyncOptions {
  handle: DbHandle;
  clientFactory?: (credential: string) => DataDiveRankClient;
  now?: () => Date;
}

interface ConnectionRow {
  id: string;
  config: Record<string, unknown>;
}

interface ProfileRow {
  country_code: string;
  timezone: string;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function radarIdsFromConfig(config: Record<string, unknown>): string[] | undefined {
  const value = config['radar_ids'];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new PermanentJobError('DataDive connection config.radar_ids must be an array of strings');
  }
  const ids = value.map((id) => nonEmptyString(id));
  if (ids.some((id) => id === null)) {
    throw new PermanentJobError('DataDive connection config.radar_ids must contain only non-empty strings');
  }
  return distinct(ids as string[]);
}

function connectionProfileId(config: Record<string, unknown>): string | null {
  return nonEmptyString(config['profile_id']);
}

function chooseConnection(rows: readonly ConnectionRow[], profileId: string): ConnectionRow {
  const exact = rows.filter((row) => connectionProfileId(row.config) === profileId);
  const unscoped = rows.filter((row) => connectionProfileId(row.config) === null);
  const eligible = exact.length > 0 ? exact : unscoped;
  if (eligible.length === 0) {
    throw new PermanentJobError('No active DataDive connection is eligible for the designated profile');
  }
  if (eligible.length > 1) {
    throw new PermanentJobError(
      'More than one active DataDive connection is eligible for the designated profile; set config.profile_id',
    );
  }
  const connection = eligible[0];
  if (!connection) throw new PermanentJobError('DataDive connection resolution returned no row');
  return connection;
}

export class PostgresDataDiveRankSyncStore implements DataDiveRankSyncStore {
  constructor(private readonly handle: DbHandle) {}

  async resolve(payload: RankSyncJob): Promise<DataDiveSyncContext> {
    const profiles = await this.handle.sql<ProfileRow[]>`
      select country_code, timezone
        from public.ad_profiles
       where id = ${payload.profileId} and org_id = ${payload.orgId}
    `;
    const profile = profiles[0];
    if (!profile) throw new PermanentJobError('The designated DataDive profile does not exist in this org');

    const rows = await this.handle.sql<ConnectionRow[]>`
      select id, config
        from public.integration_connections
       where org_id = ${payload.orgId}
         and provider = 'datadive'
         and status = 'active'
       order by created_at, id
    `;
    const connection = chooseConnection(rows, payload.profileId);
    const credential = await getIntegrationSecret(this.handle, connection.id);
    if (!credential) throw new PermanentJobError('The active DataDive connection has no stored API key');
    const configuredRadarIds = radarIdsFromConfig(connection.config);

    return {
      connectionId: connection.id,
      credential,
      countryCode: profile.country_code,
      timezone: profile.timezone,
      ...(configuredRadarIds === undefined ? {} : { configuredRadarIds }),
    };
  }

  load(rows: readonly RankObservationInput[]): Promise<RankObservationLoadCounts> {
    return loadRankObservations(this.handle, rows);
  }

  async recordSuccess(connectionId: string): Promise<void> {
    await this.handle.sql`
      update public.integration_connections
         set status = 'active', last_synced_at = now(), last_error = null
       where id = ${connectionId}
    `;
  }

  async recordFailure(connectionId: string, message: string, permanent: boolean): Promise<void> {
    if (permanent) {
      await this.handle.sql`
        update public.integration_connections
           set status = 'error', last_error = ${message}
         where id = ${connectionId}
      `;
      return;
    }
    await this.handle.sql`
      update public.integration_connections
         set last_error = ${message}
       where id = ${connectionId}
    `;
  }
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function grain(row: RankObservationInput): string {
  return JSON.stringify([row.orgId, row.asin, row.keyword, row.observedOn, row.source]);
}

function sameObservation(left: RankObservationInput, right: RankObservationInput): boolean {
  return left.profileId === right.profileId
    && left.organicRank === right.organicRank
    && left.marketplace === right.marketplace;
}

export function consolidateRankObservations(rows: readonly RankObservationInput[]): {
  rows: RankObservationInput[];
  duplicates: number;
} {
  const byGrain = new Map<string, RankObservationInput>();
  let duplicates = 0;
  for (const row of rows) {
    const key = grain(row);
    const previous = byGrain.get(key);
    if (!previous) {
      byGrain.set(key, row);
      continue;
    }
    if (!sameObservation(previous, row)) throw new ConflictingRankObservation(key);
    duplicates += 1;
  }
  return { rows: [...byGrain.values()], duplicates };
}

export async function loadRankObservations(
  handle: DbHandle,
  offered: readonly RankObservationInput[],
): Promise<RankObservationLoadCounts> {
  const consolidated = consolidateRankObservations(offered);
  let written = 0;
  for (const chunk of chunkForInsert(consolidated.rows, INSERT_COLUMNS)) {
    const values = chunk.map((row) => ({
      org_id: row.orgId,
      profile_id: row.profileId,
      asin: row.asin,
      keyword: row.keyword,
      observed_on: row.observedOn,
      organic_rank: row.organicRank,
      marketplace: row.marketplace,
      source: row.source,
    }));
    const result = await handle.sql<{ id: string }[]>`
      insert into public.rank_observations ${handle.sql(
        values,
        'org_id',
        'profile_id',
        'asin',
        'keyword',
        'observed_on',
        'organic_rank',
        'marketplace',
        'source',
      )}
      on conflict (org_id, asin, keyword, observed_on, source) do update
        set profile_id = excluded.profile_id,
            organic_rank = excluded.organic_rank,
            marketplace = excluded.marketplace
      returning id
    `;
    written += result.length;
  }
  const counts: RankObservationLoadCounts = {
    offered: offered.length,
    unique: consolidated.rows.length,
    duplicates: consolidated.duplicates,
    written,
  };
  if (counts.unique !== counts.written) throw new RankObservationLoadCountMismatch(counts);
  return counts;
}

function profileDate(now: Date, timezone: string): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
  } catch (cause) {
    throw new PermanentJobError(
      `The designated profile has an invalid timezone: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const value = (type: Intl.DateTimeFormatPartTypes): string | undefined =>
    parts.find((part) => part.type === type)?.value;
  const year = value('year');
  const month = value('month');
  const day = value('day');
  if (!year || !month || !day) throw new PermanentJobError('Could not derive the profile-local rank date');
  return `${year}-${month}-${day}`;
}

/**
 * DataDive names marketplaces by Amazon domain suffix ("com", "co.uk",
 * "com.au"); our profiles carry ISO country codes. Normalize both to the
 * country code so US ↔ "com" compares equal (live smoke 2026-08-27).
 */
const DOMAIN_SUFFIX_COUNTRIES: Record<string, string> = {
  'COM': 'US',
  'CO.UK': 'UK',
  'COM.AU': 'AU',
  'COM.MX': 'MX',
  'COM.BR': 'BR',
  'CO.JP': 'JP',
  'COM.TR': 'TR',
  'COM.BE': 'BE',
  'AE': 'AE',
  'SA': 'SA',
  'IN': 'IN',
};

function marketplace(value: string): string {
  const upper = value.trim().toUpperCase();
  const mapped = DOMAIN_SUFFIX_COUNTRIES[upper] ?? upper;
  // Our UK profiles are stored as either UK or GB depending on source.
  return mapped === 'GB' ? 'UK' : mapped;
}

export function rankObservationRows(
  payload: RankSyncJob,
  radar: RankRadar,
  data: RankRadarData,
  requestedDate: string,
): RankObservationInput[] {
  // Live smoke 2026-08-27: the endpoint returns surrounding days even for a
  // single-day request, and a day can appear twice for one keyword (a null
  // placeholder next to a real rank). Keep only the requested day, prefer a
  // non-null rank, and only treat two DIFFERENT non-null ranks as a conflict.
  const rows: RankObservationInput[] = [];
  for (const keyword of data.keywords) {
    let chosen: number | null | undefined;
    for (const rank of keyword.ranks) {
      if (rank.date !== requestedDate) continue;
      if (chosen === undefined || chosen === null) {
        chosen = rank.organicRank;
      } else if (rank.organicRank !== null && rank.organicRank !== chosen) {
        throw new ConflictingRankObservation(
          `radar=${radar.id}, keyword=${keyword.id}, date=${requestedDate}, ` +
            `ranks=${chosen} vs ${rank.organicRank}`,
        );
      }
    }
    if (chosen === undefined) continue;
    rows.push({
      orgId: payload.orgId,
      profileId: payload.profileId,
      asin: radar.asin.trim(),
      keyword: keyword.keyword.trim(),
      observedOn: requestedDate,
      organicRank: chosen,
      marketplace: marketplace(radar.marketplace),
      source: SOURCE,
    });
  }
  return rows;
}

function quotaRetrySeconds(quota: DataDiveQuota, now: Date): number {
  if (!quota.nextRefreshDate) return DEFAULT_QUOTA_RETRY_SECONDS;
  const refresh = Date.parse(quota.nextRefreshDate);
  if (Number.isNaN(refresh) || refresh <= now.getTime()) return DEFAULT_QUOTA_RETRY_SECONDS;
  return Math.max(60, Math.ceil((refresh - now.getTime()) / 1_000));
}

function quotaExhausted(quota: DataDiveQuota): boolean {
  const feature = quota.features.RANK_RADAR_KEYWORDS;
  return feature.used !== null && feature.capacity !== null && feature.used >= feature.capacity;
}

function mappedFailure(error: unknown): PermanentJobError | RetryableJobError {
  if (error instanceof PermanentJobError || error instanceof RetryableJobError) return error;
  if (error instanceof DataDiveThrottleError) {
    return new RetryableJobError(
      'DataDive rate limit remained active after bounded request retries',
      error.retryAfterMs === null ? undefined : Math.max(1, Math.ceil(error.retryAfterMs / 1_000)),
    );
  }
  if (error instanceof DataDiveTransportError) {
    return new RetryableJobError('DataDive could not be reached after bounded request retries');
  }
  if (error instanceof DataDiveHttpError) {
    return error.status >= 500
      ? new RetryableJobError(`DataDive returned retryable HTTP ${error.status}`)
      : new PermanentJobError(`DataDive rejected the rank sync with HTTP ${error.status}`);
  }
  if (
    error instanceof DataDiveParseError
    || error instanceof DataDiveConfigError
    || error instanceof ConflictingRankObservation
    || error instanceof RankObservationLoadCountMismatch
  ) {
    return new PermanentJobError(error.message);
  }
  return new RetryableJobError('DataDive rank sync failed before completion');
}

export function createDataDiveRankSyncHandler(options: DataDiveRankSyncOptions) {
  const store = new PostgresDataDiveRankSyncStore(options.handle);
  return createDataDiveRankSyncHandlerWithStore({
    store,
    clientFactory: options.clientFactory ?? ((credential) => new DataDiveClient({ apiKey: credential })),
    now: options.now,
  });
}

export function createDataDiveRankSyncHandlerWithStore(options: {
  store: DataDiveRankSyncStore;
  clientFactory: (credential: string) => DataDiveRankClient;
  now?: () => Date;
}) {
  const now = options.now ?? (() => new Date());
  return async (payload: RankSyncJob): Promise<Record<string, unknown>> => {
    const context = await options.store.resolve(payload);
    const client = options.clientFactory(context.credential);
    try {
      const quota = await client.getQuota();
      if (quotaExhausted(quota)) {
        throw new RetryableJobError(
          'DataDive Rank Radar keyword quota is exhausted; rank reads were skipped',
          quotaRetrySeconds(quota, now()),
        );
      }

      const listed = await client.listRankRadars();
      const requestedIds = payload.radarIds ?? context.configuredRadarIds;
      const selectedIds = requestedIds === undefined
        ? listed.items.map((radar) => radar.id)
        : distinct(requestedIds);
      const byId = new Map(listed.items.map((radar) => [radar.id, radar]));
      const missing = selectedIds.filter((id) => !byId.has(id));
      if (missing.length > 0) {
        throw new PermanentJobError(`Configured DataDive Rank Radar ids were not found: ${missing.join(', ')}`);
      }
      const selected = selectedIds.map((id) => byId.get(id) as RankRadar);
      const expectedMarketplace = marketplace(context.countryCode);
      for (const radar of selected) {
        const actualMarketplace = marketplace(radar.marketplace);
        if (actualMarketplace !== expectedMarketplace) {
          throw new PermanentJobError(
            `DataDive radar ${radar.id} marketplace ${actualMarketplace} does not match ` +
              `designated profile marketplace ${expectedMarketplace}`,
          );
        }
      }

      const observedOn = profileDate(now(), context.timezone);
      const rows: RankObservationInput[] = [];
      let keywords = 0;
      for (const radar of selected) {
        const data = await client.getRankRadarData(radar.id, {
          startDate: observedOn,
          endDate: observedOn,
        });
        keywords += data.keywords.length;
        rows.push(...rankObservationRows(payload, radar, data, observedOn));
      }
      const loaded = await options.store.load(rows);
      await options.store.recordSuccess(context.connectionId);
      const feature = quota.features.RANK_RADAR_KEYWORDS;
      return {
        provider: 'datadive',
        connectionId: context.connectionId,
        observedOn,
        radarsListed: listed.total,
        radarsSelected: selected.length,
        keywords,
        observations: loaded.offered,
        uniqueObservations: loaded.unique,
        duplicateObservations: loaded.duplicates,
        loaded: loaded.written,
        quotaUsed: feature.used,
        quotaCapacity: feature.capacity,
      };
    } catch (error) {
      const failure = mappedFailure(error);
      await options.store.recordFailure(
        context.connectionId,
        failure.message.slice(0, 4_000),
        failure instanceof PermanentJobError,
      );
      throw failure;
    }
  };
}
