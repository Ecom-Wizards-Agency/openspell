/**
 * The bid-corridor sync (WP-28).
 *
 * Amazon publishes a suggested-bid low/median/high per target per day. The
 * corridor chart (`tools/recon/04-optimizer.md` §3) draws that band with the
 * target's bid, its realized CPC and its max-potential CPC plotted inside it —
 * so this is a **sync-and-store** job, not an algorithm one: it reads the
 * suggested bids through the WP-27 endpoints, composes the max-potential CPC
 * from `packages/core`'s `maxPotentialCpc` (WP-26), and upserts one row per
 * target per day into `bid_series_daily`.
 *
 * It is **not** a queue job. The `sync_jobs` queue is driven by
 * `@wizard-ads/shared`'s `JobPayload` discriminated union, which this WP does
 * not own — adding a job type there is a `packages/shared` contract change, and
 * program rule 1 says stop and report one rather than make it. So the sync runs
 * as an in-process daily `PeriodicPass`, exactly like the auth healthcheck, the
 * schedule provisioner and the stale-claim reaper already do. The cadence lives
 * beside the others in `schedules.ts`.
 *
 * INTEGRATE (WP-28): a future queue-based variant (per-profile scoped, retried,
 * dead-lettered like the report jobs) needs a `bid_series.sync` member on
 * `shared`'s `JobType`/`JobPayload` and a matching `sync_job_type` enum value.
 * Both are cross-package contract changes for WP-00/WP-01; until then the
 * in-process pass is the whole of it.
 *
 * Program rule 4 is honoured the same way the fetch jobs honour it: the rows
 * composed are counted against the rows the store reports as written, and a
 * mismatch throws rather than reporting a success it did not verify.
 */
import { maxPotentialCpc, type ModifierComponent } from '@wizard-ads/core';
import {
  hasBidSeriesForDate,
  upsertBidSeries,
  type DbHandle,
  type NewBidSeriesRow,
} from '@wizard-ads/db';
import type { AdsProfileContext, SuggestedBidClient } from './ads-api.js';
import { defaultRegionTokenBuckets, type RegionTokenBuckets } from './region-token-buckets.js';
import type { WorkerLogger } from './worker.js';

/** One target the sync will read a corridor for, with the day's context. */
export interface BidSeriesTargetInput {
  targetId: string;
  isKeyword: boolean;
  campaignId: string;
  adGroupId: string;
  /** The bid in force. Null where the mirror has none (e.g. an auto target). */
  bid: number | null;
  /** Realized CPC over the reference day (cost / clicks), or null if no clicks. */
  cpc: number | null;
  /**
   * The target's placement modifiers, as Amazon stores them (percentage
   * uplift). Mutually exclusive — a click lands on one placement — so the
   * largest binds the max-potential CPC.
   */
  placementModifiers: ModifierComponent[];
}

export interface BidSeriesStore {
  /** Every profile whose sync is enabled: the corridor is synced for all of them. */
  listSyncEnabledProfiles(): Promise<AdsProfileContext[]>;
  /** The SP keywords and product targets to read a corridor for, with context. */
  listBidSeriesTargets(profile: AdsProfileContext, referenceDate: string): Promise<BidSeriesTargetInput[]>;
  /** Upsert the day's rows; returns the count the database reports as written. */
  upsertBidSeries(rows: readonly NewBidSeriesRow[]): Promise<number>;
  /**
   * Has this profile's corridor already been written for that profile-local
   * day? The daily gate: the pass is safe to invoke on every worker tick and on
   * every cron tick because this answers "already done" without an Amazon call.
   */
  hasSeriesForDate(profile: AdsProfileContext, date: string): Promise<boolean>;
}

export interface BidSeriesSyncDeps {
  store: BidSeriesStore;
  client: SuggestedBidClient;
  buckets?: RegionTokenBuckets;
  logger?: WorkerLogger;
  now?: () => Date;
  /**
   * An absolute `Date.now()` budget. Past it the pass stops before starting
   * another profile rather than being cut off mid-request by the platform;
   * the profiles it did not reach are counted, and the day's gate means the
   * next tick picks up exactly those.
   */
  deadlineMs?: number;
}

export interface BidSeriesSyncCounts {
  profiles: number;
  targets: number;
  corridors: number;
  written: number;
  /** Profiles whose corridor was already written for their local day. */
  skipped: number;
  /** Profiles whose sync threw. The pass fails only when every one did. */
  failed: number;
  /** Profiles the pass never reached because its time budget ran out. */
  unvisited: number;
}

/** The day, in a profile's own timezone, that a corridor row is stamped with. */
export function profileToday(timezone: string, now: Date): string {
  try {
    // `en-CA` renders as YYYY-MM-DD, which is exactly the profile-local calendar
    // day the facts use.
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** The reference day realized CPC is read from: the profile-local yesterday. */
function referenceDay(timezone: string, now: Date): string {
  const today = profileToday(timezone, now);
  const parsed = new Date(`${today}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return parsed.toISOString().slice(0, 10);
}

/**
 * Sync one profile's corridor for the day. Composes the row set, upserts it, and
 * proves rows written against corridors composed (program rule 4).
 */
export async function syncBidSeriesForProfile(
  profile: AdsProfileContext,
  deps: BidSeriesSyncDeps,
): Promise<{ targets: number; corridors: number; written: number }> {
  const buckets = deps.buckets ?? defaultRegionTokenBuckets;
  const now = deps.now ?? (() => new Date());
  const date = profileToday(profile.timezone, now());
  const reference = referenceDay(profile.timezone, now());

  const targets = await deps.store.listBidSeriesTargets(profile, reference);
  if (targets.length === 0) return { targets: 0, corridors: 0, written: 0 };

  const keywordIds = targets.filter((t) => t.isKeyword).map((t) => t.targetId);
  const targetIds = targets.filter((t) => !t.isKeyword).map((t) => t.targetId);

  const suggestions = await buckets.run(profile.region, () =>
    deps.client.getSpSuggestedBids(profile, { keywordIds, targetIds }),
  );

  const rows: NewBidSeriesRow[] = targets.map((target) => {
    const corridor = suggestions.byTarget.get(target.targetId) ?? null;
    const composed = maxPotentialCpc({
      baseBid: target.bid ?? 0,
      placementModifiers: target.placementModifiers,
    });
    return {
      orgId: profile.orgId,
      profileId: profile.id,
      date,
      campaignId: target.campaignId,
      adGroupId: target.adGroupId,
      targetId: target.targetId,
      isKeyword: target.isKeyword,
      suggestedBidLow: corridor?.low ?? null,
      suggestedBidMedian: corridor?.median ?? null,
      suggestedBidHigh: corridor?.high ?? null,
      bid: target.bid,
      cpc: target.cpc,
      // Only meaningful when there is a bid to inflate; null otherwise so the
      // chart draws a gap rather than a zero line.
      maxPotentialCpc: target.bid === null ? null : composed.value,
      modifierComponents: composed.components,
    };
  });

  const written = await deps.store.upsertBidSeries(rows);
  if (written !== rows.length) {
    throw new Error(`bid series composed ${rows.length} rows but wrote ${written}`);
  }
  const corridors = rows.filter((r) => r.suggestedBidMedian !== null).length;
  return { targets: targets.length, corridors, written };
}

/**
 * Sync the corridor for every sync-enabled profile.
 *
 * Two properties this pass earns rather than assumes:
 *
 *  - **Once per profile-local day.** The gate is the data itself — a profile
 *    that already has rows stamped with its local today is skipped — so the
 *    pass can be invoked on every worker tick or every five-minute cron tick
 *    without spending Amazon quota twice. It is per profile rather than global
 *    because "today" is a different day in Los Angeles and in Tokyo.
 *  - **Per-profile isolation.** One profile's throw used to end the pass, so a
 *    single 429 on the first profile starved every profile after it of a whole
 *    day's corridor. Each is now caught, logged and counted; the pass fails
 *    only when every profile it attempted failed, which is the case that means
 *    something systemic rather than something local.
 */
export async function runBidSeriesSync(deps: BidSeriesSyncDeps): Promise<BidSeriesSyncCounts> {
  const logger = deps.logger;
  const now = deps.now ?? (() => new Date());
  const profiles = await deps.store.listSyncEnabledProfiles();
  const counts: BidSeriesSyncCounts = {
    profiles: 0, targets: 0, corridors: 0, written: 0, skipped: 0, failed: 0, unvisited: 0,
  };
  const failures: unknown[] = [];

  for (const [index, profile] of profiles.entries()) {
    if (deps.deadlineMs !== undefined && now().getTime() >= deps.deadlineMs) {
      counts.unvisited = profiles.length - index;
      logger?.info('bid series sync stopped on its time budget', { unvisited: counts.unvisited });
      break;
    }
    try {
      const date = profileToday(profile.timezone, now());
      if (await deps.store.hasSeriesForDate(profile, date)) {
        counts.skipped += 1;
        continue;
      }
      const result = await syncBidSeriesForProfile(profile, deps);
      counts.profiles += 1;
      counts.targets += result.targets;
      counts.corridors += result.corridors;
      counts.written += result.written;
      logger?.info('bid series synced', {
        profileId: profile.id,
        targets: result.targets,
        corridors: result.corridors,
        written: result.written,
      });
    } catch (error) {
      counts.failed += 1;
      failures.push(error);
      logger?.error('bid series sync failed for a profile', {
        profileId: profile.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Every profile that was attempted failed: that is the pass failing, not one
  // profile failing, and the caller should see it.
  const attempted = counts.profiles + counts.failed;
  if (attempted > 0 && counts.failed === attempted) {
    throw failures[0] instanceof Error
      ? failures[0]
      : new Error(`bid series sync failed for all ${counts.failed} profiles`);
  }
  return counts;
}

/**
 * The real store, over the same handle the worker uses. The target read joins
 * the SP keyword and product-target mirrors to their campaign's placement
 * modifiers and to the prior day's facts for realized CPC.
 */
export class PostgresBidSeriesStore implements BidSeriesStore {
  constructor(private readonly handle: DbHandle) {}

  async listSyncEnabledProfiles(): Promise<AdsProfileContext[]> {
    const rows = await this.handle.sql<
      {
        id: string;
        org_id: string;
        connection_id: string | null;
        amazon_profile_id: string;
        region: 'NA' | 'EU' | 'FE';
        currency_code: string;
        timezone: string;
      }[]
    >`
      select id, org_id, connection_id, amazon_profile_id, region, currency_code, timezone
        from public.ad_profiles
       where sync_enabled
       order by id
    `;
    return rows.map((row) => ({
      id: row.id,
      orgId: row.org_id,
      connectionId: row.connection_id,
      amazonProfileId: row.amazon_profile_id,
      region: row.region,
      currencyCode: row.currency_code,
      timezone: row.timezone,
    }));
  }

  hasSeriesForDate(profile: AdsProfileContext, date: string): Promise<boolean> {
    return hasBidSeriesForDate(this.handle, { profileId: profile.id, date });
  }

  /**
   * The targets a corridor is worth reading for: live SP keywords and product
   * targets. Paused and archived ones are excluded as well as deleted ones —
   * Amazon still answers a suggested bid for a paused keyword, and paying for
   * that answer (and storing it) buys a band under a line that cannot move.
   */
  async listBidSeriesTargets(
    profile: AdsProfileContext,
    referenceDate: string,
  ): Promise<BidSeriesTargetInput[]> {
    const rows = await this.handle.sql<
      {
        target_id: string;
        is_keyword: boolean;
        campaign_id: string;
        ad_group_id: string;
        bid: string | number | null;
        placement_bidding: { topOfSearch: number | null; productPages: number | null; restOfSearch: number | null } | null;
        cost: string | number | null;
        clicks: string | number | null;
      }[]
    >`
      with facts as (
        select target_id, sum(cost) as cost, sum(clicks) as clicks
          from public.fact_sp_target_daily
         where profile_id = ${profile.id} and date = ${referenceDate}
         group by target_id
      )
      select k.amazon_id as target_id, true as is_keyword,
             k.campaign_id, k.ad_group_id, k.bid,
             c.placement_bidding, f.cost, f.clicks
        from public.keywords k
        left join public.campaigns c
          on c.profile_id = k.profile_id and c.amazon_id = k.campaign_id
        left join facts f on f.target_id = k.amazon_id
       where k.profile_id = ${profile.id} and k.deleted_at is null and k.ad_product = 'SP'
         and k.state = 'enabled'
      union all
      select t.amazon_id as target_id, false as is_keyword,
             t.campaign_id, t.ad_group_id, t.bid,
             c.placement_bidding, f.cost, f.clicks
        from public.targets t
        left join public.campaigns c
          on c.profile_id = t.profile_id and c.amazon_id = t.campaign_id
        left join facts f on f.target_id = t.amazon_id
       where t.profile_id = ${profile.id} and t.deleted_at is null and t.ad_product = 'SP'
         and t.state = 'enabled'
    `;

    return rows.map((row) => {
      const clicks = row.clicks === null ? 0 : Number(row.clicks);
      const cost = row.cost === null ? 0 : Number(row.cost);
      return {
        targetId: row.target_id,
        isKeyword: row.is_keyword,
        campaignId: row.campaign_id,
        adGroupId: row.ad_group_id,
        bid: row.bid === null ? null : Number(row.bid),
        cpc: clicks > 0 ? Number((cost / clicks).toFixed(4)) : null,
        placementModifiers: placementModifiersOf(row.placement_bidding),
      };
    });
  }

  async upsertBidSeries(rows: readonly NewBidSeriesRow[]): Promise<number> {
    const counts = await upsertBidSeries(this.handle, rows);
    return counts.written;
  }
}

/** The campaign's non-zero placement uplifts, as modifier components. */
function placementModifiersOf(
  bidding: { topOfSearch: number | null; productPages: number | null; restOfSearch: number | null } | null,
): ModifierComponent[] {
  if (bidding === null) return [];
  const named: Array<[string, number | null]> = [
    ['top_of_search', bidding.topOfSearch],
    ['product_pages', bidding.productPages],
    ['rest_of_search', bidding.restOfSearch],
  ];
  const components: ModifierComponent[] = [];
  for (const [name, pct] of named) {
    if (pct !== null && pct > 0) components.push({ name, pct });
  }
  return components;
}
