/** My Real Profit economics.sync handler: Vault -> sellers -> ASINs -> counted daily upsert. */
import { getIntegrationSecret } from '@wizard-ads/db/worker';
import {
  ProductEconomicsLoadCountMismatch,
  upsertProductEconomics,
} from '@wizard-ads/db';
import type {
  DbHandle,
  NewProductEconomics,
  ProductEconomicsLoadCounts,
} from '@wizard-ads/db';
import {
  MrpAuthError,
  MrpClient,
  MrpConfigError,
  MrpHttpError,
  MrpParseError,
  MrpProtocolError,
  MrpToolCallError,
  MrpToolNotFoundError,
  MrpTransportError,
} from '@wizard-ads/mrp-api';
import type {
  FetchLike,
  MrpClientOptions,
  MrpPeriod,
  MrpProductMetrics,
  MrpProductMetricsInput,
  MrpProductMetricsResult,
  MrpSeller,
  MrpSellersResult,
} from '@wizard-ads/mrp-api';
import type { EconomicsSyncJob, Region } from '@wizard-ads/shared';
import { marketplaceIdForCountry } from './marketplaces.js';
import { PermanentJobError } from './worker.js';

export { marketplaceIdForCountry } from './marketplaces.js';

const DEFAULT_MAX_ASINS = 25;
const MAX_RECORDED_NOTES = 20;

export interface MrpConnection {
  id: string;
  config: Record<string, unknown>;
}

export interface MrpSyncProfile {
  id: string;
  accountName: string | null;
  region: Region;
  countryCode: string;
  currencyCode: string;
  timezone: string;
  syncEnabled: boolean;
}

export interface MrpSyncScope {
  connection: MrpConnection;
  targetProfile: MrpSyncProfile;
  profiles: MrpSyncProfile[];
}

export interface MrpAsinSelection {
  asins: string[];
  total: number;
}

export interface MrpSellerMatch {
  profileId: string;
  seller: MrpSeller;
  source: 'config' | 'name';
}

export interface MrpEconomicsSyncStore {
  scope(payload: EconomicsSyncJob): Promise<MrpSyncScope | null>;
  secret(connectionId: string): Promise<string | null>;
  advertisedAsins(args: {
    orgId: string;
    profileId: string;
    limit: number;
  }): Promise<MrpAsinSelection>;
  load(rows: readonly NewProductEconomics[]): Promise<ProductEconomicsLoadCounts>;
  succeeded(args: {
    orgId: string;
    connectionId: string;
    syncedAt: Date;
    note: string | null;
  }): Promise<void>;
  failed(args: {
    orgId: string;
    connectionId: string;
    lastError: string;
    disable: boolean;
  }): Promise<void>;
}

interface MrpEconomicsClient {
  fetchSellers(): Promise<MrpSellersResult>;
  fetchProductMetrics(input: MrpProductMetricsInput): Promise<MrpProductMetricsResult>;
}

export interface MrpEconomicsSyncOptions {
  fetch?: FetchLike;
  now?: () => Date;
  clientFactory?: (options: MrpClientOptions) => MrpEconomicsClient;
}

const URL_REQUIRED = 'Enter the My Real Profit MCP URL in this connection\'s config.url.';
const TOKEN_REQUIRED = 'Enter a My Real Profit personal access token in Settings > Integrations.';

function configUrl(config: Record<string, unknown>): string | null {
  const value = config['url'];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function maxAsins(config: Record<string, unknown>): number {
  const value = config['max_asins'];
  if (value === undefined) return DEFAULT_MAX_ASINS;
  const parsed = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new MrpConfigError('My Real Profit config.max_asins must be a positive integer.');
  }
  return parsed;
}

function sellerMap(config: Record<string, unknown>): Record<string, number> {
  const value = config['seller_map'];
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MrpConfigError('My Real Profit config.seller_map must map profile ids to seller ids.');
  }
  const parsed: Record<string, number> = {};
  for (const [profileId, sellerIdValue] of Object.entries(value)) {
    const sellerId = typeof sellerIdValue === 'string' && /^\d+$/.test(sellerIdValue.trim())
      ? Number(sellerIdValue.trim())
      : sellerIdValue;
    if (!profileId.trim() || typeof sellerId !== 'number' || !Number.isSafeInteger(sellerId)) {
      throw new MrpConfigError('My Real Profit config.seller_map values must be integer seller ids.');
    }
    parsed[profileId] = sellerId;
  }
  return parsed;
}

function normalizedName(value: string | null): string {
  return (value ?? '').replace(/\s+/g, '').toLocaleLowerCase('en-US');
}

function canonicalRegion(value: string | null): string {
  return (value ?? '').replace(/[^a-zA-Z]+/g, '').toLocaleLowerCase('en-US');
}

function sellerRegionMatches(profile: MrpSyncProfile, seller: MrpSeller): boolean {
  const region = canonicalRegion(seller.region);
  if (region === 'northamerica' || region === 'na') {
    return profile.region === 'NA' && ['US', 'CA'].includes(profile.countryCode.toUpperCase());
  }
  if (region === 'europe' || region === 'eu') return profile.region === 'EU';
  if (['fareast', 'asiapacific', 'apac', 'fe'].includes(region)) return profile.region === 'FE';
  return false;
}

function profilePreference(profile: MrpSyncProfile, seller: MrpSeller): number {
  const regional = sellerRegionMatches(profile, seller);
  if (profile.syncEnabled && regional) return 3;
  if (regional) return 2;
  if (profile.syncEnabled) return 1;
  return 0;
}

/**
 * Map explicit profile overrides first, then assign each remaining seller to
 * the best normalized-name profile in its region.
 */
export function matchMrpSellersToProfiles(
  sellers: readonly MrpSeller[],
  profiles: readonly MrpSyncProfile[],
  overrides: Readonly<Record<string, number>>,
): MrpSellerMatch[] {
  const matches: MrpSellerMatch[] = [];
  const matchedProfiles = new Set<string>();
  const overriddenProfiles = new Set(Object.keys(overrides));
  const explicitlyUsedSellers = new Set<number>();
  const sellerById = new Map(sellers.map((seller) => [seller.sellerId, seller]));

  for (const profile of profiles) {
    const configuredSellerId = overrides[profile.id];
    if (configuredSellerId === undefined) continue;
    const seller = sellerById.get(configuredSellerId);
    if (!seller) continue;
    matches.push({ profileId: profile.id, seller, source: 'config' });
    matchedProfiles.add(profile.id);
    explicitlyUsedSellers.add(seller.sellerId);
  }

  for (const seller of sellers) {
    if (explicitlyUsedSellers.has(seller.sellerId)) continue;
    const sellerName = normalizedName(seller.name);
    const candidates = profiles
      .filter((profile) =>
        !matchedProfiles.has(profile.id)
        && !overriddenProfiles.has(profile.id)
        && sellerName !== ''
        && normalizedName(profile.accountName) === sellerName)
      .sort((left, right) =>
        profilePreference(right, seller) - profilePreference(left, seller)
        || left.id.localeCompare(right.id));
    const profile = candidates[0];
    if (!profile) continue;
    matches.push({ profileId: profile.id, seller, source: 'name' });
    matchedProfiles.add(profile.id);
  }
  return matches;
}

function profileDate(timezone: string, now: Date): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
  } catch {
    throw new MrpConfigError('The MRP profile timezone is invalid.');
  }
  const part = (type: Intl.DateTimeFormatPartTypes): string | undefined =>
    parts.find((candidate) => candidate.type === type)?.value;
  const year = part('year');
  const month = part('month');
  const day = part('day');
  if (!year || !month || !day) throw new MrpConfigError('Could not derive the MRP profile date.');
  return `${year}-${month}-${day}`;
}

/** Yesterday in the profile calendar: the smallest safe complete provider window. */
export function lastCompleteProfileDay(timezone: string, now: Date): string {
  const today = new Date(`${profileDate(timezone, now)}T00:00:00Z`);
  today.setUTCDate(today.getUTCDate() - 1);
  return today.toISOString().slice(0, 10);
}

/** Null means the provider says the requested capture day is fully available. */
export function incompleteMrpPeriodReason(period: MrpPeriod, capturedOn: string): string | null {
  if (period.to !== capturedOn) {
    return `provider period ended ${period.to}, not requested window end ${capturedOn}`;
  }
  if (period.complete === false) return period.note ?? 'provider marked the period incomplete';
  if (period.incompleteSources.length > 0) {
    return `provider marked sources incomplete: ${period.incompleteSources.join(', ')}`;
  }
  const unavailable = Object.entries(period.dataAvailableThrough)
    .filter(([, date]) => date === null || date < capturedOn)
    .map(([source, date]) => `${source}=${date ?? 'unloaded'}`);
  return unavailable.length === 0
    ? null
    : `provider data is not loaded through ${capturedOn}: ${unavailable.join(', ')}`;
}

/** Pure 1:1 mapper. captured_on is always the requested window end. */
export function mapMrpProductMetrics(
  args: { orgId: string; profileId: string; capturedOn: string; loadedAt: Date },
  metrics: MrpProductMetrics,
): NewProductEconomics {
  const product = metrics.product;
  return {
    orgId: args.orgId,
    profileId: args.profileId,
    asin: product.asin,
    capturedOn: args.capturedOn,
    salePrice: product.salePrice,
    cogs: product.cogs,
    fbaFees: product.fbaFees,
    referralFees: product.referralFees,
    otherFees: product.otherFees,
    margin: product.margin,
    ltvRevenue: product.ltvRevenue,
    ltvOrders: product.ltvOrders,
    repeatRate: product.repeatRate,
    currency: product.currency,
    source: 'mrp',
    details: product.details,
    loadedAt: args.loadedAt,
  };
}

function operatorFailure(error: unknown): { message: string; permanent: boolean } {
  if (error instanceof MrpAuthError) {
    return {
      message: 'My Real Profit rejected the personal access token. Replace it in Settings > Integrations.',
      permanent: true,
    };
  }
  if (error instanceof MrpTransportError) {
    return {
      message: 'My Real Profit could not be reached. The worker will retry the sync.',
      permanent: false,
    };
  }
  if (error instanceof MrpHttpError) {
    return {
      message: `My Real Profit returned HTTP ${error.status}. ${error.status >= 500 ? 'The worker will retry.' : 'Check the integration configuration.'}`,
      permanent: error.status < 500 && ![408, 425, 429].includes(error.status),
    };
  }
  if (error instanceof MrpToolNotFoundError) {
    return {
      message: 'My Real Profit did not expose the required live product tools.',
      permanent: true,
    };
  }
  if (
    error instanceof MrpConfigError
    || error instanceof MrpParseError
    || error instanceof MrpProtocolError
    || error instanceof MrpToolCallError
  ) {
    return {
      message: `My Real Profit sync could not continue: ${error.message}`,
      permanent: true,
    };
  }
  return {
    message: 'My Real Profit sync failed temporarily. The worker will retry it.',
    permanent: false,
  };
}

function fatalPerAsinFailure(error: unknown): boolean {
  if (error instanceof MrpAuthError || error instanceof MrpTransportError) return true;
  return error instanceof MrpHttpError && (error.status >= 500 || [408, 425, 429].includes(error.status));
}

function perAsinNote(asin: string, error: unknown): string {
  let detail = 'unexpected provider response';
  if (
    error instanceof MrpToolCallError
    || error instanceof MrpParseError
    || error instanceof MrpProtocolError
    || error instanceof MrpConfigError
  ) {
    detail = error.message;
  } else if (error instanceof MrpHttpError) {
    detail = `provider returned HTTP ${error.status}`;
  }
  return `${asin}: ${detail}`.slice(0, 600);
}

function recordedNotes(notes: readonly string[]): string[] {
  if (notes.length <= MAX_RECORDED_NOTES) return [...notes];
  return [
    ...notes.slice(0, MAX_RECORDED_NOTES),
    `${notes.length - MAX_RECORDED_NOTES} additional notes omitted`,
  ];
}

/** Provider-independent orchestration seam used by unit tests and the DB-bound factory. */
export function createMrpEconomicsHandler(
  store: MrpEconomicsSyncStore,
  options: MrpEconomicsSyncOptions = {},
): (payload: EconomicsSyncJob) => Promise<Record<string, unknown>> {
  const now = options.now ?? (() => new Date());
  const clientFactory = options.clientFactory ?? ((clientOptions) => new MrpClient(clientOptions));

  return async (payload) => {
    const scope = await store.scope(payload);
    if (!scope) {
      throw new PermanentJobError('No active My Real Profit connection is configured for this profile.');
    }
    const { connection, targetProfile } = scope;

    const failPermanently = async (message: string): Promise<never> => {
      await store.failed({
        orgId: payload.orgId,
        connectionId: connection.id,
        lastError: message,
        disable: true,
      });
      throw new PermanentJobError(message);
    };

    const endpoint = configUrl(connection.config);
    if (!endpoint) return failPermanently(URL_REQUIRED);
    const token = await store.secret(connection.id);
    if (!token?.trim()) return failPermanently(TOKEN_REQUIRED);

    let configuredSellerMap: Record<string, number>;
    let asinLimit: number;
    try {
      configuredSellerMap = sellerMap(connection.config);
      asinLimit = maxAsins(connection.config);
    } catch (error) {
      const failure = operatorFailure(error);
      return failPermanently(failure.message);
    }

    const capturedAt = now();
    let capturedOn: string;
    try {
      capturedOn = lastCompleteProfileDay(targetProfile.timezone, capturedAt);
    } catch (error) {
      return failPermanently(operatorFailure(error).message);
    }
    const marketplaceId = marketplaceIdForCountry(targetProfile.countryCode);
    if (!marketplaceId) {
      return failPermanently(
        `My Real Profit has no marketplace-id mapping for profile country ${targetProfile.countryCode}.`,
      );
    }

    const clientOptions: MrpClientOptions = {
      endpoint,
      token,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    };
    const notes: string[] = [];
    try {
      const client = clientFactory(clientOptions);
      const sellerResult = await client.fetchSellers();
      const matches = matchMrpSellersToProfiles(
        sellerResult.sellers,
        scope.profiles,
        configuredSellerMap,
      );
      const match = matches.find((candidate) => candidate.profileId === targetProfile.id);
      if (!match) {
        const configured = configuredSellerMap[targetProfile.id];
        notes.push(configured === undefined
          ? `Profile ${targetProfile.id} was skipped: no MRP seller matched its normalized account name and region.`
          : `Profile ${targetProfile.id} was skipped: configured MRP seller id ${configured} was not returned.`);
        const keptNotes = recordedNotes(notes);
        await store.succeeded({
          orgId: payload.orgId,
          connectionId: connection.id,
          syncedAt: capturedAt,
          note: keptNotes.join(' ').slice(0, 4_000),
        });
        return {
          provider: 'mrp',
          sellerToolName: sellerResult.toolName,
          sellersReceived: sellerResult.sellers.length,
          sellerLinesIgnored: sellerResult.ignoredLines,
          profilesConsidered: scope.profiles.length,
          profileMatched: false,
          asinsAvailable: 0,
          asinsSelected: 0,
          asinsSkippedByCap: 0,
          productCallsSucceeded: 0,
          productsSkippedIncomplete: 0,
          productCallsFailed: 0,
          rowsLoaded: 0,
          capturedOn,
          notes: keptNotes,
        };
      }

      const selection = await store.advertisedAsins({
        orgId: payload.orgId,
        profileId: targetProfile.id,
        limit: asinLimit,
      });
      const skippedByCap = Math.max(0, selection.total - selection.asins.length);
      if (skippedByCap > 0) {
        notes.push(`${skippedByCap} advertised ASIN(s) skipped by config.max_asins=${asinLimit}.`);
      }
      if (selection.total === 0) {
        notes.push('Profile was skipped: the synced product-ad mirror contains no active advertised ASINs.');
      }

      const rows: NewProductEconomics[] = [];
      let callsSucceeded = 0;
      let skippedIncomplete = 0;
      let callsFailed = 0;
      let productToolName: string | null = null;
      for (const asin of selection.asins) {
        try {
          const result = await client.fetchProductMetrics({
            asin,
            sellerIds: [match.seller.sellerId],
            marketplaceIds: [marketplaceId],
            dateFrom: capturedOn,
            dateTo: capturedOn,
          });
          productToolName = result.toolName;
          callsSucceeded += 1;
          const incomplete = incompleteMrpPeriodReason(result.metrics.period, capturedOn);
          if (incomplete) {
            skippedIncomplete += 1;
            notes.push(`${asin}: skipped unloaded period; ${incomplete}`);
            continue;
          }
          rows.push(mapMrpProductMetrics({
            orgId: payload.orgId,
            profileId: targetProfile.id,
            capturedOn,
            loadedAt: capturedAt,
          }, result.metrics));
        } catch (error) {
          if (fatalPerAsinFailure(error)) throw error;
          callsFailed += 1;
          notes.push(perAsinNote(asin, error));
        }
      }

      const counts = await store.load(rows);
      if (counts.offered !== rows.length || counts.written !== rows.length) {
        throw new ProductEconomicsLoadCountMismatch(counts);
      }
      const keptNotes = recordedNotes(notes);
      await store.succeeded({
        orgId: payload.orgId,
        connectionId: connection.id,
        syncedAt: capturedAt,
        note: keptNotes.length === 0 ? null : keptNotes.join(' ').slice(0, 4_000),
      });
      return {
        provider: 'mrp',
        sellerToolName: sellerResult.toolName,
        productToolName,
        sellersReceived: sellerResult.sellers.length,
        sellerLinesIgnored: sellerResult.ignoredLines,
        profilesConsidered: scope.profiles.length,
        profileMatched: true,
        sellerMatchSource: match.source,
        sellerId: match.seller.sellerId,
        marketplaceId,
        asinsAvailable: selection.total,
        asinsSelected: selection.asins.length,
        asinsSkippedByCap: skippedByCap,
        productCallsSucceeded: callsSucceeded,
        productsSkippedIncomplete: skippedIncomplete,
        productCallsFailed: callsFailed,
        rowsLoaded: counts.written,
        capturedOn,
        notes: keptNotes,
      };
    } catch (error) {
      const failure = operatorFailure(error);
      await store.failed({
        orgId: payload.orgId,
        connectionId: connection.id,
        lastError: failure.message.slice(0, 4_000),
        disable: failure.permanent,
      }).catch(() => {});
      if (failure.permanent) throw new PermanentJobError(failure.message);
      throw error;
    }
  };
}

interface ProfileSqlRow {
  id: string;
  account_name: string | null;
  region: Region;
  country_code: string;
  currency_code: string;
  timezone: string;
  sync_enabled: boolean;
}

function syncProfile(row: ProfileSqlRow): MrpSyncProfile {
  return {
    id: row.id,
    accountName: row.account_name,
    region: row.region,
    countryCode: row.country_code,
    currencyCode: row.currency_code,
    timezone: row.timezone,
    syncEnabled: row.sync_enabled,
  };
}

class PostgresMrpEconomicsSyncStore implements MrpEconomicsSyncStore {
  constructor(private readonly handle: DbHandle) {}

  async scope(payload: EconomicsSyncJob): Promise<MrpSyncScope | null> {
    const profiles = await this.handle.sql<ProfileSqlRow[]>`
      select id, account_name, region, country_code, currency_code, timezone, sync_enabled
        from public.ad_profiles
       where org_id = ${payload.orgId}
       order by id
    `;
    const target = profiles.find((profile) => profile.id === payload.profileId);
    if (!target) throw new PermanentJobError('The designated MRP profile does not exist in this org.');
    const connections = await this.handle.sql<{ id: string; config: Record<string, unknown> }[]>`
      select id, config
        from public.integration_connections
       where org_id = ${payload.orgId}
         and provider = 'mrp'
         and status = 'active'
         and (
           nullif(btrim(config ->> 'profile_id'), '') is null
           or config ->> 'profile_id' = ${payload.profileId}
         )
       order by (config ->> 'profile_id' = ${payload.profileId}) desc, created_at, id
       limit 1
    `;
    const connection = connections[0];
    if (!connection) return null;
    return {
      connection,
      targetProfile: syncProfile(target),
      profiles: profiles.map(syncProfile),
    };
  }

  secret(connectionId: string): Promise<string | null> {
    return getIntegrationSecret(this.handle, connectionId);
  }

  async advertisedAsins(args: {
    orgId: string;
    profileId: string;
    limit: number;
  }): Promise<MrpAsinSelection> {
    const rows = await this.handle.sql<{ asin: string; total: string }[]>`
      with advertised as (
        select distinct upper(btrim(asin)) as asin, campaign_id, ad_group_id
          from public.product_ads
         where org_id = ${args.orgId}
           and profile_id = ${args.profileId}
           and deleted_at is null
           and state <> 'archived'
           and asin is not null
           and btrim(asin) ~ '^[A-Za-z0-9]{10}$'
      ),
      recent_ad_group_spend as (
        select campaign_id, ad_group_id, sum(cost) as spend
          from public.fact_sp_target_daily
         where org_id = ${args.orgId}
           and profile_id = ${args.profileId}
           and date >= current_date - interval '30 days'
         group by campaign_id, ad_group_id
      ),
      ranked as (
        select a.asin, coalesce(sum(s.spend), 0) as recent_spend
          from advertised a
          left join recent_ad_group_spend s
            on s.campaign_id = a.campaign_id and s.ad_group_id = a.ad_group_id
         group by a.asin
      )
      select asin, count(*) over ()::text as total
        from ranked
       order by recent_spend desc, asin
       limit ${args.limit}
    `;
    return {
      asins: rows.map((row) => row.asin),
      total: Number(rows[0]?.total ?? 0),
    };
  }

  load(rows: readonly NewProductEconomics[]): Promise<ProductEconomicsLoadCounts> {
    return upsertProductEconomics(this.handle, rows);
  }

  async succeeded(args: {
    orgId: string;
    connectionId: string;
    syncedAt: Date;
    note: string | null;
  }): Promise<void> {
    const rows = await this.handle.sql<{ id: string }[]>`
      update public.integration_connections
         set status = 'active', last_synced_at = ${args.syncedAt.toISOString()}, last_error = ${args.note}
       where org_id = ${args.orgId} and id = ${args.connectionId} and provider = 'mrp'
      returning id
    `;
    if (rows.length !== 1) throw new Error('MRP connection disappeared before sync completion');
  }

  async failed(args: {
    orgId: string;
    connectionId: string;
    lastError: string;
    disable: boolean;
  }): Promise<void> {
    await this.handle.sql`
      update public.integration_connections
         set status = case when ${args.disable} then 'error'::public.connection_status else status end,
             last_error = ${args.lastError}
       where org_id = ${args.orgId} and id = ${args.connectionId} and provider = 'mrp'
    `;
  }
}

/** Bind the economics handler to the service-role database used by the worker. */
export function createMrpEconomicsSync(
  handle: DbHandle,
  options: MrpEconomicsSyncOptions = {},
): (payload: EconomicsSyncJob) => Promise<Record<string, unknown>> {
  return createMrpEconomicsHandler(new PostgresMrpEconomicsSyncStore(handle), options);
}
