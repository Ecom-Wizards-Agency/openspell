import {
  DaypartingScheduleProposal,
  type AdProduct,
  type DaypartingScheduleProposal as DaypartingScheduleProposalValue,
  type HourSettlingState,
} from '@wizard-ads/shared';
import { readMarketingStreamHourlyFacts, type DbHandle } from '@wizard-ads/db';

export interface DaypartingCoverage {
  ledgerMessages: number;
  latestReceivedAt: string | null;
}

export interface DaypartingWorkspace {
  facts: Awaited<ReturnType<typeof readMarketingStreamHourlyFacts>>;
  proposals: DaypartingScheduleProposalValue[];
  coverage: DaypartingCoverage;
  maturityPolicyConfigured: boolean;
}

interface ProposalRow {
  id: string;
  profile_id: string;
  campaign_id: string;
  baseline_label: string;
  evidence_start: string;
  evidence_end: string;
  settled_hours: string | number;
  blocks: DaypartingScheduleProposalValue['blocks'];
  status: DaypartingScheduleProposalValue['status'];
}

interface MaturityPolicyRow {
  settling_window_hours: string | number | null;
}

interface RevisionRow {
  ad_product: AdProduct;
  utc_hour: Date | string;
  latest_revision_received_at: Date | string | null;
}

export async function readDaypartingWorkspace(
  handle: DbHandle,
  input: {
    orgId: string;
    profileId: string;
    campaignId?: string;
    fromUtcHour?: string;
    toUtcHour?: string;
  },
): Promise<DaypartingWorkspace> {
  const [storedFacts, proposalRows, coverageRows, maturityRows] = await Promise.all([
    readMarketingStreamHourlyFacts(handle, input),
    handle.sql<ProposalRow[]>`
      select id, profile_id, campaign_id, baseline_label,
             evidence_start::text as evidence_start,
             evidence_end::text as evidence_end, settled_hours, blocks,
             status::text as status
        from public.dayparting_schedule_proposals
       where org_id = ${input.orgId}
         and profile_id = ${input.profileId}
         and (${input.campaignId ?? null}::text is null or campaign_id = ${input.campaignId ?? null})
       order by evidence_end desc, created_at desc, id desc
       limit 50
    `,
    handle.sql<{ messages: number; latest_received_at: Date | string | null }[]>`
      select count(*)::int as messages, max(received_at) as latest_received_at
        from public.marketing_stream_events
       where org_id = ${input.orgId} and profile_id = ${input.profileId}
    `,
    handle.sql<MaturityPolicyRow[]>`
      select coalesce(
               profile.doc #>> '{dayparting,settling_window_hours}',
               tenant.doc #>> '{dayparting,settling_window_hours}'
             ) as settling_window_hours
        from (select 1) anchor
        left join public.profile_strategy tenant
          on tenant.org_id = ${input.orgId} and tenant.profile_id is null
        left join public.profile_strategy profile
          on profile.org_id = ${input.orgId} and profile.profile_id = ${input.profileId}
    `,
  ]);

  const settlingWindowHours = nullableFiniteNumber(maturityRows[0]?.settling_window_hours ?? null);
  const revisions = settlingWindowHours === null || storedFacts.length === 0
    ? []
    : await handle.sql<RevisionRow[]>`
        select ad_product::text as ad_product,
               date_trunc('hour', event_time) as utc_hour,
               max(received_at) filter (
                 where dataset <> 'budget_usage'::public.marketing_stream_dataset
                   and received_at > date_trunc('hour', event_time)
                     + interval '1 hour'
                     + (${settlingWindowHours} * interval '1 hour')
               ) as latest_revision_received_at
          from public.marketing_stream_events
         where org_id = ${input.orgId}
           and profile_id = ${input.profileId}
           and (${input.fromUtcHour ?? null}::timestamptz is null or event_time >= ${input.fromUtcHour ?? null}::timestamptz)
           and (${input.toUtcHour ?? null}::timestamptz is null or event_time <= ${input.toUtcHour ?? null}::timestamptz)
         group by ad_product, date_trunc('hour', event_time)
      `;
  const latestRevisionByScope = new Map(revisions.map((row) => [
    maturityScopeKey(row.ad_product, row.utc_hour),
    toIsoOrNull(row.latest_revision_received_at),
  ]));
  const now = new Date();
  const facts = settlingWindowHours === null
    ? storedFacts
    : storedFacts.map((fact) => ({
        ...fact,
        settlingState: deriveCurrentSettlingState({
          utcHour: fact.utcHour,
          latestRevisionReceivedAt:
            latestRevisionByScope.get(maturityScopeKey(fact.adProduct, fact.utcHour)) ?? null,
          settlingWindowHours,
          now,
        }),
      }));

  return {
    facts,
    proposals: proposalRows.map(proposalFromRow),
    coverage: {
      ledgerMessages: coverageRows[0]?.messages ?? 0,
      latestReceivedAt: toIsoOrNull(coverageRows[0]?.latest_received_at ?? null),
    },
    maturityPolicyConfigured: settlingWindowHours !== null,
  };
}

/** Re-evaluate a stored hour without rewriting canonical facts or forecasting conversions. */
export function deriveCurrentSettlingState(input: {
  utcHour: string;
  latestRevisionReceivedAt: string | null;
  settlingWindowHours: number;
  now: Date;
}): HourSettlingState {
  const windowMs = input.settlingWindowHours * 3_600_000;
  const hourMs = new Date(input.utcHour).getTime();
  const baseDueMs = hourMs + 3_600_000 + windowMs;
  if (!Number.isFinite(hourMs) || input.now.getTime() < baseDueMs) return 'settling';
  if (input.latestRevisionReceivedAt !== null) {
    const revisionMs = new Date(input.latestRevisionReceivedAt).getTime();
    if (!Number.isFinite(revisionMs) || input.now.getTime() - revisionMs < windowMs) return 'revised';
  }
  return 'settled';
}

export async function readDaypartingProposal(
  handle: Pick<DbHandle, 'sql'>,
  input: { orgId: string; profileId: string; proposalId: string },
): Promise<DaypartingScheduleProposalValue | null> {
  const [row] = await handle.sql<ProposalRow[]>`
    select id, profile_id, campaign_id, baseline_label,
           evidence_start::text as evidence_start,
           evidence_end::text as evidence_end, settled_hours, blocks,
           status::text as status
      from public.dayparting_schedule_proposals
     where org_id = ${input.orgId}
       and profile_id = ${input.profileId}
       and id = ${input.proposalId}
  `;
  return row ? proposalFromRow(row) : null;
}

function proposalFromRow(row: ProposalRow): DaypartingScheduleProposalValue {
  return DaypartingScheduleProposal.parse({
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
}

function toIsoOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function nullableFiniteNumber(value: string | number | null): number | null {
  if (value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function maturityScopeKey(adProduct: AdProduct, utcHour: Date | string): string {
  const parsed = utcHour instanceof Date ? new Date(utcHour) : new Date(utcHour);
  if (Number.isNaN(parsed.getTime())) return `${adProduct}|${String(utcHour)}`;
  parsed.setUTCMinutes(0, 0, 0);
  return `${adProduct}|${parsed.toISOString()}`;
}
