import { isDeepStrictEqual } from 'node:util';
import {
  adGroups,
  campaigns,
  claimSyncJobs,
  factSbDaily,
  factSdDaily,
  finishSyncJob,
  keywords,
  negatives,
  portfolios,
  productAds,
  recordEntityChanges,
  reportRequests,
  requeueStaleSyncJobs,
  targets,
  upsertMirrorRows,
  upsertPlacementFacts,
  upsertProfileFacts,
  upsertSearchTermFacts,
  upsertSpTargetFacts,
  type ClaimedJob,
  type DbHandle,
  type JobOutcome,
  type NewEntityChange,
} from '@wizard-ads/db';
import type { EntityRow, JobPayload, ReportType } from '@wizard-ads/shared';
import type { AdsProfileContext } from './ads-api.js';
import type { CampaignFactRow, ParsedFactBatch } from './parsers.js';
import { defaultSchedules, type ScheduleSpec } from './schedules.js';

export interface ReportRequestState {
  id: string;
  reportType: ReportType;
  amazonReportId: string | null;
  requestedAt: Date;
  pollAttempts: number;
}

/**
 * `drizzle-orm/postgres-js` replaces the shared client's timestamptz serializer
 * *and* parser with the identity function, because Drizzle does its own date
 * mapping. `createDb` builds the Drizzle instance over the same postgres.js
 * client the raw tag uses, so that override applies to every raw query in this
 * file too: binding a `Date` throws, and reading a timestamptz yields the wire
 * string rather than a `Date`.
 *
 * The two helpers below are that boundary, in both directions. Every raw
 * timestamptz this store binds goes through `iso`; every one it reads comes
 * back through `asDate`. Drizzle-built statements need neither.
 */
function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

export interface EntitySyncOptions {
  adProduct?: 'SP' | 'SB' | 'SD';
  /**
   * A full pass re-lists every entity the profile has, so an id the mirror
   * holds and the listing omits really is gone and earns a tombstone. A delta
   * pass carries no such information — sweeping on one would tombstone every
   * entity type the pass did not happen to list.
   */
  full?: boolean;
}

export interface EntitySyncCounts {
  listed: number;
  upserted: number;
  changes: number;
  tombstoned: number;
}

export interface WorkerStore {
  claim(workerId: string, limit: number): Promise<ClaimedJob[]>;
  finish(
    jobId: string,
    outcome: JobOutcome,
    options?: { error?: string; result?: unknown; retryIn?: string },
  ): Promise<void>;
  /**
   * Finish a job as `dead` without spending its remaining attempts. For
   * failures no retry can fix — a malformed export, a payload naming a profile
   * that does not exist — retrying five times only delays the human.
   */
  deadLetter(jobId: string, error: string): Promise<void>;
  release(workerId: string): Promise<number>;
  /**
   * Requeue jobs still `running` on a worker that died without releasing them.
   * Nothing else does this: `claim_sync_jobs` only ever sees `queued`, so a
   * SIGKILLed worker's jobs are lost until somebody sweeps them back.
   */
  requeueStale(olderThan: string): Promise<number>;
  profile(profileId: string): Promise<AdsProfileContext>;
  syncEntities(
    profile: AdsProfileContext,
    entities: readonly EntityRow[],
    options?: EntitySyncOptions,
  ): Promise<EntitySyncCounts>;
  ensureReportRequest(jobId: string, payload: Extract<JobPayload, { type: 'report.request' }>): Promise<ReportRequestState>;
  setReportCreated(reportRequestId: string, amazonReportId: string, nextPollAt: Date): Promise<void>;
  getReportRequest(reportRequestId: string): Promise<ReportRequestState>;
  updateReportPoll(
    reportRequestId: string,
    values: {
      status: 'pending' | 'processing' | 'failed' | 'cancelled' | 'expired';
      nextPollAt?: Date | null;
      error?: string | null;
      downloadUrl?: string | null;
      downloadExpiresAt?: Date | null;
    },
  ): Promise<void>;
  enqueue(payload: JobPayload, runAt: Date, dedupeKey: string): Promise<boolean>;
  /** Install the default cadences for a profile. Idempotent on the scope key. */
  provisionSchedules(
    orgId: string,
    profileId: string,
    specs?: readonly ScheduleSpec[],
  ): Promise<number>;
  /**
   * Sync-enabled profiles with no schedule rows at all. Deliberately not "every
   * enabled profile": a profile whose schedules an operator pruned should stay
   * pruned, and only one that has never been provisioned gets the defaults.
   */
  unscheduledProfiles(): Promise<{ orgId: string; profileId: string }[]>;
  loadFacts(batch: ParsedFactBatch): Promise<number>;
  completeReport(
    reportRequestId: string,
    counts: { parsed: number; loaded: number; bytesDownloaded: number },
  ): Promise<void>;
}

export class ParsedLoadedMismatch extends Error {
  constructor(readonly parsed: number, readonly loaded: number) {
    super(`report parsed ${parsed} rows but loaded ${loaded}`);
    this.name = 'ParsedLoadedMismatch';
  }
}

/** `deletedAt` arrives as the wire string, not a `Date` — see the note on `asDate`. */
type ExistingEntity = { amazonId: string; deletedAt: Date | string | null; snapshot: Record<string, unknown> };

export class PostgresWorkerStore implements WorkerStore {
  constructor(readonly handle: DbHandle) {}

  claim(workerId: string, limit: number): Promise<ClaimedJob[]> {
    return claimSyncJobs(this.handle, workerId, limit);
  }

  async finish(
    jobId: string,
    outcome: JobOutcome,
    options: { error?: string; result?: unknown; retryIn?: string } = {},
  ): Promise<void> {
    await finishSyncJob(this.handle, jobId, outcome, options);
  }

  async deadLetter(jobId: string, error: string): Promise<void> {
    // `finish_sync_job` only derives `dead` from exhausted attempts, so a
    // permanent failure says the word itself and takes the function's
    // pass-through branch.
    await this.handle.sql`
      select public.finish_sync_job(
        ${jobId}, 'dead'::public.sync_job_status, ${error}, null::jsonb, null::interval
      )
    `;
  }

  async release(workerId: string): Promise<number> {
    const rows = await this.handle.sql<{ id: string }[]>`
      update public.sync_jobs
         set status = 'queued', claimed_by = null, claimed_at = null,
             run_after = now(), last_error = coalesce(last_error, 'released during graceful shutdown')
       where status = 'running' and claimed_by = ${workerId}
      returning id
    `;
    return rows.length;
  }

  requeueStale(olderThan: string): Promise<number> {
    return requeueStaleSyncJobs(this.handle, olderThan);
  }

  async profile(profileId: string): Promise<AdsProfileContext> {
    const rows = await this.handle.sql<{
      id: string;
      org_id: string;
      amazon_profile_id: string;
      region: 'NA' | 'EU' | 'FE';
      currency_code: string;
      timezone: string;
    }[]>`
      select id, org_id, amazon_profile_id, region, currency_code, timezone
        from public.ad_profiles where id = ${profileId}
    `;
    const row = rows[0];
    if (!row) throw new Error(`profile ${profileId} does not exist`);
    return {
      id: row.id,
      orgId: row.org_id,
      amazonProfileId: row.amazon_profile_id,
      region: row.region,
      currencyCode: row.currency_code,
      timezone: row.timezone,
    };
  }

  async syncEntities(
    profile: AdsProfileContext,
    entities: readonly EntityRow[],
    options: EntitySyncOptions = {},
  ): Promise<EntitySyncCounts> {
    const { adProduct, full = false } = options;
    for (const entity of entities) {
      if (entity.profileId !== profile.id) {
        throw new Error(`entity ${entity.amazonId} belongs to profile ${entity.profileId}, expected ${profile.id}`);
      }
    }
    const now = new Date();
    let upserted = 0;
    let tombstoned = 0;
    const changes: NewEntityChange[] = [];
    const entityTypes = ['portfolio', 'campaign', 'ad_group', 'product_ad', 'keyword', 'target', 'negative'] as const;

    for (const entityType of entityTypes) {
      const incoming = entities.filter((entity) => entity.entityType === entityType);
      const existing = await this.existingEntities(profile.id, entityType, adProduct);
      const byId = new Map(existing.map((row) => [row.amazonId, row]));
      const seen = new Set<string>();

      for (const entity of incoming) {
        seen.add(entity.amazonId);
        const prior = byId.get(entity.amazonId);
        const nextSnapshot = entitySnapshot(entity);
        if (!prior) {
          changes.push(change(profile, entity, 'entity', null, nextSnapshot));
        } else {
          for (const [field, value] of Object.entries(nextSnapshot)) {
            const oldValue = prior.snapshot[field];
            if (!isDeepStrictEqual(oldValue, value)) {
              changes.push(change(profile, entity, field, oldValue ?? null, value ?? null));
            }
          }
          if (prior.deletedAt) {
            changes.push(change(profile, entity, 'deletedAt', asDate(prior.deletedAt).toISOString(), null));
          }
        }
      }

      const missing = full ? existing.filter((row) => !row.deletedAt && !seen.has(row.amazonId)) : [];
      tombstoned += missing.length;
      if (missing.length > 0) {
        const ids = missing.map((row) => row.amazonId);
        await this.markDeleted(profile.id, entityType, ids, now);
        for (const row of missing) {
          changes.push({
            orgId: profile.orgId,
            profileId: profile.id,
            entityType,
            amazonId: row.amazonId,
            entityName: typeof row.snapshot['name'] === 'string' ? row.snapshot['name'] : null,
            field: 'deletedAt',
            oldValue: null,
            newValue: now.toISOString(),
            source: 'sync',
          });
        }
      }

      upserted += await this.upsertType(profile, entityType, incoming, now);
    }

    const writtenChanges = await recordEntityChanges(this.handle, changes);
    if (entities.length !== upserted) {
      throw new Error(`entity sync listed ${entities.length} rows but upserted ${upserted}`);
    }
    return { listed: entities.length, upserted, changes: writtenChanges, tombstoned };
  }

  async ensureReportRequest(
    jobId: string,
    payload: Extract<JobPayload, { type: 'report.request' }>,
  ): Promise<ReportRequestState> {
    await this.handle.db.insert(reportRequests).values({
      id: jobId,
      orgId: payload.orgId,
      profileId: payload.profileId,
      reportType: payload.reportType,
      startDate: payload.startDate,
      endDate: payload.endDate,
    }).onConflictDoNothing();
    return this.getReportRequest(jobId);
  }

  async setReportCreated(reportRequestId: string, amazonReportId: string, nextPollAt: Date): Promise<void> {
    await this.handle.sql`
      update public.report_requests
         set amazon_report_id = ${amazonReportId}, status = 'pending', next_poll_at = ${iso(nextPollAt)}
       where id = ${reportRequestId}
    `;
  }

  async getReportRequest(reportRequestId: string): Promise<ReportRequestState> {
    const rows = await this.handle.sql<{
      id: string;
      report_type: ReportType;
      amazon_report_id: string | null;
      requested_at: Date | string;
      poll_attempts: number;
    }[]>`
      select id, report_type, amazon_report_id, requested_at, poll_attempts
        from public.report_requests where id = ${reportRequestId}
    `;
    const row = rows[0];
    if (!row) throw new Error(`report request ${reportRequestId} does not exist`);
    return {
      id: row.id,
      reportType: row.report_type,
      amazonReportId: row.amazon_report_id,
      requestedAt: asDate(row.requested_at),
      pollAttempts: Number(row.poll_attempts),
    };
  }

  async updateReportPoll(
    reportRequestId: string,
    values: {
      status: 'pending' | 'processing' | 'failed' | 'cancelled' | 'expired';
      nextPollAt?: Date | null;
      error?: string | null;
      downloadUrl?: string | null;
      downloadExpiresAt?: Date | null;
    },
  ): Promise<void> {
    await this.handle.sql`
      update public.report_requests
         set status = ${values.status}::public.report_status,
             poll_attempts = poll_attempts + 1,
             last_polled_at = now(),
             next_poll_at = ${iso(values.nextPollAt)},
             error = ${values.error ?? null},
             download_url = coalesce(${values.downloadUrl ?? null}, download_url),
             download_expires_at = coalesce(${iso(values.downloadExpiresAt)}::timestamptz, download_expires_at)
       where id = ${reportRequestId}
    `;
  }

  async enqueue(payload: JobPayload, runAt: Date, dedupeKey: string): Promise<boolean> {
    const rows = await this.handle.sql<{ id: string }[]>`
      insert into public.sync_jobs
        (org_id, profile_id, job_type, payload, run_after, dedupe_key)
      values
        (${payload.orgId}, ${payload.profileId}, ${payload.type}::public.sync_job_type,
         ${JSON.stringify(payload)}::jsonb, ${runAt.toISOString()}::timestamptz, ${dedupeKey})
      on conflict (org_id, dedupe_key) where dedupe_key is not null do nothing
      returning id
    `;
    return rows.length === 1;
  }

  async provisionSchedules(
    orgId: string,
    profileId: string,
    specs: readonly ScheduleSpec[] = defaultSchedules(),
  ): Promise<number> {
    let written = 0;
    for (const spec of specs) {
      const rows = await this.handle.sql<{ id: string }[]>`
        insert into public.sync_schedules
          (org_id, profile_id, job_type, report_type, variant, cadence, lookback_days, payload)
        values
          (${orgId}, ${profileId}, ${spec.jobType}::public.sync_job_type,
           ${spec.reportType}::public.report_type, ${spec.variant},
           ${spec.cadence}::interval, ${spec.lookbackDays}, ${JSON.stringify(spec.payload)}::jsonb)
        on conflict (profile_id, job_type, report_type, variant) do nothing
        returning id
      `;
      written += rows.length;
    }
    return written;
  }

  async unscheduledProfiles(): Promise<{ orgId: string; profileId: string }[]> {
    const rows = await this.handle.sql<{ org_id: string; id: string }[]>`
      select p.org_id, p.id
        from public.ad_profiles p
       where p.sync_enabled
         and not exists (select 1 from public.sync_schedules s where s.profile_id = p.id)
    `;
    return rows.map((row) => ({ orgId: row.org_id, profileId: row.id }));
  }

  async loadFacts(batch: ParsedFactBatch): Promise<number> {
    switch (batch.kind) {
      case 'sp_target': return (await upsertSpTargetFacts(this.handle, batch.rows)).written;
      case 'search_term': return (await upsertSearchTermFacts(this.handle, batch.rows)).written;
      case 'placement': return (await upsertPlacementFacts(this.handle, batch.rows)).written;
      case 'profile': return (await upsertProfileFacts(this.handle, batch.rows)).written;
      case 'sb': return this.upsertCampaignFacts('sb', batch.rows);
      case 'sd': return this.upsertCampaignFacts('sd', batch.rows);
    }
  }

  async completeReport(
    reportRequestId: string,
    counts: { parsed: number; loaded: number; bytesDownloaded: number },
  ): Promise<void> {
    await this.handle.sql`
      update public.report_requests
         set status = ${counts.parsed === counts.loaded ? 'completed' : 'failed'}::public.report_status,
             completed_at = now(), next_poll_at = null,
             rows_parsed = ${counts.parsed}, rows_loaded = ${counts.loaded},
             bytes_downloaded = ${counts.bytesDownloaded},
             error = ${counts.parsed === counts.loaded ? null : `parsed ${counts.parsed}, loaded ${counts.loaded}`}
       where id = ${reportRequestId}
    `;
    if (counts.parsed !== counts.loaded) throw new ParsedLoadedMismatch(counts.parsed, counts.loaded);
  }

  private async upsertCampaignFacts(kind: 'sb' | 'sd', rows: readonly CampaignFactRow[]): Promise<number> {
    let written = 0;
    for (const row of rows) {
      const result = kind === 'sb'
        ? await this.handle.db.insert(factSbDaily).values(row).onConflictDoUpdate({
            target: [factSbDaily.profileId, factSbDaily.date, factSbDaily.campaignId, factSbDaily.adGroupId],
            set: campaignFactSet(row),
          }).returning({ profileId: factSbDaily.profileId })
        : await this.handle.db.insert(factSdDaily).values(row).onConflictDoUpdate({
            target: [factSdDaily.profileId, factSdDaily.date, factSdDaily.campaignId, factSdDaily.adGroupId],
            set: campaignFactSet(row),
          }).returning({ profileId: factSdDaily.profileId });
      written += result.length;
    }
    return written;
  }

  private async existingEntities(
    profileId: string,
    entityType: EntityRow['entityType'],
    adProduct?: 'SP' | 'SB' | 'SD',
  ): Promise<ExistingEntity[]> {
    const table = tableName(entityType);
    const product = adProduct ? ` and ad_product = '${adProduct}'` : '';
    const rows = await this.handle.sql.unsafe<ExistingEntity[]>(
      `select amazon_id as "amazonId", deleted_at as "deletedAt", to_jsonb(t) - array['id','org_id','profile_id','first_seen_at','synced_at','deleted_at']::text[] as snapshot from public.${table} t where profile_id = $1${product}`,
      [profileId],
    );
    return rows.map((row) => ({ ...row, snapshot: normalizeDbSnapshot(row.snapshot) }));
  }

  private async markDeleted(
    profileId: string,
    entityType: EntityRow['entityType'],
    amazonIds: readonly string[],
    at: Date,
  ): Promise<void> {
    await this.handle.sql.unsafe(
      `update public.${tableName(entityType)} set deleted_at = $1, synced_at = $1 where profile_id = $2 and amazon_id = any($3::text[])`,
      [at.toISOString(), profileId, amazonIds],
    );
  }

  private async upsertType(
    profile: AdsProfileContext,
    entityType: EntityRow['entityType'],
    rows: readonly EntityRow[],
    syncedAt: Date,
  ): Promise<number> {
    switch (entityType) {
      case 'portfolio': return (await upsertMirrorRows(this.handle, portfolios, rows.filter(isType('portfolio')).map((row) => ({ ...baseMirror(profile, row, syncedAt), budgetAmount: row.budgetAmount, budgetPolicy: row.budgetPolicy })))).upserted;
      case 'campaign': return (await upsertMirrorRows(this.handle, campaigns, rows.filter(isType('campaign')).map((row) => ({ ...baseMirror(profile, row, syncedAt), portfolioAmazonId: row.portfolioId, budgetAmount: row.budgetAmount, budgetType: row.budgetType, targetingType: row.targetingType, biddingStrategy: row.biddingStrategy, placementBidding: row.placementBidding, startDate: row.startDate, endDate: row.endDate })))).upserted;
      case 'ad_group': return (await upsertMirrorRows(this.handle, adGroups, rows.filter(isType('ad_group')).map((row) => ({ ...baseMirror(profile, row, syncedAt), campaignId: row.campaignId, defaultBid: row.defaultBid })))).upserted;
      case 'product_ad': return (await upsertMirrorRows(this.handle, productAds, rows.filter(isType('product_ad')).map((row) => ({ ...baseMirror(profile, row, syncedAt), campaignId: row.campaignId, adGroupId: row.adGroupId, asin: row.asin, sku: row.sku })))).upserted;
      case 'keyword': return (await upsertMirrorRows(this.handle, keywords, rows.filter(isType('keyword')).map((row) => ({ ...baseMirror(profile, row, syncedAt), campaignId: row.campaignId, adGroupId: row.adGroupId, keywordText: row.keywordText, matchType: row.matchType, bid: row.bid })))).upserted;
      case 'target': return (await upsertMirrorRows(this.handle, targets, rows.filter(isType('target')).map((row) => ({ ...baseMirror(profile, row, syncedAt), campaignId: row.campaignId, adGroupId: row.adGroupId, expression: row.expression, resolvedExpression: row.resolvedExpression, bid: row.bid })))).upserted;
      case 'negative': return (await upsertMirrorRows(this.handle, negatives, rows.filter(isType('negative')).map((row) => ({ ...baseMirror(profile, row, syncedAt), campaignId: row.campaignId, adGroupId: row.adGroupId, scope: row.scope, keywordText: row.keywordText, expression: row.expression, matchType: row.matchType })))).upserted;
    }
  }
}

function tableName(entityType: EntityRow['entityType']): string {
  return { portfolio: 'portfolios', campaign: 'campaigns', ad_group: 'ad_groups', product_ad: 'product_ads', keyword: 'keywords', target: 'targets', negative: 'negatives' }[entityType];
}

function isType<T extends EntityRow['entityType']>(type: T): (row: EntityRow) => row is Extract<EntityRow, { entityType: T }> {
  return (row): row is Extract<EntityRow, { entityType: T }> => row.entityType === type;
}

function baseMirror(profile: AdsProfileContext, row: EntityRow, syncedAt: Date) {
  return { orgId: profile.orgId, profileId: profile.id, amazonId: row.amazonId, adProduct: row.adProduct, name: row.name, state: row.state, syncedAt, deletedAt: null };
}

function entitySnapshot(entity: EntityRow): Record<string, unknown> {
  const { profileId: _profileId, syncedAt: _syncedAt, entityType: _entityType, ...snapshot } = entity;
  return snapshot;
}

function change(
  profile: AdsProfileContext,
  entity: EntityRow,
  field: string,
  oldValue: unknown,
  newValue: unknown,
): NewEntityChange {
  return { orgId: profile.orgId, profileId: profile.id, entityType: entity.entityType, amazonId: entity.amazonId, entityName: entity.name, field, oldValue, newValue, source: 'sync' };
}

function campaignFactSet(row: CampaignFactRow) {
  return { impressions: row.impressions, clicks: row.clicks, cost: row.cost, purchases7d: row.purchases7d, sales7d: row.sales7d, unitsSold7d: row.unitsSold7d, metrics: row.metrics, reportRequestId: row.reportRequestId, loadedAt: new Date() };
}

function normalizeDbSnapshot(snapshot: Record<string, unknown>): Record<string, unknown> {
  const numeric = new Set(['budgetAmount', 'defaultBid', 'bid']);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(snapshot)) {
    const camel = key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
    const contractKey = camel === 'portfolioAmazonId' ? 'portfolioId' : camel;
    result[contractKey] = numeric.has(contractKey) && typeof value === 'string' ? Number(value) : value;
  }
  return result;
}
