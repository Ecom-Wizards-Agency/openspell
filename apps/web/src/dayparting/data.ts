import {
  DaypartingScheduleProposal,
  type DaypartingScheduleProposal as DaypartingScheduleProposalValue,
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
  const [facts, proposalRows, coverageRows] = await Promise.all([
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
  ]);

  return {
    facts,
    proposals: proposalRows.map(proposalFromRow),
    coverage: {
      ledgerMessages: coverageRows[0]?.messages ?? 0,
      latestReceivedAt: toIsoOrNull(coverageRows[0]?.latest_received_at ?? null),
    },
  };
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
