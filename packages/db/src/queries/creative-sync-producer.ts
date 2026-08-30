/**
 * Database-only producer for one current-day SB Video observation per enabled
 * profile. It never claims work and never calls Amazon; the exclusive report
 * worker owns the jobs after they are inserted.
 */
import { JobPayload } from '@wizard-ads/shared';
import type { DbHandle } from '../client.js';

export interface DailyCreativeSyncObservation {
  orgId: string;
  profileId: string;
  localDate: string;
  dedupeKey: string;
  jobId: string;
  enqueued: boolean;
}

export interface DailyCreativeSyncEnqueueResult {
  enabledProfiles: number;
  offeredProfiles: number;
  deferredPendingProfiles: number;
  enqueuedJobs: number;
  deduplicatedJobs: number;
  observations: DailyCreativeSyncObservation[];
}

interface RawDailyCreativeSyncResult {
  enabled_profiles: string | number;
  offered_profiles: string | number;
  deferred_pending_profiles: string | number;
  enqueued_jobs: string | number;
  deduplicated_jobs: string | number;
  observations: Array<{
    orgId: string;
    profileId: string;
    localDate: string;
    dedupeKey: string;
    jobId: string;
    enqueued: boolean;
    payload: unknown;
  }>;
}

/**
 * Offer today's profile-local observation for every sync-enabled profile.
 *
 * The queue's `(org_id, dedupe_key)` partial unique index is the retry lock.
 * The key includes the profile UUID because one organization may own many
 * advertiser profiles whose local calendar date is identical.
 */
export async function enqueueDailyCreativeSyncJobs(
  handle: Pick<DbHandle, 'sql'>,
  observedAt: Date = new Date(),
): Promise<DailyCreativeSyncEnqueueResult> {
  const rows = await handle.sql<RawDailyCreativeSyncResult[]>`
    with enabled as materialized (
      select p.org_id,
             p.id as profile_id,
             (${observedAt.toISOString()}::timestamptz at time zone p.timezone)::date::text as local_date,
             'creative.sync:SB:' || p.id::text || ':' ||
               ((${observedAt.toISOString()}::timestamptz at time zone p.timezone)::date::text) as dedupe_key,
             exists (
               select 1
                 from public.creative_sync_snapshots snapshot
                where snapshot.org_id = p.org_id
                  and snapshot.profile_id = p.id
                  and snapshot.status = 'report_pending'
             ) as report_pending
        from public.ad_profiles p
       where p.sync_enabled
    ), eligible as materialized (
      select org_id, profile_id, local_date, dedupe_key
        from enabled
       where not report_pending
    ), inserted as (
      insert into public.sync_jobs
        (org_id, profile_id, job_type, payload, run_after, dedupe_key)
      select e.org_id,
             e.profile_id,
             'creative.sync'::public.sync_job_type,
             jsonb_build_object(
               'type', 'creative.sync',
               'orgId', e.org_id,
               'profileId', e.profile_id,
               'startDate', e.local_date,
               'endDate', e.local_date,
               'adProduct', 'SB',
               'allowObservedAttributionFacts', true
             ),
             ${observedAt.toISOString()}::timestamptz,
             e.dedupe_key
        from eligible e
      on conflict (org_id, dedupe_key) where dedupe_key is not null do nothing
      returning id, org_id, profile_id, dedupe_key, payload
    ), resolved as (
      select e.org_id,
             e.profile_id,
             e.local_date,
             e.dedupe_key,
             i.id as job_id,
             true as enqueued,
             i.payload
        from eligible e
        join inserted i
          on i.org_id = e.org_id
         and i.profile_id = e.profile_id
         and i.dedupe_key = e.dedupe_key
      union all
      select e.org_id,
             e.profile_id,
             e.local_date,
             e.dedupe_key,
             j.id as job_id,
             false as enqueued,
             j.payload
        from eligible e
        join public.sync_jobs j
          on j.org_id = e.org_id
         and j.profile_id = e.profile_id
         and j.dedupe_key = e.dedupe_key
       where not exists (
         select 1 from inserted i
          where i.org_id = e.org_id
            and i.profile_id = e.profile_id
            and i.dedupe_key = e.dedupe_key
       )
    )
    select (select count(*) from enabled) as enabled_profiles,
           (select count(*) from eligible) as offered_profiles,
           (select count(*) from enabled where report_pending) as deferred_pending_profiles,
           count(*) filter (where enqueued) as enqueued_jobs,
           count(*) filter (where not enqueued) as deduplicated_jobs,
           coalesce(
             jsonb_agg(
               jsonb_build_object(
                 'orgId', org_id,
                 'profileId', profile_id,
                 'localDate', local_date,
                 'dedupeKey', dedupe_key,
                 'jobId', job_id,
                 'enqueued', enqueued,
                 'payload', payload
               ) order by org_id, profile_id
             ) filter (where job_id is not null),
             '[]'::jsonb
           ) as observations
      from resolved
  `;
  const row = rows[0];
  if (row === undefined) throw new Error('daily Creative queue query returned no accounting row');
  const observations = row.observations.map((observation): DailyCreativeSyncObservation => {
    const payload = JobPayload.parse(observation.payload);
    if (
      payload.type !== 'creative.sync' ||
      payload.orgId !== observation.orgId ||
      payload.profileId !== observation.profileId ||
      payload.startDate !== observation.localDate ||
      payload.endDate !== observation.localDate ||
      payload.adProduct !== 'SB' ||
      payload.allowObservedAttributionFacts !== true
    ) {
      throw new Error('daily Creative queue row did not reconcile with its profile-local offer');
    }
    return {
      orgId: observation.orgId,
      profileId: observation.profileId,
      localDate: observation.localDate,
      dedupeKey: observation.dedupeKey,
      jobId: observation.jobId,
      enqueued: observation.enqueued,
    };
  });
  const result = {
    enabledProfiles: Number(row.enabled_profiles),
    offeredProfiles: Number(row.offered_profiles),
    deferredPendingProfiles: Number(row.deferred_pending_profiles),
    enqueuedJobs: Number(row.enqueued_jobs),
    deduplicatedJobs: Number(row.deduplicated_jobs),
    observations,
  };
  if (
    result.enabledProfiles !== result.offeredProfiles + result.deferredPendingProfiles ||
    result.offeredProfiles !== result.enqueuedJobs + result.deduplicatedJobs ||
    result.offeredProfiles !== result.observations.length
  ) {
    throw new Error('daily Creative queue counts did not reconcile');
  }
  return result;
}
