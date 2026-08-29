import type { OptimizationGroupRecord } from '@wizard-ads/db';
import type { OptimizerCampaignFactRow } from '../../app/_lib/optimizer-campaigns';
import type { ProposalView } from '../recommendations/view';

export interface OptimizerCampaignRow extends OptimizerCampaignFactRow {
  groupName: string | null;
  groupRole: string | null;
  lastRunAt: string | null;
  proposals: number;
}

export function buildOptimizerCampaignRows(
  facts: readonly OptimizerCampaignFactRow[],
  groups: readonly OptimizationGroupRecord[],
  proposals: readonly ProposalView[],
): OptimizerCampaignRow[] {
  const groupById = new Map(groups.map((record) => [record.group.id, record]));
  const proposalCounts = new Map<string, number>();
  for (const proposal of proposals) {
    if (proposal.campaignId === null) continue;
    proposalCounts.set(proposal.campaignId, (proposalCounts.get(proposal.campaignId) ?? 0) + 1);
  }

  return facts.map((campaign) => {
    const record = campaign.groupId === null ? undefined : groupById.get(campaign.groupId);
    return {
      ...campaign,
      groupName: record?.group.name ?? null,
      groupRole: record?.group.role ?? null,
      lastRunAt: record?.lastRun?.createdAt ?? null,
      proposals: proposalCounts.get(campaign.campaignId) ?? 0,
    };
  });
}

export function filterOptimizerCampaignRows(
  rows: readonly OptimizerCampaignRow[],
  input: { query: string; group: string; state: string },
): OptimizerCampaignRow[] {
  const query = input.query.trim().toLocaleLowerCase();
  return rows.filter((row) => {
    if (query !== '' && !`${row.name} ${row.campaignId} ${row.adProduct}`.toLocaleLowerCase().includes(query)) {
      return false;
    }
    if (input.group === 'unassigned' && row.groupId !== null) return false;
    if (input.group !== 'all' && input.group !== 'unassigned' && row.groupId !== input.group) return false;
    if (input.state !== 'all' && row.state !== input.state) return false;
    return true;
  });
}
